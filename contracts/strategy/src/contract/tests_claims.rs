//! Slice 6b unit tests: `claim_platform`, `claim_creator` and their callbacks (EC-C14, EC-C15,
//! EC-C61, EC-C114, EC-C117, EC-C118, EC-C169). The real tokens' answers are for the sandbox test.
use super::tests::*;
use super::tests_funding::{as_callback, at, base, events, last_event, ok, quote};
use super::tests_settle::{closing, gap, settle_cb, settle_ok};
use super::*;
use crate::limits::DAY_NS;
use near_sdk::serde_json::json;
use near_sdk::PromiseResult;

const WINDOW: u64 = 2 * DAY_NS; // platform_claim_window_ns in the test config

pub(super) fn closed() -> Strategy {
    let mut s = closing();
    settle_ok(&mut s);
    settle_cb(&mut s, vec![ok("{}")]);
    assert_eq!(s.get_status(), Status::Closed);
    s
}
/// Closed, with `fees` collected in the quote token and `paid` already paid to the platform.
fn closed_with(fees: u128, paid: u128) -> Strategy {
    let mut s = closed();
    s.fees_collected[0] = fees;
    s.paid_platform[0] = paid;
    s
}
fn snap(s: &Strategy) -> String {
    near_sdk::serde_json::to_string(&(
        s.get_status(),
        s.get_lock(),
        s.get_claim_in_flight(),
        s.paid_platform,
        s.fees_collected,
        s.get_stale_resolution_block(),
        s.next_op_id,
        near_sdk::borsh::to_vec(&s.rate_stamps).unwrap(),
    ))
    .unwrap()
}
fn claim_platform_as(
    s: &mut Strategy,
    who: &str,
    ts: u64,
    block: u64,
    gas: Gas,
    token: &str,
) -> Promise {
    at(who, block, ts, gas);
    s.claim_platform(token.to_string())
}
fn claim_creator_as(s: &mut Strategy, ts: u64, block: u64, gas: Gas, token: &str) -> Promise {
    at("creator.near", block, ts, gas);
    s.claim_creator(token.to_string())
}
/// A callback run by the contract with the gas it is really given (the balance callback starts
/// up to two transfers and their callbacks, so it gets `GAS_CLAIM_READ_CB`).
fn cb_env(block: u64, res: Vec<PromiseResult>) {
    near_sdk::testing_env!(
        ctx(ME, BAL, GAS_CLAIM_READ_CB, block).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        res
    );
}
fn read_cb(s: &mut Strategy, wallet: &str) {
    let id = s.get_lock().map(|l| l.op_id.0).unwrap_or(99);
    cb_env(BLOCK + 60, vec![ok(&format!("\"{wallet}\""))]);
    s.on_claim_balance(U64(id));
}
fn leg_cb(s: &mut Strategy, platform: bool, amount: u128, success: bool) {
    let id = s.get_lock().map(|l| l.op_id.0).unwrap_or(99);
    as_callback(
        BLOCK + 61,
        vec![if success {
            ok("")
        } else {
            PromiseResult::Failed
        }],
    );
    s.on_claim_leg(U64(id), platform, U128(amount));
}
fn transfers() -> Vec<(String, String, u128, u64)> {
    // (receiver of the ft_transfer, the transfer's args, deposit, gas) for each ft_transfer call.
    calls()
        .into_iter()
        .filter(|c| c.1 == "ft_transfer")
        .map(|c| (c.0, c.2, c.3, c.4))
        .collect()
}
fn args(to: &str, amount: u128) -> String {
    format!(r#"{{"receiver_id":"{to}","amount":"{amount}"}}"#)
}
fn assert_claim_refused(s: &Strategy, reason: &str) {
    assert_eq!(s.get_lock(), None, "{reason}");
    assert_eq!(s.get_claim_in_flight(), None, "{reason}");
    assert!(calls().is_empty(), "{reason}");
    let e = last_event();
    assert_eq!(e["event"], "claim_refused");
    assert_eq!(e["data"][0]["reason"], reason);
}
fn dust_q() -> u128 {
    limits_args().dust_threshold[0].1 .0
}

// ---- claim_platform: first checks (EC-C14, EC-C118, EC-C124, EC-C155) ----

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
        let _ = claim_platform_as(s, who, ts, block, gas, token);
    });
    assert_eq!(m, msg, "{who} {token}");
    assert!(calls().is_empty(), "{msg}");
    assert_eq!(snap(s), before, "{msg}");
}

