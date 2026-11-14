//! Slice 9 unit tests: `agent_close_position` and `exit_remove` with their reads, the remove and
//! its result (EC-C73, EC-C74, EC-C104, EC-C115, EC-C126, EC-C128, EC-C133, EC-R28, EC-R30).
//! DCL's real answers and the gas are for the sandbox test (`strategy-sandbox/tests/remove.rs`).
use super::tests::*;
use super::tests_funding::{at, events, last_event, ok, quote};
use super::tests_start::started;
use super::*;
use crate::limits::{DAY_NS, NANOS_PER_S};
use near_sdk::PromiseResult;

/// The mocked VM reserves far more per receipt than the real runtime (see `tests_open`).
const OK_GAS: Gas = Gas::from_tgas(900);
const POINT: i32 = 401_312;
const CALL_BLOCK: u64 = BLOCK + 100;
const LIQ: u128 = 1_000_000;
const UX: u128 = 5_257;
const UY: u128 = 6_025;

fn pos() -> String {
    format!("{}#7", limits_args().pool)
}
fn hash(n: u64) -> String {
    format!("{n:064x}")
}
fn meta(n: u64, block: u64) -> Meta {
    Meta {
        observed: Observed {
            block: U64(block),
            point: POINT,
        },
        decision_hash: hash(n),
        chain_head: None,
    }
}
fn confirm(block: u64) -> Observed {
    Observed {
        block: U64(block),
        point: POINT,
    }
}
/// A strategy with an own position, as after a successful open.
fn holding() -> Strategy {
    let mut s = started();
    s.tokens_registered = true;
    s.opened = true;
    s.own_position = Some(pos());
    s
}
fn closing() -> Strategy {
    let mut s = holding();
    s.status = Status::Closing;
    s
}
const OBS: u64 = CALL_BLOCK - 5;
fn close_at(
    s: &mut Strategy,
    who: &str,
    ts: u64,
    gas: Gas,
    p: &str,
    m: Meta,
    c: Observed,
) -> Promise {
    at(who, CALL_BLOCK, ts, gas);
    s.agent_close_position(p.to_string(), m, c)
}
fn agent_close(s: &mut Strategy, n: u64) -> Promise {
    close_at(
        s,
        "agent.near",
        NOW,
        OK_GAS,
        &pos(),
        meta(n, OBS),
        confirm(OBS - OFFCHAIN_MARGIN_BLOCKS),
    )
}
fn exit_at(s: &mut Strategy, who: &str, ts: u64, block: u64, gas: Gas, p: &str) -> Promise {
    at(who, block, ts, gas);
    s.exit_remove(p.to_string())
}
fn snap(s: &Strategy) -> String {
    near_sdk::serde_json::to_string(&(
        s.get_status(),
        s.get_lock(),
        s.actions.clone(),
        s.seen_decisions.clone(),
        s.get_own_position(),
        s.get_settle_window(),
        s.get_fees_collected(),
        s.next_op_id,
        s.rate_stamps.len(),
    ))
    .unwrap()
}
fn cb_env(block: u64, res: Vec<PromiseResult>) {
    let mut b = ctx(ME, BAL, Gas::from_tgas(300), block);
    b.block_timestamp(NOW);
    near_sdk::testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        res
    );
}
fn op_id(s: &Strategy) -> U64 {
    U64(s.get_lock().map(|l| l.op_id.0).unwrap_or(99))
}
fn liq_json(amount: &str, owner: &str, pool: &str, id: &str) -> String {
    format!(
        r#"{{"lpt_id":"{id}","owner_id":"{owner}","pool_id":"{pool}","left_point":400812,"right_point":401812,"amount":"{amount}","unclaimed_fee_x":"{UX}","unclaimed_fee_y":"{UY}","v_liquidity":"0","mft_id":"m"}}"#
    )
}
fn good_liq() -> String {
    liq_json(&LIQ.to_string(), ME, &limits_args().pool, &pos())
}
fn round1(s: &mut Strategy, res: Vec<PromiseResult>) {
    let id = op_id(s);
    cb_env(CALL_BLOCK + 2, res);
    s.on_remove_reads(id);
}
fn predicted(s: &mut Strategy, res: Vec<PromiseResult>) {
    let id = op_id(s);
    cb_env(CALL_BLOCK + 4, res);
    s.on_remove_predicted(id);
}
fn removed(s: &mut Strategy, res: PromiseResult) {
    let id = op_id(s);
    cb_env(CALL_BLOCK + 8, vec![res]);
    s.on_removed(id);
}
fn pred(x: u128, y: u128) -> PromiseResult {
    ok(&format!(r#"["{x}","{y}"]"#))
}
/// A close driven to the remove's launch.
fn removing() -> Strategy {
    let mut s = holding();
    let _ = agent_close(&mut s, 1);
    round1(&mut s, vec![ok(&good_liq())]);
    predicted(
        &mut s,
        vec![pred(100_000_000, 29_000_000_000_000_000_000_000_000)],
    );
    s
}
fn rec(s: &Strategy) -> ActionRecord {
    s.get_action(U64(0)).unwrap()
}
fn assert_ended(s: &Strategy, result: ActionResult, window: bool, position_kept: bool) {
    let r = rec(s);
    assert_eq!(r.result, result);
    assert_eq!(s.get_lock(), None);
    assert!(calls().is_empty(), "{result:?}");
    assert_eq!(s.get_own_position().is_some(), position_kept, "{result:?}");
    assert_eq!(
        s.get_settle_window().settle_until_block.0 != 0,
        window,
        "{result:?}"
    );
    assert_eq!(last_event()["event"], "action_result");
    assert!(r.result_block.is_some() && r.result_ts_ns.is_some());
}

// ---- agent_close_position: the first checks ----

#[allow(clippy::too_many_arguments)]
fn expect_close_refusal(
    s: &mut Strategy,
    who: &str,
    ts: u64,
    gas: Gas,
    p: &str,
    m: Meta,
    c: Observed,
    msg: &str,
) {
    let before = snap(s);
    let r = refused(|| {
        let _ = close_at(s, who, ts, gas, p, m, c);
    });
    assert_eq!(r, msg, "{who}");
    assert!(calls().is_empty(), "{msg}");
    assert_eq!(snap(s), before, "{msg}");
}

#[test]
fn a_valid_close_takes_the_lock_records_and_reads_the_position() {
    let mut s = holding();
    let _ = agent_close(&mut s, 1);
    let l = s.get_lock().unwrap();
    assert_eq!(
        (l.op, l.stage),
        (
            Op::Remove {
                index: U64(0),
                class: Class::Agent
            },
            Stage::ReadRound
        )
    );
    let r = rec(&s);
    assert_eq!(
        (r.kind, r.result.clone()),
        (ActionKind::ClosePosition, ActionResult::Pending)
    );
    let rm = r.remove.unwrap();
    assert_eq!(rm.position, pos());
    assert_eq!(
        rm.confirm_observed,
        Some(confirm(OBS - OFFCHAIN_MARGIN_BLOCKS))
    );
    assert_eq!(s.seen_decisions.len(), 1);
    assert_eq!(last_event()["event"], "action");
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(
        (
            c[0].0.as_str(),
            c[0].1.as_str(),
            c[0].2.as_str(),
            c[0].3,
            c[0].4
        ),
        (
            network().dcl_contract.as_str(),
            "get_liquidity",
            format!(r#"{{"lpt_id":"{}"}}"#, pos()).as_str(),
            0,
            GAS_VIEW.as_gas()
        )
    );
    assert_eq!(
        (c[1].1.as_str(), c[1].2.as_str(), c[1].4, c[1].5),
        (
            "on_remove_reads",
            r#"{"op_id":"1"}"#,
            GAS_REMOVE_READ_CB.as_gas(),
            0
        )
    );
}

#[test]
fn agent_close_refusals_in_order() {
    let low = Gas::from_gas(MIN_GAS_REMOVE.as_gas() - 1);
    let m = meta(1, OBS);
    let c0 = confirm(OBS - OFFCHAIN_MARGIN_BLOCKS);
    for st in [
        Status::Open,
        Status::Cancelled,
        Status::Closing,
        Status::Closed,
    ] {
        let mut s = holding();
        s.status = st;
        expect_close_refusal(
            &mut s,
            "outsider.near",
            NOW,
            low,
            &pos(),
            m.clone(),
            c0,
            "LIMIT: wrong status",
        );
    }
    let mut s = holding();
    for who in [
        "creator.near",
        "outsider.near",
        "platform.near",
        "deliverer.near",
        ME,
    ] {
        expect_close_refusal(
            &mut s,
            who,
            NOW,
            low,
            "x",
            m.clone(),
            c0,
            "AUTH: agent only",
        );
    }
    // Time: a close may run past run_end, to run_end + exit_grace exclusive.
    let end = config().run_end_ns.0;
    let grace = config().exit_grace_ns.0;
    expect_close_refusal(
        &mut s,
        "agent.near",
        end + grace,
        low,
        &pos(),
        m.clone(),
        c0,
        "LIMIT: run ended",
    );
    s.lock = Some(Lock {
        op_id: U64(9),
        op: Op::Settle,
        stage: Stage::ReadAssets,
        promise_block: U64(BLOCK),
    });
    expect_close_refusal(
        &mut s,
        "agent.near",
        end + grace - 1,
        low,
        &pos(),
        m.clone(),
        c0,
        "LIMIT: operation pending",
    );
    s.lock = None;
    // The interval and the 24-hour count.
    let gap = limits_args().min_action_interval_s.0 * NANOS_PER_S;
    let mut s2 = holding();
    s2.actions.push(synthetic(0, NOW));
    expect_close_refusal(
        &mut s2,
        "agent.near",
        NOW + gap - 1,
        low,
        &pos(),
        m.clone(),
        c0,
        "LIMIT: action interval",
    );
    let mut s3 = holding();
    for i in 0..6 {
        s3.actions.push(synthetic(i, NOW));
    }
    expect_close_refusal(
        &mut s3,
        "agent.near",
        NOW + 6 * gap,
        low,
        &pos(),
        m.clone(),
        c0,
        "LIMIT: actions per 24h",
    );
    // Quiet, then the payout margin for each observation.
    s.settle_until_block = CALL_BLOCK + 1;
    expect_close_refusal(
        &mut s,
        "agent.near",
        NOW,
        low,
        &pos(),
        m.clone(),
        c0,
        "LIMIT: not quiet",
    );
    s.settle_until_block = 0;
    s.last_payout_callback_block = OBS - OFFCHAIN_MARGIN_BLOCKS + 1;
    expect_close_refusal(
        &mut s,
        "agent.near",
        NOW,
        low,
        &pos(),
        m.clone(),
        confirm(OBS - OFFCHAIN_MARGIN_BLOCKS),
        "LIMIT: inside payout margin",
    );
    s.last_payout_callback_block = 0;
    // The confirmation span: at the margin and at the maximum, one outside each, and not before.
    for (span, good) in [
        (OFFCHAIN_MARGIN_BLOCKS - 1, false),
        (OFFCHAIN_MARGIN_BLOCKS, true),
        (CONFIRM_MAX_BLOCKS, true),
        (CONFIRM_MAX_BLOCKS + 1, false),
    ] {
        let mut t = holding();
        let c = confirm(OBS - span);
        if good {
            let _ = close_at(&mut t, "agent.near", NOW, OK_GAS, &pos(), m.clone(), c);
            assert!(t.get_lock().is_some(), "{span}");
        } else {
            expect_close_refusal(
                &mut t,
                "agent.near",
                NOW,
                OK_GAS,
                &pos(),
                m.clone(),
                c,
                "LIMIT: confirmation span",
            );
        }
    }
    expect_close_refusal(
        &mut s,
        "agent.near",
        NOW,
        OK_GAS,
        &pos(),
        m.clone(),
        confirm(OBS),
        "LIMIT: confirmation span",
    );
    expect_close_refusal(
        &mut s,
        "agent.near",
        NOW,
        OK_GAS,
        &pos(),
        m.clone(),
        confirm(OBS + 1),
        "LIMIT: confirmation span",
    );
    // Points out of bounds.
    let mut bad = m.clone();
    bad.observed.point = 800_001;
    expect_close_refusal(
        &mut s,
        "agent.near",
        NOW,
        OK_GAS,
        &pos(),
        bad,
        c0,
        "LIMIT: points",
    );
    let mut bc = c0;
    bc.point = -800_001;
    expect_close_refusal(
        &mut s,
        "agent.near",
        NOW,
        OK_GAS,
        &pos(),
        m.clone(),
        bc,
        "LIMIT: points",
    );
    // The position: another id, and none at all.
    expect_close_refusal(
        &mut s,
        "agent.near",
        NOW,
        OK_GAS,
        "other#1",
        m.clone(),
        c0,
        "LIMIT: not the own position",
    );
    let mut none = started();
    expect_close_refusal(
        &mut none,
        "agent.near",
        NOW,
        OK_GAS,
        &pos(),
        m.clone(),
        c0,
        "LIMIT: not the own position",
    );
    // Gas, observation age, the hash, log capacity.
    expect_close_refusal(
        &mut s,
        "agent.near",
        NOW,
        low,
        &pos(),
        m.clone(),
        c0,
        "LIMIT: gas",
    );
    let age = limits_args().max_observation_age_blocks.0;
    let old = meta(1, CALL_BLOCK - age - 1);
    expect_close_refusal(
        &mut s,
        "agent.near",
        NOW,
        OK_GAS,
        &pos(),
        old,
        confirm(CALL_BLOCK - age - 1 - 40),
        "LIMIT: observation age",
    );
    s.seen_decisions
        .push(crate::contract::parse_hash(&hash(1)).unwrap());
    expect_close_refusal(
        &mut s,
        "agent.near",
        NOW,
        OK_GAS,
        &pos(),
        m.clone(),
        c0,
        "LIMIT: decision hash",
    );
    let mut full = holding();
    full.limits.max_actions_per_24h = 1_000;
    for i in 0..(MAX_ACTIONS_STORED - RESERVED_SLOTS) as u64 {
        full.actions.push(synthetic(i, 1));
    }
    expect_close_refusal(
        &mut full,
        "agent.near",
        NOW,
        OK_GAS,
        &pos(),
        m.clone(),
        c0,
        "LIMIT: action log full",
    );
}

fn synthetic(i: u64, ts: u64) -> ActionRecord {
    ActionRecord {
        index: U64(i),
        op_id: U64(100 + i),
        kind: ActionKind::Swap,
        caller: acc("agent.near"),
        left_point: 0,
        right_point: 1000,
        observed: Observed {
            block: U64(1),
            point: POINT,
        },
        reference: None,
        decision_hash: hash(500 + i),
        chain_head: None,
        call_block: U64(1),
        timestamp_ns: U64(ts),
        result_block: Some(U64(1)),
        result_ts_ns: Some(U64(ts)),
        result: ActionResult::Refused("drift".into()),
        round: None,
        swap: None,
        open: None,
        remove: None,
    }
}

// ---- the removal itself ----

#[test]
fn the_read_leads_to_a_prediction_then_the_remove_with_minimums() {
    let mut s = holding();
    let _ = agent_close(&mut s, 1);
    round1(&mut s, vec![ok(&good_liq())]);
    assert_eq!(s.get_lock().unwrap().stage, Stage::Predicting);
    let r = rec(&s);
    assert_eq!((r.left_point, r.right_point), (400_812, 401_812));
    let rm = r.remove.unwrap();
    assert_eq!(
        (rm.liquidity.0, rm.unclaimed_x.0, rm.unclaimed_y.0),
        (LIQ, UX, UY)
    );
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(
        (c[0].1.as_str(), c[0].2.as_str(), c[0].3, c[0].4),
        (
            "predict_remove_liquidity",
            format!(r#"{{"lpt_id":"{}","amount":"{LIQ}"}}"#, pos()).as_str(),
            0,
            GAS_PREDICT.as_gas()
        )
    );
    assert_eq!(
        (c[1].1.as_str(), c[1].4, c[1].5),
        ("on_remove_predicted", GAS_PREDICTED_CB.as_gas(), 0)
    );
    // Predicted [x, y]: minimums floor(pred * 9950 / 10000) (max_slippage_bps 50), EC-R28.
    predicted(&mut s, vec![pred(79_509_995, 120_505_042)]);
    assert_eq!(s.get_lock().unwrap().stage, Stage::Removing);
    let (mx, my) = (
        79_509_995u128 * 9_950 / 10_000,
        120_505_042u128 * 9_950 / 10_000,
    );
    let rm = rec(&s).remove.unwrap();
    assert_eq!(
        (rm.predict_x.0, rm.predict_y.0, rm.min_x.0, rm.min_y.0),
        (79_509_995, 120_505_042, mx, my)
    );
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(
        (c[0].0.as_str(), c[0].1.as_str(), c[0].3, c[0].4),
        (
            network().dcl_contract.as_str(),
            "remove_liquidity",
            0,
            GAS_REMOVE.as_gas()
        )
    );
    assert_eq!(
        c[0].2,
        format!(
            r#"{{"lpt_id":"{}","amount":"{LIQ}","min_amount_x":"{mx}","min_amount_y":"{my}","skip_unwrap_near":true}}"#,
            pos()
        )
    );
    assert_eq!(
        (c[1].1.as_str(), c[1].4, c[1].5),
        ("on_removed", GAS_REMOVE_RESULT.as_gas(), 0)
    );
}

/// EC-R28 at the edges: the minimum of a prediction at 0, 1, an exact multiple of 10,000 and `u128::MAX`.
#[test]
fn remove_minimums_never_overflow() {
    for p in [0u128, 1, 10_000, 10_001, u128::MAX] {
        let mut s = holding();
        let _ = agent_close(&mut s, 1);
        round1(&mut s, vec![ok(&good_liq())]);
        predicted(&mut s, vec![pred(p, p)]);
        let m = rec(&s).remove.unwrap().min_x.0;
        let want = (p / 10_000) * 9_950 + (p % 10_000) * 9_950 / 10_000;
        assert_eq!(m, want, "{p}");
        assert!(m <= p);
    }
    assert_eq!(
        rec(&{
            let mut s = holding();
            let _ = agent_close(&mut s, 1);
            round1(&mut s, vec![ok(&good_liq())]);
            predicted(&mut s, vec![pred(10_000, 0)]);
            s
        })
        .remove
        .unwrap()
        .min_x
        .0,
        9_950
    );
}

/// EC-C115: fees are `min(unclaimed_t, reported_t)` per token, added once; the position is gone,
/// the window opened as the caller's class, the lock free.
#[test]
fn a_remove_counts_the_fees_once_clears_the_position_and_opens_the_window() {
    // (reported_x, reported_y, expected fees_x, fees_y): unclaimed 5257 and 6025.
    for (rx, ry, fx, fy) in [
        (79_509_995u128, 120_505_042u128, UX, UY),
        (100, 200, 100, 200),
        (UX, UY, UX, UY),
        (UX - 1, UY + 1, UX - 1, UY),
        (0, 0, 0, 0),
    ] {
        let mut s = removing();
        s.fees_collected = [1_000, 2_000];
        removed(&mut s, ok(&format!(r#"["{rx}","{ry}"]"#)));
        let r = rec(&s);
        assert_eq!(r.result, ActionResult::Ok);
        // The unit pool has the quote token as token_x.
        assert_eq!(s.get_fees_collected().quote.0, 1_000 + fx);
        assert_eq!(s.get_fees_collected().base.0, 2_000 + fy);
        let rm = r.remove.unwrap();
        assert_eq!(
            (rm.reported_x.0, rm.reported_y.0, rm.fees_x.0, rm.fees_y.0),
            (rx, ry, fx, fy)
        );
        assert_eq!(s.get_own_position(), None);
        assert_eq!(s.get_lock(), None);
        let w = s.get_settle_window();
        assert_eq!(w.settle_window_class, Class::Agent);
        assert_eq!(w.last_payout_callback_block.0, CALL_BLOCK + 8);
        assert_eq!(
            w.settle_until_block.0,
            CALL_BLOCK + 8 + PAYOUT_SETTLE_BLOCKS
        );
        assert!(calls().is_empty());
        assert_eq!(last_event()["event"], "action_result");
        // The platform's cut follows: fees / 20 per token.
        assert_eq!(s.platform_owed(0), (1_000 + fx) / 20);
    }
}

#[test]
fn a_failed_remove_keeps_the_position_and_counts_nothing() {
    let mut s = removing();
    removed(&mut s, PromiseResult::Failed);
    assert_ended(&s, ActionResult::Failed("remove".into()), true, true);
    assert_eq!(
        s.get_fees_collected().quote.0 + s.get_fees_collected().base.0,
        0
    );
    // The agent can try again after the window: a new close with a new hash.
    let gap = limits_args().min_action_interval_s.0 * NANOS_PER_S;
    let blk = CALL_BLOCK + 8 + PAYOUT_SETTLE_BLOCKS + 3 * OFFCHAIN_MARGIN_BLOCKS;
    at("agent.near", blk, NOW + gap, OK_GAS);
    let _ = s.agent_close_position(pos(), meta(2, blk - 5), confirm(blk - 5 - 40));
    assert!(s.get_lock().is_some());
}

/// A success whose result can't be read: the position is gone (the receipt succeeded) but no
/// fee is counted; the record is `Unknown`.
#[test]
fn an_unreadable_remove_result_clears_the_position_and_counts_no_fees() {
    for body in [
        "null",
        "[\"1\"]",
        "[\"1\",\"2\",\"3\"]",
        "[1,2]",
        "[\"01\",\"2\"]",
        "{}",
        "not json",
    ] {
        let mut s = removing();
        removed(&mut s, ok(body));
        assert_ended(&s, ActionResult::Unknown, true, false);
        assert_eq!(
            s.get_fees_collected().quote.0 + s.get_fees_collected().base.0,
            0,
            "{body}"
        );
    }
}

/// A position that is gone (`null`) or now owned by another account: cleared with no fees, the
/// record `Refused(own_position_gone)`, the window open, no remove sent (5.2 principle 7).
#[test]
fn a_vanished_position_is_cleared_without_fees() {
    for liq in [
        "null".to_string(),
        liq_json(
            &LIQ.to_string(),
            "someone.near",
            &limits_args().pool,
            &pos(),
        ),
    ] {
        let mut s = holding();
        let _ = agent_close(&mut s, 1);
        round1(&mut s, vec![ok(&liq)]);
        assert_ended(
            &s,
            ActionResult::Refused("own_position_gone".into()),
            true,
            false,
        );
        assert_eq!(s.get_fees_collected().quote.0, 0);
    }
}

#[test]
fn read_refusals_end_the_record_and_keep_the_position() {
    let pool = limits_args().pool;
    let cases: Vec<(&str, Vec<PromiseResult>, ActionResult)> = vec![
        (
            "failed read",
            vec![PromiseResult::Failed],
            ActionResult::Failed("read".into()),
        ),
        (
            "two results",
            vec![ok(&good_liq()), ok("1")],
            ActionResult::Failed("read".into()),
        ),
        (
            "not json",
            vec![ok("zz")],
            ActionResult::Failed("read".into()),
        ),
        (
            "bad amount",
            vec![ok(&liq_json("01", ME, &pool, &pos()))],
            ActionResult::Failed("read".into()),
        ),
        (
            "other pool",
            vec![ok(&liq_json("5", ME, "a|b|100", &pos()))],
            ActionResult::Refused("position".into()),
        ),
        (
            "other id",
            vec![ok(&liq_json("5", ME, &pool, "x#1"))],
            ActionResult::Refused("position".into()),
        ),
    ];
    for (name, res, want) in cases {
        let mut s = holding();
        let _ = agent_close(&mut s, 1);
        round1(&mut s, res);
        assert_ended(&s, want, false, true);
        let _ = name;
    }
    // The prediction: failed, not an array, wrong length, non-strict.
    for res in [
        PromiseResult::Failed,
        ok("{}"),
        ok(r#"["1"]"#),
        ok(r#"["1","2","3"]"#),
        ok(r#"["01","2"]"#),
        ok(r#"[1,2]"#),
    ] {
        let mut s = holding();
        let _ = agent_close(&mut s, 1);
        round1(&mut s, vec![ok(&good_liq())]);
        predicted(&mut s, vec![res]);
        assert_ended(&s, ActionResult::Failed("read".into()), false, true);
    }
}

#[test]
fn after_a_remove_settle_can_close_the_strategy() {
    let mut s = removing();
    removed(&mut s, ok(r#"["79509995","120505042"]"#));
    s.status = Status::Closing;
    let blk = CALL_BLOCK + 8 + PAYOUT_SETTLE_BLOCKS;
    at("outsider.near", blk, NOW, MIN_GAS_SETTLE);
    let _ = s.settle();
    let id = op_id(&s);
    cb_env(blk + 2, vec![ok("{}")]);
    s.on_settle_assets(id);
    assert_eq!(s.get_status(), Status::Closed);
}

// ---- exit_remove ----

fn expect_exit_refusal(
    s: &mut Strategy,
    who: &str,
    ts: u64,
    block: u64,
    gas: Gas,
    p: &str,
    msg: &str,
) {
    let before = snap(s);
    let r = refused(|| {
        let _ = exit_at(s, who, ts, block, gas, p);
    });
    assert_eq!(r, msg, "{who}");
    assert!(calls().is_empty(), "{msg}");
    assert_eq!(snap(s), before, "{msg}");
}

#[test]
fn exit_remove_access_by_status_and_role() {
    let end = config().run_end_ns.0;
    let grace = config().exit_grace_ns.0;
    // Running: only an outsider, and only from run_end + exit_grace.
    for (who, ts, allowed) in [
        ("agent.near", end + grace, false),
        ("creator.near", end + grace, false),
        ("outsider.near", end + grace - 1, false),
        ("outsider.near", end + grace, true),
    ] {
        let mut s = holding();
        if allowed {
            let _ = exit_at(&mut s, who, ts, CALL_BLOCK, OK_GAS, &pos());
            assert!(s.get_lock().is_some());
        } else {
            expect_exit_refusal(
                &mut s,
                who,
                ts,
                CALL_BLOCK,
                OK_GAS,
                &pos(),
                "LIMIT: exit not open yet",
            );
        }
    }
    // Closing and Closed: agent and creator at any time, an outsider only after the grace.
    for st in [Status::Closing, Status::Closed] {
        for (who, ts, allowed) in [
            ("agent.near", NOW, true),
            ("creator.near", NOW, true),
            ("outsider.near", end + grace - 1, false),
            ("platform.near", end + grace - 1, false),
            ("outsider.near", end + grace, true),
        ] {
            let mut s = holding();
            s.status = st;
            if allowed {
                let _ = exit_at(&mut s, who, ts, CALL_BLOCK, OK_GAS, &pos());
                let l = s.get_lock().unwrap();
                assert_eq!(l.stage, Stage::ReadRound);
                assert_eq!(rec(&s).kind, ActionKind::ExitRemove);
                assert_eq!(rec(&s).caller.as_str(), who);
            } else {
                expect_exit_refusal(
                    &mut s,
                    who,
                    ts,
                    CALL_BLOCK,
                    OK_GAS,
                    &pos(),
                    "LIMIT: exit not open yet",
                );
            }
        }
    }
    for st in [Status::Open, Status::Cancelled] {
        let mut s = holding();
        s.status = st;
        expect_exit_refusal(
            &mut s,
            "agent.near",
            NOW,
            CALL_BLOCK,
            OK_GAS,
            &pos(),
            "LIMIT: wrong status",
        );
    }
}

#[test]
fn exit_remove_refusals_in_order() {
    let low = Gas::from_gas(MIN_GAS_REMOVE.as_gas() - 1);
    let mut s = closing();
    s.lock = Some(Lock {
        op_id: U64(9),
        op: Op::Settle,
        stage: Stage::ReadAssets,
        promise_block: U64(BLOCK),
    });
    expect_exit_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        low,
        &pos(),
        "LIMIT: operation pending",
    );
    s.lock = None;
    expect_exit_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        low,
        "other#1",
        "LIMIT: not the own position",
    );
    // The rate limit: the same class again inside the interval is refused; at the interval it is not.
    let gap = limits_args().min_action_interval_s.0 * NANOS_PER_S;
    let _ = exit_at(&mut s, "agent.near", NOW, CALL_BLOCK, OK_GAS, &pos());
    s.lock = None;
    expect_exit_refusal(
        &mut s,
        "agent.near",
        NOW + gap - 1,
        CALL_BLOCK,
        low,
        &pos(),
        "LIMIT: rate limited",
    );
    // The creator has its own slot.
    let _ = exit_at(&mut s, "creator.near", NOW + 1, CALL_BLOCK, OK_GAS, &pos());
    s.lock = None;
    // The stale cooldown, then gas.
    s.stale_resolution_block = Some(CALL_BLOCK);
    expect_exit_refusal(
        &mut s,
        "agent.near",
        NOW + gap,
        CALL_BLOCK + 1,
        low,
        &pos(),
        "LIMIT: stale cooldown",
    );
    s.stale_resolution_block = None;
    expect_exit_refusal(
        &mut s,
        "agent.near",
        NOW + gap,
        CALL_BLOCK,
        low,
        &pos(),
        "LIMIT: gas",
    );
    // At the interval it is allowed.
    let _ = exit_at(&mut s, "agent.near", NOW + gap, CALL_BLOCK, OK_GAS, &pos());
    assert!(s.get_lock().is_some());
}

/// EC-C104: an exit has no slot, quiet or decision checks; its record has no decision hash and
/// uses no decision slot; it never touches the 24-hour count's hash set.
#[test]
fn exit_remove_runs_the_same_stages_with_no_decision() {
    let mut s = closing();
    let _ = exit_at(&mut s, "agent.near", NOW, CALL_BLOCK, OK_GAS, &pos());
    let r = rec(&s);
    assert_eq!(r.decision_hash, "");
    assert!(s.seen_decisions.is_empty());
    assert_eq!(r.remove.as_ref().unwrap().confirm_observed, None);
    assert_eq!(
        s.get_lock().unwrap().op,
        Op::Remove {
            index: U64(0),
            class: Class::Agent
        }
    );
    round1(&mut s, vec![ok(&good_liq())]);
    predicted(&mut s, vec![pred(100, 200)]);
    removed(&mut s, ok(r#"["100","200"]"#));
    assert_eq!(rec(&s).result, ActionResult::Ok);
    assert_eq!(s.get_own_position(), None);
    assert_eq!(s.get_fees_collected().quote.0, 100);
    assert_eq!(s.get_fees_collected().base.0, 200);
    // The window is the caller's class: a creator's exit opens it as the creator's.
    let mut s = closing();
    let _ = exit_at(&mut s, "creator.near", NOW, CALL_BLOCK, OK_GAS, &pos());
    round1(&mut s, vec![ok(&good_liq())]);
    predicted(&mut s, vec![pred(1, 1)]);
    removed(&mut s, ok(r#"["1","1"]"#));
    assert_eq!(s.get_settle_window().settle_window_class, Class::Creator);
}

/// A lost remove leaves the position; `exit_remove` then reads `null` and clears it, no fees.
#[test]
fn a_lost_remove_is_cleared_by_an_exit_that_finds_it_gone() {
    let mut s = removing();
    let stale = CALL_BLOCK + 4 + config().stale_after_blocks.0;
    at("outsider.near", stale, NOW, Gas::from_tgas(30));
    s.resolve_stale();
    assert_eq!(rec(&s).result, ActionResult::Unknown);
    assert_eq!(s.get_lock(), None);
    assert!(s.get_own_position().is_some());
    assert_ne!(s.get_settle_window().settle_until_block.0, 0);
    // An exit after the cooldown: DCL says null.
    s.status = Status::Closing;
    let blk = stale + config().stale_cooldown_blocks.0;
    let _ = exit_at(&mut s, "agent.near", NOW, blk, OK_GAS, &pos());
    let id = op_id(&s);
    cb_env(blk + 2, vec![ok("null")]);
    s.on_remove_reads(id);
    assert_eq!(
        s.actions[1].result,
        ActionResult::Refused("own_position_gone".into())
    );
    assert_eq!(s.get_own_position(), None);
    assert_eq!(s.get_fees_collected().quote.0, 0);
    // A lost read stage is `Failed(read)` with no window.
    let mut s = holding();
    let _ = agent_close(&mut s, 1);
    let stale = CALL_BLOCK + config().stale_after_blocks.0;
    at("outsider.near", stale, NOW, Gas::from_tgas(30));
    s.resolve_stale();
    assert_eq!(rec(&s).result, ActionResult::Failed("read".into()));
    assert_eq!(s.get_lock(), None);
    assert!(s.get_own_position().is_some());
    assert_eq!(s.get_settle_window().settle_until_block.0, 0);
}

#[test]
fn remove_callbacks_act_only_on_their_own_stage() {
    let mut s = holding();
    let _ = agent_close(&mut s, 1);
    let before = snap(&s);
    let id = op_id(&s);
    cb_env(CALL_BLOCK + 2, vec![pred(1, 1)]);
    s.on_remove_predicted(id);
    assert_eq!(last_event()["event"], "callback_ignored");
    s.on_removed(id);
    cb_env(CALL_BLOCK + 2, vec![ok(&good_liq())]);
    s.on_remove_reads(U64(55));
    assert_eq!(snap(&s), before);
    assert!(calls().is_empty());
    near_sdk::testing_env!(ctx("agent.near", BAL, Gas::from_tgas(10), CALL_BLOCK).build());
    assert_eq!(refused(|| s.on_remove_reads(id)), "AUTH: callback only");
    assert_eq!(refused(|| s.on_remove_predicted(id)), "AUTH: callback only");
    assert_eq!(refused(|| s.on_removed(id)), "AUTH: callback only");
    let _ = (events(), quote(), DAY_NS);
}

proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig::with_cases(24))]
    /// EC-C115: the counted fee is never above what was unclaimed nor what was reported.
    #[test]
    fn fees_are_the_minimum_of_unclaimed_and_reported(rx in proptest::prelude::any::<u128>(), ry in proptest::prelude::any::<u128>()) {
        let mut s = removing();
        removed(&mut s, ok(&format!(r#"["{rx}","{ry}"]"#)));
        proptest::prop_assert_eq!(s.get_fees_collected().quote.0, UX.min(rx));
        proptest::prop_assert_eq!(s.get_fees_collected().base.0, UY.min(ry));
    }
}

/// EC-C171: the largest `ClosePosition` record fits the storage reserve's `RECORD_BYTES`, also
/// with the longest accepted position id.
#[test]
fn a_remove_record_fits_the_reserve() {
    let mut s = removing();
    removed(&mut s, ok(r#"["79509995","120505042"]"#));
    s.actions[0].remove.as_mut().unwrap().position = "p".repeat(128);
    s.actions[0].chain_head = Some(hash(9));
    let bytes = near_sdk::borsh::to_vec(&s.actions[0]).unwrap().len();
    assert!(bytes <= super::start::RECORD_BYTES as usize, "{bytes}");
}

/// Security audit H1 (contract review F1): the agent's close leaves the last slots for exits, and
/// `exit_remove` still runs with the log full, clears the position, and `settle` then passes.
#[test]
fn the_log_keeps_slots_for_the_exit_that_clears_the_position() {
    let mut s = holding();
    s.limits.max_actions_per_24h = 1_000;
    for i in 0..(MAX_ACTIONS_STORED - RESERVED_SLOTS - 1) as u64 {
        s.actions.push(synthetic(i, 1));
    }
    // One below the reserve: the close is allowed; at the reserve it is refused.
    let _ = agent_close(&mut s, 1);
    assert!(s.get_lock().is_some());
    s.release();
    s.actions.pop();
    s.actions.push(synthetic(0, 1));
    s.actions.push(synthetic(1, 1));
    assert_eq!(s.actions.len(), MAX_ACTIONS_STORED - RESERVED_SLOTS + 1);
    expect_close_refusal(
        &mut s,
        "agent.near",
        NOW,
        OK_GAS,
        &pos(),
        meta(2, OBS),
        confirm(OBS - OFFCHAIN_MARGIN_BLOCKS),
        "LIMIT: action log full",
    );
    // The log completely full: the exit still runs.
    while s.actions.len() < MAX_ACTIONS_STORED {
        s.actions.push(synthetic(s.actions.len() as u64, 1));
    }
    s.status = Status::Closing;
    let _ = exit_at(&mut s, "agent.near", NOW, CALL_BLOCK, OK_GAS, &pos());
    assert_eq!(s.actions.len(), MAX_ACTIONS_STORED + 1);
    let idx = (s.actions.len() - 1) as u64;
    let id = op_id(&s);
    cb_env(CALL_BLOCK + 2, vec![ok(&good_liq())]);
    s.on_remove_reads(id);
    predicted(&mut s, vec![pred(100, 200)]);
    removed(&mut s, ok(r#"["100","200"]"#));
    assert_eq!(s.get_action(U64(idx)).unwrap().result, ActionResult::Ok);
    assert_eq!(s.get_own_position(), None);
}

/// Security audit L2: a position with no liquidity is cleared (it would otherwise block `settle`
/// for ever), as a vanished one is, with the window open and no fees counted.
#[test]
fn an_empty_position_is_cleared() {
    let mut s = holding();
    let _ = agent_close(&mut s, 1);
    round1(
        &mut s,
        vec![ok(&liq_json("0", ME, &limits_args().pool, &pos()))],
    );
    assert_ended(
        &s,
        ActionResult::Refused("own_position_gone".into()),
        true,
        false,
    );
}

/// Security audit M1: the first confirming observation must be after `settle_until_block`.
#[test]
fn the_confirming_observation_must_be_quiet() {
    let mut s = holding();
    // The payout margin check is the stricter one in v1, so lower it out of the way.
    s.last_payout_callback_block = 0;
    s.settle_until_block = OBS - OFFCHAIN_MARGIN_BLOCKS + 1;
    expect_close_refusal(
        &mut s,
        "agent.near",
        NOW,
        OK_GAS,
        &pos(),
        meta(1, OBS),
        confirm(OBS - OFFCHAIN_MARGIN_BLOCKS),
        "LIMIT: observation not quiet",
    );
    s.settle_until_block = OBS - OFFCHAIN_MARGIN_BLOCKS;
    let _ = agent_close(&mut s, 1);
    assert!(s.get_lock().is_some());
}

/// EC-C130 (per status): a close is refused outside `Running`.
#[test]
fn a_close_is_refused_in_every_status_but_running() {
    for st in [
        Status::Open,
        Status::Cancelled,
        Status::Closing,
        Status::Closed,
    ] {
        let mut s = holding();
        s.status = st;
        expect_close_refusal(
            &mut s,
            "agent.near",
            NOW,
            OK_GAS,
            &pos(),
            meta(1, OBS),
            confirm(OBS - OFFCHAIN_MARGIN_BLOCKS),
            "LIMIT: wrong status",
        );
    }
}

/// EC-C171, EC-C172 (contract review, round 4a; principle 8): a failed or refused exit leaves no
/// record, so exits that keep failing cannot grow the log; an exit that clears the position keeps
/// its full record.
#[test]
fn failing_exits_leave_no_record_but_a_productive_exit_does() {
    let gap = limits_args().min_action_interval_s.0 * NANOS_PER_S;
    let mut s = closing();
    let mut ts = NOW;
    for (i, outcome) in [
        PromiseResult::Failed,                     // the read fails
        ok(&liq_json("5", ME, "a|b|100", &pos())), // another pool: Refused(position)
        ok("zz"),                                  // unreadable
    ]
    .into_iter()
    .enumerate()
    {
        let _ = exit_at(
            &mut s,
            "agent.near",
            ts,
            CALL_BLOCK + 10 * i as u64,
            OK_GAS,
            &pos(),
        );
        assert_eq!(s.actions.len(), 1, "the call took a record");
        let id = op_id(&s);
        cb_env(CALL_BLOCK + 10 * i as u64 + 2, vec![outcome]);
        s.on_remove_reads(id);
        assert_eq!(
            s.actions.len(),
            0,
            "a failed or refused exit leaves no record"
        );
        assert_eq!(last_event()["event"], "action_result");
        assert!(s.get_own_position().is_some());
        assert_eq!(s.get_lock(), None);
        ts += gap;
    }
    // The prediction fails: also no record.
    let _ = exit_at(&mut s, "agent.near", ts, CALL_BLOCK + 100, OK_GAS, &pos());
    round1(&mut s, vec![ok(&good_liq())]);
    predicted(&mut s, vec![PromiseResult::Failed]);
    assert_eq!(s.actions.len(), 0);
    // A failed remove: no record either.
    ts += gap;
    let _ = exit_at(&mut s, "agent.near", ts, CALL_BLOCK + 200, OK_GAS, &pos());
    round1(&mut s, vec![ok(&good_liq())]);
    predicted(&mut s, vec![pred(1, 1)]);
    removed(&mut s, PromiseResult::Failed);
    assert_eq!(s.actions.len(), 0);
    // A productive exit keeps its record.
    ts += gap;
    let _ = exit_at(&mut s, "agent.near", ts, CALL_BLOCK + 300, OK_GAS, &pos());
    round1(&mut s, vec![ok(&good_liq())]);
    predicted(&mut s, vec![pred(1, 1)]);
    removed(&mut s, ok(r#"["1","1"]"#));
    assert_eq!(s.actions.len(), 1);
    assert_eq!(s.actions[0].result, ActionResult::Ok);
    // A vanished position keeps its record too (it clears `own_position`).
    let mut s = closing();
    let _ = exit_at(&mut s, "agent.near", NOW, CALL_BLOCK, OK_GAS, &pos());
    round1(&mut s, vec![ok("null")]);
    assert_eq!(s.actions.len(), 1);
    assert_eq!(
        s.actions[0].result,
        ActionResult::Refused("own_position_gone".into())
    );
}
