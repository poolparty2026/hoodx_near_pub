//! Slice 8 unit tests: `register_tokens` and `agent_open` with its four stages (EC-C95, EC-C96,
//! EC-C97, EC-C105, EC-C106, EC-C116, EC-C126, EC-C128, EC-C148, EC-C155, EC-C158, EC-R26, EC-R28).
//! Real DCL answers and gas are for the sandbox test (`strategy-sandbox/tests/open.rs`).
use super::tests::*;
use super::tests_funding::{at, base, events, last_event, ok, quote};
use super::tests_start::{pool, started};
use super::*;
use crate::limits::NANOS_PER_S;
use near_sdk::PromiseResult;

/// The mocked VM reserves far more per receipt than the real runtime, so a successful call is
/// given a large prepaid; the minimum itself is asserted at `MIN_GAS_OPEN - 1` and in the sandbox.
const OK_GAS: Gas = Gas::from_tgas(900);
const POINT: i32 = 401_312;
const LEFT: i32 = 400_812;
const RIGHT: i32 = 401_812;
const CALL_BLOCK: u64 = BLOCK + 100;
const NEED_X: u128 = 1_000_000_000_000_000_000;
const NEED_Y: u128 = 250_000_000_000_000_000_000_000_000_000_000_000;
/// 250 USDC and 62.5e24 yocto-wNEAR: exactly the probe's ratio, so `scale_need` takes both whole
/// (value at the reference is about 482 USDC, under the 500 USDC cap).
const ADD_X: u128 = 250_000_000;
const ADD_Y: u128 = 62_500_000_000_000_000_000_000_000;

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
fn registered() -> Strategy {
    let mut s = started();
    s.tokens_registered = true;
    s
}
fn open_at(s: &mut Strategy, who: &str, ts: u64, block: u64, gas: Gas, m: Meta) -> Promise {
    at(who, block, ts, gas);
    s.agent_open(LEFT, RIGHT, m)
}
fn agent_open(s: &mut Strategy, n: u64) -> Promise {
    open_at(s, "agent.near", NOW, CALL_BLOCK, OK_GAS, good_meta(n))
}
fn snap(s: &Strategy) -> String {
    near_sdk::serde_json::to_string(&(
        s.get_status(),
        s.get_lock(),
        s.actions.clone(),
        s.seen_decisions.clone(),
        s.get_opened(),
        s.get_own_position(),
        s.get_settle_window(),
        s.next_op_id,
    ))
    .unwrap()
}
fn expect_refusal(s: &mut Strategy, who: &str, ts: u64, block: u64, gas: Gas, m: Meta, msg: &str) {
    let before = snap(s);
    let r = refused(|| {
        let _ = open_at(s, who, ts, block, gas, m);
    });
    assert_eq!(r, msg, "{who}");
    assert!(calls().is_empty(), "{msg}");
    assert_eq!(snap(s), before, "{msg}");
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
fn predict(x: u128, y: u128) -> String {
    format!(r#"{{"need_x":"{x}","need_y":"{y}","liquidity_amount":"1"}}"#)
}
fn assets(q: u128, b: u128) -> String {
    format!(r#"{{"{}":"{q}","{}":"{b}"}}"#, quote(), base())
}
/// Round one: pool, quote wallet, base wallet, internal assets, probe.
fn reads1(point: i64, wq: u128, wb: u128, internal: &str, pred: &str) -> Vec<PromiseResult> {
    vec![
        ok(&pool(point, "Running", &quote(), &base())),
        ok(&format!("\"{wq}\"")),
        ok(&format!("\"{wb}\"")),
        ok(internal),
        ok(pred),
    ]
}
fn good1() -> Vec<PromiseResult> {
    reads1(POINT as i64, ADD_X, ADD_Y, "{}", &predict(NEED_X, NEED_Y))
}
fn round1(s: &mut Strategy, res: Vec<PromiseResult>) {
    let id = op_id(s);
    cb_env(CALL_BLOCK + 2, res);
    s.on_open_reads(id);
}
fn deposited(s: &mut Strategy, res: Vec<PromiseResult>) {
    let id = op_id(s);
    cb_env(CALL_BLOCK + 6, res);
    s.on_open_deposited(id);
}
fn reads2(point: i64, internal: &str, pred: &str) -> Vec<PromiseResult> {
    vec![
        ok(&pool(point, "Running", &quote(), &base())),
        ok(internal),
        ok(pred),
    ]
}
fn good2() -> Vec<PromiseResult> {
    reads2(POINT as i64, &assets(ADD_X, ADD_Y), &predict(ADD_X, ADD_Y))
}
fn round2(s: &mut Strategy, res: Vec<PromiseResult>) {
    let id = op_id(s);
    cb_env(CALL_BLOCK + 10, res);
    s.on_open_add_reads(id);
}
fn added(s: &mut Strategy, res: PromiseResult) {
    let id = op_id(s);
    cb_env(CALL_BLOCK + 14, vec![res]);
    s.on_open_added(id);
}
fn lpt() -> String {
    format!("\"{}#7\"", limits_args().pool)
}
fn full_deposit_results() -> Vec<PromiseResult> {
    vec![ok(&format!("\"{ADD_X}\"")), ok(&format!("\"{ADD_Y}\""))]
}
/// An open run to the add's launch.
fn adding() -> Strategy {
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    round1(&mut s, good1());
    deposited(&mut s, full_deposit_results());
    round2(&mut s, good2());
    s
}
fn record(s: &Strategy) -> ActionRecord {
    s.get_action(U64(0)).unwrap()
}
/// A callback refusal after the lock: the record's result, lock released, no promise.
fn assert_ended(s: &Strategy, result: ActionResult, window: bool) {
    let r = record(s);
    assert_eq!(r.result, result);
    assert_eq!(s.get_lock(), None);
    assert!(calls().is_empty(), "{result:?}");
    assert!(r.result_block.is_some() && r.result_ts_ns.is_some());
    assert!(
        !s.get_opened() && s.get_own_position().is_none(),
        "{result:?}"
    );
    let opened_window = s.get_settle_window().settle_until_block.0 != 0;
    assert_eq!(opened_window, window, "{result:?}");
    assert_eq!(last_event()["event"], "action_result");
}

// ---- register_tokens ----

fn register_as(s: &mut Strategy, who: &str, balance: u128, gas: Gas) -> Promise {
    near_sdk::testing_env!(ctx(who, balance, gas, CALL_BLOCK).build());
    s.register_tokens()
}

#[test]
fn register_tokens_sends_one_call_with_the_deposit_and_a_callback() {
    let mut s = started();
    let _ = register_as(&mut s, "creator.near", BAL, MIN_GAS_REGISTER_TOKENS);
    let l = s.get_lock().unwrap();
    assert_eq!((l.op, l.stage), (Op::RegisterTokens, Stage::Register));
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(
        (c[0].0.as_str(), c[0].1.as_str(), c[0].3, c[0].4),
        (
            network().dcl_contract.as_str(),
            "register_tokens",
            20_000_000_000_000_000_000_000,
            GAS_REGISTER_TOKENS.as_gas()
        )
    );
    assert_eq!(
        c[0].2,
        format!(r#"{{"token_ids":["{}","{}"]}}"#, quote(), base())
    );
    assert_eq!(
        (c[1].0.as_str(), c[1].1.as_str(), c[1].2.as_str()),
        (ME, "on_tokens_registered", r#"{"op_id":"1"}"#)
    );
    assert_eq!((c[1].3, c[1].4, c[1].5), (0, GAS_CALLBACK.as_gas(), 0));
    assert!(!s.get_tokens_registered());
    assert_eq!(last_event()["event"], "register_tokens_started");
}

/// Principle 5's order: status, caller, lock, already done, gas, balance (at and one below).
#[test]
fn register_tokens_refusals_in_order() {
    let low = Gas::from_gas(MIN_GAS_REGISTER_TOKENS.as_gas() - 1);
    let dep = REGISTER_TOKENS_DEPOSIT.as_yoctonear();
    let check = |s: &mut Strategy, who: &str, bal: u128, gas: Gas, msg: &str| {
        let before = snap(s);
        let r = refused(|| {
            let _ = register_as(s, who, bal, gas);
        });
        assert_eq!(r, msg);
        assert!(calls().is_empty());
        assert_eq!(snap(s), before);
    };
    for st in [
        Status::Open,
        Status::Cancelled,
        Status::Closing,
        Status::Closed,
    ] {
        let mut s = started();
        s.status = st;
        check(&mut s, "outsider.near", 0, low, "LIMIT: wrong status");
    }
    let mut s = started();
    for who in ["agent.near", "outsider.near", "platform.near", ME] {
        check(&mut s, who, 0, low, "AUTH: creator only");
    }
    s.lock = Some(Lock {
        op_id: U64(9),
        op: Op::Settle,
        stage: Stage::ReadAssets,
        promise_block: U64(BLOCK),
    });
    check(&mut s, "creator.near", 0, low, "LIMIT: operation pending");
    s.lock = None;
    check(&mut s, "creator.near", 0, low, "LIMIT: gas");
    check(
        &mut s,
        "creator.near",
        stake() + dep - 1,
        MIN_GAS_REGISTER_TOKENS,
        "LIMIT: balance for registration",
    );
    s.tokens_registered = true;
    check(
        &mut s,
        "creator.near",
        BAL,
        MIN_GAS_REGISTER_TOKENS,
        "LIMIT: tokens already registered",
    );
    // Exactly the stake plus the deposit is enough.
    let mut s = started();
    let _ = register_as(
        &mut s,
        "creator.near",
        stake() + dep,
        MIN_GAS_REGISTER_TOKENS,
    );
    assert!(s.get_lock().is_some());
}

#[test]
fn register_tokens_callback_sets_the_flag_only_on_success() {
    for (res, flag) in [
        (ok("null"), true),
        (ok(""), true),
        (PromiseResult::Failed, false),
    ] {
        let mut s = started();
        let _ = register_as(&mut s, "creator.near", BAL, MIN_GAS_REGISTER_TOKENS);
        let id = op_id(&s);
        cb_env(CALL_BLOCK + 2, vec![res]);
        s.on_tokens_registered(id);
        assert_eq!(s.get_tokens_registered(), flag);
        assert_eq!(s.get_lock(), None);
        let e = last_event();
        assert_eq!(e["event"], "tokens_registered");
        assert_eq!(e["data"][0]["ok"], flag);
        assert!(calls().is_empty());
        if !flag {
            // The creator can try again.
            let _ = register_as(&mut s, "creator.near", BAL, MIN_GAS_REGISTER_TOKENS);
            assert!(s.get_lock().is_some());
        }
    }
}

/// EC-C11: a stale or foreign callback does nothing; only the contract itself may call it.
#[test]
fn register_tokens_callback_is_guarded() {
    let mut s = started();
    let _ = register_as(&mut s, "creator.near", BAL, MIN_GAS_REGISTER_TOKENS);
    let before = snap(&s);
    cb_env(CALL_BLOCK + 2, vec![ok("null")]);
    s.on_tokens_registered(U64(77));
    assert_eq!(last_event()["event"], "callback_ignored");
    assert!(!s.get_tokens_registered());
    assert_eq!(snap(&s), before);
    near_sdk::testing_env!(ctx("creator.near", BAL, Gas::from_tgas(10), CALL_BLOCK).build());
    let id = op_id(&s);
    assert_eq!(
        refused(|| s.on_tokens_registered(id)),
        "AUTH: callback only"
    );
}

// ---- agent_open: the first checks ----

#[test]
fn a_valid_open_takes_the_lock_records_and_sends_five_reads() {
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    let l = s.get_lock().unwrap();
    assert_eq!(
        (l.op, l.stage),
        (Op::Open { index: U64(0) }, Stage::ReadRound)
    );
    let r = record(&s);
    assert_eq!(
        (r.kind, r.result.clone(), r.left_point, r.right_point),
        (ActionKind::Open, ActionResult::Pending, LEFT, RIGHT)
    );
    assert_eq!(r.open, None);
    assert_eq!(last_event()["event"], "action");
    let c = calls();
    assert_eq!(c.len(), 6, "{c:?}");
    let dcl = network().dcl_contract;
    let methods: Vec<_> = c.iter().map(|x| (x.0.as_str(), x.1.as_str())).collect();
    assert_eq!(
        methods,
        vec![
            (dcl.as_str(), "get_pool"),
            (quote().as_str(), "ft_balance_of"),
            (base().as_str(), "ft_balance_of"),
            (dcl.as_str(), "list_user_assets"),
            (dcl.as_str(), "predict_add_liquidity"),
            (ME, "on_open_reads"),
        ]
    );
    assert_eq!(c[3].2, format!(r#"{{"account_id":"{ME}"}}"#));
    assert_eq!(
        c[4].2,
        format!(
            r#"{{"pool_id":"{}","left_point":{LEFT},"right_point":{RIGHT},"amount_x":"{PROBE_X}","amount_y":"{PROBE_Y}"}}"#,
            limits_args().pool
        )
    );
    assert_eq!(
        (c[5].2.as_str(), c[5].3, c[5].4, c[5].5),
        (r#"{"op_id":"1"}"#, 0, GAS_OPEN_READ_CB.as_gas(), 0)
    );
    // The reads and the first callback fit in the prepaid minimum.
    let attached: u64 = c.iter().map(|x| x.4).sum();
    assert!(attached <= MIN_GAS_OPEN.as_gas(), "{attached}");
}

#[test]
fn agent_open_refusals_in_order() {
    let low = Gas::from_gas(MIN_GAS_OPEN.as_gas() - 1);
    let m = good_meta(1);
    for st in [
        Status::Open,
        Status::Cancelled,
        Status::Closing,
        Status::Closed,
    ] {
        let mut s = registered();
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
    let mut s = registered();
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
    // Registration, then opened, then position, then quiet, gas, observation, hash, points.
    s.tokens_registered = false;
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        low,
        m.clone(),
        "LIMIT: tokens not registered",
    );
    s.tokens_registered = true;
    s.opened = true;
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        low,
        m.clone(),
        "LIMIT: already opened",
    );
    s.opened = false;
    s.own_position = Some("p#1".into());
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        low,
        m.clone(),
        "LIMIT: position exists",
    );
    s.own_position = None;
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
    s.settle_until_block = 0;
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
    // Observation age: at the limit is fine, one older is not; a future block is not.
    s.last_payout_callback_block = 0;
    let age = limits_args().max_observation_age_blocks.0;
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        OK_GAS,
        meta(1, POINT, CALL_BLOCK - age - 1),
        "LIMIT: observation age",
    );
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        OK_GAS,
        meta(1, POINT, CALL_BLOCK + 1),
        "LIMIT: observation age",
    );
    let mut bad = m.clone();
    bad.chain_head = Some("xyz".into());
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        OK_GAS,
        bad,
        "LIMIT: chain head",
    );
    let mut bad = m.clone();
    bad.decision_hash = "AB".repeat(32);
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        OK_GAS,
        bad,
        "LIMIT: decision hash",
    );
    // Points: observed outside the range.
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        OK_GAS,
        meta(1, RIGHT, CALL_BLOCK - 5),
        "LIMIT: points",
    );
    // At the age limit it is accepted.
    let _ = open_at(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        OK_GAS,
        meta(1, POINT, CALL_BLOCK - age),
    );
    assert!(s.get_lock().is_some());
}

/// EC-C126: the interval and the 24-hour count apply to an open that is not paired; the log
/// capacity (the reserved slots are usable by an open) is `MAX_ACTIONS_STORED`.
#[test]
fn agent_open_windows_and_log_capacity() {
    let gap = limits_args().min_action_interval_s.0 * NANOS_PER_S;
    let mut s = registered();
    s.actions.push(synthetic(0, NOW));
    expect_refusal(
        &mut s,
        "agent.near",
        NOW + gap - 1,
        CALL_BLOCK,
        OK_GAS,
        good_meta(1),
        "LIMIT: action interval",
    );
    let _ = open_at(
        &mut s,
        "agent.near",
        NOW + gap,
        CALL_BLOCK,
        OK_GAS,
        good_meta(1),
    );
    assert!(s.get_lock().is_some());
    let mut s = registered();
    for i in 0..6 {
        s.actions.push(synthetic(i, NOW));
    }
    expect_refusal(
        &mut s,
        "agent.near",
        NOW + 6 * gap,
        CALL_BLOCK,
        OK_GAS,
        good_meta(1),
        "LIMIT: actions per 24h",
    );
    // The log: the last `RESERVED_SLOTS` are for exits (security audit H1).
    let mut s = registered();
    s.limits.max_actions_per_24h = 1_000;
    for i in 0..(MAX_ACTIONS_STORED - RESERVED_SLOTS) as u64 - 1 {
        s.actions.push(synthetic(i, 1));
    }
    let _ = open_at(&mut s, "agent.near", NOW, CALL_BLOCK, OK_GAS, good_meta(1));
    assert!(s.get_lock().is_some());
    let mut s = registered();
    s.limits.max_actions_per_24h = 1_000;
    for i in 0..(MAX_ACTIONS_STORED - RESERVED_SLOTS) as u64 {
        s.actions.push(synthetic(i, 1));
    }
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        OK_GAS,
        good_meta(1),
        "LIMIT: action log full",
    );
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

/// EC-C158: an open pairs with the agent's previous Swap (result `Ok`, `used > 0`, same hash,
/// inside `PAIR_WINDOW_S`): it may reuse the hash and is exempt from the interval; at the window
/// or with another hash, a failed swap, or `used == 0` it is not.
#[test]
fn a_paired_open_reuses_the_swap_hash_and_skips_the_interval() {
    let swap_at = NOW;
    let paired = |mutate: &dyn Fn(&mut ActionRecord), now: u64, m: Meta| -> Result<(), String> {
        let mut s = registered();
        let mut sw = synthetic(0, swap_at);
        sw.decision_hash = hash(1);
        sw.result = ActionResult::Ok;
        sw.swap = Some(SwapInfo {
            token_in: acc(&quote()),
            amount_in: U128(5),
            min_out: U128(1),
            used: U128(5),
        });
        mutate(&mut sw);
        s.actions.push(sw);
        s.seen_decisions
            .push(crate::contract::parse_hash(&hash(1)).unwrap());
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = open_at(&mut s, "agent.near", now, CALL_BLOCK, OK_GAS, m);
        }));
        match r {
            Ok(()) => {
                assert_eq!(s.actions.len(), 2);
                assert_eq!(s.seen_decisions.len(), 1, "no duplicate hash stored");
                Ok(())
            }
            Err(_) => Err("refused".into()),
        }
    };
    let same = || good_meta(1);
    // Paired one second after the swap, well inside the 600 s interval.
    assert!(paired(&|_| {}, swap_at + NANOS_PER_S, same()).is_ok());
    // One nanosecond inside the window pairs; at the window it does not (the hash is then reused).
    let w = PAIR_WINDOW_S * NANOS_PER_S;
    assert!(paired(&|_| {}, swap_at + w - 1, same()).is_ok());
    assert!(paired(&|_| {}, swap_at + w, same()).is_err());
    // A different hash is an ordinary open: the interval applies.
    assert!(paired(&|_| {}, swap_at + NANOS_PER_S, good_meta(2)).is_err());
    // A swap that did not move tokens, or did not finish Ok, does not pair.
    assert!(paired(
        &|r| r.swap.as_mut().unwrap().used = U128(0),
        swap_at + NANOS_PER_S,
        same()
    )
    .is_err());
    assert!(paired(
        &|r| r.result = ActionResult::SwapRefused,
        swap_at + NANOS_PER_S,
        same()
    )
    .is_err());
    assert!(paired(
        &|r| r.kind = ActionKind::Open,
        swap_at + NANOS_PER_S,
        same()
    )
    .is_err());
    // A reused hash that is not the previous swap's is refused even past the interval.
    let mut s = registered();
    s.seen_decisions
        .push(crate::contract::parse_hash(&hash(1)).unwrap());
    expect_refusal(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        OK_GAS,
        good_meta(1),
        "LIMIT: decision hash",
    );
}

