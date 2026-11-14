//! Slice 6a unit tests: `exit_withdraw`, its callbacks, the settle window it opens and the
//! stuck-token rule `settle` uses (EC-C73, EC-C74, EC-C103, EC-C133, EC-C152, EC-C169).
use super::tests::*;
use super::tests_claims::closed;
use super::tests_funding::{at, base, last_event, ok, quote};
use super::tests_settle::{closing, gap, run_end, settle_cb, settle_ok};
use super::tests_start::started;
use super::*;
use crate::limits::DAY_NS;
use near_sdk::PromiseResult;

fn grace() -> u64 {
    config().exit_grace_ns.0
}
fn snap(s: &Strategy) -> String {
    near_sdk::serde_json::to_string(&(
        s.get_status(),
        s.get_lock(),
        s.get_stale_resolution_block(),
        s.get_settle_window(),
        s.get_withdraw_failures(),
        s.next_op_id,
        near_sdk::borsh::to_vec(&s.rate_stamps).unwrap(),
    ))
    .unwrap()
}
fn exit_as(s: &mut Strategy, who: &str, ts: u64, block: u64, gas: Gas, token: &str) -> Promise {
    at(who, block, ts, gas);
    s.exit_withdraw(token.to_string())
}
fn cb_env(block: u64, gas: Gas, res: Vec<PromiseResult>) {
    near_sdk::testing_env!(
        ctx(ME, BAL, gas, block).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        res
    );
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
/// The read's callback with the given `list_user_assets` body.
fn assets_cb(s: &mut Strategy, body: &str) {
    let id = s.get_lock().map(|l| l.op_id.0).unwrap_or(99);
    cb_env(BLOCK + 60, GAS_EXIT_READ_CB, vec![ok(body)]);
    s.on_exit_assets(U64(id));
}
fn withdrawn_cb(s: &mut Strategy, block: u64, ts: u64, res: PromiseResult) {
    let id = s.get_lock().map(|l| l.op_id.0).unwrap_or(99);
    let mut b = ctx(ME, BAL, GAS_EXIT_RESULT, block);
    b.block_timestamp(ts);
    near_sdk::testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![res]
    );
    s.on_exit_withdrawn(U64(id));
}
fn quote_assets(amount: u128) -> String {
    format!(r#"{{"{}":"{amount}"}}"#, network().quote_token)
}
fn assert_exit_refused(s: &Strategy, reason: &str) {
    assert_eq!(s.get_lock(), None, "{reason}");
    assert!(calls().is_empty(), "{reason}");
    let e = last_event();
    assert_eq!(e["event"], "exit_withdraw");
    assert_eq!(
        (
            e["data"][0]["ok"].as_bool(),
            e["data"][0]["reason"].as_str()
        ),
        (Some(false), Some(reason))
    );
}

// ---- first checks (EC-C08, EC-C42, EC-C124, EC-C128, EC-C152) ----

fn expect_refusal(
    s: &mut Strategy,
    who: &str,
    ts: u64,
    block: u64,
    gas: Gas,
    token: &str,
    msg: &str,
) {
    let before = snap(s);
    let m = refused(|| {
        let _ = exit_as(s, who, ts, block, gas, token);
    });
    assert_eq!(m, msg, "{who} {ts} {token}");
    assert!(calls().is_empty(), "{msg}");
    assert_eq!(snap(s), before, "{msg}");
}

#[test]
fn exit_withdraw_refusals_in_order() {
    let q = quote();
    let low = Gas::from_gas(MIN_GAS_EXIT.as_gas() - 1);
    let cool = config().stale_cooldown_blocks.0;
    let b = BLOCK + 50;
    // Status first: Open and Cancelled, for anyone, with everything else wrong.
    for st in [Status::Open, Status::Cancelled] {
        let mut s = started();
        s.status = st;
        for who in ["outsider.near", "creator.near", "agent.near"] {
            expect_refusal(&mut s, who, NOW, b, low, "x.near", "LIMIT: wrong status");
        }
    }
    let mut s = started();
    // The token first (principle 5: status, caller, token, time): an outsider before the grace
    // period with a bad token gets the token message; with a good token, the time message, even
    // with low gas; the creator and the agent are allowed at any time (EC-C152).
    for who in ["outsider.near", "platform.near", "deliverer.near", ME] {
        let early = run_end() + grace() - 1;
        expect_refusal(
            &mut s,
            who,
            early,
            b,
            low,
            "x.near",
            "LIMIT: not a pool token",
        );
        expect_refusal(&mut s, who, early, b, low, &q, "LIMIT: exit not open yet");
    }
    // The token before the lock, and the lock before the rate limit, cooldown and gas.
    for t in ["x.near".to_string(), q.to_uppercase(), String::new()] {
        expect_refusal(
            &mut s,
            "agent.near",
            NOW,
            b,
            low,
            &t,
            "LIMIT: not a pool token",
        );
    }
    s.lock = Some(Lock {
        op_id: U64(9),
        op: Op::Settle,
        stage: Stage::ReadAssets,
        promise_block: U64(BLOCK),
    });
    s.stale_resolution_block = Some(b);
    s.rate_stamp(RateMethod::ExitWithdraw, 1, Class::Agent);
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        b,
        low,
        &q,
        "LIMIT: operation pending",
    );
    s.lock = None;
    expect_refusal(
        &mut s,
        "agent.near",
        NOW + gap() - 1,
        b,
        low,
        &q,
        "LIMIT: rate limited",
    );
    expect_refusal(
        &mut s,
        "creator.near",
        NOW,
        b + cool - 1,
        low,
        &q,
        "LIMIT: stale cooldown",
    );
    expect_refusal(&mut s, "creator.near", NOW, b + cool, low, &q, "LIMIT: gas");
    assert!(s.rate_stamps.iter().all(|r| r.class != Class::Creator));
    let _ = exit_as(&mut s, "creator.near", NOW, b + cool, MIN_GAS_EXIT, &q);
    assert!(s.get_lock().is_some());
}