#[test]
fn claim_platform_refusals_in_order() {
    let q = quote();
    let low = Gas::from_gas(MIN_GAS_CLAIM.as_gas() - 1);
    let cool = config().stale_cooldown_blocks.0;
    let b = BLOCK + 50;
    // Status first, for any caller, with everything else wrong.
    for st in [
        Status::Open,
        Status::Cancelled,
        Status::Running,
        Status::Closing,
    ] {
        let mut s = closed_with(0, 0);
        s.status = st;
        expect_refusal(
            &mut s,
            "outsider.near",
            NOW,
            b,
            low,
            "x.near",
            "LIMIT: wrong status",
        );
    }
    // EC-C124: a third token, other case, empty, the DCL contract, before the lock and the rest.
    let mut s = closed_with(2_000, 0);
    s.lock = Some(Lock {
        op_id: U64(9),
        op: Op::Settle,
        stage: Stage::ReadAssets,
        promise_block: U64(BLOCK),
    });
    for t in [
        "x.near".to_string(),
        q.to_uppercase(),
        String::new(),
        network().dcl_contract,
    ] {
        expect_refusal(
            &mut s,
            "outsider.near",
            NOW,
            b,
            low,
            &t,
            "LIMIT: not a pool token",
        );
    }
    // Lock before the rate limit, nothing owed, the cooldown and the gas.
    s.fees_collected[0] = 0;
    s.stale_resolution_block = Some(b);
    s.rate_stamp(RateMethod::ClaimPlatform, 1, Class::Outsider);
    expect_refusal(
        &mut s,
        "outsider.near",
        NOW,
        b,
        low,
        &q,
        "LIMIT: operation pending",
    );
    s.lock = None;
    // Rate limit before nothing owed, the cooldown and the gas.
    expect_refusal(
        &mut s,
        "outsider.near",
        NOW + gap() - 1,
        b,
        low,
        &q,
        "LIMIT: rate limited",
    );
    // Nothing owed (cached) before the cooldown and the gas; another class has its own slot.
    expect_refusal(
        &mut s,
        "creator.near",
        NOW,
        b,
        low,
        &q,
        "LIMIT: nothing owed",
    );
    s.fees_collected[0] = 2_000;
    // Cooldown before the gas.
    expect_refusal(
        &mut s,
        "creator.near",
        NOW,
        b + cool - 1,
        low,
        &q,
        "LIMIT: stale cooldown",
    );
    // Gas last, with no stamp for the creator on any refusal.
    expect_refusal(&mut s, "creator.near", NOW, b + cool, low, &q, "LIMIT: gas");
    assert!(s.rate_stamps.iter().all(|r| r.class != Class::Creator));
    let _ = claim_platform_as(&mut s, "creator.near", NOW, b + cool, MIN_GAS_CLAIM, &q);
    assert!(s.get_lock().is_some());
}

/// EC-C14: a cut of 0 for fees of 0 and 19, 1 for 20; `claim_platform` refused `nothing owed` at 0.
#[test]
fn the_cut_is_a_twentieth_rounded_down() {
    for (fees, owed) in [
        (0u128, 0u128),
        (19, 0),
        (20, 1),
        (39, 1),
        (40, 2),
        (u128::MAX, u128::MAX / 20),
    ] {
        let s = closed_with(fees, 0);
        assert_eq!(s.get_platform_owed(quote()).0, owed, "{fees}");
    }
    let mut s = closed_with(19, 0);
    expect_refusal(
        &mut s,
        "outsider.near",
        NOW,
        BLOCK + 50,
        MIN_GAS_CLAIM,
        &quote(),
        "LIMIT: nothing owed",
    );
    // Paid more than owed (a lost claim kept paid raised): owed saturates at 0.
    assert_eq!(closed_with(20, 5).get_platform_owed(quote()).0, 0);
}

// ---- claim_platform: the flow (EC-C114) ----

