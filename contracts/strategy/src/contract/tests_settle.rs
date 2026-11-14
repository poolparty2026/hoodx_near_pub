//! Slice 5 unit tests: `close`, `settle` and its callback, and the rate limit shared with
//! `resolve_stale` (EC-C25, EC-C49, EC-C50, EC-C128, EC-C168). The pinned DCL's real answers are
//! for the sandbox test.
use super::tests::*;
use super::tests_funding::{as_callback, at, events, last_event, ok};
use super::tests_start::started;
use super::*;
use crate::limits::NANOS_PER_S;
use near_sdk::PromiseResult;

pub(super) fn gap() -> u64 {
    limits_args().min_action_interval_s.0 * NANOS_PER_S
}
pub(super) fn run_end() -> u64 {
    config().run_end_ns.0
}
pub(super) fn closing() -> Strategy {
    let mut s = started();
    at("creator.near", BLOCK + 30, NOW, Gas::from_tgas(10));
    s.close();
    s
}
fn settle_as(s: &mut Strategy, who: &str, ts: u64, block: u64, gas: Gas) -> Promise {
    at(who, block, ts, gas);
    s.settle()
}
pub(super) fn settle_ok(s: &mut Strategy) {
    let _ = settle_as(s, "outsider.near", NOW, BLOCK + 40, MIN_GAS_SETTLE);
}
fn snap(s: &Strategy) -> String {
    near_sdk::serde_json::to_string(&(
        s.get_status(),
        s.get_lock(),
        s.get_closed_at(),
        s.get_stale_resolution_block(),
        s.get_settle_until_block(),
        s.next_op_id,
        near_sdk::borsh::to_vec(&s.rate_stamps).unwrap(),
    ))
    .unwrap()
}
pub(super) fn settle_cb(s: &mut Strategy, res: Vec<PromiseResult>) {
    as_callback(BLOCK + 42, res);
    s.on_settle_assets(U64(s.get_lock().map(|l| l.op_id.0).unwrap_or(99)));
}
/// A refusal of the callback: lock released, still `Closing`, an event with exactly this reason.
fn assert_settle_refused(s: &Strategy, reason: &str) {
    assert_eq!(s.get_lock(), None, "{reason}");
    assert_eq!(s.get_status(), Status::Closing, "{reason}");
    assert_eq!(s.get_closed_at(), None, "{reason}");
    assert!(calls().is_empty(), "{reason}");
    let e = last_event();
    assert_eq!(e["event"], "settle_refused");
    assert_eq!(e["data"][0]["reason"], reason);
}
fn dust(t: &str) -> u128 {
    let net = network();
    let id = if t == "quote" {
        net.quote_token
    } else {
        net.base_token
    };
    limits_args()
        .dust_threshold
        .iter()
        .find(|(a, _)| a.as_str() == id)
        .unwrap()
        .1
         .0
}
fn assets(q: Option<&str>, b: Option<&str>) -> String {
    let net = network();
    let mut m = near_sdk::serde_json::Map::new();
    if let Some(q) = q {
        m.insert(net.quote_token, near_sdk::serde_json::json!(q));
    }
    if let Some(b) = b {
        m.insert(net.base_token, near_sdk::serde_json::json!(b));
    }
    near_sdk::serde_json::Value::Object(m).to_string()
}

// ---- close (EC-C25, EC-C50, EC-C168) ----

/// The creator closes a running strategy at any time; the event names who, when and whether the
/// run had ended; `Closing` takes no more funding credit, no start, no cancel, no withdraw.
#[test]
fn the_creator_closes_a_running_strategy() {
    let mut s = started();
    at("creator.near", BLOCK + 30, NOW, Gas::from_tgas(10));
    s.close();
    assert_eq!(s.get_status(), Status::Closing);
    let e = last_event();
    assert_eq!(e["event"], "close");
    assert_eq!(
        e["data"][0],
        near_sdk::serde_json::json!({"by":"creator.near","at_ns":NOW.to_string(),"after_run_end":false})
    );
    // Closing keeps pool-token transfers (holdings), never credits principal, and takes no start,
    // cancel or withdraw.
    let p = s.get_principal();
    assert_eq!(
        super::tests_funding::inbound(
            &mut s,
            &super::tests_funding::quote(),
            "creator.near",
            9,
            "fund",
            BLOCK + 31
        ),
        0
    );
    assert_eq!(s.get_principal(), p);
    at("creator.near", BLOCK + 32, NOW, MIN_GAS_START);
    assert_eq!(
        refused(|| {
            let _ = s.start(0);
        }),
        "LIMIT: wrong status"
    );
    assert_eq!(refused(|| s.cancel()), "LIMIT: wrong status");
    assert_eq!(refused(|| s.close()), "LIMIT: wrong status");
}

