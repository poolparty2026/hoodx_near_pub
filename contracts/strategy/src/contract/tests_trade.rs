//! Slice 7 unit tests: the action log and `agent_swap` with its read round and result (EC-C95,
//! EC-C96, EC-C97, EC-C105, EC-C106, EC-C116, EC-C126, EC-C128, EC-C130, EC-C155, EC-C170). The
//! real DCL's answers and the gas are for the sandbox test.
use super::tests::*;
use super::tests_funding::{at, base, events, last_event, ok, quote};
use super::tests_start::{pool, started};
use super::*;
use crate::limits::NANOS_PER_S;
use crate::price;
use near_sdk::PromiseResult;

const POINT: i32 = 401_312;
const LEFT: i32 = 400_812;
const RIGHT: i32 = 401_812;
const CALL_BLOCK: u64 = BLOCK + 100;
const NEED_X: u128 = 1_000_000_000_000_000_000;
const NEED_Y: u128 = 290_000_000_000_000_000_000_000_000_000_000_000;

fn hash(n: u64) -> String {
    format!("{n:064x}")
}
fn meta(n: u64, point: i32, block: u64) -> Meta {
    Meta {
        observed: Observed {
            block: U64(block),
            point,
        },
        decision_hash: hash(n),
        chain_head: Some(hash(1000 + n)),
    }
}
fn good_meta(n: u64) -> Meta {
    meta(n, POINT, CALL_BLOCK - 5)
}
fn swap_at(s: &mut Strategy, who: &str, ts: u64, block: u64, gas: Gas, m: Meta) -> Promise {
    at(who, block, ts, gas);
    s.agent_swap(LEFT, RIGHT, m)
}
fn agent_swap(s: &mut Strategy, n: u64) -> Promise {
    swap_at(s, "agent.near", NOW, CALL_BLOCK, MIN_GAS_SWAP, good_meta(n))
}
fn snap(s: &Strategy) -> String {
    near_sdk::serde_json::to_string(&(
        s.get_status(),
        s.get_lock(),
        s.actions.clone(),
        s.seen_decisions.clone(),
        s.swaps_used,
        s.get_settle_window(),
        s.next_op_id,
    ))
    .unwrap()
}
fn expect_refusal(s: &mut Strategy, who: &str, ts: u64, block: u64, gas: Gas, m: Meta, msg: &str) {
    let before = snap(s);
    let r = refused(|| {
        let _ = swap_at(s, who, ts, block, gas, m);
    });
    assert_eq!(r, msg, "{who}");
    assert!(calls().is_empty(), "{msg}");
    assert_eq!(snap(s), before, "{msg}");
}
fn read_env(block: u64, ts: u64, res: Vec<PromiseResult>) {
    let mut b = ctx(ME, BAL, GAS_SWAP_READ_CB, block);
    b.block_timestamp(ts);
    near_sdk::testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        res
    );
}
fn predict(x: u128, y: u128) -> String {
    format!(r#"{{"need_x":"{x}","need_y":"{y}","liquidity_amount":"1"}}"#)
}
/// The four reads: pool at `point`, the two wallet balances, the predict.
fn reads(point: i64, quote_bal: &str, base_bal: &str, pred: &str) -> Vec<PromiseResult> {
    vec![
        ok(&pool(point, "Running", &quote(), &base())),
        ok(&format!("\"{quote_bal}\"")),
        ok(&format!("\"{base_bal}\"")),
        ok(pred),
    ]
}
fn good_reads() -> Vec<PromiseResult> {
    reads(POINT as i64, "500000000", "0", &predict(NEED_X, NEED_Y))
}
fn round(s: &mut Strategy, res: Vec<PromiseResult>) {
    let id = s.get_lock().map(|l| l.op_id.0).unwrap_or(99);
    read_env(CALL_BLOCK + 2, NOW, res);
    s.on_swap_reads(U64(id));
}
fn swapped(s: &mut Strategy, block: u64, res: PromiseResult) {
    let id = s.get_lock().map(|l| l.op_id.0).unwrap_or(99);
    let mut b = ctx(ME, BAL, GAS_SWAP_RESULT, block);
    b.block_timestamp(NOW);
    near_sdk::testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![res]
    );
    s.on_swapped(U64(id));
}
fn assert_refused_action(s: &Strategy, reason: &str) {
    let r = s.get_action(U64(0)).unwrap();
    assert_eq!(
        r.result,
        ActionResult::Refused(reason.to_string()),
        "{reason}"
    );
    assert_eq!(s.get_lock(), None, "{reason}");
    assert!(calls().is_empty(), "{reason}");
    assert_eq!(s.swaps_used, 0);
    assert!(r.result_block.is_some() && r.result_ts_ns.is_some());
}
fn running_with(n: usize) -> Strategy {
    // A strategy with `n` finished records `NOW - ...` apart, to test the windows.
    let mut s = started();
    for i in 0..n {
        s.actions.push(synthetic(i as u64, NOW));
    }
    s
}
fn synthetic(i: u64, ts: u64) -> ActionRecord {
    ActionRecord {
        index: U64(i),
        op_id: U64(100 + i),
        kind: ActionKind::Swap,
        caller: acc("agent.near"),
        left_point: LEFT,
        right_point: RIGHT,
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

// ---- the first checks (EC-C126, EC-C130, EC-C155) ----

#[test]
fn a_valid_call_takes_the_lock_records_and_sends_four_reads() {
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    let l = s.get_lock().unwrap();
    assert_eq!(
        (l.op, l.stage),
        (Op::Swap { index: U64(0) }, Stage::ReadRound)
    );
    assert_eq!(s.get_actions_len(), U64(1));
    let r = s.get_action(U64(0)).unwrap();
    assert_eq!(
        (
            r.kind,
            r.result.clone(),
            r.caller.as_str(),
            r.left_point,
            r.right_point
        ),
        (
            ActionKind::Swap,
            ActionResult::Pending,
            "agent.near",
            LEFT,
            RIGHT
        )
    );
    assert_eq!(
        (r.call_block.0, r.timestamp_ns.0, r.decision_hash.as_str()),
        (CALL_BLOCK, NOW, hash(1).as_str())
    );
    assert_eq!(r.chain_head, Some(hash(1001)));
    assert_eq!(
        r.observed,
        Observed {
            block: U64(CALL_BLOCK - 5),
            point: POINT
        }
    );
    assert_eq!(s.seen_decisions.len(), 1);
    assert_eq!(last_event()["event"], "action");
    let c = calls();
    assert_eq!(c.len(), 5, "{c:?}");
    let dcl = network().dcl_contract;
    let pool_id = limits_args().pool;
    assert_eq!(
        (c[0].0.as_str(), c[0].1.as_str(), c[0].3, c[0].4),
        (dcl.as_str(), "get_pool", 0, GAS_VIEW.as_gas())
    );
    assert_eq!(c[0].2, format!(r#"{{"pool_id":"{pool_id}"}}"#));
    for (i, tok) in [(1, quote()), (2, base())] {
        assert_eq!(
            (c[i].0.as_str(), c[i].1.as_str(), c[i].3, c[i].4),
            (tok.as_str(), "ft_balance_of", 0, GAS_READ_STORAGE.as_gas())
        );
        assert_eq!(c[i].2, format!(r#"{{"account_id":"{ME}"}}"#));
    }
    assert_eq!(
        (c[3].0.as_str(), c[3].1.as_str(), c[3].3, c[3].4),
        (
            dcl.as_str(),
            "predict_add_liquidity",
            0,
            GAS_PREDICT.as_gas()
        )
    );
    assert_eq!(
        c[3].2,
        format!(
            r#"{{"pool_id":"{pool_id}","left_point":{LEFT},"right_point":{RIGHT},"amount_x":"{PROBE_X}","amount_y":"{PROBE_Y}"}}"#
        )
    );
    assert_eq!(
        (c[4].0.as_str(), c[4].1.as_str(), c[4].2.as_str()),
        (ME, "on_swap_reads", r#"{"op_id":"1"}"#)
    );
    assert_eq!((c[4].3, c[4].4, c[4].5), (0, GAS_SWAP_READ_CB.as_gas(), 0));
}

/// Principle 5's order, each refusal alone, nothing changed, no promise, no record.
#[test]
fn agent_swap_refusals_in_order() {
    let low = Gas::from_gas(MIN_GAS_SWAP.as_gas() - 1);
    let m = good_meta(1);
    // Status first.
    for st in [
        Status::Open,
        Status::Cancelled,
        Status::Closing,
        Status::Closed,
    ] {
        let mut s = started();
        s.status = st;
        expect_refusal(
            &mut s,
            "outsider.near",
            NOW,
            CALL_BLOCK,
            low,
            m.clone(),
            "LIMIT: wrong status",
        );
    }
    // The caller: every role but the agent, by predecessor.
    let mut s = started();
    for who in [
        "creator.near",
        "outsider.near",
        "platform.near",
        "deliverer.near",
        ME,
    ] {
        expect_refusal(
            &mut s,
            who,
            NOW,
            CALL_BLOCK,
            low,
            meta(1, 0, 0),
            "AUTH: agent only",
        );
    }
    // The run's end, then the lock.
    let end = config().run_end_ns.0;
    s.lock = Some(Lock {
        op_id: U64(9),
        op: Op::Settle,
        stage: Stage::ReadAssets,
        promise_block: U64(BLOCK),
    });
    expect_refusal(
        &mut s,
        "agent.near",
        end,
        CALL_BLOCK,
        low,
        m.clone(),
        "LIMIT: run ended",
    );
    expect_refusal(
        &mut s,
        "agent.near",
        end - 1,
        CALL_BLOCK,
        low,
        m.clone(),
        "LIMIT: operation pending",
    );
    s.lock = None;
    // Interval and the 24-hour count.
    let mut s = running_with(1);
    s.actions[0].timestamp_ns = U64(NOW);
    let gap = limits_args().min_action_interval_s.0 * NANOS_PER_S;
    expect_refusal(
        &mut s,
        "agent.near",
        NOW + gap - 1,
        CALL_BLOCK,
        low,
        m.clone(),
        "LIMIT: action interval",
    );
    let _ = swap_at(
        &mut s,
        "agent.near",
        NOW + gap,
        CALL_BLOCK,
        MIN_GAS_SWAP,
        m.clone(),
    );
    assert!(s.get_lock().is_some());
    // The 24-hour count: 6 records inside the window refuse, one aged out of it does not.
    let mut s = running_with(6);
    let day = 86_400 * NANOS_PER_S;
    expect_refusal(
        &mut s,
        "agent.near",
        NOW + 2 * gap,
        CALL_BLOCK,
        low,
        m.clone(),
        "LIMIT: actions per 24h",
    );
    s.actions[0].timestamp_ns = U64(NOW - day + 3 * gap); // ages out at NOW + 3 * gap... still inside at 2 * gap
    expect_refusal(
        &mut s,
        "agent.near",
        NOW + 2 * gap,
        CALL_BLOCK,
        low,
        m.clone(),
        "LIMIT: actions per 24h",
    );
    s.actions[0].timestamp_ns = U64(NOW - day);
    for a in s.actions.iter_mut().skip(1) {
        a.timestamp_ns = U64(NOW - 2 * gap);
    }
    let _ = swap_at(
        &mut s,
        "agent.near",
        NOW + gap,
        CALL_BLOCK,
        MIN_GAS_SWAP,
        m.clone(),
    );
    assert!(
        s.get_lock().is_some(),
        "a record exactly a day old no longer counts"
    );
    // The counters: opened, a position, swaps per run.
    for (name, msg) in [
        ("opened", "LIMIT: already opened"),
        ("position", "LIMIT: position exists"),
        ("swaps", "LIMIT: swaps per run"),
    ] {
        let mut s = started();
        match name {
            "opened" => s.opened = true,
            "position" => s.own_position = Some("7".into()),
            _ => s.swaps_used = 2,
        }
        expect_refusal(&mut s, "agent.near", NOW, CALL_BLOCK, low, m.clone(), msg);
    }
    // Quietness: the settle window, then the payout margin.
    let mut s = started();
    s.settle_until_block = CALL_BLOCK + 1;
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        low,
        m.clone(),
        "LIMIT: not quiet",
    );
    s.settle_until_block = CALL_BLOCK;
    s.last_payout_callback_block = CALL_BLOCK - 5 - OFFCHAIN_MARGIN_BLOCKS + 1;
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        low,
        m.clone(),
        "LIMIT: inside payout margin",
    );
    s.last_payout_callback_block = CALL_BLOCK - 5 - OFFCHAIN_MARGIN_BLOCKS;
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        low,
        m.clone(),
        "LIMIT: gas",
    );
    // Gas before the observation; the observation before the hash; the hash before the points.
    let mut s = started();
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        low,
        meta(1, 0, CALL_BLOCK),
        "LIMIT: gas",
    );
    let age = limits_args().max_observation_age_blocks.0;
    for b in [CALL_BLOCK + 1, CALL_BLOCK - age - 1] {
        expect_refusal(
            &mut s,
            "agent.near",
            NOW,
            CALL_BLOCK,
            MIN_GAS_SWAP,
            meta(1, 0, b),
            "LIMIT: observation age",
        );
    }
    for h in [
        "",
        "abc",
        &"A".repeat(64),
        &"g".repeat(64),
        &"a".repeat(63),
        &"a".repeat(65),
    ] {
        let mut mm = meta(1, 0, CALL_BLOCK);
        mm.decision_hash = h.to_string();
        expect_refusal(
            &mut s,
            "agent.near",
            NOW,
            CALL_BLOCK,
            MIN_GAS_SWAP,
            mm,
            "LIMIT: decision hash",
        );
    }
    s.seen_decisions.push(parse_hash(&hash(1)).unwrap());
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        MIN_GAS_SWAP,
        meta(1, 0, CALL_BLOCK),
        "LIMIT: decision hash",
    );
}

/// The points: bounds, order, spacing (fee 100 has spacing 1), width limits and the observed point.
#[test]
fn agent_swap_points() {
    let mut s = started();
    let mut w = |l: i32, r: i32, p: i32| {
        at("agent.near", CALL_BLOCK, NOW, MIN_GAS_SWAP);
        refused(|| {
            let _ = s.agent_swap(l, r, meta(9, p, CALL_BLOCK));
        })
    };
    for (l, r, p) in [
        (RIGHT, LEFT, POINT),              // reversed
        (LEFT, LEFT, LEFT),                // empty
        (LEFT, LEFT + 999, POINT),         // width 999 < min 1000
        (LEFT, LEFT + 2001, POINT),        // width 2001 > max 2000
        (800_000 - 999, 800_001, 800_000), // above the bound
        (-800_001, -800_001 + 1000, -800_000),
        (LEFT, RIGHT, LEFT - 1), // observed below the range
        (LEFT, RIGHT, RIGHT),    // observed at the right edge (half-open)
        (i32::MIN, i32::MAX, 0),
    ] {
        assert_eq!(w(l, r, p), "LIMIT: points", "{l} {r} {p}");
    }
    // Widths 1000 and 2000, the edges of the range, and the extreme points are accepted.
    for (l, r, p) in [
        (LEFT, LEFT + 1000, LEFT),
        (LEFT, LEFT + 2000, LEFT + 1999),
        (LEFT, RIGHT, RIGHT - 1),
        (799_000, 800_000, 799_999),
        (-800_000, -799_000, -800_000),
    ] {
        let mut t = started();
        at("agent.near", CALL_BLOCK, NOW, MIN_GAS_SWAP);
        let _ = t.agent_swap(l, r, meta(9, p, CALL_BLOCK));
        assert!(t.get_lock().is_some(), "{l} {r} {p}");
    }
}

/// The log is capped at `MAX_ACTIONS_STORED`: the 65th call is refused, nothing changed.
#[test]
fn the_action_log_is_capped() {
    let mut s = started();
    s.limits.max_actions_per_24h = 100; // the cap under test is the log's, not the window's
    for i in 0..MAX_ACTIONS_STORED - RESERVED_SLOTS - 1 {
        s.actions.push(synthetic(i as u64, 1));
    }
    // At the limit - 1 a swap still goes through (it fills the last swap slot).
    let mut s2 = started();
    for i in 0..MAX_ACTIONS_STORED - RESERVED_SLOTS - 1 {
        s2.actions.push(synthetic(i as u64, 1));
    }
    s2.limits.max_actions_per_24h = 100;
    let _ = agent_swap(&mut s2, 1);
    assert_eq!(s2.actions.len(), MAX_ACTIONS_STORED - RESERVED_SLOTS);
    s.actions.push(synthetic(99, 1));
    // The reserved slots stay free for the open, the close and the exits (security L4).
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        MIN_GAS_SWAP,
        good_meta(1),
        "LIMIT: action log full",
    );
}

/// EC-C171: `chain_head` is 64 lowercase hex or absent (contract review H1, security M1), and the
/// largest valid record fits the storage reserve's `RECORD_BYTES`.
#[test]
fn chain_head_is_bounded_and_a_record_fits_the_reserve() {
    let mut s = started();
    for bad in [
        "0".repeat(63),
        "0".repeat(65),
        "A".repeat(64),
        "x".repeat(1_000_000),
        String::new(),
    ] {
        let mut m = good_meta(1);
        m.chain_head = Some(bad);
        expect_refusal(
            &mut s,
            "agent.near",
            NOW,
            CALL_BLOCK,
            MIN_GAS_SWAP,
            m,
            "LIMIT: chain head",
        );
    }
    let mut m = good_meta(1);
    m.chain_head = None;
    let _ = swap_at(&mut s, "agent.near", NOW, CALL_BLOCK, MIN_GAS_SWAP, m);
    s.release();
    // The largest record: every optional part present.
    let mut s = started();
    let _ = agent_swap(&mut s, 2);
    round(&mut s, good_reads());
    swapped(&mut s, CALL_BLOCK + 9, ok("\"5\""));
    let bytes = near_sdk::borsh::to_vec(&s.actions[0]).unwrap().len();
    assert!(bytes <= super::start::RECORD_BYTES as usize, "{bytes}");
}

/// Roles are the predecessor, never the signer.
#[test]
fn the_agent_is_the_predecessor_not_the_signer() {
    let mut s = started();
    let mut b = ctx("relay.near", BAL, MIN_GAS_SWAP, CALL_BLOCK);
    b.signer_account_id(acc("agent.near")).block_timestamp(NOW);
    near_sdk::testing_env!(b.build());
    assert_eq!(
        refused(|| {
            let _ = s.agent_swap(LEFT, RIGHT, good_meta(1));
        }),
        "AUTH: agent only"
    );
    assert!(s.actions.is_empty());
}

// ---- the read round (EC-C95, EC-C96, EC-C97, EC-C105, EC-C106, EC-C116) ----

#[test]
fn a_good_round_sends_the_swap() {
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    round(&mut s, good_reads());
    let r = s.get_action(U64(0)).unwrap();
    assert_eq!(
        r.result,
        ActionResult::Pending,
        "pending until the swap reports"
    );
    assert_eq!(
        r.reference,
        Some(Observed {
            block: U64(CALL_BLOCK + 2),
            point: POINT
        })
    );
    let round_info = r.round.clone().unwrap();
    assert_eq!(
        (
            round_info.spendable_quote.0,
            round_info.spendable_base.0,
            round_info.need_x.0,
            round_info.need_y.0
        ),
        (500_000_000, 0, NEED_X, NEED_Y)
    );
    let swap = r.swap.clone().unwrap();
    let q = quote();
    assert_eq!(swap.token_in, acc(&q));
    // The amount is the library's, about half of the 500 USDC, never more than held.
    let want = price::swap_for_range(500_000_000, 0, NEED_X, NEED_Y, POINT);
    assert_eq!(want, Some(Some(price::SwapStep::SellX(swap.amount_in.0))));
    assert!(
        swap.amount_in.0 > 240_000_000 && swap.amount_in.0 < 260_000_000,
        "{}",
        swap.amount_in.0
    );
    let floor = price::swap_min_output(0, swap.amount_in.0, true, POINT, true, 100, 60).unwrap();
    assert_eq!(swap.min_out.0, floor);
    assert_eq!(s.get_lock().unwrap().stage, Stage::Swapping);
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(
        (c[0].0.as_str(), c[0].1.as_str(), c[0].3, c[0].4),
        (q.as_str(), "ft_transfer_call", 1, GAS_SWAP.as_gas())
    );
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&c[0].2).unwrap();
    assert_eq!(
        (args["receiver_id"].as_str(), args["amount"].as_str()),
        (
            Some(network().dcl_contract.as_str()),
            Some(swap.amount_in.0.to_string().as_str())
        )
    );
    let msg: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(args["msg"].as_str().unwrap()).unwrap();
    assert_eq!(
        msg,
        near_sdk::serde_json::json!({"Swap": {
            "pool_ids": [limits_args().pool],
            "output_token": base(),
            "min_output_amount": swap.min_out.0.to_string(),
            "skip_unwrap_near": true,
        }})
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
            "on_swapped",
            r#"{"op_id":"1"}"#,
            GAS_SWAP_RESULT.as_gas(),
            0
        )
    );
}

