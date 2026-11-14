//! Slice 3 unit tests: funding, cancel, withdraw and the withdraw lock (EC-C03, EC-C06 for
//! `ft_on_transfer`, EC-C11 for the callbacks, EC-C46, EC-C63, EC-C124, EC-C134, EC-C166).
//! Real gas and the real tokens' answers are for the sandbox tests (slice 3b).
use super::tests::*;
use super::*;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const USDC_UNIT: u128 = 1_000_000;

pub(super) fn quote() -> String {
    network().quote_token
}
pub(super) fn base() -> String {
    network().base_token
}
pub(super) fn cap() -> u128 {
    limits_args().max_principal.0
}
/// `ft_on_transfer` as `token` at `block`, in the given state.
pub(super) fn inbound(
    s: &mut Strategy,
    token: &str,
    sender: &str,
    amount: u128,
    msg: &str,
    block: u64,
) -> u128 {
    testing_env!(ctx(token, BAL, Gas::from_tgas(30), block).build());
    s.ft_on_transfer(acc(sender), U128(amount), msg.to_string())
        .0
}
pub(super) fn fund(s: &mut Strategy, amount: u128) -> u128 {
    inbound(s, &quote(), "creator.near", amount, FUND_MSG, BLOCK)
}
pub(super) fn at(pred: &str, block: u64, ts: u64, gas: Gas) {
    let mut b = ctx(pred, BAL, gas, block);
    b.block_timestamp(ts);
    testing_env!(b.build());
}
fn cancelled() -> Strategy {
    let mut s = deployed();
    at("creator.near", BLOCK, NOW, Gas::from_tgas(10));
    s.cancel();
    s
}
fn withdraw_at(s: &mut Strategy, token: &str, block: u64) {
    at("creator.near", block, NOW, MIN_GAS_WITHDRAW);
    let _ = s.withdraw(token.to_string());
}
/// A callback run by the contract itself with the given promise results.
pub(super) fn as_callback(block: u64, res: Vec<PromiseResult>) {
    testing_env!(
        ctx(ME, BAL, GAS_ON_BALANCE, block).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        res
    );
}
pub(super) fn ok(body: &str) -> PromiseResult {
    PromiseResult::Successful(body.as_bytes().to_vec())
}
pub(super) fn events() -> Vec<near_sdk::serde_json::Value> {
    near_sdk::test_utils::get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| near_sdk::serde_json::from_str(j).unwrap())
        .collect()
}
pub(super) fn last_event() -> near_sdk::serde_json::Value {
    let e = events().pop().expect("an event");
    assert_eq!(e["standard"], "poolside");
    assert_eq!(e["version"], "1.0.0");
    e
}
/// Everything a refusal must leave unchanged.
pub(super) fn snapshot(s: &Strategy) -> String {
    near_sdk::serde_json::to_string(&(
        s.get_status(),
        s.get_principal(),
        s.get_lock(),
        s.get_last_inbound_block(),
        s.get_stale_resolution_block(),
        s.get_registrations(),
        s.next_op_id,
    ))
    .unwrap()
}

// ---- ft_on_transfer (EC-C03, EC-C06, EC-C134) ----

/// EC-C03: the creator's fund at the cap and one above credits exactly the cap; the excess is
/// returned and sets `last_inbound_block`; a second fund at the cap is returned in full.
#[test]
fn fund_is_credited_up_to_the_cap_and_the_excess_returned() {
    let mut s = deployed();
    assert_eq!(fund(&mut s, cap()), 0);
    assert_eq!(s.get_principal().0, cap());
    assert_eq!(
        s.get_last_inbound_block().0,
        0,
        "a zero return sets nothing"
    );
    let e = last_event();
    assert_eq!(e["event"], "inbound");
    assert_eq!(e["data"][0]["credited"], cap().to_string());
    assert_eq!(e["data"][0]["returned"], "0");

    let mut s = deployed();
    assert_eq!(fund(&mut s, cap() + 1), 1);
    assert_eq!(s.get_principal().0, cap());
    assert_eq!(s.get_last_inbound_block().0, BLOCK);

    // A second fund once at the cap: returned in full.
    assert_eq!(
        inbound(&mut s, &quote(), "creator.near", 7, FUND_MSG, BLOCK + 3),
        7
    );
    assert_eq!(s.get_principal().0, cap());
    assert_eq!(s.get_last_inbound_block().0, BLOCK + 3);
}

/// EC-C03: a partial fund (`principal = max - 1`, fund 2) credits 1 and returns 1.
#[test]
fn a_partial_fund_credits_the_room_left() {
    let mut s = deployed();
    assert_eq!(fund(&mut s, cap() - 1), 0);
    assert_eq!(fund(&mut s, 2), 1);
    assert_eq!(s.get_principal().0, cap());
    assert_eq!(fund(&mut s, 1), 1);
}