/// Anyone closes from `run_end_ns` (one nanosecond before: only the creator); roles by predecessor.
#[test]
fn anyone_closes_after_the_run_ends() {
    for who in [
        "outsider.near",
        "agent.near",
        "platform.near",
        "deliverer.near",
        ME,
    ] {
        let mut s = started();
        let before = snap(&s);
        at(who, BLOCK + 30, run_end() - 1, Gas::from_tgas(10));
        assert_eq!(
            refused(|| s.close()),
            "AUTH: creator only before run end",
            "{who}"
        );
        assert_eq!(snap(&s), before);
        at(who, BLOCK + 30, run_end(), Gas::from_tgas(10));
        s.close();
        assert_eq!(s.get_status(), Status::Closing, "{who}");
        let e = last_event();
        assert_eq!(
            (
                e["data"][0]["by"].as_str(),
                e["data"][0]["after_run_end"].as_bool()
            ),
            (Some(who), Some(true))
        );
    }
}

/// EC-C25, EC-C50: refused while an operation holds the lock (before or after `run_end`), after
/// the status and the caller, nothing changed. Every other status is `wrong status` for anyone.
#[test]
fn close_refusals_in_order() {
    let lock = Some(Lock {
        op_id: U64(5),
        op: Op::Settle,
        stage: Stage::ReadAssets,
        promise_block: U64(BLOCK),
    });
    for (who, ts, want) in [
        ("creator.near", NOW, "LIMIT: operation pending"),
        ("outsider.near", run_end(), "LIMIT: operation pending"),
        ("outsider.near", NOW, "AUTH: creator only before run end"),
    ] {
        let mut s = started();
        s.lock = lock.clone();
        let before = snap(&s);
        at(who, BLOCK + 30, ts, Gas::from_tgas(10));
        assert_eq!(refused(|| s.close()), want, "{who} {ts}");
        assert_eq!(snap(&s), before);
        assert_eq!(s.get_status(), Status::Running);
    }
    for st in [
        Status::Open,
        Status::Cancelled,
        Status::Closing,
        Status::Closed,
    ] {
        let mut s = started();
        s.status = st;
        s.lock = lock.clone();
        // The status first, also where the caller check would fail too (before the run ends).
        for (who, ts) in [
            ("creator.near", run_end()),
            ("outsider.near", run_end()),
            ("outsider.near", run_end() - 1),
        ] {
            at(who, BLOCK + 30, ts, Gas::from_tgas(10));
            assert_eq!(refused(|| s.close()), "LIMIT: wrong status");
        }
    }
}

// ---- settle: first checks (EC-C49, EC-C128, EC-C155) ----