/// Every refusal after the lock: the record says why, the lock is released, nothing is sent, the
/// action still counts toward the windows, nothing is counted as used.
#[test]
fn the_round_refuses_with_a_reason() {
    let cases: Vec<(&str, Vec<PromiseResult>)> = vec![
        (
            "pool",
            vec![
                ok(&pool(POINT as i64, "Paused", &quote(), &base())),
                ok("\"1\""),
                ok("\"0\""),
                ok(&predict(1, 1)),
            ],
        ),
        (
            "pool",
            vec![
                ok(&pool(POINT as i64, "Running", "other.near", &base())),
                ok("\"1\""),
                ok("\"0\""),
                ok(&predict(1, 1)),
            ],
        ),
        (
            "pool",
            vec![
                ok(&pool(900_000, "Running", &quote(), &base())),
                ok("\"1\""),
                ok("\"0\""),
                ok(&predict(1, 1)),
            ],
        ),
        (
            "drift",
            reads(
                POINT as i64 + 31,
                "500000000",
                "0",
                &predict(NEED_X, NEED_Y),
            ),
        ),
        (
            "drift",
            reads(
                POINT as i64 - 31,
                "500000000",
                "0",
                &predict(NEED_X, NEED_Y),
            ),
        ),
        (
            "centring",
            reads(
                LEFT as i64 + 249,
                "500000000",
                "0",
                &predict(NEED_X, NEED_Y),
            ),
        ),
        (
            "centring",
            reads(
                RIGHT as i64 - 249,
                "500000000",
                "0",
                &predict(NEED_X, NEED_Y),
            ),
        ),
        (
            "predict",
            reads(POINT as i64, "500000000", "0", &predict(0, 0)),
        ),
        (
            "no_swap_needed",
            reads(POINT as i64, "0", "0", &predict(NEED_X, NEED_Y)),
        ),
        (
            "swap_step",
            reads(
                POINT as i64,
                "1",
                "999999999999999999999999",
                &predict(NEED_X, 0),
            ),
        ),
    ];
    let mut centring_points = [LEFT + 249, RIGHT - 249].into_iter();
    for (reason, res) in cases {
        let mut s = started();
        // The drift cases observe the live point and the pool moves; the centring cases have the
        // agent observe the (off-centre) point the pool is really at, so only the centring fails.
        let observed = if reason == "centring" {
            centring_points.next().unwrap()
        } else {
            POINT
        };
        let _ = swap_at(
            &mut s,
            "agent.near",
            NOW,
            CALL_BLOCK,
            MIN_GAS_SWAP,
            meta(1, observed, CALL_BLOCK - 5),
        );
        round(&mut s, res);
        assert_refused_action(&s, reason);
        assert_eq!(last_event()["event"], "action_result");
        // It still counts toward the interval.
        let gap = limits_args().min_action_interval_s.0 * NANOS_PER_S;
        expect_refusal(
            &mut s,
            "agent.near",
            NOW + gap - 1,
            CALL_BLOCK + 5,
            MIN_GAS_SWAP,
            good_meta(2),
            "LIMIT: action interval",
        );
    }
}