/// EC-C03, EC-C06: a fund of `u128::MAX` saturates: the cap credited, the rest returned.
#[test]
fn a_fund_of_u128_max_never_overflows() {
    let mut s = deployed();
    assert_eq!(fund(&mut s, 5), 0);
    assert_eq!(fund(&mut s, u128::MAX), u128::MAX - (cap() - 5));
    assert_eq!(s.get_principal().0, cap());
    assert_eq!(fund(&mut s, u128::MAX), u128::MAX);
}

/// EC-C03: a wrong token, sender or `msg` in `Open` is returned in full and credits nothing;
/// each non-zero return sets `last_inbound_block`.
#[test]
fn every_other_transfer_in_open_is_returned_in_full() {
    let cases: [(String, &str, &str); 6] = [
        (base(), "creator.near", FUND_MSG),
        (quote(), "outsider.near", FUND_MSG),
        (quote(), "agent.near", FUND_MSG),
        (quote(), "creator.near", ""),
        (quote(), "creator.near", "Fund"),
        (quote(), "creator.near", "fund "),
    ];
    for (i, (token, sender, msg)) in cases.iter().enumerate() {
        let mut s = deployed();
        let block = BLOCK + 1 + i as u64;
        assert_eq!(
            inbound(&mut s, token, sender, 3 * USDC_UNIT, msg, block),
            3 * USDC_UNIT,
            "{i}"
        );
        assert_eq!(s.get_principal().0, 0, "{i}");
        assert_eq!(s.get_last_inbound_block().0, block, "{i}");
        assert_eq!(last_event()["data"][0]["credited"], "0");
    }
}

/// EC-C03: a 4 KB `msg` is compared and returned, never panics.
#[test]
fn a_4_kb_msg_is_returned() {
    let mut s = deployed();
    let msg = "f".repeat(4_096);
    assert_eq!(inbound(&mut s, &quote(), "creator.near", 9, &msg, BLOCK), 9);
    assert_eq!(s.get_principal().0, 0);
}

/// EC-C134: a predecessor that isn't a pool token is returned in full in every status, nothing
/// written (no event either), `last_inbound_block` not set.
#[test]
fn a_non_pool_token_is_returned_in_full_in_every_status() {
    for status in [Status::Open, Status::Cancelled] {
        let mut s = deployed();
        s.status = status;
        let before = snapshot(&s);
        for token in [
            "other-token.near",
            "creator.near",
            "usdc.near",
            "dcl.test.near",
        ] {
            if token == quote() || token == base() {
                continue;
            }
            assert_eq!(
                inbound(&mut s, token, "creator.near", 50, FUND_MSG, BLOCK + 9),
                50
            );
            assert!(events().is_empty(), "{token}");
        }
        assert_eq!(snapshot(&s), before);
    }
}

/// EC-C03, EC-C134: outside `Open` every pool-token transfer is kept (returns 0), `principal`
/// unchanged, and it doesn't set `last_inbound_block`, so `withdraw` isn't delayed by it.
#[test]
fn outside_open_pool_token_transfers_are_kept() {
    let mut s = cancelled();
    for (token, sender, msg) in [
        (quote(), "creator.near", FUND_MSG),
        (base(), "outsider.near", ""),
        (quote(), "outsider.near", "x"),
    ] {
        assert_eq!(inbound(&mut s, &token, sender, 1, msg, BLOCK + 10), 0);
        assert_eq!(last_event()["data"][0]["credited"], "0");
    }
    assert_eq!(
        inbound(
            &mut s,
            &quote(),
            "creator.near",
            u128::MAX,
            FUND_MSG,
            BLOCK + 11
        ),
        0
    );
    assert_eq!(s.get_principal().0, 0);
    assert_eq!(s.get_last_inbound_block().0, 0);
}

// ---- cancel (EC-C63, EC-C166) ----

/// EC-C166: the creator cancels in `Open` any time; an outsider only from `start_deadline`
/// (one nanosecond before: refused, nothing changed).
#[test]
fn cancel_by_the_creator_and_by_anyone_from_the_deadline() {
    let mut s = deployed();
    at("creator.near", BLOCK, NOW, Gas::from_tgas(10));
    s.cancel();
    assert_eq!(s.get_status(), Status::Cancelled);
    let e = last_event();
    assert_eq!(e["event"], "cancel");
    assert_eq!(e["data"][0]["by"], "creator.near");

    let deadline = config().start_deadline_ns.0;
    let mut s = deployed();
    let before = snapshot(&s);
    for who in ["outsider.near", "agent.near", "platform.near", ME] {
        at(who, BLOCK, deadline - 1, Gas::from_tgas(10));
        assert_eq!(
            refused(|| s.cancel()),
            "AUTH: creator only before start deadline"
        );
        assert_eq!(snapshot(&s), before);
    }
    at("outsider.near", BLOCK, deadline, Gas::from_tgas(10));
    s.cancel();
    assert_eq!(s.get_status(), Status::Cancelled);
    assert_eq!(last_event()["data"][0]["by"], "outsider.near");
}