/// EC-C08: outsiders at `run_end + exit_grace - 1 ns` refused, at it allowed, in `Running`,
/// `Closing` and `Closed`; the agent and the creator any time in those statuses (EC-C42).
#[test]
fn outsiders_wait_for_the_grace_period() {
    for make in [started as fn() -> Strategy, closing, closed] {
        let mut s = make();
        let before = snap(&s);
        expect_refusal(
            &mut s,
            "outsider.near",
            run_end() + grace() - 1,
            BLOCK + 50,
            MIN_GAS_EXIT,
            &quote(),
            "LIMIT: exit not open yet",
        );
        assert_eq!(snap(&s), before);
        let _ = exit_as(
            &mut s,
            "outsider.near",
            run_end() + grace(),
            BLOCK + 50,
            MIN_GAS_EXIT,
            &quote(),
        );
        assert!(s.get_lock().is_some());
        let mut s = make();
        for who in ["creator.near", "agent.near"] {
            s.lock = None;
            let _ = exit_as(&mut s, who, NOW, BLOCK + 50, MIN_GAS_EXIT, &quote());
            assert!(s.get_lock().is_some(), "{who}");
        }
    }
}

/// EC-C128: per (token, class) slots: the same class and token inside the interval is rate
/// limited (the other token and the other class are free); allowed at the interval.
#[test]
fn exit_withdraw_is_rate_limited_per_token_and_class() {
    let mut s = started();
    for (who, tok) in [
        ("agent.near", quote()),
        ("agent.near", base()),
        ("creator.near", quote()),
    ] {
        let _ = exit_as(&mut s, who, NOW, BLOCK + 50, MIN_GAS_EXIT, &tok);
        assert!(s.get_lock().is_some(), "{who} {tok}");
        assets_cb(&mut s, "{}"); // nothing to withdraw: frees the lock, keeps the stamp
    }
    for (who, tok) in [
        ("agent.near", quote()),
        ("agent.near", base()),
        ("creator.near", quote()),
    ] {
        expect_refusal(
            &mut s,
            who,
            NOW + gap() - 1,
            BLOCK + 70,
            MIN_GAS_EXIT,
            &tok,
            "LIMIT: rate limited",
        );
        let _ = exit_as(&mut s, who, NOW + gap(), BLOCK + 70, MIN_GAS_EXIT, &tok);
        assert!(s.get_lock().is_some());
        assets_cb(&mut s, "{}");
    }
}