/// The drift and centring boundaries are inclusive/exclusive exactly: 30 away is fine, 31 refused;
/// 250 from an edge is fine, 249 refused.
#[test]
fn drift_and_centring_boundaries() {
    for (p, expect_ok) in [
        (POINT as i64 + 30, true),
        (POINT as i64 - 30, true),
        (LEFT as i64 + 250, true),
        (RIGHT as i64 - 250, true),
    ] {
        let mut s = started();
        let _ = swap_at(
            &mut s,
            "agent.near",
            NOW,
            CALL_BLOCK,
            MIN_GAS_SWAP,
            meta(1, p as i32, CALL_BLOCK - 5),
        );
        round(&mut s, reads(p, "500000000", "0", &predict(NEED_X, NEED_Y)));
        assert_eq!(
            s.get_lock().map(|l| l.stage),
            expect_ok.then_some(Stage::Swapping),
            "{p}"
        );
    }
}

/// Unreadable reads and answers are `Failed("read")`, never a swap.
#[test]
fn bad_reads_never_swap() {
    let pool_ok = || ok(&pool(POINT as i64, "Running", &quote(), &base()));
    let cases: Vec<Vec<PromiseResult>> = vec![
        vec![],
        vec![pool_ok(), ok("\"1\""), ok("\"0\"")],
        vec![
            PromiseResult::Failed,
            ok("\"1\""),
            ok("\"0\""),
            ok(&predict(1, 1)),
        ],
        vec![
            pool_ok(),
            PromiseResult::Failed,
            ok("\"0\""),
            ok(&predict(1, 1)),
        ],
        vec![
            pool_ok(),
            ok("\"1\""),
            PromiseResult::Failed,
            ok(&predict(1, 1)),
        ],
        vec![pool_ok(), ok("\"1\""), ok("\"0\""), PromiseResult::Failed],
        vec![pool_ok(), ok("\"+1\""), ok("\"0\""), ok(&predict(1, 1))],
        vec![pool_ok(), ok("\"01\""), ok("\"0\""), ok(&predict(1, 1))],
        vec![pool_ok(), ok("5"), ok("\"0\""), ok(&predict(1, 1))],
        vec![pool_ok(), ok("\"1\""), ok("null"), ok(&predict(1, 1))],
        vec![pool_ok(), ok("\"1\""), ok("\"0\""), ok(r#"{"need_x":"1"}"#)],
        vec![
            pool_ok(),
            ok("\"1\""),
            ok("\"0\""),
            ok(r#"{"need_x":"1","need_y":2}"#),
        ],
        vec![pool_ok(), ok("\"1\""), ok("\"0\""), ok("not json")],
        vec![pool_ok(), ok("\"1\""), ok("\"0\""), ok(&"x".repeat(5_000))],
    ];
    for res in cases {
        let mut s = started();
        let _ = agent_swap(&mut s, 1);
        round(&mut s, res);
        let r = s.get_action(U64(0)).unwrap();
        assert_eq!(r.result, ActionResult::Failed("read".into()));
        assert_eq!((s.get_lock(), calls().len(), s.swaps_used), (None, 0, 0));
    }
}

/// A risk-adding stage re-checks the status and the run's end.
#[test]
fn the_round_rechecks_status_and_the_run_end() {
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    s.status = Status::Closing;
    round(&mut s, good_reads());
    assert_refused_action(&s, "status");
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    let id = s.get_lock().unwrap().op_id.0;
    read_env(CALL_BLOCK + 2, config().run_end_ns.0, good_reads());
    s.on_swap_reads(U64(id));
    assert_refused_action(&s, "run_ended");
}

/// Both tokens: holdings in base only are swapped the other way; the pool's token order is read, not assumed.
#[test]
fn the_swap_direction_follows_the_holdings_and_the_pool_order() {
    // Base only: sell the base for the quote token.
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    round(
        &mut s,
        reads(
            POINT as i64,
            "0",
            "2000000000000000000000000",
            &predict(NEED_X, NEED_Y),
        ),
    );
    let swap = s.get_action(U64(0)).unwrap().swap.unwrap();
    assert_eq!(swap.token_in, acc(&base()));
    assert!(swap.amount_in.0 > 0 && swap.amount_in.0 < 2_000_000_000_000_000_000_000_000);
    let msg: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(
        near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(&calls()[0].2).unwrap()
            ["msg"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(msg["Swap"]["output_token"], quote());
    // The pool lists the quote token as token_y: the point and the needs mirror, the holdings map
    // to the other axis, and the quote token is sold.
    let mut s = started();
    let (l, r, p) = (-RIGHT, -LEFT, -POINT);
    at("agent.near", CALL_BLOCK, NOW, MIN_GAS_SWAP);
    let _ = s.agent_swap(l, r, meta(1, p, CALL_BLOCK - 5));
    let mut res = reads(p as i64, "500000000", "0", &predict(NEED_Y, NEED_X));
    res[0] = ok(&pool(p as i64, "Running", &base(), &quote()));
    round(&mut s, res);
    let swap = s.get_action(U64(0)).unwrap().swap.unwrap();
    assert_eq!(swap.token_in, acc(&quote()));
    assert_eq!(
        price::swap_for_range(0, 500_000_000, NEED_Y, NEED_X, p),
        Some(Some(price::SwapStep::SellY(swap.amount_in.0)))
    );
    assert!(swap.amount_in.0 > 240_000_000 && swap.amount_in.0 < 260_000_000);
}

// ---- the result (EC-C105) ----

#[test]
fn a_swap_with_used_above_zero_is_ok_and_opens_the_window() {
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    round(&mut s, good_reads());
    let amount = s.get_action(U64(0)).unwrap().swap.unwrap().amount_in.0;
    swapped(&mut s, CALL_BLOCK + 9, ok(&format!("\"{amount}\"")));
    let r = s.get_action(U64(0)).unwrap();
    assert_eq!(r.result, ActionResult::Ok);
    assert_eq!(r.swap.unwrap().used.0, amount);
    assert_eq!(
        (r.result_block, r.result_ts_ns),
        (Some(U64(CALL_BLOCK + 9)), Some(U64(NOW)))
    );
    assert_eq!((s.swaps_used, s.get_lock()), (1, None));
    let w = s.get_settle_window();
    assert_eq!(
        (
            w.settle_until_block.0,
            w.last_payout_callback_block.0,
            w.settle_window_class
        ),
        (
            CALL_BLOCK + 9 + PAYOUT_SETTLE_BLOCKS,
            CALL_BLOCK + 9,
            Class::Agent
        )
    );
    assert_eq!(last_event()["event"], "action_result");
    // A second swap waits for the window and the margin, then works until two are used.
    let gap = limits_args().min_action_interval_s.0 * NANOS_PER_S;
    let late = CALL_BLOCK + 9 + OFFCHAIN_MARGIN_BLOCKS + 10;
    expect_refusal(
        &mut s,
        "agent.near",
        NOW + gap,
        late,
        MIN_GAS_SWAP,
        meta(2, POINT, CALL_BLOCK + 9 + 1),
        "LIMIT: inside payout margin",
    );
    let _ = swap_at(
        &mut s,
        "agent.near",
        NOW + gap,
        late,
        MIN_GAS_SWAP,
        meta(2, POINT, CALL_BLOCK + 9 + OFFCHAIN_MARGIN_BLOCKS),
    );
    assert!(s.get_lock().is_some());
    s.lock = None;
    s.swaps_used = 2;
    expect_refusal(
        &mut s,
        "agent.near",
        NOW + 2 * gap,
        late + 1,
        MIN_GAS_SWAP,
        meta(3, POINT, late - 1),
        "LIMIT: swaps per run",
    );
}

#[test]
fn a_refused_swap_and_a_failed_swap_are_not_ok() {
    // used 0: the pool refused, nothing moved, no window.
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    round(&mut s, good_reads());
    swapped(&mut s, CALL_BLOCK + 9, ok("\"0\""));
    assert_eq!(
        s.get_action(U64(0)).unwrap().result,
        ActionResult::SwapRefused
    );
    assert_eq!(
        (
            s.swaps_used,
            s.get_settle_window().settle_until_block.0,
            s.get_lock()
        ),
        (0, 0, None)
    );
    // A failed receipt and every non-strict result: Failed("swap"), nothing counted.
    for res in [
        PromiseResult::Failed,
        ok(""),
        ok("01"),
        ok("\"01\""),
        ok("\"+5\""),
        ok("5"),
        ok("null"),
        ok("\"1.0\""),
        ok("\"-1\""),
    ] {
        let mut s = started();
        let _ = agent_swap(&mut s, 1);
        round(&mut s, good_reads());
        swapped(&mut s, CALL_BLOCK + 9, res);
        assert_eq!(
            s.get_action(U64(0)).unwrap().result,
            ActionResult::Failed("swap".into())
        );
        assert_eq!(
            (
                s.swaps_used,
                s.get_settle_window().settle_until_block.0,
                s.get_lock()
            ),
            // Every failed or unreadable result counts toward the swap cap (round 5 C, EC-C97, EC-C172).
            (1u8, CALL_BLOCK + 9 + PAYOUT_SETTLE_BLOCKS, None),
            "a failed swap may still have moved tokens, so the window opens"
        );
    }
}

// ---- callbacks and stale ----

#[test]
fn the_trading_callbacks_act_only_on_their_own_lock() {
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    let before = snap(&s);
    for who in ["agent.near", "creator.near", "outsider.near"] {
        near_sdk::testing_env!(
            ctx(who, BAL, GAS_SWAP_READ_CB, CALL_BLOCK + 2).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            good_reads()
        );
        assert_eq!(refused(|| s.on_swap_reads(U64(1))), "AUTH: callback only");
        assert_eq!(refused(|| s.on_swapped(U64(1))), "AUTH: callback only");
    }
    assert_eq!(snap(&s), before);
    read_env(CALL_BLOCK + 2, NOW, good_reads());
    s.on_swap_reads(U64(9)); // another op
    s.on_swapped(U64(1)); // right op, wrong stage
    assert_eq!(snap(&s), before);
    assert!(calls().is_empty());
    assert_eq!(
        events()
            .iter()
            .filter(|e| e["event"] == "callback_ignored")
            .count(),
        2
    );
    // A duplicate read-round callback after it ran is ignored.
    round(&mut s, good_reads());
    let before = snap(&s);
    read_env(CALL_BLOCK + 3, NOW, good_reads());
    s.on_swap_reads(U64(1));
    assert_eq!(snap(&s), before);
}

/// A lost swap: `resolve_stale` marks the record `Unknown`, opens the window (tokens may have
/// moved), starts the cooldown; the lost callback arriving late is ignored.
#[test]
fn a_lost_swap_is_unknown_and_opens_the_window() {
    let stale = config().stale_after_blocks.0;
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    round(&mut s, good_reads()); // swap out at CALL_BLOCK + 2
    at(
        "outsider.near",
        CALL_BLOCK + 2 + stale,
        NOW,
        Gas::from_tgas(10),
    );
    s.resolve_stale();
    assert_eq!(s.get_lock(), None);
    let r = s.get_action(U64(0)).unwrap();
    assert_eq!(r.result, ActionResult::Unknown);
    assert_eq!(r.result_block, Some(U64(CALL_BLOCK + 2 + stale)));
    let w = s.get_settle_window();
    assert_eq!(
        (w.settle_until_block.0, w.settle_window_class),
        (CALL_BLOCK + 2 + stale + PAYOUT_SETTLE_BLOCKS, Class::Agent)
    );
    let before = snap(&s);
    swapped(&mut s, CALL_BLOCK + 2 + stale + 1, ok("\"5\""));
    assert_eq!(snap(&s), before);
    assert_eq!(
        s.swaps_used, 1,
        "a lost swap counts toward the cap, so a lost callback buys no extra swap"
    );
}

/// A call lost before its swap was sent moved nothing: failed read, no window, no swap counted.
#[test]
fn a_call_lost_in_the_read_round_is_failed_and_opens_no_window() {
    let stale = config().stale_after_blocks.0;
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    at("outsider.near", CALL_BLOCK + stale, NOW, Gas::from_tgas(10));
    s.resolve_stale();
    assert_eq!(s.get_lock(), None);
    assert_eq!(
        s.get_action(U64(0)).unwrap().result,
        ActionResult::Failed("read".into())
    );
    assert_eq!(
        (s.swaps_used, s.get_settle_window().settle_until_block.0),
        (0, 0)
    );
}

// ---- views ----

#[test]
fn the_action_views() {
    let mut s = started();
    for i in 0..25 {
        s.actions.push(synthetic(i, 1));
    }
    assert_eq!(s.get_actions_len(), U64(25));
    assert_eq!(s.get_actions(U64(0), 5).len(), 5);
    assert_eq!(
        s.get_actions(U64(0), 1_000).len(),
        20,
        "capped at 20 a page"
    );
    assert_eq!(s.get_actions(U64(20), 20).len(), 5);
    assert_eq!(s.get_actions(U64(25), 20).len(), 0);
    assert_eq!(s.get_actions(U64(u64::MAX), 20).len(), 0);
    assert_eq!(s.get_action(U64(24)).unwrap().index, U64(24));
    assert_eq!(s.get_action(U64(25)), None);
    assert_eq!(
        (s.get_swaps_used(), s.get_opened(), s.get_own_position()),
        (0, false, None)
    );
    // The record's JSON: integers above 2^53 as strings, the result an enum object or a string.
    let j = near_sdk::serde_json::to_value(s.get_action(U64(3)).unwrap()).unwrap();
    assert_eq!(
        (
            j["index"].as_str(),
            j["call_block"].as_str(),
            j["kind"].as_str()
        ),
        (Some("3"), Some("1"), Some("Swap"))
    );
    assert_eq!(
        j["result"],
        near_sdk::serde_json::json!({"Refused": "drift"})
    );
}

// ---- test audit of slice 7: limits at the limit, funds flow, identity, order ----

/// One good round on a strategy mutated by `f`; returns it with the action 0 record.
fn round_with(f: impl FnOnce(&mut Strategy), res: Vec<PromiseResult>) -> Strategy {
    let mut s = started();
    f(&mut s);
    let _ = agent_swap(&mut s, 1);
    round(&mut s, res);
    s
}
fn record(s: &Strategy) -> ActionRecord {
    s.get_action(U64(0)).unwrap()
}
/// The swap a good round computes: its `amount_in` and the total value it is capped against.
fn good_step() -> (u128, u128) {
    let s = round_with(|_| {}, good_reads());
    (record(&s).swap.unwrap().amount_in.0, 500_000_000)
}

/// EC-C97: a swap of exactly `max_swap_step_bps` goes through, one basis point less refuses.
#[test]
fn the_step_cap_holds_at_the_limit_and_one_below() {
    let (a, total) = good_step();
    let bps = ((a * 10_000).div_ceil(total)) as u16; // the smallest cap that admits `a`
    let s = round_with(|s| s.limits.max_swap_step_bps = bps, good_reads());
    assert_eq!(
        s.get_lock().map(|l| l.stage),
        Some(Stage::Swapping),
        "at the limit"
    );
    let s = round_with(|s| s.limits.max_swap_step_bps = bps - 1, good_reads());
    assert_refused_action(&s, "swap_step");
}

/// EC-C116: the deploy cap. A step of exactly `max_principal` goes through, one unit less cap
/// refuses `swap_step` (the minimal build refuses rather than scaling the step down; D55).
#[test]
fn the_deploy_cap_holds_at_the_limit_and_one_below() {
    let (a, _) = good_step();
    let s = round_with(|s| s.limits.max_principal = U128(a), good_reads());
    assert_eq!(
        s.get_lock().map(|l| l.stage),
        Some(Stage::Swapping),
        "at the limit"
    );
    let s = round_with(|s| s.limits.max_principal = U128(a - 1), good_reads());
    assert_refused_action(&s, "swap_step");
}

/// The platform's accrued share is held back from what the swap may use, per token, and
/// a share above the balance leaves nothing (funds flow).
#[test]
fn platform_owed_is_not_spendable() {
    // owed quote = 200_000_000 / 20 = 10_000_000; owed base = 2_000 / 20 - 40 = 60.
    let s = round_with(
        |s| {
            s.fees_collected = [200_000_000, 2_000];
            s.paid_platform = [0, 40];
        },
        reads(POINT as i64, "500000000", "1000", &predict(NEED_X, NEED_Y)),
    );
    let r = record(&s).round.expect("round");
    assert_eq!(
        (r.spendable_quote.0, r.spendable_base.0),
        (490_000_000, 940)
    );
    // Owed above the balance: nothing spendable in that token.
    let s = round_with(
        |s| {
            s.fees_collected = [20_000_000_000, 0];
        },
        reads(POINT as i64, "500000000", "0", &predict(NEED_X, NEED_Y)),
    );
    // With nothing spendable the round cannot swap.
    assert_eq!(s.get_lock(), None);
    assert!(matches!(record(&s).result, ActionResult::Refused(_)));
    assert!(record(&s).swap.is_none());
}

fn pool_json(id: &str, x: &str, y: &str) -> String {
    format!(
        r#"{{"pool_id":"{id}","token_x":"{x}","token_y":"{y}","fee":100,"point_delta":1,"current_point":{POINT},"state":"Running","liquidity":"0","total_x":"0","total_y":"0"}}"#
    )
}
fn with_pool(p: &str) -> Vec<PromiseResult> {
    vec![
        ok(p),
        ok("\"500000000\""),
        ok("\"0\""),
        ok(&predict(NEED_X, NEED_Y)),
    ]
}

/// EC-C170: only the exact pool and its two tokens, in either order, are swapped into.
#[test]
fn the_pool_identity_is_exact() {
    let id = limits_args().pool;
    let (q, b) = (quote(), base());
    for (p, why) in [
        (
            pool_json(&id, &q, "other.near"),
            "right quote, wrong partner (x is quote)",
        ),
        (
            pool_json(&id, "other.near", &q),
            "right quote, wrong partner (y is quote)",
        ),
        (pool_json(&id, &b, &b), "no quote"),
        (pool_json("other|pool|100", &q, &b), "another pool id"),
        (
            pool_json(&id, &b, "other.near"),
            "base with a wrong partner",
        ),
        (r#"{"state":"Running"}"#.to_string(), "no tokens"),
        (
            r#"{"token_x":1,"token_y":2}"#.to_string(),
            "non-string tokens",
        ),
        ("[]".to_string(), "not an object"),
    ] {
        let s = round_with(|_| {}, with_pool(&p));
        assert_refused_action(&s, "pool");
        let _ = why;
    }
    // Both orders of the right pair are accepted.
    for p in [pool_json(&id, &q, &b), pool_json(&id, &b, &q)] {
        let s = round_with(|_| {}, with_pool(&p));
        assert_ne!(record(&s).result, ActionResult::Refused("pool".into()));
    }
}

/// EC-C95: drift of exactly `max_observation_drift_bps` is allowed, one more refused.
#[test]
fn the_drift_limit_is_inclusive() {
    for (pool_point, ok_) in [
        (POINT as i64 + 30, true),
        (POINT as i64 - 30, true),
        (POINT as i64 + 31, false),
        (POINT as i64 - 31, false),
    ] {
        let s = round_with(
            |_| {},
            reads(pool_point, "500000000", "0", &predict(NEED_X, NEED_Y)),
        );
        if ok_ {
            assert_eq!(
                s.get_lock().map(|l| l.stage),
                Some(Stage::Swapping),
                "{pool_point}"
            );
        } else {
            assert_refused_action(&s, "drift");
        }
    }
}

/// The observation may be exactly `max_observation_age_blocks` old, not one more, and not newer
/// than the call.
#[test]
fn the_observation_age_is_inclusive() {
    let age = limits_args().max_observation_age_blocks.0;
    for (ob, expect) in [
        (CALL_BLOCK - age, None),
        (CALL_BLOCK, None),
        (CALL_BLOCK - age - 1, Some("LIMIT: observation age")),
        (CALL_BLOCK + 1, Some("LIMIT: observation age")),
    ] {
        let mut s = started();
        match expect {
            None => {
                let _ = swap_at(
                    &mut s,
                    "agent.near",
                    NOW,
                    CALL_BLOCK,
                    MIN_GAS_SWAP,
                    meta(1, POINT, ob),
                );
                assert!(s.get_lock().is_some(), "{ob}");
            }
            Some(m) => expect_refusal(
                &mut s,
                "agent.near",
                NOW,
                CALL_BLOCK,
                MIN_GAS_SWAP,
                meta(1, POINT, ob),
                m,
            ),
        }
    }
}

/// Principle 5's order, pairwise: each case violates two checks, and the earlier one's message wins.
#[test]
fn the_first_checks_run_in_order() {
    let gap = limits_args().min_action_interval_s.0 * NANOS_PER_S;
    let low = Gas::from_gas(MIN_GAS_SWAP.as_gas() - 1);
    let call = |s: &mut Strategy, ts: u64, gas: Gas, m: Meta, msg: &str| {
        expect_refusal(s, "agent.near", ts, CALL_BLOCK, gas, m, msg)
    };
    // lock before interval (the lock is taken by a call at the same time).
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    call(
        &mut s,
        NOW,
        MIN_GAS_SWAP,
        good_meta(2),
        "LIMIT: operation pending",
    );
    // interval before the 24-hour count.
    let mut s = started();
    s.limits.max_actions_per_24h = 1;
    s.actions.push(synthetic(0, NOW));
    call(
        &mut s,
        NOW,
        MIN_GAS_SWAP,
        good_meta(2),
        "LIMIT: action interval",
    );
    // 24-hour count before opened / position / swaps / quiet / gas / points / log full.
    let mut s = started();
    s.limits.max_actions_per_24h = 1;
    s.actions.push(synthetic(0, NOW - gap));
    s.opened = true;
    s.own_position = Some("1".into());
    s.swaps_used = 2;
    s.settle_until_block = u64::MAX;
    call(&mut s, NOW, low, meta(2, 0, 0), "LIMIT: actions per 24h");
    s.limits.max_actions_per_24h = 100;
    // opened, then position, then swaps, then quiet, then gas, then points, then log full.
    call(&mut s, NOW, low, meta(2, 0, 0), "LIMIT: already opened");
    s.opened = false;
    call(&mut s, NOW, low, meta(2, 0, 0), "LIMIT: position exists");
    s.own_position = None;
    call(&mut s, NOW, low, meta(2, 0, 0), "LIMIT: swaps per run");
    s.swaps_used = 0;
    call(&mut s, NOW, low, meta(2, 0, 0), "LIMIT: not quiet");
    s.settle_until_block = 0;
    call(&mut s, NOW, low, meta(2, 0, CALL_BLOCK - 5), "LIMIT: gas");
    // points before the log is full.
    let mut s = started();
    s.limits.max_actions_per_24h = 100;
    for i in 0..MAX_ACTIONS_STORED {
        s.actions.push(synthetic(i as u64, 1));
    }
    let mut bad = good_meta(2);
    bad.observed.point = 0;
    call(&mut s, NOW, MIN_GAS_SWAP, bad, "LIMIT: points");
}

/// The interval reads the **last** record, and the 24-hour window edge is exact.
#[test]
fn the_interval_uses_the_last_record_and_the_day_edge_is_exact() {
    let gap = limits_args().min_action_interval_s.0 * NANOS_PER_S;
    let day = 86_400 * NANOS_PER_S;
    // Old first, recent last: refused. Recent first, old last: allowed.
    let mut s = started();
    s.actions.push(synthetic(0, 1));
    s.actions.push(synthetic(1, NOW));
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        MIN_GAS_SWAP,
        good_meta(1),
        "LIMIT: action interval",
    );
    let mut s = started();
    s.actions.push(synthetic(0, NOW));
    s.actions.push(synthetic(1, NOW - gap));
    let _ = agent_swap(&mut s, 1);
    assert!(s.get_lock().is_some());
    // A record one nanosecond inside the day still counts; one exactly a day old does not.
    for (age, counts) in [(day - 1, true), (day, false)] {
        let mut s = started();
        s.limits.max_actions_per_24h = 1;
        s.actions.push(synthetic(0, NOW - age));
        if counts {
            expect_refusal(
                &mut s,
                "agent.near",
                NOW,
                CALL_BLOCK,
                MIN_GAS_SWAP,
                good_meta(1),
                "LIMIT: actions per 24h",
            );
        } else {
            let _ = agent_swap(&mut s, 1);
            assert!(s.get_lock().is_some());
        }
    }
}

/// Spacing is checked on both ends for every fee tier; an unknown tier refuses every range.
#[test]
fn point_spacing_is_checked_on_both_ends() {
    assert_eq!(
        [100, 400, 1000, 2000, 10000, 7].map(point_delta),
        [Some(1), Some(8), Some(20), Some(40), Some(200), None]
    );
    let mut s = started();
    s.limits.pool = format!("a.near|b.near|{}", 400);
    at("agent.near", CALL_BLOCK, NOW, MIN_GAS_SWAP);
    let check = |s: &Strategy, l: i32, r: i32| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            s.trading_points(l, r, l + 8)
        }))
        .is_ok()
    };
    let msg = |s: &Strategy, l: i32, r: i32| refused(|| s.trading_points(l, r, l + 8));
    assert!(check(&s, 400_000, 401_000));
    assert_eq!(
        msg(&s, 400_001, 401_000),
        "LIMIT: points",
        "left off the grid"
    );
    assert_eq!(
        msg(&s, 400_000, 401_001),
        "LIMIT: points",
        "right off the grid"
    );
    s.limits.pool = "a.near|b.near|7".into();
    assert_eq!(msg(&s, 400_000, 401_000), "LIMIT: points", "unknown tier");
}

/// EC-C97, EC-C172 (round 5 C): every failed or unreadable swap result (a failed receipt, an oversized result,
/// a non-strict body) counts toward `MAX_SWAPS_PER_RUN`, so after two the agent is refused
/// `LIMIT: swaps per run`; only `SwapRefused` (used 0) does not count.
#[test]
fn unreadable_swap_results_use_the_swap_cap() {
    let gap = limits_args().min_action_interval_s.0 * NANOS_PER_S;
    let mut s = started();
    s.limits.max_actions_per_24h = 100;
    for i in 0..2u64 {
        let ts = NOW + i * gap;
        let blk = CALL_BLOCK + i * 200;
        at("agent.near", blk, ts, MIN_GAS_SWAP);
        let _ = s.agent_swap(LEFT, RIGHT, meta(10 + i, POINT, blk - 5));
        let id = s.get_lock().map(|l| l.op_id.0).unwrap();
        read_env(blk + 2, ts, good_reads());
        s.on_swap_reads(U64(id));
        let mut b = ctx(ME, BAL, GAS_SWAP_RESULT, blk + 9);
        b.block_timestamp(ts);
        near_sdk::testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![ok("5")]
        );
        s.on_swapped(U64(id));
        assert_eq!(s.swaps_used as u64, i + 1);
    }
    // A failed receipt and an oversized result count too (a fresh strategy, one of each).
    for res in [
        PromiseResult::Failed,
        ok(&format!("\"{}\"", "9".repeat(5_000))),
    ] {
        let mut s = started();
        let _ = agent_swap(&mut s, 1);
        round(&mut s, good_reads());
        swapped(&mut s, CALL_BLOCK + 9, res);
        assert_eq!(s.swaps_used, 1, "a failed or oversized result is counted");
        assert_eq!(
            s.get_action(U64(0)).unwrap().result,
            ActionResult::Failed("swap".into())
        );
    }
    let ts = NOW + 2 * gap;
    expect_refusal(
        &mut s,
        "agent.near",
        ts,
        CALL_BLOCK + 600,
        MIN_GAS_SWAP,
        meta(99, POINT, CALL_BLOCK + 595),
        "LIMIT: swaps per run",
    );
}