/// A valid settle takes the lock, stamps the rate limit and sends exactly one read and a callback.
#[test]
fn settle_sends_one_read_and_a_callback() {
    let mut s = closing();
    settle_ok(&mut s);
    let l = s.get_lock().unwrap();
    assert_eq!(
        (l.op, l.stage, l.promise_block.0),
        (Op::Settle, Stage::ReadAssets, BLOCK + 40)
    );
    assert_eq!(
        s.get_status(),
        Status::Closing,
        "not Closed until the callback"
    );
    assert_eq!(last_event()["event"], "settle_started");
    assert_eq!(s.rate_stamps.len(), 1);
    assert_eq!(
        s.rate_stamps[0],
        RateStamp {
            method: RateMethod::Settle,
            token: 0,
            class: Class::Outsider,
            at_ns: NOW
        }
    );
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(
        (c[0].0.as_str(), c[0].1.as_str(), c[0].3, c[0].4),
        (
            network().dcl_contract.as_str(),
            "list_user_assets",
            0,
            GAS_VIEW.as_gas()
        )
    );
    assert_eq!(c[0].2, format!(r#"{{"account_id":"{ME}"}}"#));
    assert_eq!((c[1].0.as_str(), c[1].1.as_str()), (ME, "on_settle_assets"));
    assert_eq!(c[1].2, r#"{"op_id":"1"}"#);
    assert_eq!((c[1].4, c[1].5), (GAS_SETTLE_CALLBACK.as_gas(), 0));
}

/// One refusal of `settle`: the exact message, no promise, nothing changed (stamps included).
fn expect_settle_refusal(s: &mut Strategy, who: &str, ts: u64, block: u64, gas: Gas, msg: &str) {
    let before = snap(s);
    at(who, block, ts, gas);
    assert_eq!(
        refused(|| {
            let _ = s.settle();
        }),
        msg,
        "{who} {ts} {block}"
    );
    assert!(calls().is_empty(), "{msg}");
    assert_eq!(snap(s), before, "{msg}");
}

/// The first checks in principle 5's order, each alone and each pair at once, nothing changed:
/// status, lock, rate limit, stale cooldown, settle window, gas.
#[test]
fn settle_refusals_in_order() {
    let low = Gas::from_gas(MIN_GAS_SETTLE.as_gas() - 1);
    let lock = Lock {
        op_id: U64(5),
        op: Op::Settle,
        stage: Stage::ReadAssets,
        promise_block: U64(BLOCK),
    };
    let cool = config().stale_cooldown_blocks.0;
    let b = BLOCK + 40;
    // Status first, with everything else wrong too.
    for st in [
        Status::Open,
        Status::Cancelled,
        Status::Running,
        Status::Closed,
    ] {
        let mut s = closing();
        s.status = st;
        s.lock = Some(lock.clone());
        expect_settle_refusal(&mut s, "outsider.near", NOW, b, low, "LIMIT: wrong status");
    }
    let mut s = closing();
    // Lock before the rate limit, the cooldown, the window and the gas.
    s.lock = Some(lock);
    s.stale_resolution_block = Some(b);
    s.settle_until_block = b + cool + 50;
    s.rate_stamp(RateMethod::Settle, 0, Class::Outsider);
    expect_settle_refusal(
        &mut s,
        "outsider.near",
        NOW,
        b,
        low,
        "LIMIT: operation pending",
    );
    s.lock = None;
    // Rate limit before the cooldown, the window and the gas (all three also failing).
    expect_settle_refusal(
        &mut s,
        "outsider.near",
        NOW + gap() - 1,
        b,
        low,
        "LIMIT: rate limited",
    );
    // Cooldown before the window and the gas (the window is open until b + cool + 50; both fail).
    expect_settle_refusal(
        &mut s,
        "creator.near",
        NOW,
        b + cool - 1,
        low,
        "LIMIT: stale cooldown",
    );
    // Window before the gas: the cooldown has passed, the window has not.
    expect_settle_refusal(
        &mut s,
        "creator.near",
        NOW,
        b + cool + 49,
        low,
        "LIMIT: settling",
    );
    // Gas last: one unit below refused with no stamp for the creator; at the window's block and
    // the minimum gas it goes through.
    expect_settle_refusal(
        &mut s,
        "creator.near",
        NOW,
        b + cool + 50,
        low,
        "LIMIT: gas",
    );
    assert!(s.rate_stamps.iter().all(|r| r.class != Class::Creator));
    let _ = settle_as(&mut s, "creator.near", NOW, b + cool + 50, MIN_GAS_SETTLE);
    assert!(s.get_lock().is_some());
}

/// EC-C155: the gas forwarded to DCL and to the callback is the same whatever the caller
/// attached, at the minimum and at 300 Tgas (`settle`, and `start` and `withdraw` for the same rule).
#[test]
fn forwarded_gas_does_not_depend_on_what_the_caller_attached() {
    let mut seen = vec![];
    for gas in [MIN_GAS_SETTLE, Gas::from_tgas(300)] {
        let mut s = closing();
        let _ = settle_as(&mut s, "outsider.near", NOW, BLOCK + 40, gas);
        seen.push(calls());
    }
    assert_eq!(seen[0], seen[1]);
    assert_eq!(
        (seen[0][0].4, seen[0][1].4, seen[0][1].5),
        (GAS_VIEW.as_gas(), GAS_SETTLE_CALLBACK.as_gas(), 0)
    );
    let mut seen = vec![];
    for gas in [MIN_GAS_START, Gas::from_tgas(300)] {
        let mut s = super::tests_start::ready();
        at("creator.near", BLOCK + 10, NOW, gas);
        let _ = s.start(401_312);
        seen.push(calls());
    }
    assert_eq!(seen[0], seen[1]);
    let mut seen = vec![];
    for gas in [MIN_GAS_WITHDRAW, Gas::from_tgas(300)] {
        let mut s = deployed();
        at("creator.near", BLOCK, NOW, Gas::from_tgas(10));
        s.cancel();
        at("creator.near", BLOCK + 100, NOW, gas);
        let _ = s.withdraw(super::tests_funding::quote());
        seen.push(calls());
    }
    assert_eq!(seen[0], seen[1]);
}

/// The cooldown after a stale resolution: one block early refused, at it allowed.
#[test]
fn settle_waits_the_stale_cooldown() {
    let cool = config().stale_cooldown_blocks.0;
    let mut s = closing();
    s.stale_resolution_block = Some(BLOCK + 100);
    let before = snap(&s);
    at("outsider.near", BLOCK + 100 + cool - 1, NOW, MIN_GAS_SETTLE);
    assert_eq!(
        refused(|| {
            let _ = s.settle();
        }),
        "LIMIT: stale cooldown"
    );
    assert_eq!(snap(&s), before);
    let _ = settle_as(
        &mut s,
        "outsider.near",
        NOW,
        BLOCK + 100 + cool,
        MIN_GAS_SETTLE,
    );
    assert!(s.get_lock().is_some());
}

/// EC-C128: each caller class has its own slot; the same class within `min_action_interval_s` is
/// `LIMIT: rate limited` (allowed at the interval, refused one nanosecond earlier); the platform
/// account and the deliverer are outsiders; a refused call stamps nothing.
#[test]
fn settle_is_rate_limited_per_class() {
    let mut s = closing();
    for (who, class) in [
        ("outsider.near", Class::Outsider),
        ("creator.near", Class::Creator),
        ("agent.near", Class::Agent),
    ] {
        settle_cb_after(&mut s, who);
        assert!(
            s.rate_stamps
                .iter()
                .any(|r| r.class == class && r.at_ns == NOW),
            "{who}"
        );
    }
    assert_eq!(s.rate_stamps.len(), 3);
    // Platform and deliverer share the outsiders' slot.
    for who in ["platform.near", "deliverer.near", "x.near"] {
        let before = snap(&s);
        at(who, BLOCK + 50, NOW + gap() - 1, MIN_GAS_SETTLE);
        assert_eq!(
            refused(|| {
                let _ = s.settle();
            }),
            "LIMIT: rate limited",
            "{who}"
        );
        assert_eq!(snap(&s), before);
    }
    // At the interval each class is allowed again.
    for who in ["outsider.near", "creator.near", "agent.near"] {
        let _ = settle_as(&mut s, who, NOW + gap(), BLOCK + 60, MIN_GAS_SETTLE);
        assert!(s.get_lock().is_some(), "{who}");
        s.lock = None;
    }
    assert_eq!(s.rate_stamps.len(), 3);
    assert!(s.rate_stamps.iter().all(|r| r.at_ns == NOW + gap()));
}

/// A settle by `who` whose callback refuses (an unreadable answer), freeing the lock and leaving the stamp.
fn settle_cb_after(s: &mut Strategy, who: &str) {
    let _ = settle_as(s, who, NOW, BLOCK + 40, MIN_GAS_SETTLE);
    settle_cb(s, vec![PromiseResult::Failed]);
    assert_eq!(last_event()["event"], "settle_refused");
}

// ---- the callback (EC-C11, EC-C49, EC-C168) ----

/// An empty account (`{}`), a balance of 0, and each token one below its dust: `Closed`, with the
/// exact event, the close time set, the lock released, the stamp kept. Other tokens' strict
/// entries are not ours to judge.
#[test]
fn a_clean_account_settles() {
    let net = network();
    // Other tokens' strict entries are not ours to judge; they never block.
    let other = format!(
        r#"{{"{}":"5","other.near":"999999999999","x.near":"0"}}"#,
        net.quote_token
    );
    for body in [
        "{}".to_string(),
        assets(Some("0"), Some("0")),
        assets(
            Some(&(dust("quote") - 1).to_string()),
            Some(&(dust("base") - 1).to_string()),
        ),
        other,
    ] {
        let mut s = closing();
        settle_ok(&mut s);
        settle_cb(&mut s, vec![ok(&body)]);
        assert_eq!(s.get_status(), Status::Closed, "{body}");
        assert_eq!(s.get_lock(), None);
        assert_eq!(s.get_closed_at(), Some(U64(NOW)));
        assert!(calls().is_empty());
        let e = last_event();
        assert_eq!(e["event"], "settle");
        assert_eq!(
            e["data"][0],
            near_sdk::serde_json::json!({"op_id":"1","closed_at_ns":NOW.to_string()})
        );
        assert_eq!(s.rate_stamps.len(), 1);
    }
}

/// EC-C49: an internal balance at the dust threshold, in either token, is `internal balance left`
/// (one below closes); nothing changes but the lock released; a later settle after the interval works.
#[test]
fn an_internal_balance_at_dust_blocks_settlement() {
    for (q, b) in [
        (dust("quote"), 0),
        (0, dust("base")),
        (u128::MAX, 0),
        (0, u128::MAX),
        (dust("quote"), dust("base")),
    ] {
        let mut s = closing();
        settle_ok(&mut s);
        settle_cb(
            &mut s,
            vec![ok(&assets(Some(&q.to_string()), Some(&b.to_string())))],
        );
        assert_settle_refused(&s, "LIMIT: internal balance left");
        // Retry after the interval with the balance gone.
        let _ = settle_as(
            &mut s,
            "outsider.near",
            NOW + gap(),
            BLOCK + 60,
            MIN_GAS_SETTLE,
        );
        settle_cb(&mut s, vec![ok("{}")]);
        assert_eq!(s.get_status(), Status::Closed);
    }
}

/// A failed, missing, doubled, non-JSON, non-object or non-strict answer is `read failed`
/// (principle 10: only `0|[1-9][0-9]*` fitting in u128), never a close.
#[test]
fn an_unreadable_answer_never_closes() {
    let big = format!("{}0", u128::MAX);
    let mut cases: Vec<Vec<PromiseResult>> = vec![
        vec![PromiseResult::Failed],
        vec![],
        vec![ok("{}"), ok("{}")],
        vec![ok("not json")],
        vec![ok("null")],
        vec![ok("[]")],
        vec![ok("\"{}\"")],
        vec![ok("5")],
        vec![ok(&"x".repeat(5_000))],
    ];
    for bad in ["+5", "007", "", " 5", "5 ", "1e3", "-1", "0x5", "٣", &big] {
        cases.push(vec![ok(&assets(Some(bad), None))]);
        cases.push(vec![ok(&assets(None, Some(bad)))]);
    }
    // A number or null in place of a string for a pool token.
    let net = network();
    cases.push(vec![ok(&format!(r#"{{"{}":5}}"#, net.quote_token))]);
    cases.push(vec![ok(&format!(r#"{{"{}":null}}"#, net.base_token))]);
    // Security audit M-1: an answer in a shape we don't understand never reads as "no balance",
    // whatever the token of the odd entry: nested objects, a renamed wrapper, a number or an
    // unreadable amount for a token that isn't ours.
    for body in [
        r#"{"x":{"a":"1"}}"#,
        r#"{"tokens":{"usdc":"5"}}"#,
        r#"{"other.near":5}"#,
        r#"{"other.near":"not a number"}"#,
        r#"{"other.near":"007"}"#,
        r#"{"x.near":["1"]}"#,
        r#"{"x.near":null}"#,
    ] {
        cases.push(vec![ok(body)]);
    }
    // Security audit M-2: a valid answer over 4 KB (many entries) is refused as an event, the lock
    // released, never a panic.
    let many: String = (0..400)
        .map(|i| format!(r#""t{i}.near":"1""#))
        .collect::<Vec<_>>()
        .join(",");
    assert!(many.len() > 4_096);
    cases.push(vec![ok(&format!("{{{many}}}"))]);
    for res in cases {
        let mut s = closing();
        settle_ok(&mut s);
        settle_cb(&mut s, res);
        assert_settle_refused(&s, "LIMIT: read failed");
    }
}

/// The status changing while the read is in flight (set directly) refuses; the callback acts only
/// on its own lock and only for the contract itself (EC-C11).
#[test]
fn the_callback_acts_only_on_its_own_lock() {
    let mut s = closing();
    settle_ok(&mut s);
    s.status = Status::Closed;
    settle_cb(&mut s, vec![ok("{}")]);
    assert_eq!(s.get_lock(), None);
    assert_eq!(last_event()["data"][0]["reason"], "LIMIT: wrong status");

    let mut s = closing();
    settle_ok(&mut s);
    let before = snap(&s);
    for who in ["creator.near", "outsider.near", "platform.near"] {
        near_sdk::testing_env!(
            ctx(who, BAL, Gas::from_tgas(50), BLOCK + 42).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![ok("{}")]
        );
        assert_eq!(
            refused(|| s.on_settle_assets(U64(1))),
            "AUTH: callback only"
        );
    }
    assert_eq!(snap(&s), before);
    as_callback(BLOCK + 42, vec![ok("{}")]);
    s.on_settle_assets(U64(9));
    assert_eq!(snap(&s), before);
    assert_eq!(last_event()["event"], "callback_ignored");
    let mut s = closing();
    let before = snap(&s);
    as_callback(BLOCK + 42, vec![ok("{}")]);
    s.on_settle_assets(U64(0));
    assert_eq!(snap(&s), before);
    assert_eq!(events().len(), 1);
}

/// Another operation's callback arriving at a lock of the same stage but another op id is ignored.
#[test]
fn a_late_settle_callback_is_ignored() {
    let stale = config().stale_after_blocks.0;
    let mut s = closing();
    settle_ok(&mut s); // op 1, launched at BLOCK + 40, lost
    at(
        "outsider.near",
        BLOCK + 40 + stale - 1,
        NOW + 5,
        Gas::from_tgas(10),
    );
    assert_eq!(refused(|| s.resolve_stale()), "LIMIT: not stale yet");
    at(
        "creator.near",
        BLOCK + 40 + stale,
        NOW + 5,
        Gas::from_tgas(10),
    );
    s.resolve_stale();
    assert_eq!(s.get_lock(), None);
    assert_eq!(s.get_status(), Status::Closing);
    assert_eq!(last_event()["data"][0]["op"], "Settle");
    // A new settle must wait the stale cooldown; then op 2 is in flight and op 1's callback lands.
    let cool = config().stale_cooldown_blocks.0;
    let r = BLOCK + 40 + stale;
    let _ = settle_as(&mut s, "agent.near", NOW + gap(), r + cool, MIN_GAS_SETTLE);
    assert_eq!(s.get_lock().unwrap().op_id.0, 2);
    let before = snap(&s);
    as_callback(r + cool + 1, vec![ok("{}")]);
    s.on_settle_assets(U64(1));
    assert_eq!(snap(&s), before);
    assert_eq!(last_event()["event"], "callback_ignored");
    s.on_settle_assets(U64(2));
    assert_eq!(s.get_status(), Status::Closed);
}

// ---- resolve_stale's rate limit (EC-C128) ----

fn lock_at_block(s: &mut Strategy, b: u64) {
    s.lock = Some(Lock {
        op_id: U64(7),
        op: Op::Settle,
        stage: Stage::ReadAssets,
        promise_block: U64(b),
    });
}

/// Each class resolves on its own slot; the same class again inside the interval is rate limited
/// before anything else; a `not stale yet` or `nothing in flight` refusal leaves the stamp alone.
#[test]
fn resolve_stale_is_rate_limited_per_class() {
    let stale = config().stale_after_blocks.0;
    let mut s = closing();
    let t0 = NOW;
    for (i, who) in ["outsider.near", "creator.near", "agent.near"]
        .iter()
        .enumerate()
    {
        lock_at_block(&mut s, BLOCK);
        at(who, BLOCK + stale + i as u64, t0, Gas::from_tgas(10));
        s.resolve_stale();
        assert_eq!(s.get_lock(), None, "{who}");
    }
    assert_eq!(s.rate_stamps.len(), 3);
    // The outsider again inside the interval: rate limited, even though a stale lock waits.
    lock_at_block(&mut s, BLOCK);
    let before = snap(&s);
    at(
        "platform.near",
        BLOCK + stale + 9,
        t0 + gap() - 1,
        Gas::from_tgas(10),
    );
    assert_eq!(refused(|| s.resolve_stale()), "LIMIT: rate limited");
    assert_eq!(snap(&s), before);
    // At the interval it resolves.
    at(
        "platform.near",
        BLOCK + stale + 9,
        t0 + gap(),
        Gas::from_tgas(10),
    );
    s.resolve_stale();
    assert_eq!(s.get_lock(), None);
    // Refusals after the rate check stamp nothing: not stale yet, then nothing in flight, then
    // the same class resolves at once when a lock goes stale.
    let stamps = s.rate_stamps.clone();
    lock_at_block(&mut s, BLOCK + 1_000_000);
    at(
        "deliverer.near",
        BLOCK + 1_000_001,
        t0 + 2 * gap(),
        Gas::from_tgas(10),
    );
    assert_eq!(refused(|| s.resolve_stale()), "LIMIT: not stale yet");
    s.lock = None;
    assert_eq!(refused(|| s.resolve_stale()), "LIMIT: nothing in flight");
    assert_eq!(s.rate_stamps, stamps);
    lock_at_block(&mut s, BLOCK);
    at(
        "deliverer.near",
        BLOCK + stale,
        t0 + 2 * gap(),
        Gas::from_tgas(10),
    );
    s.resolve_stale();
    assert_eq!(s.get_lock(), None);
}

// ---- views and states ----

#[test]
fn views_before_and_after() {
    let mut s = closing();
    assert_eq!(
        (s.get_closed_at(), s.get_settle_until_block()),
        (None, U64(0))
    );
    settle_ok(&mut s);
    settle_cb(&mut s, vec![ok("{}")]);
    assert_eq!(s.get_closed_at(), Some(U64(NOW)));
    // Closed: no second settle, no close, no start; a pool-token transfer is kept.
    at(
        "outsider.near",
        BLOCK + 70,
        NOW + 10 * gap(),
        MIN_GAS_SETTLE,
    );
    assert_eq!(
        refused(|| {
            let _ = s.settle();
        }),
        "LIMIT: wrong status"
    );
    assert_eq!(refused(|| s.close()), "LIMIT: wrong status");
}

proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig::with_cases(48))]
    /// EC-C49, EC-C168: the quote token closes if and only if its internal balance is below its
    /// dust (`dust - 1`, `dust`, `dust + 1`, 0 and any `u128` up to `u128::MAX`).
    #[test]
    fn settlement_is_exactly_below_dust(a in proptest::prop_oneof![
        proptest::strategy::Just(0u128), proptest::strategy::Just(dust("quote") - 1),
        proptest::strategy::Just(dust("quote")), proptest::strategy::Just(dust("quote") + 1),
        proptest::num::u128::ANY,
    ]) {
        let mut s = closing();
        settle_ok(&mut s);
        settle_cb(&mut s, vec![ok(&assets(Some(&a.to_string()), None))]);
        proptest::prop_assert_eq!(s.get_status() == Status::Closed, a < dust("quote"));
    }
}

/// Test audit M1 (EC-C168, EC-C128): roles are the predecessor, never the signer. A transaction the
/// creator signs but a contract relays is the contract's call: `close` before the run ends is
/// refused, and `settle` and `resolve_stale` use the caller's class by predecessor.
fn at_signed(pred: &str, signer: &str, block: u64, ts: u64, gas: Gas) {
    let mut b = ctx(pred, BAL, gas, block);
    b.signer_account_id(acc(signer)).block_timestamp(ts);
    near_sdk::testing_env!(b.build());
}

#[test]
fn roles_are_the_predecessor_not_the_signer() {
    // close: predecessor an outsider, signer the creator -> refused; the reverse -> allowed.
    let mut s = started();
    let before = snap(&s);
    at_signed(
        "relay.near",
        "creator.near",
        BLOCK + 30,
        NOW,
        Gas::from_tgas(10),
    );
    assert_eq!(refused(|| s.close()), "AUTH: creator only before run end");
    assert_eq!(snap(&s), before);
    at_signed(
        "creator.near",
        "relay.near",
        BLOCK + 30,
        NOW,
        Gas::from_tgas(10),
    );
    s.close();
    assert_eq!(s.get_status(), Status::Closing);
    // settle: the class comes from the predecessor.
    for (pred, class) in [
        ("relay.near", Class::Outsider),
        ("agent.near", Class::Agent),
        ("creator.near", Class::Creator),
    ] {
        let mut s = closing();
        at_signed(pred, "creator.near", BLOCK + 40, NOW, MIN_GAS_SETTLE);
        let _ = s.settle();
        assert_eq!(s.rate_stamps.len(), 1);
        assert_eq!(s.rate_stamps[0].class, class, "{pred}");
    }
    // resolve_stale likewise.
    for (pred, class) in [
        ("relay.near", Class::Outsider),
        ("agent.near", Class::Agent),
    ] {
        let mut s = closing();
        lock_at_block(&mut s, BLOCK);
        at_signed(
            pred,
            "creator.near",
            BLOCK + config().stale_after_blocks.0,
            NOW,
            Gas::from_tgas(10),
        );
        s.resolve_stale();
        assert_eq!(s.rate_stamps[0].class, class, "{pred}");
    }
}

/// Test audit L4 (EC-C128): the rate limit is checked before the staleness, so a same-class call
/// inside the interval against a lock that isn't stale yet is `rate limited`, not `not stale yet`.
#[test]
fn resolve_stale_rate_limit_comes_before_staleness() {
    let stale = config().stale_after_blocks.0;
    let mut s = closing();
    lock_at_block(&mut s, BLOCK);
    at("outsider.near", BLOCK + stale, NOW, Gas::from_tgas(10));
    s.resolve_stale();
    lock_at_block(&mut s, BLOCK + 10_000);
    let before = snap(&s);
    at(
        "outsider.near",
        BLOCK + 10_001,
        NOW + gap() - 1,
        Gas::from_tgas(10),
    );
    assert_eq!(refused(|| s.resolve_stale()), "LIMIT: rate limited");
    at(
        "outsider.near",
        BLOCK + 10_001,
        NOW + gap(),
        Gas::from_tgas(10),
    );
    assert_eq!(refused(|| s.resolve_stale()), "LIMIT: not stale yet");
    assert_eq!(snap(&s), before);
}

/// Test audit M2 (EC-C168): the amount parser rejects every non-canonical spelling and accepts
/// the canonical ones.
#[test]
fn strict_amounts() {
    for bad in [
        "00", "01", "007", "0123", "+5", "-0", "", " 1", "1 ", "1_0", "0x1", "1.0", "\u{661}",
        "\u{663}",
    ] {
        assert_eq!(
            strict_amount(&near_sdk::serde_json::json!(bad)),
            None,
            "{bad:?}"
        );
    }
    for (good, v) in [
        ("0", 0u128),
        ("1", 1),
        ("10", 10),
        ("9", 9),
        ("1000", 1_000),
        (&*u128::MAX.to_string(), u128::MAX),
    ] {
        assert_eq!(
            strict_amount(&near_sdk::serde_json::json!(good)),
            Some(v),
            "{good}"
        );
    }
    assert_eq!(
        strict_amount(&near_sdk::serde_json::json!(
            "340282366920938463463374607431768211456"
        )),
        None
    );
    assert_eq!(strict_amount(&near_sdk::serde_json::json!(5)), None);
    assert_eq!(strict_amount(&near_sdk::serde_json::Value::Null), None);
}

/// S8 gate (EC-C73, EC-C49): while the strategy owns a position `settle` refuses
/// `LIMIT: own position exists` even with an empty DCL account, changes nothing but the lock,
/// and closes once the position is gone.
#[test]
fn settle_refuses_while_an_own_position_exists() {
    let mut s = closing();
    s.own_position = Some("pool#1".to_string());
    settle_ok(&mut s);
    settle_cb(&mut s, vec![ok("{}")]);
    assert_settle_refused(&s, "LIMIT: own position exists");
    assert_eq!(s.own_position.as_deref(), Some("pool#1"));
    // The position is removed; a later settle after the interval closes.
    s.own_position = None;
    let _ = settle_as(
        &mut s,
        "outsider.near",
        NOW + gap(),
        BLOCK + 60,
        MIN_GAS_SETTLE,
    );
    settle_cb(&mut s, vec![ok("{}")]);
    assert_eq!(s.get_status(), Status::Closed);
}

/// S8 gate (EC-C103): a stuck token (3 counted failures over 24 hours) does not block `settle`,
/// a token with fewer failures does; this fails if `settle` ignores the rule.
#[test]
fn settle_ignores_a_stuck_token_but_not_a_failing_one() {
    use crate::limits::DAY_NS;
    let big = (dust("quote") * 10).to_string();
    let body = assets(Some(&big), Some("0"));
    let mut stuck = closing();
    stuck.withdraw_failures[0] = WithdrawFailures {
        count: 3,
        first_ns: 1,
        last_ns: 1 + DAY_NS,
    };
    settle_ok(&mut stuck);
    settle_cb(&mut stuck, vec![ok(&body)]);
    assert_eq!(stuck.get_status(), Status::Closed);
    let mut failing = closing();
    failing.withdraw_failures[0] = WithdrawFailures {
        count: 3,
        first_ns: 1,
        last_ns: DAY_NS,
    };
    settle_ok(&mut failing);
    settle_cb(&mut failing, vec![ok(&body)]);
    assert_settle_refused(&failing, "LIMIT: internal balance left");
}