#[test]
fn exit_withdraw_sends_one_read_and_a_callback() {
    let mut seen = vec![];
    let mut s = started();
    for gas in [MIN_GAS_EXIT, Gas::from_tgas(300)] {
        s = started();
        let _ = exit_as(&mut s, "agent.near", NOW, BLOCK + 50, gas, &quote());
        seen.push(calls());
    }
    assert_eq!(
        seen[0], seen[1],
        "forwarded gas does not depend on what was attached"
    );
    let c = &seen[0];
    assert_eq!(c.len(), 2);
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
    assert_eq!(
        (c[1].1.as_str(), c[1].4, c[1].5),
        ("on_exit_assets", GAS_EXIT_READ_CB.as_gas(), 0)
    );
    let l = s.get_lock().unwrap();
    assert_eq!(l.stage, Stage::ReadAssets);
    assert_eq!(
        l.op,
        Op::ExitWithdraw {
            token: acc(&quote()),
            class: Class::Agent
        }
    );
    assert_eq!(last_event()["event"], "exit_withdraw_started");
}

// ---- the read's callback (EC-C73) ----

/// EC-C73: below dust the call writes only an event, sends nothing, releases the lock and counts
/// no failure; the stamp stays; at dust (either token) it withdraws.
#[test]
fn nothing_to_withdraw_below_dust() {
    for (tok, body) in [
        (quote(), quote_assets(dust("quote") - 1)),
        (quote(), "{}".into()),
        (
            base(),
            format!(r#"{{"{}":"{}"}}"#, network().base_token, dust("base") - 1),
        ),
    ] {
        let mut s = started();
        let _ = exit_as(&mut s, "agent.near", NOW, BLOCK + 50, MIN_GAS_EXIT, &tok);
        assets_cb(&mut s, &body);
        assert_exit_refused(&s, "LIMIT: nothing to withdraw");
        assert_eq!(s.get_withdraw_failures(), [WithdrawFailures::default(); 2]);
        assert_eq!(
            s.get_settle_window().settle_until_block.0,
            0,
            "no window for a read that withdrew nothing"
        );
        assert_eq!(s.rate_stamps.len(), 1);
    }
}

#[test]
fn at_dust_it_withdraws_with_the_exact_call() {
    let q = quote();
    for amount in [dust("quote"), dust("quote") + 1, u128::MAX] {
        let mut s = started();
        let _ = exit_as(&mut s, "creator.near", NOW, BLOCK + 50, MIN_GAS_EXIT, &q);
        assets_cb(&mut s, &quote_assets(amount));
        let c = calls();
        assert_eq!(c.len(), 2, "{c:?}");
        assert_eq!(
            (c[0].0.as_str(), c[0].1.as_str(), c[0].3, c[0].4),
            (
                network().dcl_contract.as_str(),
                "withdraw_asset",
                0,
                GAS_WITHDRAW_ASSET.as_gas()
            )
        );
        assert_eq!(
            c[0].2,
            format!(r#"{{"token_id":"{q}","skip_unwrap_near":true}}"#)
        );
        assert_eq!(
            (
                c[1].0.as_str(),
                c[1].1.as_str(),
                c[1].2.as_str(),
                c[1].4,
                c[1].5
            ),
            (
                ME,
                "on_exit_withdrawn",
                r#"{"op_id":"1"}"#,
                GAS_EXIT_RESULT.as_gas(),
                0
            )
        );
        assert_eq!(s.get_lock().unwrap().stage, Stage::Withdraw);
    }
}

/// An unreadable answer, an entry that isn't a strict amount (any token), or a status that left
/// the exit statuses in flight: refused as an event, the lock released, nothing sent.
#[test]
fn the_read_callback_never_panics_or_withdraws_on_bad_answers() {
    let big = format!("{}0", u128::MAX);
    let mut bodies: Vec<String> = [
        "not json",
        "null",
        "[]",
        "5",
        r#"{"x":{"a":"1"}}"#,
        r#"{"other.near":5}"#,
        r#"{"other.near":"007"}"#,
        r#"{"other.near":null}"#,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    for bad in ["+5", "007", "", " 5", "1e3", "-1", &big] {
        bodies.push(quote_assets(1).replace("\"1\"", &format!("\"{bad}\"")));
    }
    bodies.push(format!(
        "{{{}}}",
        (0..400)
            .map(|i| format!(r#""t{i}.near":"1""#))
            .collect::<Vec<_>>()
            .join(",")
    ));
    for body in bodies {
        let mut s = started();
        let _ = exit_as(
            &mut s,
            "agent.near",
            NOW,
            BLOCK + 50,
            MIN_GAS_EXIT,
            &quote(),
        );
        assets_cb(&mut s, &body);
        assert_exit_refused(&s, "LIMIT: read failed");
    }
    for res in [
        vec![PromiseResult::Failed],
        vec![],
        vec![ok("{}"), ok("{}")],
    ] {
        let mut s = started();
        let _ = exit_as(
            &mut s,
            "agent.near",
            NOW,
            BLOCK + 50,
            MIN_GAS_EXIT,
            &quote(),
        );
        cb_env(BLOCK + 60, GAS_EXIT_READ_CB, res);
        s.on_exit_assets(U64(1));
        assert_exit_refused(&s, "LIMIT: read failed");
    }
    // Strict entries for other tokens never matter.
    let mut s = started();
    let _ = exit_as(
        &mut s,
        "agent.near",
        NOW,
        BLOCK + 50,
        MIN_GAS_EXIT,
        &quote(),
    );
    assets_cb(
        &mut s,
        &format!(
            r#"{{"other.near":"999999","{}":"1"}}"#,
            network().quote_token
        ),
    );
    assert_exit_refused(&s, "LIMIT: nothing to withdraw");
    // The status leaving Running/Closing/Closed while the read is out.
    for st in [Status::Open, Status::Cancelled] {
        let mut s = started();
        let _ = exit_as(
            &mut s,
            "agent.near",
            NOW,
            BLOCK + 50,
            MIN_GAS_EXIT,
            &quote(),
        );
        s.status = st;
        assets_cb(&mut s, &quote_assets(u128::MAX));
        assert_exit_refused(&s, "LIMIT: wrong status");
    }
}

// ---- the result: the window and the failure count (EC-C103, EC-C133) ----

/// EC-C133: every result opens the settle window at the callback's block; `true` resets the
/// failures; the class is the caller's; the window is a `max`, never a sum.
#[test]
fn a_result_opens_the_settle_window() {
    let w = PAYOUT_SETTLE_BLOCKS;
    for (res, ok_) in [
        (ok("true"), true),
        (ok("false"), false),
        (PromiseResult::Failed, false),
        (ok("garbage"), false),
    ] {
        let mut s = started();
        let _ = exit_as(
            &mut s,
            "agent.near",
            NOW,
            BLOCK + 50,
            MIN_GAS_EXIT,
            &quote(),
        );
        assets_cb(&mut s, &quote_assets(dust("quote")));
        withdrawn_cb(&mut s, BLOCK + 100, NOW, res);
        let win = s.get_settle_window();
        assert_eq!(
            (
                win.settle_until_block.0,
                win.last_payout_callback_block.0,
                win.settle_window_class
            ),
            (BLOCK + 100 + w, BLOCK + 100, Class::Agent)
        );
        assert_eq!(s.get_lock(), None);
        let e = last_event();
        assert_eq!(
            (e["event"].as_str(), e["data"][0]["ok"].as_bool()),
            (Some("exit_withdraw"), Some(ok_))
        );
        assert!(calls().is_empty());
    }
    // Two overlapping windows keep the later end.
    let mut s = started();
    s.settle_until_block = BLOCK + 100 + w + 500;
    let _ = exit_as(
        &mut s,
        "creator.near",
        NOW,
        BLOCK + 50,
        MIN_GAS_EXIT,
        &quote(),
    );
    assets_cb(&mut s, &quote_assets(dust("quote")));
    withdrawn_cb(&mut s, BLOCK + 100, NOW, ok("true"));
    assert_eq!(
        s.get_settle_window().settle_until_block.0,
        BLOCK + 100 + w + 500
    );
    assert_eq!(s.get_settle_window().settle_window_class, Class::Creator);
    assert_eq!(s.get_last_payout_callback_block().0, BLOCK + 100);
}

/// EC-C103: a `false` counts only when at least `min_action_interval_s` after the last counted one;
/// three counted over at least 24 hours are stuck; a `true` resets; 24 hours minus a nanosecond
/// and two failures are not stuck.
#[test]
fn failed_withdraws_make_a_token_stuck() {
    let g = gap();
    let f = WithdrawFailures::default();
    let mut w = f;
    w.record(100, g);
    w.record(100 + g - 1, g); // too close: not counted
    assert_eq!(w.count, 1);
    w.record(100 + g, g);
    w.record(100 + DAY_NS, g);
    assert_eq!((w.count, w.first_ns, w.last_ns), (3, 100, 100 + DAY_NS));
    assert!(w.stuck(DAY_NS));
    let mut w2 = f;
    for t in [100, 100 + g, 100 + DAY_NS - 1] {
        w2.record(t, g);
    }
    assert_eq!(w2.count, 3);
    assert!(!w2.stuck(DAY_NS), "24 hours minus a nanosecond");
    let mut w3 = f;
    w3.record(100, g);
    w3.record(100 + DAY_NS, g);
    assert!(!w3.stuck(DAY_NS), "two failures");
    // Through the contract: three `false` results over a day, a `true` between resets.
    let mut s = started();
    let times = [NOW, NOW + g, NOW + DAY_NS];
    for (i, t) in times.iter().enumerate() {
        s.lock = None;
        let _ = exit_as(&mut s, "agent.near", *t, BLOCK + 50, MIN_GAS_EXIT, &quote());
        assets_cb(&mut s, &quote_assets(dust("quote")));
        withdrawn_cb(&mut s, BLOCK + 100 + i as u64, *t, ok("false"));
    }
    assert!(s.get_withdraw_failures()[0].stuck(DAY_NS));
    assert!(
        !s.get_withdraw_failures()[1].stuck(DAY_NS),
        "the other token is untouched"
    );
    // A call that reverts every time (a failed receipt, or a result that isn't `true`) counts the
    // same way, so a token whose withdraw always fails still becomes stuck (contract review M1).
    for failed in [true, false] {
        let mut s = started();
        for (i, t) in times.iter().enumerate() {
            s.lock = None;
            let _ = exit_as(&mut s, "agent.near", *t, BLOCK + 50, MIN_GAS_EXIT, &quote());
            assets_cb(&mut s, &quote_assets(dust("quote")));
            let bad = if failed {
                PromiseResult::Failed
            } else {
                ok("garbage")
            };
            withdrawn_cb(&mut s, BLOCK + 100 + i as u64, *t, bad);
            assert_eq!(last_event()["data"][0]["ok"], false);
        }
        assert!(
            s.get_withdraw_failures()[0].stuck(DAY_NS),
            "failed receipt: {failed}"
        );
    }
    s.lock = None;
    let _ = exit_as(
        &mut s,
        "agent.near",
        NOW + DAY_NS + g,
        BLOCK + 200,
        MIN_GAS_EXIT,
        &quote(),
    );
    assets_cb(&mut s, &quote_assets(dust("quote")));
    withdrawn_cb(&mut s, BLOCK + 201, NOW + DAY_NS + g, ok("true"));
    assert_eq!(s.get_withdraw_failures()[0], WithdrawFailures::default());
}

/// EC-C103: a stuck token with a balance at dust no longer blocks `settle`; one failure short, or
/// 24 hours minus a nanosecond, does; the other token still counts.
#[test]
fn settle_ignores_only_a_stuck_token() {
    let q_bal = quote_assets(dust("quote"));
    let g = gap();
    for (failures, closes) in [
        (
            WithdrawFailures {
                count: 3,
                first_ns: 0,
                last_ns: DAY_NS,
            },
            true,
        ),
        (
            WithdrawFailures {
                count: 3,
                first_ns: 0,
                last_ns: DAY_NS - 1,
            },
            false,
        ),
        (
            WithdrawFailures {
                count: 2,
                first_ns: 0,
                last_ns: DAY_NS,
            },
            false,
        ),
        (
            WithdrawFailures {
                count: 9,
                first_ns: 5,
                last_ns: 5 + DAY_NS + g,
            },
            true,
        ),
    ] {
        let mut s = closing();
        s.withdraw_failures[0] = failures;
        settle_ok(&mut s);
        settle_cb(&mut s, vec![ok(&q_bal)]);
        assert_eq!(s.get_status() == Status::Closed, closes, "{failures:?}");
    }
    // The base token's balance still blocks when only the quote token is stuck.
    let mut s = closing();
    s.withdraw_failures[0] = WithdrawFailures {
        count: 3,
        first_ns: 0,
        last_ns: DAY_NS,
    };
    settle_ok(&mut s);
    settle_cb(
        &mut s,
        vec![ok(&format!(
            r#"{{"{}":"{}","{}":"{}"}}"#,
            network().quote_token,
            dust("quote"),
            network().base_token,
            dust("base")
        ))],
    );
    assert_eq!(s.get_status(), Status::Closing);
}

// ---- callbacks and stale ----

#[test]
fn exit_callbacks_act_only_on_their_own_lock() {
    let mut s = started();
    let _ = exit_as(
        &mut s,
        "agent.near",
        NOW,
        BLOCK + 50,
        MIN_GAS_EXIT,
        &quote(),
    );
    let before = snap(&s);
    for who in ["creator.near", "outsider.near", "agent.near"] {
        near_sdk::testing_env!(
            ctx(who, BAL, GAS_EXIT_READ_CB, BLOCK + 60).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![ok("{}")]
        );
        assert_eq!(refused(|| s.on_exit_assets(U64(1))), "AUTH: callback only");
        assert_eq!(
            refused(|| s.on_exit_withdrawn(U64(1))),
            "AUTH: callback only"
        );
    }
    assert_eq!(snap(&s), before);
    cb_env(BLOCK + 60, GAS_EXIT_READ_CB, vec![ok("{}")]);
    s.on_exit_assets(U64(5)); // another op
    s.on_exit_withdrawn(U64(1)); // right op, wrong stage
    assert_eq!(snap(&s), before);
    assert!(calls().is_empty());
}

/// A lost withdraw is resolved by `resolve_stale`: the lock goes, the window opens with the lost
/// operation's class, the cooldown starts, and the late callback is ignored.
#[test]
fn a_lost_exit_withdraw_is_resolved_and_its_late_callback_ignored() {
    let stale = config().stale_after_blocks.0;
    let mut s = started();
    let _ = exit_as(
        &mut s,
        "creator.near",
        NOW,
        BLOCK + 50,
        MIN_GAS_EXIT,
        &quote(),
    );
    assets_cb(&mut s, &quote_assets(dust("quote"))); // withdraw out at BLOCK + 60
    at("outsider.near", BLOCK + 60 + stale, NOW, Gas::from_tgas(10));
    s.resolve_stale();
    assert_eq!(s.get_lock(), None);
    let win = s.get_settle_window();
    assert_eq!(
        (win.settle_until_block.0, win.settle_window_class),
        (BLOCK + 60 + stale + PAYOUT_SETTLE_BLOCKS, Class::Creator)
    );
    let before = snap(&s);
    withdrawn_cb(&mut s, BLOCK + 60 + stale + 1, NOW, ok("true"));
    assert_eq!(snap(&s), before);
    assert_eq!(last_event()["event"], "callback_ignored");
}

/// EC-C74: exits still work in `Closed`, and the window they open keeps `settle` waiting
/// (`LIMIT: settling` at `settle_until_block - 1`, allowed at it).
#[test]
fn an_exit_window_makes_settle_wait() {
    let mut s = closing();
    let _ = exit_as(
        &mut s,
        "creator.near",
        NOW,
        BLOCK + 50,
        MIN_GAS_EXIT,
        &quote(),
    );
    assets_cb(&mut s, &quote_assets(dust("quote")));
    withdrawn_cb(&mut s, BLOCK + 100, NOW, ok("true"));
    let until = BLOCK + 100 + PAYOUT_SETTLE_BLOCKS;
    at("outsider.near", until - 1, NOW + 10 * gap(), MIN_GAS_SETTLE);
    assert_eq!(
        refused(|| {
            let _ = s.settle();
        }),
        "LIMIT: settling"
    );
    let _ = {
        at("outsider.near", until, NOW + 10 * gap(), MIN_GAS_SETTLE);
        s.settle()
    };
    assert!(s.get_lock().is_some());
}

// ---- test audit of slice 6 (H1, L1 to L4) ----

/// H1 (EC-C103): exactly what counts as a failed withdraw and what resets. Only an exact `true`
/// resets and succeeds; an exact `false`, a failed receipt and every other result (an empty body,
/// `1`, `"true"` as a string, `False`, a quoted `"false"`, trailing space, two results) count one
/// failure and are never mistaken for a success; the reason strings are exact.
#[test]
fn every_withdraw_result_is_classified_exactly() {
    let g = gap();
    type R = fn() -> Vec<PromiseResult>;
    let cases: Vec<(&str, R, &str)> = vec![
        ("true", || vec![ok("true")], "ok"),
        ("false", || vec![ok("false")], "withdraw returned false"),
        (
            "failed receipt",
            || vec![PromiseResult::Failed],
            "withdraw failed",
        ),
        ("empty", || vec![ok("")], "withdraw failed"),
        ("one", || vec![ok("1")], "withdraw failed"),
        ("zero", || vec![ok("0")], "withdraw failed"),
        ("string true", || vec![ok("\"true\"")], "withdraw failed"),
        ("string false", || vec![ok("\"false\"")], "withdraw failed"),
        ("False", || vec![ok("False")], "withdraw failed"),
        ("True", || vec![ok("True")], "withdraw failed"),
        ("trailing space", || vec![ok("false ")], "withdraw failed"),
        ("leading space", || vec![ok(" true")], "withdraw failed"),
        ("falsey", || vec![ok("falsey")], "withdraw failed"),
        (
            "two results",
            || vec![ok("true"), ok("true")],
            "withdraw failed",
        ),
        ("no result", Vec::new, "withdraw failed"),
    ];
    for (name, res, want) in cases {
        // From a clean count, and from a count of 2 (so a counted one makes 3 and an uncounted stays 2).
        for start in [0u8, 2] {
            let mut s = started();
            s.withdraw_failures[0] = WithdrawFailures {
                count: start,
                first_ns: if start == 0 { 0 } else { NOW - 2 * DAY_NS },
                last_ns: if start == 0 { 0 } else { NOW - g },
            };
            let before = s.withdraw_failures[0];
            let _ = exit_as(
                &mut s,
                "agent.near",
                NOW,
                BLOCK + 50,
                MIN_GAS_EXIT,
                &quote(),
            );
            assets_cb(&mut s, &quote_assets(dust("quote")));
            let id = s.get_lock().unwrap().op_id.0;
            cb_env(BLOCK + 100, GAS_EXIT_RESULT, res());
            s.on_exit_withdrawn(U64(id));
            let e = last_event();
            let reason = e["data"][0]["reason"].as_str().unwrap_or("ok");
            assert_eq!(
                (e["data"][0]["ok"].as_bool(), reason),
                (Some(want == "ok"), want),
                "{name}"
            );
            let after = s.get_withdraw_failures()[0];
            if want == "ok" {
                assert_eq!(
                    after,
                    WithdrawFailures::default(),
                    "a true resets ({name}, from {start})"
                );
            } else if start == 0 {
                assert_eq!(after.count, 1, "{name}");
            } else {
                assert_eq!(after.count, 3, "{name}: counted");
                assert_eq!(
                    (after.first_ns, after.last_ns),
                    (before.first_ns, NOW),
                    "{name}"
                );
                assert!(after.stuck(DAY_NS), "{name}");
            }
            assert_eq!(
                s.get_withdraw_failures()[1],
                WithdrawFailures::default(),
                "the other token"
            );
            assert_eq!(s.get_lock(), None);
        }
    }
    // Two counted failures are not stuck, and a `true` after one resets.
    let mut s = started();
    s.withdraw_failures[0] = WithdrawFailures {
        count: 2,
        first_ns: 0,
        last_ns: DAY_NS,
    };
    assert!(!s.get_withdraw_failures()[0].stuck(DAY_NS));
}

/// L2, L3: an outsider's exit after the grace period opens the window as an outsider; two exits of
/// different classes closer than the interval count one failure (the gap is shared across classes).
#[test]
fn outsider_exit_class_and_the_shared_failure_gap() {
    let g = gap();
    let late = run_end() + grace();
    let mut s = started();
    let _ = exit_as(
        &mut s,
        "outsider.near",
        late,
        BLOCK + 50,
        MIN_GAS_EXIT,
        &quote(),
    );
    assets_cb(&mut s, &quote_assets(dust("quote")));
    withdrawn_cb(&mut s, BLOCK + 100, late, ok("true"));
    assert_eq!(s.get_settle_window().settle_window_class, Class::Outsider);
    let mut s = started();
    for (who, ts, expected) in [
        ("creator.near", late, 1u8),
        ("agent.near", late + g - 1, 1),
        ("outsider.near", late + 2 * g - 1, 2),
    ] {
        s.lock = None;
        let _ = exit_as(&mut s, who, ts, BLOCK + 50, MIN_GAS_EXIT, &quote());
        assets_cb(&mut s, &quote_assets(dust("quote")));
        withdrawn_cb(&mut s, BLOCK + 100, ts, ok("false"));
        assert_eq!(s.get_withdraw_failures()[0].count, expected, "{who}");
    }
}

/// L4: a duplicate read callback after it already ran is ignored.
#[test]
fn a_duplicate_exit_read_callback_is_ignored() {
    let mut s = started();
    let _ = exit_as(
        &mut s,
        "agent.near",
        NOW,
        BLOCK + 50,
        MIN_GAS_EXIT,
        &quote(),
    );
    assets_cb(&mut s, &quote_assets(dust("quote")));
    let before = snap(&s);
    cb_env(
        BLOCK + 61,
        GAS_EXIT_READ_CB,
        vec![ok(&quote_assets(dust("quote")))],
    );
    s.on_exit_assets(U64(1));
    assert_eq!(snap(&s), before);
    assert!(calls().is_empty());
}