/// EC-C97, EC-C116 (test audit H1): a swap whose minimum output would be 0 is refused
/// `Refused("floor")` before anything is sent, with no window; one more unit of excess gives a
/// minimum of 1 and the swap goes out. Holdings sit in the range's ratio but for a small excess of
/// the base token, so the step is a tiny sale of base (worth under 1 raw USDC at the point).
#[test]
fn a_zero_swap_floor_is_refused_and_one_unit_more_is_not() {
    let hold_y = |excess: u128| format!("{}", 290_000_000_000_000_000_000_000u128 + excess);
    // Direct: the floor of a base sale at the live point is 0 below the price's inverse.
    assert_eq!(
        price::swap_min_output(0, 400_000_000_000_000_000, false, POINT, true, 100, 60),
        Some(0)
    );
    assert_eq!(
        price::swap_min_output(0, 800_000_000_000_000_000, false, POINT, true, 100, 60),
        Some(1)
    );
    // Through the contract.
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    round(
        &mut s,
        reads(
            POINT as i64,
            "1000000",
            &hold_y(660_000_000_000_000_000),
            &predict(NEED_X, NEED_Y),
        ),
    );
    assert_refused_action(&s, "floor");
    assert_eq!(s.get_settle_window().settle_until_block.0, 0);
    let mut s = started();
    let _ = agent_swap(&mut s, 1);
    round(
        &mut s,
        reads(
            POINT as i64,
            "1000000",
            &hold_y(1_320_000_000_000_000_000),
            &predict(NEED_X, NEED_Y),
        ),
    );
    assert_eq!(s.get_lock().unwrap().stage, Stage::Swapping);
    assert!(s.get_action(U64(0)).unwrap().swap.unwrap().min_out.0 >= 1);
}