#[test]
fn claim_platform_reads_then_pays_min_of_owed_and_wallet() {
    let q = quote();
    // fees 20_000 -> owed 1_000. wallet above, at and below the owed amount.
    for (wallet, pay) in [(5_000u128, 1_000u128), (1_000, 1_000), (600, 600), (1, 1)] {
        let mut s = closed_with(20_000, 0);
        let _ = claim_platform_as(&mut s, "creator.near", NOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
        let l = s.get_lock().unwrap();
        assert_eq!(
            (l.stage, s.get_status()),
            (Stage::ReadWallet, Status::Closed)
        );
        assert_eq!(last_event()["event"], "claim_started");
        let c = calls();
        assert_eq!(c.len(), 2, "{c:?}");
        assert_eq!(
            (c[0].0.as_str(), c[0].1.as_str(), c[0].3, c[0].4),
            (q.as_str(), "ft_balance_of", 0, GAS_VIEW.as_gas())
        );
        assert_eq!(c[0].2, format!(r#"{{"account_id":"{ME}"}}"#));
        assert_eq!(
            (c[1].1.as_str(), c[1].4, c[1].5),
            ("on_claim_balance", GAS_CLAIM_READ_CB.as_gas(), 0)
        );
        read_cb(&mut s, &wallet.to_string());
        // paid_platform raised before the transfer; exactly one transfer to the platform, 1 yocto.
        assert_eq!(s.paid_platform[0], pay, "{wallet}");
        assert_eq!(
            transfers(),
            vec![(
                q.clone(),
                args("platform.near", pay),
                1,
                GAS_FT_TRANSFER.as_gas()
            )]
        );
        let inflight = s.get_claim_in_flight().unwrap();
        assert_eq!(
            (
                inflight.platform_amount.0,
                inflight.platform_pending,
                inflight.creator_pending
            ),
            (pay, true, false)
        );
        assert_eq!(s.get_lock().unwrap().stage, Stage::Transfers);
        // The callback: success keeps paid raised and frees the lock.
        leg_cb(&mut s, true, pay, true);
        assert_eq!(
            (s.get_lock(), s.get_claim_in_flight(), s.paid_platform[0]),
            (None, None, pay)
        );
        let e = last_event();
        assert_eq!(e["event"], "claim");
        assert_eq!(e["data"][0]["leg"], "platform");
        assert_eq!(
            (
                e["data"][0]["ok"].as_bool(),
                e["data"][0]["amount"].as_str()
            ),
            (Some(true), Some(pay.to_string().as_str()))
        );
        assert_eq!(s.get_platform_owed(q.clone()).0, 1_000 - pay);
    }
}

/// EC-C15, EC-C114: a failed platform transfer restores `paid_platform`, so the next claim owes the
/// same; an empty wallet is refused `nothing to pay`; an unreadable balance is `read failed`.
#[test]
fn a_failed_platform_transfer_restores_paid() {
    let q = quote();
    let mut s = closed_with(20_000, 0);
    let _ = claim_platform_as(&mut s, "creator.near", NOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    read_cb(&mut s, "5000");
    assert_eq!(s.paid_platform[0], 1_000);
    leg_cb(&mut s, true, 1_000, false);
    assert_eq!(
        (s.paid_platform[0], s.get_lock(), s.get_claim_in_flight()),
        (0, None, None)
    );
    assert_eq!(last_event()["data"][0]["ok"], false);
    assert_eq!(s.get_platform_owed(q.clone()).0, 1_000);
    // An empty wallet.
    let mut s = closed_with(20_000, 0);
    let _ = claim_platform_as(&mut s, "creator.near", NOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    read_cb(&mut s, "0");
    assert_claim_refused(&s, "LIMIT: nothing to pay");
    assert_eq!(s.paid_platform[0], 0);
    // Unreadable balances never pay.
    for res in [
        vec![PromiseResult::Failed],
        vec![],
        vec![ok("1"), ok("1")],
        vec![ok("\"01\"")],
        vec![ok("\"+1\"")],
        vec![ok("null")],
        vec![ok("5")],
    ] {
        let mut s = closed_with(20_000, 0);
        let _ = claim_platform_as(&mut s, "creator.near", NOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
        let id = s.get_lock().unwrap().op_id.0;
        cb_env(BLOCK + 60, res);
        s.on_claim_balance(U64(id));
        assert_claim_refused(&s, "LIMIT: read failed");
        assert_eq!(s.paid_platform[0], 0);
    }
    // The status changed in flight.
    let mut s = closed_with(20_000, 0);
    let _ = claim_platform_as(&mut s, "creator.near", NOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    s.status = Status::Closing;
    read_cb(&mut s, "5000");
    assert_claim_refused(&s, "LIMIT: wrong status");
}

/// EC-C114: an outsider's claim must pay at least the token's dust or the whole owed amount;
/// the creator and the agent are not held to it.
#[test]
fn an_outsiders_claim_obeys_the_dust_rule() {
    let q = quote();
    let d = dust_q();
    // owed = 3 * dust.
    for (wallet, who, paid) in [
        (d - 1, "outsider.near", None),
        (d, "outsider.near", Some(d)),
        (d + 1, "outsider.near", Some(d + 1)),
        (3 * d, "outsider.near", Some(3 * d)),
        (10 * d, "outsider.near", Some(3 * d)),
        (d - 1, "creator.near", Some(d - 1)),
        (1, "agent.near", Some(1)),
        (1, "platform.near", None),
        (1, "deliverer.near", None),
    ] {
        let mut s = closed_with(60 * d, 0);
        let _ = claim_platform_as(&mut s, who, NOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
        read_cb(&mut s, &wallet.to_string());
        match paid {
            Some(p) => assert_eq!(s.paid_platform[0], p, "{who} {wallet}"),
            None => {
                assert_claim_refused(&s, "LIMIT: claim below dust");
                assert_eq!(s.paid_platform[0], 0);
            }
        }
    }
    // The whole owed amount is allowed even when it is below dust.
    let mut s = closed_with(20 * (d - 5), 0);
    let _ = claim_platform_as(&mut s, "outsider.near", NOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    read_cb(&mut s, &(5 * d).to_string());
    assert_eq!(s.paid_platform[0], d - 5);
}

/// EC-C118: per token and class the rate limit holds; the other token and the other class are free.
#[test]
fn claim_platform_is_rate_limited_per_token_and_class() {
    let mut s = closed_with(20_000, 0);
    s.fees_collected[1] = 20_000;
    for (who, tok) in [
        ("outsider.near", quote()),
        ("outsider.near", base()),
        ("creator.near", quote()),
        ("agent.near", quote()),
    ] {
        let _ = claim_platform_as(&mut s, who, NOW, BLOCK + 50, MIN_GAS_CLAIM, &tok);
        assert!(s.get_lock().is_some(), "{who} {tok}");
        read_cb(&mut s, "0"); // refused: nothing to pay; frees the lock, keeps the stamp
    }
    assert_eq!(
        s.rate_stamps
            .iter()
            .filter(|r| r.method == RateMethod::ClaimPlatform)
            .count(),
        4
    );
    for (who, tok) in [
        ("outsider.near", quote()),
        ("outsider.near", base()),
        ("creator.near", quote()),
    ] {
        expect_refusal(
            &mut s,
            who,
            NOW + gap() - 1,
            BLOCK + 70,
            MIN_GAS_CLAIM,
            &tok,
            "LIMIT: rate limited",
        );
        let _ = claim_platform_as(&mut s, who, NOW + gap(), BLOCK + 70, MIN_GAS_CLAIM, &tok);
        assert!(s.get_lock().is_some(), "{who} {tok} at the interval");
        read_cb(&mut s, "0");
    }
}

// ---- claim_creator (EC-C15, EC-C114, EC-C117) ----

#[test]
fn claim_creator_refusals_in_order() {
    let q = quote();
    let low = Gas::from_gas(MIN_GAS_CLAIM.as_gas() - 1);
    let b = BLOCK + 50;
    let mut s = closed_with(20_000, 0); // owed 1_000
    let opens = NOW + WINDOW; // closed_at is NOW
    let refuse_creator = |s: &mut Strategy, ts: u64, block: u64, gas: Gas, tok: &str, msg: &str| {
        let before = snap(s);
        let m = refused(|| {
            let _ = claim_creator_as(s, ts, block, gas, tok);
        });
        assert_eq!(m, msg);
        assert!(calls().is_empty());
        assert_eq!(snap(s), before, "{msg}");
    };
    // Status, then the caller (every other role), by predecessor.
    s.status = Status::Closing;
    refuse_creator(&mut s, NOW, b, low, "x.near", "LIMIT: wrong status");
    s.status = Status::Closed;
    for who in [
        "outsider.near",
        "agent.near",
        "platform.near",
        "deliverer.near",
        ME,
    ] {
        at(who, b, NOW, low);
        assert_eq!(
            refused(|| {
                let _ = s.claim_creator(q.clone());
            }),
            "AUTH: creator only",
            "{who}"
        );
    }
    s.rate_stamps.clear();
    // The token, then the platform window (time), then the lock, the rate limit and the gas.
    refuse_creator(&mut s, NOW, b, low, "x.near", "LIMIT: not a pool token");
    s.lock = Some(Lock {
        op_id: U64(9),
        op: Op::Settle,
        stage: Stage::ReadAssets,
        promise_block: U64(BLOCK),
    });
    // The window before the lock: both failing reports the window.
    refuse_creator(&mut s, opens - 1, b, low, &q, "LIMIT: platform window");
    refuse_creator(&mut s, opens, b, low, &q, "LIMIT: operation pending");
    s.lock = None;
    s.rate_stamp(RateMethod::ClaimCreator, 1, Class::Creator);
    // The window before the rate limit too; once it is open, the rate limit is next.
    refuse_creator(&mut s, opens - 1, b, low, &q, "LIMIT: platform window");
    refuse_creator(&mut s, opens + gap() - 1, b, low, &q, "LIMIT: rate limited");
    s.rate_stamps.clear();
    // The platform window: owed > 0, one nanosecond early refused, at it allowed.
    refuse_creator(&mut s, opens - 1, b, low, &q, "LIMIT: platform window");
    refuse_creator(&mut s, opens, b, low, &q, "LIMIT: gas");
    // Before the window, with the platform owed nothing, it is allowed.
    s.fees_collected[0] = 0;
    refuse_creator(&mut s, NOW, b, low, &q, "LIMIT: gas");
    let _ = claim_creator_as(&mut s, NOW, b, MIN_GAS_CLAIM, &q);
    assert!(s.get_lock().is_some());
}

/// The creator's claim: both legs from one read, platform first, summing to the wallet.
#[test]
fn claim_creator_pays_the_platform_then_the_rest_from_one_read() {
    let q = quote();
    // owed 500: wallet well above, at the owed amount, below it, one above it.
    for (wallet, p, c) in [
        (10_000u128, 500u128, 9_500u128),
        (501, 500, 1),
        (500, 500, 0),
        (200, 200, 0),
        (1, 1, 0),
    ] {
        let mut s = closed_with(10_000, 0);
        let _ = claim_creator_as(&mut s, NOW + WINDOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
        read_cb(&mut s, &wallet.to_string());
        let t = transfers();
        let want: Vec<_> = [("platform.near", p), ("creator.near", c)]
            .into_iter()
            .filter(|(_, a)| *a > 0)
            .map(|(to, a)| (q.clone(), args(to, a), 1u128, GAS_FT_TRANSFER.as_gas()))
            .collect();
        assert_eq!(t, want, "{wallet}");
        assert_eq!(p + c, wallet.min(wallet), "legs sum to the wallet");
        assert_eq!(s.paid_platform[0], p);
        let inflight = s.get_claim_in_flight().unwrap();
        assert_eq!(
            (inflight.platform_pending, inflight.creator_pending),
            (p > 0, c > 0)
        );
        // Each leg's callback has fixed gas and no share of unused gas.
        let cbs: Vec<_> = calls()
            .into_iter()
            .filter(|c| c.1 == "on_claim_leg")
            .collect();
        assert_eq!(cbs.len(), want.len());
        assert!(cbs.iter().all(|c| (c.4, c.5) == (GAS_CALLBACK.as_gas(), 0)));
        // The lock is held until both legs report.
        if p > 0 && c > 0 {
            leg_cb(&mut s, true, p, true);
            assert!(s.get_lock().is_some());
            assert_eq!(last_event()["data"][0]["leg"], "platform");
            leg_cb(&mut s, false, c, true);
        } else if p > 0 {
            leg_cb(&mut s, true, p, true);
        }
        assert_eq!(
            (s.get_lock(), s.get_claim_in_flight()),
            (None, None),
            "{wallet}"
        );
    }
}

/// Owed 0: the creator gets the whole wallet in one transfer, before the platform window.
#[test]
fn claim_creator_with_nothing_owed_pays_the_whole_wallet() {
    let q = quote();
    let mut s = closed_with(0, 0);
    let _ = claim_creator_as(&mut s, NOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    read_cb(&mut s, "123456");
    assert_eq!(
        transfers(),
        vec![(
            q.clone(),
            args("creator.near", 123_456),
            1,
            GAS_FT_TRANSFER.as_gas()
        )]
    );
    assert_eq!(s.paid_platform[0], 0);
    leg_cb(&mut s, false, 123_456, true);
    assert_eq!(s.get_lock(), None);
    // Repeat claims pay exactly what arrived since; an empty wallet is `nothing to claim`.
    let _ = claim_creator_as(&mut s, NOW + gap(), BLOCK + 80, MIN_GAS_CLAIM, &q);
    read_cb(&mut s, "42");
    assert_eq!(transfers()[0].1, args("creator.near", 42));
    leg_cb(&mut s, false, 42, true);
    let _ = claim_creator_as(&mut s, NOW + 2 * gap(), BLOCK + 90, MIN_GAS_CLAIM, &q);
    read_cb(&mut s, "0");
    assert_claim_refused(&s, "LIMIT: nothing to claim");
}

/// EC-C15, EC-C114: a failed platform leg restores `paid_platform` and the creator is still paid
/// `wallet - owed`; a failed creator leg changes nothing (its tokens stay in the wallet).
#[test]
fn a_failed_leg_is_handled_on_its_own() {
    let q = quote();
    let mut s = closed_with(10_000, 0);
    let _ = claim_creator_as(&mut s, NOW + WINDOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    read_cb(&mut s, "10000");
    assert_eq!(s.paid_platform[0], 500);
    leg_cb(&mut s, true, 500, false); // the platform can't receive (blocklisted)
    assert_eq!(s.paid_platform[0], 0, "restored");
    assert!(s.get_lock().is_some(), "the creator's leg is still out");
    leg_cb(&mut s, false, 9_500, true);
    assert_eq!((s.get_lock(), s.get_claim_in_flight()), (None, None));
    assert_eq!(
        s.get_platform_owed(q.clone()).0,
        500,
        "still owed, still reserved"
    );
    // A failed creator leg: paid_platform untouched.
    let mut s = closed_with(10_000, 0);
    let _ = claim_creator_as(&mut s, NOW + WINDOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    read_cb(&mut s, "10000");
    leg_cb(&mut s, false, 9_500, false);
    assert_eq!(s.paid_platform[0], 500);
    leg_cb(&mut s, true, 500, true);
    assert_eq!(s.get_lock(), None);
}

/// EC-C117: a claim while another is in flight, in either order, is `operation pending`.
#[test]
fn claims_do_not_overlap() {
    let q = quote();
    let mut s = closed_with(10_000, 0);
    let _ = claim_platform_as(&mut s, "outsider.near", NOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    expect_claim_creator_refusal(&mut s, "LIMIT: operation pending");
    let mut s = closed_with(10_000, 0);
    let _ = claim_creator_as(&mut s, NOW + WINDOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    expect_refusal(
        &mut s,
        "outsider.near",
        NOW,
        BLOCK + 51,
        MIN_GAS_CLAIM,
        &q,
        "LIMIT: operation pending",
    );
    // While the transfers are out too.
    read_cb(&mut s, "10000");
    expect_refusal(
        &mut s,
        "outsider.near",
        NOW,
        BLOCK + 62,
        MIN_GAS_CLAIM,
        &q,
        "LIMIT: operation pending",
    );
}
fn expect_claim_creator_refusal(s: &mut Strategy, msg: &str) {
    let before = snap(s);
    let q = quote();
    assert_eq!(
        refused(|| {
            let _ = claim_creator_as(s, NOW + WINDOW, BLOCK + 51, MIN_GAS_CLAIM, &q);
        }),
        msg
    );
    assert_eq!(snap(s), before);
}

// ---- callbacks and stale (EC-C11, EC-C114, EC-C169) ----

#[test]
fn claim_callbacks_act_only_on_their_own_claim() {
    let q = quote();
    let mut s = closed_with(10_000, 0);
    let _ = claim_creator_as(&mut s, NOW + WINDOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    let before = snap(&s);
    for who in ["creator.near", "outsider.near", "platform.near"] {
        near_sdk::testing_env!(
            ctx(who, BAL, Gas::from_tgas(100), BLOCK + 60).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![ok("\"100\"")]
        );
        assert_eq!(
            refused(|| s.on_claim_balance(U64(1))),
            "AUTH: callback only"
        );
        assert_eq!(
            refused(|| s.on_claim_leg(U64(1), true, U128(1))),
            "AUTH: callback only"
        );
    }
    assert_eq!(snap(&s), before);
    // Another op id, the wrong stage, no lock: ignored with an event, nothing changed.
    cb_env(BLOCK + 60, vec![ok("\"100\"")]);
    s.on_claim_balance(U64(7));
    s.on_claim_leg(U64(1), true, U128(1)); // right op, wrong stage (still ReadWallet)
    assert_eq!(snap(&s), before);
    assert_eq!(
        events()
            .iter()
            .filter(|e| e["event"] == "callback_ignored")
            .count(),
        2
    );
    let mut s = closed_with(10_000, 0);
    let before = snap(&s);
    cb_env(BLOCK + 60, vec![ok("\"100\"")]);
    s.on_claim_balance(U64(0));
    s.on_claim_leg(U64(0), true, U128(1));
    assert_eq!(snap(&s), before);
    assert!(calls().is_empty());
}

/// EC-C114: a lost claim is resolved by `resolve_stale`: the lock and the in-flight record go,
/// `paid_platform` stays raised (a bounded platform loss, disclosed), the cooldown starts, and the
/// lost callback arriving late does nothing.
#[test]
fn a_lost_claim_keeps_paid_platform_raised() {
    let q = quote();
    let stale = config().stale_after_blocks.0;
    let cool = config().stale_cooldown_blocks.0;
    let mut s = closed_with(10_000, 0);
    let _ = claim_creator_as(&mut s, NOW + WINDOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    read_cb(&mut s, "10000"); // transfers out at BLOCK + 60; callbacks lost
    at("outsider.near", BLOCK + 60 + stale, NOW, Gas::from_tgas(10));
    s.resolve_stale();
    assert_eq!(
        (s.get_lock(), s.get_claim_in_flight(), s.paid_platform[0]),
        (None, None, 500)
    );
    assert_eq!(
        last_event()["data"][0]["op"],
        json!({"ClaimCreator": {"token": q}})
    );
    // The platform now owes nothing (its paid amount stayed raised), so a platform claim is
    // `nothing owed` before anything else. The creator's claim waits the cooldown: one block early
    // refused, at it allowed; the late leg callback is ignored.
    expect_refusal(
        &mut s,
        "outsider.near",
        NOW + WINDOW + 10 * gap(),
        BLOCK + 70 + stale,
        MIN_GAS_CLAIM,
        &q,
        "LIMIT: nothing owed",
    );
    let before = snap(&s);
    assert_eq!(
        refused(|| {
            let _ = claim_creator_as(
                &mut s,
                NOW + WINDOW + 10 * gap(),
                BLOCK + 60 + stale + cool - 1,
                MIN_GAS_CLAIM,
                &q,
            );
        }),
        "LIMIT: stale cooldown"
    );
    assert_eq!(snap(&s), before);
    let _ = claim_creator_as(
        &mut s,
        NOW + WINDOW + 10 * gap(),
        BLOCK + 60 + stale + cool,
        MIN_GAS_CLAIM,
        &q,
    );
    assert!(s.get_lock().is_some());
    s.lock = None;
    let before = snap(&s);
    as_callback(BLOCK + 60 + stale + 1, vec![ok("")]);
    s.on_claim_leg(U64(1), true, U128(500));
    assert_eq!(snap(&s), before);
}

#[test]
fn claim_views() {
    let s = closed_with(1_234, 10);
    assert_eq!(
        s.get_fees_collected(),
        TokenAmounts {
            quote: U128(1_234),
            base: U128(0)
        }
    );
    assert_eq!(s.get_platform_owed(quote()).0, 61 - 10);
    assert_eq!(s.get_paid_platform(quote()).0, 10);
    assert_eq!(s.get_platform_owed(base()).0, 0);
    assert_eq!(
        refused(|| {
            s.get_platform_owed("x.near".into());
        }),
        "LIMIT: not a pool token"
    );
    assert_eq!(
        refused(|| {
            s.get_paid_platform(quote().to_uppercase());
        }),
        "LIMIT: not a pool token"
    );
}

proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig::with_cases(64))]
    /// EC-C120: for any fees, prior payment and wallet, a creator claim never pays out more than the
    /// wallet read, pays the platform at most its owed amount, and reserves the owed amount from the
    /// creator whenever the wallet covers it.
    #[test]
    fn claims_never_pay_more_than_the_wallet(fees in 0u128..1_000_000_000, paid_frac in 0u128..=100, wallet in 0u128..2_000_000_000) {
        let owed_total = fees / 20;
        let paid = owed_total * paid_frac / 100;
        let owed = owed_total - paid;
        let mut s = closed_with(fees, paid);
        let _ = claim_creator_as(&mut s, NOW + WINDOW, BLOCK + 50, MIN_GAS_CLAIM, &quote());
        read_cb(&mut s, &wallet.to_string());
        let t = transfers();
        let sum: u128 = t.iter().map(|x| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(&x.1).unwrap()["amount"].as_str().unwrap().parse::<u128>().unwrap()).sum();
        proptest::prop_assert!(sum <= wallet);
        proptest::prop_assert_eq!(sum, if wallet == 0 { 0 } else { wallet });
        let platform: u128 = t.iter().filter(|x| x.1.contains("platform.near")).map(|x| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(&x.1).unwrap()["amount"].as_str().unwrap().parse::<u128>().unwrap()).sum();
        proptest::prop_assert_eq!(platform, owed.min(wallet));
        proptest::prop_assert_eq!(s.paid_platform[0], paid + platform);
        proptest::prop_assert!(s.paid_platform[0] <= fees / 20);
    }
}

// ---- test audit of slice 6 (M1 to M5, L4) ----

fn lock_held() -> Lock {
    Lock {
        op_id: U64(9),
        op: Op::Settle,
        stage: Stage::ReadAssets,
        promise_block: U64(BLOCK),
    }
}
fn roles() -> [&'static str; 6] {
    [
        "outsider.near",
        "agent.near",
        "platform.near",
        "deliverer.near",
        "x.near",
        ME,
    ]
}

/// M1: `claim_creator` checks the status, then the caller, then the token, whatever else is wrong
/// (a held lock, a rate stamp, low gas); every role but the creator is `AUTH: creator only`.
#[test]
fn claim_creator_status_then_caller_then_token() {
    let low = Gas::from_gas(MIN_GAS_CLAIM.as_gas() - 1);
    for who in roles().into_iter().chain(["creator.near"]) {
        let mut s = closed_with(20_000, 0);
        s.status = Status::Closing;
        s.lock = Some(lock_held());
        let before = snap(&s);
        at(who, BLOCK + 50, NOW, low);
        assert_eq!(
            refused(|| {
                let _ = s.claim_creator("x.near".into());
            }),
            "LIMIT: wrong status",
            "{who}"
        );
        assert_eq!(snap(&s), before);
    }
    for who in roles() {
        let mut s = closed_with(20_000, 0);
        s.lock = Some(lock_held());
        s.rate_stamp(RateMethod::ClaimCreator, 1, Class::Creator);
        for tok in ["x.near".to_string(), quote()] {
            let before = snap(&s);
            at(who, BLOCK + 50, NOW, low);
            assert_eq!(
                refused(|| {
                    let _ = s.claim_creator(tok.clone());
                }),
                "AUTH: creator only",
                "{who} {tok}"
            );
            assert_eq!(snap(&s), before);
        }
    }
    // The creator with a bad token: the token, before the window, the lock and the rate stamp.
    let mut s = closed_with(20_000, 0);
    s.lock = Some(lock_held());
    let before = snap(&s);
    at("creator.near", BLOCK + 50, NOW, low);
    for tok in ["x.near".to_string(), quote().to_uppercase(), String::new()] {
        assert_eq!(
            refused(|| {
                let _ = s.claim_creator(tok.clone());
            }),
            "LIMIT: not a pool token"
        );
    }
    assert_eq!(snap(&s), before);
}

/// M2: roles are the predecessor, never the signer, on the new methods.
#[test]
fn the_new_methods_use_the_predecessor_not_the_signer() {
    let q = quote();
    let signed = |pred: &str, signer: &str, ts: u64, gas: Gas| {
        let mut b = ctx(pred, BAL, gas, BLOCK + 50);
        b.signer_account_id(acc(signer)).block_timestamp(ts);
        near_sdk::testing_env!(b.build());
    };
    // claim_creator relayed by an outsider contract for the creator's transaction.
    let mut s = closed_with(0, 0);
    signed("relay.near", "creator.near", NOW, MIN_GAS_CLAIM);
    assert_eq!(
        refused(|| {
            let _ = s.claim_creator(q.clone());
        }),
        "AUTH: creator only"
    );
    signed("creator.near", "relay.near", NOW, MIN_GAS_CLAIM);
    let _ = s.claim_creator(q.clone());
    assert!(s.get_lock().is_some());
    // An outsider exit before the grace period stays refused whoever signed.
    let mut s = super::tests_start::started();
    for signer in ["creator.near", "agent.near"] {
        signed("relay.near", signer, NOW, MIN_GAS_EXIT);
        assert_eq!(
            refused(|| {
                let _ = s.exit_withdraw(q.clone());
            }),
            "LIMIT: exit not open yet",
            "{signer}"
        );
    }
    // An outsider's platform claim below dust is the outsider's, whoever signed.
    let d = dust_q();
    let mut s = closed_with(60 * d, 0);
    signed("relay.near", "creator.near", NOW, MIN_GAS_CLAIM);
    let _ = s.claim_platform(q.clone());
    read_cb(&mut s, &(d - 1).to_string());
    assert_claim_refused(&s, "LIMIT: claim below dust");
}

/// M3 (EC-C133, EC-C74): exits and both claims are allowed while the settle window is open, with
/// the exact transfers: a window never strands funds.
#[test]
fn claims_and_exits_ignore_the_settle_window() {
    let q = quote();
    let mut s = closed_with(20_000, 0);
    s.settle_until_block = BLOCK + 50 + 1;
    let _ = claim_platform_as(&mut s, "outsider.near", NOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    read_cb(&mut s, "5000");
    assert_eq!(transfers()[0].1, args("platform.near", 1_000));
    leg_cb(&mut s, true, 1_000, true);
    let _ = claim_creator_as(&mut s, NOW + WINDOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    read_cb(&mut s, "4000");
    assert_eq!(transfers()[0].1, args("creator.near", 4_000));
    // And the exits, for the agent, the creator and an outsider after the grace period.
    for (who, ts) in [
        ("agent.near", NOW),
        ("creator.near", NOW),
        ("outsider.near", NOW + 100 * DAY_NS),
    ] {
        let mut s = closed_with(0, 0);
        s.settle_until_block = BLOCK + 50 + 1;
        let _ = super::tests_claims::exit_call(&mut s, who, ts);
        assert!(s.get_lock().is_some(), "{who}");
    }
}
pub(super) fn exit_call(s: &mut Strategy, who: &str, ts: u64) -> Promise {
    at(who, BLOCK + 50, ts, MIN_GAS_EXIT);
    s.exit_withdraw(quote())
}

/// M4, L4: both legs failing restores `paid_platform` and frees everything; a duplicate leg
/// callback and a second balance callback are ignored (no double restore).
#[test]
fn both_legs_failing_and_duplicate_callbacks() {
    let q = quote();
    let mut s = closed_with(10_000, 0);
    let _ = claim_creator_as(&mut s, NOW + WINDOW, BLOCK + 50, MIN_GAS_CLAIM, &q);
    read_cb(&mut s, "10000");
    // A second balance callback at the later stage is ignored.
    let before = snap(&s);
    cb_env(BLOCK + 61, vec![ok("\"1\"")]);
    s.on_claim_balance(U64(1));
    assert_eq!(snap(&s), before);
    assert_eq!(last_event()["event"], "callback_ignored");
    leg_cb(&mut s, true, 500, false);
    assert_eq!(s.paid_platform[0], 0);
    // The platform leg reporting again (a duplicate) restores nothing more and changes nothing.
    let before = snap(&s);
    leg_cb(&mut s, true, 500, false);
    assert_eq!(snap(&s), before);
    assert_eq!(last_event()["event"], "callback_ignored");
    leg_cb(&mut s, false, 9_500, false);
    assert_eq!(
        (s.get_lock(), s.get_claim_in_flight(), s.paid_platform[0]),
        (None, None, 0)
    );
    assert_eq!(s.get_platform_owed(q.clone()).0, 500);
    // After completion the same leg again is ignored (no lock).
    let before = snap(&s);
    as_callback(BLOCK + 70, vec![PromiseResult::Failed]);
    s.on_claim_leg(U64(1), true, U128(500));
    assert_eq!(snap(&s), before);
}

// M5: over the whole `u128` range a creator claim never overflows or overpays, and a platform
// claim pays exactly `min(owed, wallet)` or is refused.
proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig::with_cases(64))]
    #[test]
    fn claims_over_the_whole_u128_range(fees in proptest::num::u128::ANY, paid_pct in 0u128..=100, wallet in proptest::num::u128::ANY, creator in proptest::bool::ANY) {
        let owed_total = fees / 20;
        let paid = owed_total / 100 * paid_pct;
        let owed = owed_total - paid;
        let mut s = closed_with(fees, paid);
        if creator {
            // The window is open (owed > 0 waits for it): claim at it.
            let _ = claim_creator_as(&mut s, NOW + WINDOW, BLOCK + 50, MIN_GAS_CLAIM, &quote());
        } else if owed == 0 {
            return Ok(());
        } else {
            let _ = claim_platform_as(&mut s, "creator.near", NOW, BLOCK + 50, MIN_GAS_CLAIM, &quote());
        }
        read_cb(&mut s, &wallet.to_string());
        let amounts: Vec<u128> = transfers().iter().map(|x| near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(&x.1).unwrap()["amount"].as_str().unwrap().parse().unwrap()).collect();
        let sum = amounts.iter().fold(0u128, |a, b| a.checked_add(*b).expect("no overflow"));
        let platform = owed.min(wallet);
        if creator {
            proptest::prop_assert_eq!(sum, wallet);
        } else {
            proptest::prop_assert_eq!(sum, platform);
        }
        proptest::prop_assert_eq!(s.paid_platform[0], paid + if amounts.is_empty() { 0 } else { platform });
        proptest::prop_assert!(s.paid_platform[0] <= fees / 20);
    }
}

/// EC-C114: 1,000 cycles of 1-unit donations and creator claims: each claim pays exactly what
/// arrived, `actions` and the ring don't exist to grow, the lock always returns and the rate limit
/// opens at every interval.
#[test]
fn a_thousand_donation_and_claim_cycles() {
    let q = quote();
    let mut s = closed_with(0, 0);
    let mut total = 0u128;
    for i in 0..1_000u64 {
        let ts = NOW + (i + 1) * gap();
        let _ = claim_creator_as(&mut s, ts, BLOCK + 50 + i, MIN_GAS_CLAIM, &q);
        read_cb(&mut s, "1");
        assert_eq!(
            transfers(),
            vec![(
                q.clone(),
                args("creator.near", 1),
                1,
                GAS_FT_TRANSFER.as_gas()
            )]
        );
        leg_cb(&mut s, false, 1, true);
        total += 1;
        assert_eq!(s.get_lock(), None);
    }
    assert_eq!(total, 1_000);
    assert_eq!(s.paid_platform, [0, 0]);
    assert_eq!(
        s.rate_stamps
            .iter()
            .filter(|r| r.method == RateMethod::ClaimCreator)
            .count(),
        1
    );
}