/// EC-C166: `cancel` outside `Open` is refused `LIMIT: wrong status`, before the caller check.
#[test]
fn cancel_twice_is_refused() {
    let mut s = cancelled();
    let before = snapshot(&s);
    for who in ["creator.near", "outsider.near"] {
        at(who, BLOCK, NOW, Gas::from_tgas(10));
        assert_eq!(refused(|| s.cancel()), "LIMIT: wrong status");
    }
    assert_eq!(snapshot(&s), before);
}

/// EC-C63: `cancel` is refused while the lock is held.
#[test]
fn cancel_is_refused_while_locked() {
    let mut s = deployed();
    s.lock = Some(Lock {
        op_id: U64(0),
        op: Op::Withdraw {
            token: acc(&quote()),
        },
        stage: Stage::ReadBalance,
        promise_block: U64(BLOCK),
    });
    let before = snapshot(&s);
    at("creator.near", BLOCK, NOW, Gas::from_tgas(10));
    assert_eq!(refused(|| s.cancel()), "LIMIT: operation pending");
    assert_eq!(snapshot(&s), before);
}

// ---- withdraw (EC-C46, EC-C124) ----

/// EC-C46: a withdraw takes the lock, reads the balance with exactly this call, then pays the
/// creator the whole balance with exactly this `ft_transfer`, and releases the lock.
#[test]
fn withdraw_reads_then_pays_the_whole_balance() {
    let mut s = cancelled();
    withdraw_at(&mut s, &quote(), BLOCK + 50);
    let lock = s.get_lock().unwrap();
    assert_eq!(lock.op_id.0, 0);
    assert_eq!(
        lock.op,
        Op::Withdraw {
            token: acc(&quote())
        }
    );
    assert_eq!(lock.stage, Stage::ReadBalance);
    assert_eq!(lock.promise_block.0, BLOCK + 50);
    assert_eq!(last_event()["event"], "withdraw_started");
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(
        (c[0].0.as_str(), c[0].1.as_str(), c[0].3, c[0].4),
        (quote().as_str(), "ft_balance_of", 0, GAS_VIEW.as_gas())
    );
    assert_eq!(c[0].2, format!(r#"{{"account_id":"{ME}"}}"#));
    assert_eq!(
        (c[1].0.as_str(), c[1].1.as_str()),
        (ME, "on_withdraw_balance")
    );
    assert_eq!((c[1].4, c[1].5), (GAS_ON_BALANCE.as_gas(), 0));

    as_callback(BLOCK + 51, vec![ok("\"1234567\"")]);
    s.on_withdraw_balance(U64(0));
    let lock = s.get_lock().unwrap();
    assert_eq!(
        (lock.stage, lock.promise_block.0),
        (Stage::Transfer, BLOCK + 51)
    );
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(
        (c[0].0.as_str(), c[0].1.as_str(), c[0].3, c[0].4),
        (quote().as_str(), "ft_transfer", 1, GAS_FT_TRANSFER.as_gas())
    );
    assert_eq!(
        c[0].2,
        r#"{"receiver_id":"creator.near","amount":"1234567"}"#
    );
    assert_eq!((c[1].0.as_str(), c[1].1.as_str()), (ME, "on_withdrawn"));
    assert_eq!((c[1].4, c[1].5), (GAS_CALLBACK.as_gas(), 0));

    as_callback(BLOCK + 52, vec![ok("")]);
    s.on_withdrawn(U64(0), U128(1_234_567));
    assert_eq!(s.get_lock(), None);
    assert!(calls().is_empty());
    let e = last_event();
    assert_eq!(e["event"], "withdraw");
    assert_eq!(e["data"][0]["ok"], true);
    assert_eq!(e["data"][0]["amount"], "1234567");

    // Repeatable, for either token: the next op_id.
    withdraw_at(&mut s, &base(), BLOCK + 60);
    assert_eq!(s.get_lock().unwrap().op_id.0, 1);
}

/// EC-C46: a failed transfer changes nothing but releasing the lock; the next withdraw pays.
#[test]
fn a_failed_transfer_releases_the_lock_and_can_be_retried() {
    let mut s = cancelled();
    withdraw_at(&mut s, &quote(), BLOCK + 50);
    as_callback(BLOCK + 51, vec![ok("\"10\"")]);
    s.on_withdraw_balance(U64(0));
    as_callback(BLOCK + 52, vec![PromiseResult::Failed]);
    s.on_withdrawn(U64(0), U128(10));
    assert_eq!(s.get_lock(), None);
    assert_eq!(last_event()["data"][0]["ok"], false);
    assert_eq!(s.get_status(), Status::Cancelled);
    withdraw_at(&mut s, &quote(), BLOCK + 53);
    assert!(s.get_lock().is_some());
}

/// EC-C46: a zero balance releases the lock with `nothing to withdraw` and sends nothing; an
/// unreadable or non-strict answer releases it with `balance read failed` (principle 10).
#[test]
fn a_zero_or_unreadable_balance_sends_nothing() {
    let cases: Vec<(Vec<PromiseResult>, &str)> = vec![
        (vec![ok("\"0\"")], "nothing to withdraw"),
        (vec![PromiseResult::Failed], "balance read failed"),
        (vec![], "balance read failed"),
        (vec![ok("\"1\""), ok("\"1\"")], "balance read failed"),
        (vec![ok("1")], "balance read failed"),
        (vec![ok("\"01\"")], "balance read failed"),
        (vec![ok("\"+1\"")], "balance read failed"),
        (vec![ok("\"-1\"")], "balance read failed"),
        (vec![ok("\" 1\"")], "balance read failed"),
        (vec![ok("\"1e3\"")], "balance read failed"),
        (vec![ok("\"\"")], "balance read failed"),
        (vec![ok("null")], "balance read failed"),
        (
            vec![ok("\"340282366920938463463374607431768211456\"")],
            "balance read failed",
        ),
        (
            vec![ok(&format!("\"{}\"", "1".repeat(5_000)))],
            "balance read failed",
        ),
    ];
    for (i, (res, reason)) in cases.into_iter().enumerate() {
        let mut s = cancelled();
        withdraw_at(&mut s, &quote(), BLOCK + 50);
        as_callback(BLOCK + 51, res);
        s.on_withdraw_balance(U64(0));
        assert_eq!(s.get_lock(), None, "{i}");
        assert!(calls().is_empty(), "{i}");
        let e = last_event();
        assert_eq!(
            (e["event"].as_str(), e["data"][0]["reason"].as_str()),
            (Some("withdraw"), Some(reason)),
            "{i}"
        );
    }
}

/// EC-C46, EC-C06: the largest balance is paid exactly.
#[test]
fn a_u128_max_balance_is_paid_exactly() {
    let mut s = cancelled();
    withdraw_at(&mut s, &base(), BLOCK + 50);
    as_callback(BLOCK + 51, vec![ok(&format!("\"{}\"", u128::MAX))]);
    s.on_withdraw_balance(U64(0));
    assert_eq!(
        calls()[0].2,
        format!(
            r#"{{"receiver_id":"creator.near","amount":"{}"}}"#,
            u128::MAX
        )
    );
}

/// EC-C46: `QUIET_INBOUND_BLOCKS - 1` after a refund made in `Open`: refused; at it: allowed.
#[test]
fn withdraw_waits_quiet_inbound_blocks_after_a_refund() {
    assert_eq!(QUIET_INBOUND_BLOCKS, OFFCHAIN_MARGIN_BLOCKS);
    let mut s = deployed();
    assert_eq!(fund(&mut s, cap() + 1), 1);
    at("creator.near", BLOCK, NOW, Gas::from_tgas(10));
    s.cancel();
    let before = snapshot(&s);
    at(
        "creator.near",
        BLOCK + QUIET_INBOUND_BLOCKS - 1,
        NOW,
        MIN_GAS_WITHDRAW,
    );
    assert_eq!(
        refused(|| {
            let _ = s.withdraw(quote());
        }),
        "LIMIT: inbound transfer settling"
    );
    assert_eq!(snapshot(&s), before);
    withdraw_at(&mut s, &quote(), BLOCK + QUIET_INBOUND_BLOCKS);
    assert!(s.get_lock().is_some());
}

/// EC-C46, EC-C166: refusals in principle 5's order, each with nothing changed.
#[test]
fn withdraw_refusals_in_order() {
    // Status first: in `Open`, even an outsider with a bad token gets `LIMIT: wrong status`.
    let mut s = deployed();
    let before = snapshot(&s);
    at("outsider.near", BLOCK + 100, NOW, MIN_GAS_WITHDRAW);
    assert_eq!(
        refused(|| {
            let _ = s.withdraw("x".into());
        }),
        "LIMIT: wrong status"
    );
    at("creator.near", BLOCK + 100, NOW, MIN_GAS_WITHDRAW);
    assert_eq!(
        refused(|| {
            let _ = s.withdraw(quote());
        }),
        "LIMIT: wrong status"
    );
    assert_eq!(snapshot(&s), before);

    let mut s = cancelled();
    let before = snapshot(&s);
    // The caller before the token, the gas and everything else.
    for who in [
        "outsider.near",
        "agent.near",
        "platform.near",
        "deliverer.near",
        ME,
    ] {
        at(who, BLOCK, NOW, Gas::from_tgas(1));
        assert_eq!(
            refused(|| {
                let _ = s.withdraw("x".into());
            }),
            "AUTH: creator only",
            "{who}"
        );
    }
    // EC-C124: a third token, other letter case, an empty string, the DCL contract.
    for t in [
        "other.near".to_string(),
        quote().to_uppercase(),
        String::new(),
        network().dcl_contract,
        format!("{} ", quote()),
    ] {
        at("creator.near", BLOCK + 100, NOW, MIN_GAS_WITHDRAW);
        assert_eq!(
            refused(|| {
                let _ = s.withdraw(t.clone());
            }),
            "LIMIT: not a pool token",
            "{t}"
        );
    }
    // Gas last: at `MIN_GAS_WITHDRAW` allowed, one gas unit below refused.
    at(
        "creator.near",
        BLOCK + 100,
        NOW,
        Gas::from_gas(MIN_GAS_WITHDRAW.as_gas() - 1),
    );
    assert_eq!(
        refused(|| {
            let _ = s.withdraw(quote());
        }),
        "LIMIT: gas"
    );
    assert_eq!(snapshot(&s), before);
    withdraw_at(&mut s, &quote(), BLOCK + 100);

    // A second withdraw while the first holds the lock (either token).
    let before = snapshot(&s);
    for t in [quote(), base()] {
        at("creator.near", BLOCK + 101, NOW, MIN_GAS_WITHDRAW);
        assert_eq!(
            refused(|| {
                let _ = s.withdraw(t.clone());
            }),
            "LIMIT: operation pending"
        );
    }
    assert_eq!(snapshot(&s), before);
}

// ---- callbacks (EC-C11, EC-C166) ----

/// EC-C11: a callback by anyone but the contract is refused `AUTH: callback only`.
#[test]
fn callbacks_refuse_outsiders() {
    let mut s = cancelled();
    withdraw_at(&mut s, &quote(), BLOCK + 50);
    let before = snapshot(&s);
    for who in ["creator.near", "outsider.near", &quote()] {
        testing_env!(
            ctx(who, BAL, Gas::from_tgas(40), BLOCK + 51).build(),
            near_sdk::test_vm_config(),
            RuntimeFeesConfig::test(),
            Default::default(),
            vec![ok("\"5\"")]
        );
        assert_eq!(
            refused(|| s.on_withdraw_balance(U64(0))),
            "AUTH: callback only"
        );
        assert_eq!(
            refused(|| s.on_withdrawn(U64(0), U128(5))),
            "AUTH: callback only"
        );
    }
    assert_eq!(snapshot(&s), before);
}

/// EC-C166: a callback for another op_id or another stage does nothing but log
/// `callback_ignored`: a late callback after `resolve_stale` can't pay or release a new lock.
#[test]
fn callbacks_for_another_operation_or_stage_are_ignored() {
    let mut s = cancelled();
    withdraw_at(&mut s, &quote(), BLOCK + 50);
    let before = snapshot(&s);
    as_callback(BLOCK + 51, vec![ok("\"5\"")]);
    s.on_withdraw_balance(U64(7));
    s.on_withdrawn(U64(0), U128(5)); // right op, wrong stage
    assert!(calls().is_empty());
    assert_eq!(snapshot(&s), before);
    let ev = events();
    assert_eq!(ev.len(), 2);
    assert!(ev.iter().all(|e| e["event"] == "callback_ignored"));

    // With no lock at all.
    let mut s = cancelled();
    let before = snapshot(&s);
    as_callback(BLOCK + 51, vec![ok("\"5\"")]);
    s.on_withdraw_balance(U64(0));
    s.on_withdrawn(U64(0), U128(5));
    assert_eq!(snapshot(&s), before);
}

// ---- resolve_stale (EC-C166) ----

/// EC-C166: a lost callback can't hold the tokens for ever. `resolve_stale` is refused with no
/// lock and one block before `stale_after_blocks`; at it, anyone releases the lock; `withdraw`
/// then waits `stale_cooldown_blocks`; the lost callback arriving late is ignored.
#[test]
fn resolve_stale_releases_a_lost_withdraw() {
    let stale = config().stale_after_blocks.0;
    let cool = config().stale_cooldown_blocks.0;
    let mut s = cancelled();
    at("outsider.near", BLOCK + 1, NOW, Gas::from_tgas(10));
    assert_eq!(refused(|| s.resolve_stale()), "LIMIT: nothing in flight");

    withdraw_at(&mut s, &quote(), BLOCK + 50);
    as_callback(BLOCK + 60, vec![ok("\"5\"")]);
    s.on_withdraw_balance(U64(0)); // the transfer goes out at BLOCK + 60, then its callback is lost
    let before = snapshot(&s);
    at(
        "outsider.near",
        BLOCK + 60 + stale - 1,
        NOW,
        Gas::from_tgas(10),
    );
    assert_eq!(refused(|| s.resolve_stale()), "LIMIT: not stale yet");
    assert_eq!(snapshot(&s), before);

    let r = BLOCK + 60 + stale;
    at("outsider.near", r, NOW, Gas::from_tgas(10));
    s.resolve_stale();
    assert_eq!(s.get_lock(), None);
    assert_eq!(s.get_stale_resolution_block(), Some(U64(r)));
    let e = last_event();
    assert_eq!(e["event"], "stale_resolution");
    assert_eq!(e["data"][0]["stage"], "Transfer");
    // With nothing in flight the call is refused at its first check, rate limit or not (no stamp);
    // the rate limit itself is tested with a stale lock in `tests_settle` (EC-C128).
    let gap = limits_args().min_action_interval_s.0 * 1_000_000_000;
    for ts in [NOW, NOW + gap - 1, NOW + gap] {
        at("outsider.near", r, ts, Gas::from_tgas(10));
        assert_eq!(refused(|| s.resolve_stale()), "LIMIT: nothing in flight");
    }

    // The cooldown: one block early refused, at it allowed.
    let before = snapshot(&s);
    at("creator.near", r + cool - 1, NOW, MIN_GAS_WITHDRAW);
    assert_eq!(
        refused(|| {
            let _ = s.withdraw(quote());
        }),
        "LIMIT: stale cooldown"
    );
    assert_eq!(snapshot(&s), before);
    withdraw_at(&mut s, &quote(), r + cool);
    assert_eq!(s.get_lock().unwrap().op_id.0, 1);

    // The lost transfer's callback lands now: ignored, the new lock untouched.
    let before = snapshot(&s);
    as_callback(r + cool + 1, vec![ok("")]);
    s.on_withdrawn(U64(0), U128(5));
    assert_eq!(snapshot(&s), before);
    assert_eq!(last_event()["event"], "callback_ignored");
}

/// EC-C166: a lost balance read is resolved the same way, counted from its own launch.
#[test]
fn resolve_stale_counts_from_the_promise_in_flight() {
    let stale = config().stale_after_blocks.0;
    let mut s = cancelled();
    withdraw_at(&mut s, &base(), BLOCK + 50);
    at(
        "creator.near",
        BLOCK + 50 + stale - 1,
        NOW,
        Gas::from_tgas(10),
    );
    assert_eq!(refused(|| s.resolve_stale()), "LIMIT: not stale yet");
    at("creator.near", BLOCK + 50 + stale, NOW, Gas::from_tgas(10));
    s.resolve_stale();
    assert_eq!(last_event()["data"][0]["stage"], "ReadBalance");
}

// ---- parse_balance (principle 10) ----

#[test]
fn parse_balance_is_strict() {
    assert_eq!(parse_balance(b"\"0\""), Some(0));
    assert_eq!(parse_balance(b"\"10\""), Some(10));
    assert_eq!(
        parse_balance(format!("\"{}\"", u128::MAX).as_bytes()),
        Some(u128::MAX)
    );
    for bad in [
        "0", "\"00\"", "\"007\"", "\"\"", "\"1", "1\"", "\"0x1\"", "\"1.0\"", " \"1\"", "\"1\" ",
        "\"٣\"",
    ] {
        assert_eq!(parse_balance(bad.as_bytes()), None, "{bad}");
    }
}

proptest::proptest! {
    /// EC-C03, EC-C06: for any funding sequence, `principal` never exceeds the cap, every
    /// transfer is split exactly into credited + returned, and nothing panics.
    #[test]
    fn funding_never_exceeds_the_cap(amounts in proptest::collection::vec(proptest::num::u128::ANY, 1..8)) {
        let mut s = deployed();
        for a in amounts {
            let before = s.get_principal().0;
            let returned = fund(&mut s, a);
            let after = s.get_principal().0;
            proptest::prop_assert!(after <= cap());
            proptest::prop_assert_eq!(after - before + returned, a);
        }
    }

    #[test]
    fn parse_balance_round_trips(v in proptest::num::u128::ANY) {
        proptest::prop_assert_eq!(parse_balance(format!("\"{v}\"").as_bytes()), Some(v));
    }
}

// ---- audit follow-ups (test audit M1, M2, L2 to L7) ----

/// A held withdraw lock at `stage` for op 0, promise launched at `b`.
fn hold(s: &mut Strategy, stage: Stage, b: u64) {
    s.lock = Some(Lock {
        op_id: U64(0),
        op: Op::Withdraw {
            token: acc(&quote()),
        },
        stage,
        promise_block: U64(b),
    });
    s.next_op_id = 1;
}

/// EC-C166 (test audit M1): with two conditions failing at once, the earlier one in principle
/// 5's order is reported: token, settling, lock, cooldown, gas. Nothing changed.
#[test]
fn withdraw_reports_the_earlier_of_two_failing_checks() {
    let low = Gas::from_gas(MIN_GAS_WITHDRAW.as_gas() - 1);
    let settled = BLOCK + QUIET_INBOUND_BLOCKS;
    let cool = config().stale_cooldown_blocks.0;
    // bad token + low gas; bad token + settling
    let mut s = cancelled();
    s.last_inbound_block = BLOCK;
    let before = snapshot(&s);
    at("creator.near", settled, NOW, low);
    assert_eq!(
        refused(|| {
            let _ = s.withdraw("x".into());
        }),
        "LIMIT: not a pool token"
    );
    assert_eq!(snapshot(&s), before);
    at("creator.near", settled - 1, NOW, MIN_GAS_WITHDRAW);
    assert_eq!(
        refused(|| {
            let _ = s.withdraw("x".into());
        }),
        "LIMIT: not a pool token"
    );
    assert_eq!(snapshot(&s), before);
    // settling + locked
    hold(&mut s, Stage::ReadBalance, BLOCK);
    let before_locked = snapshot(&s);
    at("creator.near", settled - 1, NOW, MIN_GAS_WITHDRAW);
    assert_eq!(
        refused(|| {
            let _ = s.withdraw(quote());
        }),
        "LIMIT: inbound transfer settling"
    );
    assert_eq!(snapshot(&s), before_locked);
    // locked + cooldown
    s.stale_resolution_block = Some(settled);
    let before_cool = snapshot(&s);
    at("creator.near", settled, NOW, MIN_GAS_WITHDRAW);
    assert_eq!(
        refused(|| {
            let _ = s.withdraw(quote());
        }),
        "LIMIT: operation pending"
    );
    assert_eq!(snapshot(&s), before_cool);
    // cooldown + low gas
    s.lock = None;
    let before_free = snapshot(&s);
    at("creator.near", settled + cool - 1, NOW, low);
    assert_eq!(
        refused(|| {
            let _ = s.withdraw(quote());
        }),
        "LIMIT: stale cooldown"
    );
    assert_eq!(snapshot(&s), before_free);
}

/// EC-C166 (test audit M2): a late callback of op 0 is ignored while op 1 holds the lock at the
/// same stage, so it can't release op 1's lock while op 1's transfer is in flight.
#[test]
fn a_late_callback_of_another_op_at_the_same_stage_is_ignored() {
    let stale = config().stale_after_blocks.0;
    let cool = config().stale_cooldown_blocks.0;
    let mut s = cancelled();
    withdraw_at(&mut s, &quote(), BLOCK + 50);
    as_callback(BLOCK + 51, vec![ok("\"5\"")]);
    s.on_withdraw_balance(U64(0)); // op 0 at Transfer, then its callback is lost
    let r = BLOCK + 51 + stale;
    at("outsider.near", r, NOW, Gas::from_tgas(10));
    s.resolve_stale();
    // op 1 sits at ReadBalance: a callback naming op 0 at that stage (a synthetic check of the
    // op_id guard; op 0's real late callback is the transfer one below) is ignored.
    withdraw_at(&mut s, &quote(), r + cool);
    let before = snapshot(&s);
    as_callback(r + cool + 1, vec![ok("\"5\"")]);
    s.on_withdraw_balance(U64(0));
    assert!(calls().is_empty());
    assert_eq!(last_event()["event"], "callback_ignored");
    assert_eq!(snapshot(&s), before);
    // op 1 reaches Transfer: op 0's late transfer callback is ignored.
    as_callback(r + cool + 2, vec![ok("\"5\"")]);
    s.on_withdraw_balance(U64(1));
    let before = snapshot(&s);
    assert_eq!(s.get_lock().unwrap().stage, Stage::Transfer);
    as_callback(r + cool + 3, vec![ok("")]);
    s.on_withdrawn(U64(0), U128(5));
    assert!(calls().is_empty());
    assert_eq!(last_event()["event"], "callback_ignored");
    assert_eq!(snapshot(&s), before);
}

/// EC-C46 (test audit L2): withdrawn twice; a later arrival is paid by the next call in full.
#[test]
fn a_later_arrival_is_paid_by_the_next_withdraw() {
    let mut s = cancelled();
    for (i, bal) in ["7", "42"].iter().enumerate() {
        let b = BLOCK + 50 + 10 * i as u64;
        withdraw_at(&mut s, &quote(), b);
        as_callback(b + 1, vec![ok(&format!("\"{bal}\""))]);
        s.on_withdraw_balance(U64(i as u64));
        assert_eq!(
            calls()[0].2,
            format!(r#"{{"receiver_id":"creator.near","amount":"{bal}"}}"#)
        );
        as_callback(b + 2, vec![ok("")]);
        s.on_withdrawn(U64(i as u64), U128(bal.parse().unwrap()));
        assert_eq!(s.get_lock(), None);
        let e = last_event();
        assert_eq!(
            (e["event"].as_str(), e["data"][0]["ok"].as_bool()),
            (Some("withdraw"), Some(true))
        );
        assert_eq!(e["data"][0]["amount"], *bal);
        // A transfer kept in Cancelled between the two (EC-C134): no delay.
        assert_eq!(inbound(&mut s, &quote(), "outsider.near", 1, "", b + 3), 0);
    }
}

/// EC-C134 (test audit L3): a kept transfer in `Cancelled` doesn't delay `withdraw`.
#[test]
fn a_kept_transfer_does_not_delay_withdraw() {
    let mut s = cancelled();
    assert_eq!(
        inbound(&mut s, &base(), "outsider.near", 1, "", BLOCK + 20),
        0
    );
    assert_eq!(s.get_last_inbound_block().0, 0);
    withdraw_at(&mut s, &base(), BLOCK + 21);
    let l = s.get_lock().unwrap();
    assert_eq!((l.op_id.0, l.stage), (0, Stage::ReadBalance));
    assert_eq!(
        l.op,
        Op::Withdraw {
            token: acc(&base())
        }
    );
}

/// EC-C166 (test audit L4): with no lock, callbacks send nothing and log `callback_ignored`.
#[test]
fn callbacks_with_no_lock_send_nothing() {
    let mut s = cancelled();
    let before = snapshot(&s);
    as_callback(BLOCK + 51, vec![ok("\"5\"")]);
    s.on_withdraw_balance(U64(0));
    s.on_withdrawn(U64(0), U128(5));
    assert!(calls().is_empty());
    let ev = events();
    assert_eq!(ev.len(), 2);
    assert!(ev.iter().all(|e| e["event"] == "callback_ignored"));
    assert_eq!(snapshot(&s), before);
}

/// EC-C166 (test audit L5): the refusal with no lock changes nothing; the stale event names
/// the operation in full.
#[test]
fn resolve_stale_event_and_refusal_in_full() {
    let mut s = cancelled();
    let before = snapshot(&s);
    at("outsider.near", BLOCK + 1, NOW, Gas::from_tgas(10));
    assert_eq!(refused(|| s.resolve_stale()), "LIMIT: nothing in flight");
    assert_eq!(snapshot(&s), before);
    withdraw_at(&mut s, &base(), BLOCK + 2);
    at(
        "outsider.near",
        BLOCK + 2 + config().stale_after_blocks.0,
        NOW,
        Gas::from_tgas(10),
    );
    s.resolve_stale();
    let d = &last_event()["data"][0];
    assert_eq!(d["op_id"], "0");
    assert_eq!(d["stage"], "ReadBalance");
    assert_eq!(
        d["op"],
        near_sdk::serde_json::json!({"Withdraw": {"token": base()}})
    );
}

/// EC-C03 (test audit L6): an amount of 0 credits and returns 0, sets nothing, logs an event.
#[test]
fn a_zero_transfer_credits_and_returns_nothing() {
    let mut s = deployed();
    assert_eq!(fund(&mut s, 0), 0);
    assert_eq!(
        inbound(&mut s, &base(), "outsider.near", 0, "", BLOCK + 1),
        0
    );
    assert_eq!(s.get_principal().0, 0);
    assert_eq!(s.get_last_inbound_block().0, 0);
    assert_eq!(last_event()["data"][0]["returned"], "0");
}

/// EC-C124 (test audit L7): the base token in upper case is not a pool token.
#[test]
fn the_base_token_in_upper_case_is_refused() {
    let mut s = cancelled();
    let before = snapshot(&s);
    at("creator.near", BLOCK + 100, NOW, MIN_GAS_WITHDRAW);
    assert_eq!(
        refused(|| {
            let _ = s.withdraw(base().to_uppercase());
        }),
        "LIMIT: not a pool token"
    );
    assert_eq!(snapshot(&s), before);
}

fn edge_amount() -> impl proptest::strategy::Strategy<Value = u128> {
    use proptest::prelude::*;
    let c = cap();
    prop_oneof![
        Just(0u128),
        Just(1),
        Just(c - 1),
        Just(c),
        Just(c + 1),
        Just(u128::MAX),
        proptest::num::u128::ANY,
        0..=c,
    ]
}

proptest::proptest! {
    /// EC-C03 (test audit L6): the cap property with edge values weighted in.
    #[test]
    fn funding_never_exceeds_the_cap_at_edges(amounts in proptest::collection::vec(edge_amount(), 1..8)) {
        let mut s = deployed();
        for a in amounts {
            let before = s.get_principal().0;
            let returned = fund(&mut s, a);
            let after = s.get_principal().0;
            proptest::prop_assert!(after <= cap());
            proptest::prop_assert_eq!(after - before + returned, a);
            proptest::prop_assert_eq!(after, (before.saturating_add(a)).min(cap()));
        }
    }
}