// ---- agent_open: round one ----

#[test]
fn round_one_sizes_the_add_and_sends_both_deposits() {
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    round1(&mut s, good1());
    let l = s.get_lock().unwrap();
    assert_eq!(
        (l.op, l.stage),
        (Op::Open { index: U64(0) }, Stage::Depositing)
    );
    let r = record(&s);
    assert_eq!(
        r.reference,
        Some(Observed {
            block: U64(CALL_BLOCK + 2),
            point: POINT
        })
    );
    let o = r.open.unwrap();
    assert_eq!(
        (
            o.add_x.0,
            o.add_y.0,
            o.internal_x.0,
            o.internal_y.0,
            o.deposit_x.0,
            o.deposit_y.0
        ),
        (ADD_X, ADD_Y, 0, 0, ADD_X, ADD_Y)
    );
    let rd = r.round.unwrap();
    assert_eq!(
        (
            rd.spendable_quote.0,
            rd.spendable_base.0,
            rd.need_x.0,
            rd.need_y.0
        ),
        (ADD_X, ADD_Y, NEED_X, NEED_Y)
    );
    let c = calls();
    assert_eq!(c.len(), 3, "{c:?}");
    let dcl = network().dcl_contract;
    for (i, (tok, amt)) in [(quote(), ADD_X), (base(), ADD_Y)].into_iter().enumerate() {
        assert_eq!(
            (c[i].0.as_str(), c[i].1.as_str(), c[i].3, c[i].4),
            (tok.as_str(), "ft_transfer_call", 1, GAS_DEPOSIT.as_gas())
        );
        assert_eq!(
            c[i].2,
            format!(r#"{{"receiver_id":"{dcl}","amount":"{amt}","msg":"\"Deposit\""}}"#)
        );
    }
    assert_eq!(
        (c[2].1.as_str(), c[2].2.as_str(), c[2].4, c[2].5),
        (
            "on_open_deposited",
            r#"{"op_id":"1"}"#,
            GAS_OPEN_DEPOSITED_CB.as_gas(),
            0
        )
    );
}

/// What DCL already holds counts as spendable and is not deposited twice; a donation of the
/// quote token beyond the cap is not used (EC-C116, EC-R26).
#[test]
fn round_one_deposits_only_the_shortfall_and_respects_the_cap() {
    // Internal covers all of x and half of y: one deposit (y), for the other half.
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    round1(
        &mut s,
        reads1(
            POINT as i64,
            0,
            ADD_Y / 2,
            &assets(ADD_X, 0),
            &predict(NEED_X, NEED_Y),
        ),
    );
    let o = record(&s).open.unwrap();
    assert_eq!(
        (o.deposit_x.0, o.deposit_y.0, o.internal_x.0),
        (0, ADD_Y / 2, ADD_X)
    );
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(c[0].0, base());
    // Everything already inside DCL: no deposit, straight to the second read round.
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    round1(
        &mut s,
        reads1(
            POINT as i64,
            0,
            0,
            &assets(ADD_X, ADD_Y),
            &predict(NEED_X, NEED_Y),
        ),
    );
    assert_eq!(s.get_lock().unwrap().stage, Stage::ReadAdd);
    let c = calls();
    let m: Vec<_> = c.iter().map(|x| x.1.as_str()).collect();
    assert_eq!(
        m,
        vec![
            "get_pool",
            "list_user_assets",
            "predict_add_liquidity",
            "on_open_add_reads"
        ]
    );
    assert_eq!(
        c[2].2,
        format!(
            r#"{{"pool_id":"{}","left_point":{LEFT},"right_point":{RIGHT},"amount_x":"{ADD_X}","amount_y":"{ADD_Y}"}}"#,
            limits_args().pool
        )
    );
    assert_eq!((c[3].4, c[3].5), (GAS_OPEN_ADD_READ_CB.as_gas(), 0));
    // A cap below the value: both amounts scaled down together (cap 241_000_000 of ~482 -> half).
    let mut s = registered();
    s.limits.max_principal = U128(241_000_000);
    let _ = agent_open(&mut s, 1);
    round1(&mut s, good1());
    let o = record(&s).open.unwrap();
    assert!(o.add_x.0 < ADD_X && o.add_y.0 < ADD_Y);
    assert!((o.add_x.0 as f64 / ADD_X as f64 - 0.5).abs() < 0.01);
}

#[test]
fn the_platform_share_is_not_spendable() {
    let mut s = registered();
    s.fees_collected = [2_000_000_000, 0]; // platform owes 100 USDC of the wallet
    let _ = agent_open(&mut s, 1);
    // Wallet 250 + 100 owed = 350 USDC; only 250 is spendable, so the same add as before.
    round1(
        &mut s,
        reads1(
            POINT as i64,
            ADD_X + 100_000_000,
            ADD_Y,
            "{}",
            &predict(NEED_X, NEED_Y),
        ),
    );
    let o = record(&s).open.unwrap();
    assert_eq!((o.add_x.0, o.add_y.0), (ADD_X, ADD_Y));
    assert_eq!(o.deposit_x.0, ADD_X);
}

#[test]
fn round_one_refusals_end_the_record_without_a_window() {
    let cases: Vec<(&str, Vec<PromiseResult>, ActionResult)> = vec![
        (
            "pool not running",
            {
                let mut r = good1();
                r[0] = ok(&pool(POINT as i64, "Paused", &quote(), &base()));
                r
            },
            ActionResult::Refused("pool".into()),
        ),
        (
            "wrong tokens",
            {
                let mut r = good1();
                r[0] = ok(&pool(POINT as i64, "Running", &quote(), "other.near"));
                r
            },
            ActionResult::Refused("pool".into()),
        ),
        (
            "drift +1",
            reads1(
                POINT as i64 + 31,
                ADD_X,
                ADD_Y,
                "{}",
                &predict(NEED_X, NEED_Y),
            ),
            ActionResult::Refused("drift".into()),
        ),
        (
            "centring",
            reads1(
                RIGHT as i64 - 249,
                ADD_X,
                ADD_Y,
                "{}",
                &predict(NEED_X, NEED_Y),
            ),
            ActionResult::Refused("drift".into()),
        ),
        (
            "failed read",
            {
                let mut r = good1();
                r[1] = PromiseResult::Failed;
                r
            },
            ActionResult::Failed("read".into()),
        ),
        (
            "bad balance",
            {
                let mut r = good1();
                r[2] = ok("\"01\"");
                r
            },
            ActionResult::Failed("read".into()),
        ),
        (
            "bad assets",
            {
                let mut r = good1();
                r[3] = ok(r#"{"x":{"a":1}}"#);
                r
            },
            ActionResult::Failed("read".into()),
        ),
        (
            "bad predict",
            {
                let mut r = good1();
                r[4] = ok(r#"{"need_x":"1"}"#);
                r
            },
            ActionResult::Failed("read".into()),
        ),
        (
            "zero need",
            reads1(POINT as i64, ADD_X, ADD_Y, "{}", &predict(0, 0)),
            ActionResult::Refused("nothing_to_add".into()),
        ),
        (
            "nothing spendable",
            reads1(POINT as i64, 0, 0, "{}", &predict(NEED_X, NEED_Y)),
            ActionResult::Refused("nothing_to_add".into()),
        ),
        // The quote side below its dust (1,000) while the range needs it.
        (
            "below dust",
            reads1(POINT as i64, 999, ADD_Y, "{}", &predict(NEED_X, NEED_Y)),
            ActionResult::Refused("nothing_to_add".into()),
        ),
    ];
    for (name, res, want) in cases {
        let mut s = registered();
        let _ = agent_open(&mut s, 1);
        round1(&mut s, res);
        // `centring` is reached only when the drift passes: the case above sits 249 from the edge
        // but 31 from the observation, so it is a drift refusal; the pure centring case follows.
        assert_ended(&s, want, false);
        let _ = name;
    }
}

#[test]
fn round_one_centring_at_the_limit_and_one_past() {
    // Centre 401_312; quarter = 250: the point must be at least 250 from each edge. Observed point
    // follows the pool so drift passes.
    for (point, want) in [
        (LEFT as i64 + 250, None),
        (LEFT as i64 + 249, Some("centring")),
        (RIGHT as i64 - 250, None),
        (RIGHT as i64 - 249, Some("centring")),
    ] {
        let mut s = registered();
        s.limits.max_observation_drift_bps = 1_000;
        let _ = open_at(
            &mut s,
            "agent.near",
            NOW,
            CALL_BLOCK,
            OK_GAS,
            meta(1, point as i32, CALL_BLOCK - 5),
        );
        round1(
            &mut s,
            reads1(point, ADD_X, ADD_Y, "{}", &predict(NEED_X, NEED_Y)),
        );
        match want {
            Some(r) => assert_ended(&s, ActionResult::Refused(r.into()), false),
            None => assert_eq!(s.get_lock().unwrap().stage, Stage::Depositing, "{point}"),
        }
    }
}

#[test]
fn round_one_rechecks_status_and_the_run_end() {
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    s.status = Status::Closing;
    round1(&mut s, good1());
    assert_ended(&s, ActionResult::Refused("status".into()), false);
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    let id = op_id(&s);
    let mut b = ctx(ME, BAL, Gas::from_tgas(300), CALL_BLOCK + 2);
    b.block_timestamp(config().run_end_ns.0);
    near_sdk::testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        good1()
    );
    s.on_open_reads(id);
    assert_ended(&s, ActionResult::Refused("run_ended".into()), false);
}

// ---- agent_open: deposits and round two ----

#[test]
fn deposit_results_must_report_the_whole_amount() {
    let cases: Vec<(&str, Vec<PromiseResult>)> = vec![
        (
            "one failed",
            vec![ok(&format!("\"{ADD_X}\"")), PromiseResult::Failed],
        ),
        (
            "partial",
            vec![
                ok(&format!("\"{}\"", ADD_X - 1)),
                ok(&format!("\"{ADD_Y}\"")),
            ],
        ),
        ("zero", vec![ok("\"0\""), ok(&format!("\"{ADD_Y}\""))]),
        (
            "not a string",
            vec![ok(&ADD_X.to_string()), ok(&format!("\"{ADD_Y}\""))],
        ),
        ("missing", vec![ok(&format!("\"{ADD_X}\""))]),
        (
            "extra",
            vec![
                ok(&format!("\"{ADD_X}\"")),
                ok(&format!("\"{ADD_Y}\"")),
                ok("\"1\""),
            ],
        ),
    ];
    for (name, res) in cases {
        let mut s = registered();
        let _ = agent_open(&mut s, 1);
        round1(&mut s, good1());
        deposited(&mut s, res);
        assert_ended(&s, ActionResult::Failed("deposit".into()), true);
        let _ = name;
    }
    // One deposit only: exactly one result is expected.
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    round1(
        &mut s,
        reads1(
            POINT as i64,
            ADD_X,
            0,
            &assets(0, ADD_Y),
            &predict(NEED_X, NEED_Y),
        ),
    );
    deposited(&mut s, vec![ok(&format!("\"{ADD_X}\""))]);
    assert_eq!(s.get_lock().unwrap().stage, Stage::ReadAdd);
}

#[test]
fn deposits_done_start_round_two() {
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    round1(&mut s, good1());
    deposited(&mut s, full_deposit_results());
    assert_eq!(s.get_lock().unwrap().stage, Stage::ReadAdd);
    let c = calls();
    assert_eq!(c.len(), 4, "{c:?}");
    assert_eq!(c[3].1, "on_open_add_reads");
    // A deposit callback after the strategy left `Running` stops, window open (tokens moved).
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    round1(&mut s, good1());
    s.status = Status::Closing;
    deposited(&mut s, full_deposit_results());
    assert_ended(&s, ActionResult::Refused("status".into()), true);
}

#[test]
fn round_two_sends_the_add_with_exact_amounts_and_minimums() {
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    round1(&mut s, good1());
    deposited(&mut s, full_deposit_results());
    // The add uses a little less of x than deposited.
    let (px, py) = (249_000_000u128, ADD_Y);
    round2(
        &mut s,
        reads2(POINT as i64, &assets(ADD_X, ADD_Y), &predict(px, py)),
    );
    assert_eq!(s.get_lock().unwrap().stage, Stage::Adding);
    let (mx, my) = (px * 9_950 / 10_000, py * 9_950 / 10_000);
    let o = record(&s).open.unwrap();
    assert_eq!(
        (o.predict_x.0, o.predict_y.0, o.min_x.0, o.min_y.0),
        (px, py, mx, my)
    );
    assert_eq!((mx, my), (247_755_000, 62_187_500_000_000_000_000_000_000));
    let c = calls();
    assert_eq!(c.len(), 2, "{c:?}");
    assert_eq!(
        (c[0].0.as_str(), c[0].1.as_str(), c[0].3, c[0].4),
        (
            network().dcl_contract.as_str(),
            "add_liquidity",
            0,
            GAS_ADD.as_gas()
        )
    );
    assert_eq!(
        c[0].2,
        format!(
            r#"{{"pool_id":"{}","left_point":{LEFT},"right_point":{RIGHT},"amount_x":"{ADD_X}","amount_y":"{ADD_Y}","min_amount_x":"{mx}","min_amount_y":"{my}","skip_unwrap_near":true}}"#,
            limits_args().pool
        )
    );
    assert_eq!(
        (c[1].1.as_str(), c[1].2.as_str(), c[1].4, c[1].5),
        (
            "on_open_added",
            r#"{"op_id":"1"}"#,
            GAS_OPEN_ADDED.as_gas(),
            0
        )
    );
}

/// The refusals of round two in the design's order, each with the deposited tokens left in DCL's
/// internal balance (no promise, window open, nothing opened).
#[test]
fn round_two_refusals() {
    let full = assets(ADD_X, ADD_Y);
    let pr = predict(ADD_X, ADD_Y);
    let cases: Vec<(&str, Vec<PromiseResult>, ActionResult)> = vec![
        (
            "deposit_short x",
            reads2(POINT as i64, &assets(ADD_X - 1, ADD_Y), &pr),
            ActionResult::Refused("deposit_short".into()),
        ),
        (
            "deposit_short y",
            reads2(POINT as i64, &assets(ADD_X, ADD_Y - 1), &pr),
            ActionResult::Refused("deposit_short".into()),
        ),
        (
            "pool",
            vec![
                ok(&pool(POINT as i64, "Paused", &quote(), &base())),
                ok(&full),
                ok(&pr),
            ],
            ActionResult::Refused("pool".into()),
        ),
        (
            "drift",
            reads2(POINT as i64 + 31, &full, &pr),
            ActionResult::Refused("drift".into()),
        ),
        (
            "predict_over x",
            reads2(POINT as i64, &full, &predict(ADD_X + 1, ADD_Y)),
            ActionResult::Refused("predict_over".into()),
        ),
        (
            "predict_over y",
            reads2(POINT as i64, &full, &predict(ADD_X, ADD_Y + 1)),
            ActionResult::Refused("predict_over".into()),
        ),
        (
            "read failed",
            vec![
                ok(&pool(POINT as i64, "Running", &quote(), &base())),
                PromiseResult::Failed,
                ok(&pr),
            ],
            ActionResult::Failed("read".into()),
        ),
        (
            "bad predict",
            reads2(POINT as i64, &full, "{}"),
            ActionResult::Failed("read".into()),
        ),
    ];
    for (name, res, want) in cases {
        let mut s = registered();
        let _ = agent_open(&mut s, 1);
        round1(&mut s, good1());
        deposited(&mut s, full_deposit_results());
        round2(&mut s, res);
        assert_ended(&s, want, true);
        let _ = name;
    }
}

/// EC-C148, EC-R28: the add ratio bound. D = 30, W = 1000, ref 500 from each edge: the bound is
/// 1,200 bps, so a prediction of 88% of `add` passes and one unit less is `add_ratio`; in both
/// tokens. The minimums at the largest allowed prediction are floors of 99.5%.
#[test]
fn round_two_add_ratio_at_the_limit_and_one_past() {
    let floor = |v: u128| v * 8_800 / 10_000;
    for (px, py, ok_) in [
        (floor(ADD_X), ADD_Y, true),
        (floor(ADD_X) - 1, ADD_Y, false),
        (ADD_X, floor(ADD_Y), true),
        (ADD_X, floor(ADD_Y) - 1, false),
    ] {
        let mut s = registered();
        let _ = agent_open(&mut s, 1);
        round1(&mut s, good1());
        deposited(&mut s, full_deposit_results());
        round2(
            &mut s,
            reads2(POINT as i64, &assets(ADD_X, ADD_Y), &predict(px, py)),
        );
        if ok_ {
            assert_eq!(s.get_lock().unwrap().stage, Stage::Adding, "{px} {py}");
        } else {
            assert_ended(&s, ActionResult::Refused("add_ratio".into()), true);
        }
    }
    // A slippage bound above the drift term takes over (ratio = max_slippage_bps).
    let mut s = registered();
    s.limits.max_slippage_bps = 2_000;
    let _ = agent_open(&mut s, 1);
    round1(&mut s, good1());
    deposited(&mut s, full_deposit_results());
    round2(
        &mut s,
        reads2(
            POINT as i64,
            &assets(ADD_X, ADD_Y),
            &predict(ADD_X * 8 / 10 - 1, ADD_Y),
        ),
    );
    assert_ended(&s, ActionResult::Refused("add_ratio".into()), true);
}

// ---- agent_open: the add's result ----

#[test]
fn a_successful_add_sets_the_position_and_opens_the_window() {
    let mut s = adding();
    added(&mut s, ok(&lpt()));
    let r = record(&s);
    assert_eq!(r.result, ActionResult::Ok);
    assert_eq!(
        r.open.unwrap().lpt_id,
        Some(format!("{}#7", limits_args().pool))
    );
    assert_eq!(
        s.get_own_position(),
        Some(format!("{}#7", limits_args().pool))
    );
    assert!(s.get_opened());
    assert_eq!(s.get_lock(), None);
    assert_eq!(
        s.get_settle_window().settle_until_block.0,
        CALL_BLOCK + 14 + PAYOUT_SETTLE_BLOCKS
    );
    assert_eq!(
        s.get_settle_window().last_payout_callback_block.0,
        CALL_BLOCK + 14
    );
    assert!(calls().is_empty());
    assert_eq!(last_event()["event"], "action_result");
    // A second open is refused for good (EC-C106 family): the run is opened.
    expect_refusal(
        &mut s,
        "agent.near",
        NOW + 99 * NANOS_PER_S * 600,
        CALL_BLOCK + 500,
        OK_GAS,
        meta(2, POINT, CALL_BLOCK + 490),
        "LIMIT: already opened",
    );
}

#[test]
fn a_failed_add_leaves_the_tokens_in_dcl_and_the_open_retryable() {
    let mut s = adding();
    added(&mut s, PromiseResult::Failed);
    let r = record(&s);
    assert_eq!(r.result, ActionResult::Failed("add".into()));
    assert!(!s.get_opened() && s.get_own_position().is_none());
    assert_eq!(s.get_lock(), None);
    assert_eq!(
        s.get_settle_window().settle_until_block.0,
        CALL_BLOCK + 14 + PAYOUT_SETTLE_BLOCKS
    );
    assert!(calls().is_empty());
    // After the window and the interval the agent can retry: a new hash, and it deposits only the shortfall.
    let gap = limits_args().min_action_interval_s.0 * NANOS_PER_S;
    let blk = CALL_BLOCK + 14 + PAYOUT_SETTLE_BLOCKS + 3 * OFFCHAIN_MARGIN_BLOCKS;
    let _ = open_at(
        &mut s,
        "agent.near",
        NOW + gap,
        blk,
        OK_GAS,
        meta(2, POINT, blk - 5),
    );
    assert!(s.get_lock().is_some());
    let id = op_id(&s);
    cb_env(
        blk + 2,
        reads1(
            POINT as i64,
            0,
            0,
            &assets(ADD_X, ADD_Y),
            &predict(NEED_X, NEED_Y),
        ),
    );
    s.on_open_reads(id);
    assert_eq!(
        s.get_lock().unwrap().stage,
        Stage::ReadAdd,
        "no deposit needed"
    );
    assert_eq!(s.actions[1].open.as_ref().unwrap().deposit_x.0, 0);
}

/// A position id that isn't this pool's, empty, not a string or too long is not trusted: the
/// open is `Unknown` and closed for good (the position may exist; v1 cannot adopt it).
#[test]
fn an_unreadable_position_id_is_unknown_and_closes_the_open() {
    let pool_id = limits_args().pool;
    for body in [
        "null".to_string(),
        "\"\"".to_string(),
        format!("\"{pool_id}#\""),
        "\"other|pool|100#1\"".to_string(),
        "7".to_string(),
        format!("\"{pool_id}#{}\"", "9".repeat(200)),
    ] {
        let mut s = adding();
        added(&mut s, ok(&body));
        assert_eq!(record(&s).result, ActionResult::Unknown, "{body}");
        assert!(s.get_opened(), "{body}");
        assert!(s.get_own_position().is_none());
        assert_eq!(s.get_lock(), None);
        assert_ne!(s.get_settle_window().settle_until_block.0, 0);
    }
}

/// EC-C11: every callback acts only on its own lock and stage; a late or foreign one only logs.
#[test]
fn open_callbacks_act_only_on_their_own_stage() {
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    let before = snap(&s);
    let id = op_id(&s);
    cb_env(CALL_BLOCK + 2, good2());
    // Wrong stage for each later callback, and a wrong op id for the right one.
    s.on_open_deposited(id);
    assert_eq!(last_event()["event"], "callback_ignored");
    s.on_open_add_reads(id);
    s.on_open_added(id);
    cb_env(CALL_BLOCK + 2, good1());
    s.on_open_reads(U64(55));
    assert_eq!(snap(&s), before);
    assert!(calls().is_empty());
    // Not the contract itself.
    near_sdk::testing_env!(ctx("agent.near", BAL, Gas::from_tgas(10), CALL_BLOCK).build());
    assert_eq!(refused(|| s.on_open_reads(id)), "AUTH: callback only");
    assert_eq!(refused(|| s.on_open_deposited(id)), "AUTH: callback only");
    assert_eq!(refused(|| s.on_open_add_reads(id)), "AUTH: callback only");
    assert_eq!(refused(|| s.on_open_added(id)), "AUTH: callback only");
}

/// `resolve_stale` over each stage of an open: reads end `Failed(read)` with no window; a lost
/// deposit is `Unknown` with the window; a lost add is `Unknown`, closes the open and opens the
/// window.
#[test]
fn resolve_stale_over_every_open_stage() {
    for (stage, opened, window, result) in [
        (
            Stage::ReadRound,
            false,
            false,
            ActionResult::Failed("read".into()),
        ),
        (
            Stage::ReadAdd,
            false,
            true,
            ActionResult::Failed("read".into()),
        ),
        (Stage::Depositing, false, true, ActionResult::Unknown),
        (Stage::Adding, true, true, ActionResult::Unknown),
    ] {
        let mut s = registered();
        let _ = agent_open(&mut s, 1);
        let mut l = s.get_lock().unwrap();
        l.stage = stage;
        s.lock = Some(l);
        let stale = CALL_BLOCK + config().stale_after_blocks.0;
        at("outsider.near", stale, NOW, Gas::from_tgas(30));
        s.resolve_stale();
        assert_eq!(record(&s).result, result, "{stage:?}");
        assert_eq!(s.get_lock(), None);
        assert_eq!(s.get_opened(), opened, "{stage:?}");
        assert_eq!(
            s.get_settle_window().settle_until_block.0 != 0,
            window,
            "{stage:?}"
        );
        assert_eq!(s.get_stale_resolution_block(), Some(U64(stale)));
    }
    // A lost register_tokens: nothing changes but the lock and the cooldown.
    let mut s = started();
    let _ = register_as(&mut s, "creator.near", BAL, MIN_GAS_REGISTER_TOKENS);
    let stale = CALL_BLOCK + config().stale_after_blocks.0;
    at("outsider.near", stale, NOW, Gas::from_tgas(30));
    s.resolve_stale();
    assert_eq!(s.get_lock(), None);
    assert!(!s.get_tokens_registered());
    let _ = events();
}

/// EC-C171: the largest `Open` record (every stage reached, the longest position id) fits the
/// storage reserve's `RECORD_BYTES`.
#[test]
fn an_open_record_fits_the_reserve() {
    let mut s = adding();
    added(&mut s, ok(&lpt()));
    let bytes = near_sdk::borsh::to_vec(&s.actions[0]).unwrap().len();
    assert!(bytes <= super::start::RECORD_BYTES as usize, "{bytes}");
    s.actions[0].open.as_mut().unwrap().lpt_id = Some("p".repeat(128));
    s.actions[0].chain_head = Some(hash(9));
    let bytes = near_sdk::borsh::to_vec(&s.actions[0]).unwrap().len();
    assert!(bytes <= super::start::RECORD_BYTES as usize, "{bytes}");
}

/// EC-C99, EC-C154: `agent_open` at `run_end - 1` is accepted and at `run_end` refused; the later
/// stages re-check the run's end (the deposit callback and round two refuse at `run_end`).
#[test]
fn the_run_end_boundary_for_open_and_its_stages() {
    let end = config().run_end_ns.0;
    let mut s = registered();
    let _ = open_at(
        &mut s,
        "agent.near",
        end - 1,
        CALL_BLOCK,
        OK_GAS,
        good_meta(1),
    );
    assert!(s.get_lock().is_some());
    let mut s = registered();
    expect_refusal(
        &mut s,
        "agent.near",
        end,
        CALL_BLOCK,
        OK_GAS,
        good_meta(1),
        "LIMIT: run ended",
    );
    let at_end = |s: &mut Strategy, f: &dyn Fn(&mut Strategy, U64), res: Vec<PromiseResult>| {
        let id = op_id(s);
        let mut b = ctx(ME, BAL, Gas::from_tgas(300), CALL_BLOCK + 6);
        b.block_timestamp(end);
        near_sdk::testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            res
        );
        f(s, id);
    };
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    round1(&mut s, good1());
    at_end(
        &mut s,
        &|s, id| s.on_open_deposited(id),
        full_deposit_results(),
    );
    assert_ended(&s, ActionResult::Refused("run_ended".into()), true);
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    round1(&mut s, good1());
    deposited(&mut s, full_deposit_results());
    at_end(&mut s, &|s, id| s.on_open_add_reads(id), good2());
    assert_ended(&s, ActionResult::Refused("run_ended".into()), true);
}

/// EC-C159: only a successful add latches `opened`; every refusal, failure and lost-read outcome
/// leaves it unset so the agent may retry.
#[test]
fn only_a_successful_add_latches_opened() {
    let mut cases: Vec<Strategy> = vec![];
    for stage in 0..4 {
        let mut s = registered();
        let _ = agent_open(&mut s, 1);
        match stage {
            0 => round1(
                &mut s,
                reads1(
                    POINT as i64 + 31,
                    ADD_X,
                    ADD_Y,
                    "{}",
                    &predict(NEED_X, NEED_Y),
                ),
            ),
            1 => {
                round1(&mut s, good1());
                deposited(&mut s, vec![PromiseResult::Failed, PromiseResult::Failed]);
            }
            2 => {
                round1(&mut s, good1());
                deposited(&mut s, full_deposit_results());
                round2(
                    &mut s,
                    reads2(
                        POINT as i64,
                        &assets(ADD_X - 1, ADD_Y),
                        &predict(ADD_X, ADD_Y),
                    ),
                );
            }
            _ => {
                round1(&mut s, good1());
                deposited(&mut s, full_deposit_results());
                round2(&mut s, good2());
                added(&mut s, PromiseResult::Failed);
            }
        }
        cases.push(s);
    }
    for s in &cases {
        assert!(!s.get_opened() && s.get_own_position().is_none());
        assert_eq!(s.get_lock(), None);
    }
}

// ---- slice 8 test audit, round 4a (umbrella EC-C172) ----

/// EC-C172, EC-C116, EC-R26: the platform's held-back share is not spendable, for each pool token
/// separately, through `agent_open`: with the subtraction removed the add would be larger. The
/// limiting token has only half of what the range needs on top of what the platform is owed.
#[test]
fn the_platform_share_is_held_back_from_the_add_for_each_token() {
    let owed_q = 100_000_000u128;
    let owed_b = 1_000_000_000_000_000_000_000_000u128;
    // fees_collected / 20 = owed.
    let fees = [owed_q * 20, owed_b * 20];
    // Quote limits: wallet quote is owed + half of ADD_X; base is ample.
    let mut s = registered();
    s.fees_collected = fees;
    let _ = agent_open(&mut s, 1);
    round1(
        &mut s,
        reads1(
            POINT as i64,
            owed_q + ADD_X / 2,
            owed_b + ADD_Y,
            "{}",
            &predict(NEED_X, NEED_Y),
        ),
    );
    let o = record(&s).open.unwrap();
    assert_eq!(
        o.add_x.0,
        ADD_X / 2,
        "quote: the owed share is not spendable"
    );
    assert!(
        o.add_y.0 <= ADD_Y / 2 + ADD_Y / 1_000,
        "y follows x in the ratio"
    );
    // Base limits: wallet base is owed + half of ADD_Y; quote is ample.
    let mut s = registered();
    s.fees_collected = fees;
    let _ = agent_open(&mut s, 1);
    round1(
        &mut s,
        reads1(
            POINT as i64,
            owed_q + ADD_X,
            owed_b + ADD_Y / 2,
            "{}",
            &predict(NEED_X, NEED_Y),
        ),
    );
    let o = record(&s).open.unwrap();
    assert_eq!(
        o.add_y.0,
        ADD_Y / 2,
        "base: the owed share is not spendable"
    );
    // A wallet below what is owed has nothing spendable: nothing_to_add, and no platform state moved.
    let mut s = registered();
    s.fees_collected = fees;
    let (fc, pp) = (s.get_fees_collected(), s.paid_platform);
    let _ = agent_open(&mut s, 1);
    round1(
        &mut s,
        reads1(
            POINT as i64,
            owed_q - 1,
            owed_b - 1,
            "{}",
            &predict(NEED_X, NEED_Y),
        ),
    );
    assert_ended(&s, ActionResult::Refused("nothing_to_add".into()), false);
    assert_eq!(
        (
            s.get_fees_collected().quote.0,
            s.get_fees_collected().base.0,
            s.paid_platform,
            s.platform_owed(0),
            s.platform_owed(1)
        ),
        (fc.quote.0, fc.base.0, pp, owed_q, owed_b)
    );
}

/// EC-C148, EC-C172: the add-ratio bound at the symmetric range (W 1,000, 500 from each edge):
/// drift 249 gives a bound of 9,960 (allowed), drift 250 gives 10,000, which is refused
/// `add_ratio` before any arithmetic can go negative.
#[test]
fn the_add_ratio_bound_below_and_at_10000() {
    for (drift, ok_) in [(249u16, true), (250, false)] {
        let mut s = registered();
        s.limits.max_observation_drift_bps = drift;
        let _ = agent_open(&mut s, 1);
        round1(&mut s, good1());
        deposited(&mut s, full_deposit_results());
        round2(&mut s, good2());
        if ok_ {
            assert_eq!(s.get_lock().unwrap().stage, Stage::Adding, "bound 9,960");
        } else {
            assert_ended(&s, ActionResult::Refused("add_ratio".into()), true);
        }
    }
}

/// EC-C148, EC-C172: round two's drift is measured from this operation's reference as well as from
/// the agent's observation. Reference 15 below the observation: a point 15 above the observation is 30
/// from the reference (allowed), 16 above is 31 (refused) though only 16 from the observation.
/// Reference 15 above: a point 30 above the observation is allowed, 31 above refused (31 from the observation).
#[test]
fn round_two_drift_from_the_reference_and_from_the_observation() {
    let run = |ref_off: i64, p2_off: i64| {
        let mut s = registered();
        let _ = agent_open(&mut s, 1);
        round1(
            &mut s,
            reads1(
                POINT as i64 + ref_off,
                ADD_X,
                ADD_Y,
                "{}",
                &predict(NEED_X, NEED_Y),
            ),
        );
        deposited(&mut s, full_deposit_results());
        round2(
            &mut s,
            reads2(
                POINT as i64 + p2_off,
                &assets(ADD_X, ADD_Y),
                &predict(ADD_X, ADD_Y),
            ),
        );
        s
    };
    assert_eq!(run(-15, 15).get_lock().unwrap().stage, Stage::Adding);
    assert_ended(&run(-15, 16), ActionResult::Refused("drift".into()), true);
    assert_eq!(run(15, 30).get_lock().unwrap().stage, Stage::Adding);
    assert_ended(&run(15, 31), ActionResult::Refused("drift".into()), true);
}

/// EC-C95, EC-C96, EC-C172: round two re-checks the centring: a point 249 from the left edge is
/// within the drift of the observation (so only the centring can refuse it).
#[test]
fn round_two_rechecks_the_centring() {
    let mut s = registered();
    s.limits.max_observation_drift_bps = 1_000;
    let edge = LEFT as i64 + 250;
    let _ = open_at(
        &mut s,
        "agent.near",
        NOW,
        CALL_BLOCK,
        OK_GAS,
        meta(1, edge as i32, CALL_BLOCK - 5),
    );
    round1(
        &mut s,
        reads1(edge, ADD_X, ADD_Y, "{}", &predict(NEED_X, NEED_Y)),
    );
    deposited(&mut s, full_deposit_results());
    round2(
        &mut s,
        reads2(edge - 1, &assets(ADD_X, ADD_Y), &predict(ADD_X, ADD_Y)),
    );
    assert_ended(&s, ActionResult::Refused("centring".into()), true);
}

/// EC-C172 (rev 22 security L-2): the dust boundary: the quote add exactly at its dust threshold
/// (1,000) goes ahead, one below is `nothing_to_add`.
#[test]
fn the_dust_boundary_for_the_add() {
    let dust = 1_000u128;
    for (q, ok_) in [(dust, true), (dust - 1, false)] {
        let mut s = registered();
        let _ = agent_open(&mut s, 1);
        round1(
            &mut s,
            reads1(POINT as i64, q, ADD_Y, "{}", &predict(NEED_X, NEED_Y)),
        );
        if ok_ {
            assert_eq!(s.get_lock().unwrap().stage, Stage::Depositing);
            assert_eq!(record(&s).open.unwrap().add_x.0, dust);
        } else {
            assert_ended(&s, ActionResult::Refused("nothing_to_add".into()), false);
        }
    }
}

/// EC-R28, EC-C172: a prediction whose minimums are both 0 at round two is `nothing_to_add`
/// (nothing would be protected), with the deposits left in DCL and the window open.
#[test]
fn a_round_two_with_both_minimums_zero_is_nothing_to_add() {
    let mut s = registered();
    let _ = agent_open(&mut s, 1);
    round1(&mut s, good1());
    deposited(&mut s, full_deposit_results());
    // The recorded add is one unit of each; the prediction one unit of each: floor(1 * 9,950 / 10,000) is 0.
    if let Some(o) = s.record_mut(0).and_then(|r| r.open.as_mut()) {
        o.add_x = U128(1);
        o.add_y = U128(1);
    }
    round2(&mut s, reads2(POINT as i64, &assets(1, 1), &predict(1, 1)));
    assert_ended(&s, ActionResult::Refused("nothing_to_add".into()), true);
}
