//! Slice 4 unit tests: `start` and its callback (EC-C136, EC-C146, EC-C63, EC-C13 for the
//! reserve, EC-C167). The pinned DCL's and the tokens' real answers are for the sandbox test.
use super::tests::*;
use super::tests_funding::{
    as_callback, at, base, cap, events, fund, inbound, last_event, ok, quote,
};
use super::*;
use crate::limits::DAY_NS;
use crate::price;
use near_sdk::testing_env;
use near_sdk::PromiseResult;

const POINT: i32 = 401_312;

fn drift() -> i64 {
    limits_args().max_observation_drift_bps as i64
}
/// Funded, with all three registrations `Ok`, still `Open`.
pub(super) fn ready() -> Strategy {
    let mut s = deployed();
    for t in TARGETS {
        callback(&mut s, t, true);
    }
    assert_eq!(fund(&mut s, cap()), 0);
    s
}
fn start_at(s: &mut Strategy, who: &str, ts: u64, gas: Gas, balance: u128, point: i32) -> Promise {
    let mut b = ctx(who, balance, gas, BLOCK + 10);
    b.block_timestamp(ts);
    testing_env!(b.build());
    s.start(point)
}
fn do_start(s: &mut Strategy) {
    let _ = start_at(s, "creator.near", NOW, MIN_GAS_START, BAL, POINT);
}
pub(super) fn pool(point: i64, state: &str, x: &str, y: &str) -> String {
    format!(
        r#"{{"pool_id":"{}","token_x":"{x}","token_y":"{y}","fee":100,"point_delta":1,"current_point":{point},"state":"{state}","liquidity":"0","total_x":"0","total_y":"0"}}"#,
        limits_args().pool
    )
}
fn slots(max: u64, liq: u64, ord: u64) -> String {
    format!(
        r#"{{"sponsor_id":"x","locked_near":"1","storage_for_asset":"1","slot_price":"1","max_slots":{max},"cur_order_slots":{ord},"cur_liquidity_slots":{liq}}}"#
    )
}
const REG: &str = r#"{"total":"1250000000000000000000","available":"0"}"#;
/// Six good answers: pool, slots, then the four `storage_balance_of`.
fn good() -> Vec<String> {
    vec![
        pool(POINT as i64, "Running", &quote(), &base()),
        slots(190, 0, 0),
        REG.into(),
        REG.into(),
        REG.into(),
        REG.into(),
    ]
}
fn results(v: &[String]) -> Vec<PromiseResult> {
    v.iter().map(|b| ok(b)).collect()
}
fn callback_start(s: &mut Strategy, res: Vec<PromiseResult>) {
    as_callback(BLOCK + 12, res);
    s.on_start_reads(U64(0), POINT);
}
pub(super) fn started() -> Strategy {
    let mut s = ready();
    do_start(&mut s);
    callback_start(&mut s, results(&good()));
    s
}
fn snap(s: &Strategy) -> String {
    near_sdk::serde_json::to_string(&(
        s.get_status(),
        s.get_principal(),
        s.get_lock(),
        s.get_started_at(),
        s.get_registrations(),
        s.next_op_id,
    ))
    .unwrap()
}
/// A callback refusal: the lock released, still `Open`, a `start` event with `ok: false` and
/// exactly this reason, no promise, nothing started.
fn assert_refused_start(s: &Strategy, reason: &str) {
    assert_eq!(s.get_lock(), None, "{reason}");
    assert_eq!(s.get_status(), Status::Open, "{reason}");
    assert_eq!(s.get_started_at(), None, "{reason}");
    assert!(calls().is_empty(), "{reason}");
    let e = last_event();
    assert_eq!(e["event"], "start_refused");
    assert_eq!(e["data"][0]["op_id"], "0");
    assert_eq!(e["data"][0]["reason"], format!("LIMIT: {reason}"));
}
fn refuses_with(res: Vec<String>, reason: &str) {
    let mut s = ready();
    do_start(&mut s);
    callback_start(&mut s, results(&res));
    assert_refused_start(&s, reason);
    // A refusal leaves the strategy startable: a good start works after it.
    do_start(&mut s);
    assert_eq!(s.get_lock().unwrap().op_id.0, 1);
}

/// EC-C167: a valid start takes the lock and sends exactly six reads in parallel, each with no
/// deposit and its fixed gas (`GAS_VIEW` for DCL's two, `GAS_READ_STORAGE` for the tokens'), then the callback with fixed gas and no share of unused gas.
#[test]
fn start_sends_exactly_six_reads_and_a_callback() {
    let mut s = ready();
    do_start(&mut s);
    let l = s.get_lock().unwrap();
    assert_eq!((l.op_id.0, l.op, l.stage), (0, Op::Start, Stage::ReadStart));
    assert_eq!(l.promise_block.0, BLOCK + 10);
    assert_eq!(
        s.get_status(),
        Status::Open,
        "not Running until the callback"
    );
    assert_eq!(last_event()["event"], "start_started");
    let c = calls();
    assert_eq!(c.len(), 7, "{c:?}");
    let pool_id = limits_args().pool;
    let me = ME;
    let want: [(String, &str, String); 6] = [
        (
            network().dcl_contract,
            "get_pool",
            format!(r#"{{"pool_id":"{pool_id}"}}"#),
        ),
        (
            network().dcl_contract,
            "get_user_storage_detail",
            format!(r#"{{"user_id":"{me}"}}"#),
        ),
        (
            quote(),
            "storage_balance_of",
            r#"{"account_id":"platform.near"}"#.into(),
        ),
        (
            quote(),
            "storage_balance_of",
            r#"{"account_id":"creator.near"}"#.into(),
        ),
        (
            base(),
            "storage_balance_of",
            r#"{"account_id":"platform.near"}"#.into(),
        ),
        (
            base(),
            "storage_balance_of",
            r#"{"account_id":"creator.near"}"#.into(),
        ),
    ];
    for (i, (got, (to, m, a))) in c.iter().zip(want).enumerate() {
        assert_eq!(
            (got.0.as_str(), got.1.as_str(), got.2.as_str()),
            (to.as_str(), m, a.as_str())
        );
        let gas = if i < 2 { GAS_VIEW } else { GAS_READ_STORAGE };
        assert_eq!((got.3, got.4), (0, gas.as_gas()), "read {i}");
    }
    assert_eq!((c[6].0.as_str(), c[6].1.as_str()), (ME, "on_start_reads"));
    assert_eq!(c[6].2, r#"{"op_id":"0","expected_point":401312}"#);
    assert_eq!(
        (c[6].3, c[6].4, c[6].5),
        (0, GAS_START_CALLBACK.as_gas(), 0)
    );
}

/// EC-C167, EC-C146: a good callback moves to `Running`, sets the start time, releases the lock
/// and emits the exact event; `ft_on_transfer` then keeps pool-token transfers.
#[test]
fn a_good_callback_starts_the_strategy() {
    let mut s = started();
    assert_eq!(s.get_status(), Status::Running);
    assert_eq!(s.get_lock(), None);
    assert_eq!(s.get_started_at(), Some(U64(NOW)));
    assert!(calls().is_empty());
    let e = last_event();
    assert_eq!(e["event"], "start");
    assert_eq!(
        e["data"][0],
        near_sdk::serde_json::json!({"op_id":"0","started_at_ns":NOW.to_string(),"point":POINT,"principal":cap().to_string()})
    );
    // EC-C03: in Running a pool-token transfer is kept and never raises the principal.
    assert_eq!(
        inbound(&mut s, &quote(), "creator.near", 5, "fund", BLOCK + 20),
        0
    );
    assert_eq!(s.get_principal().0, cap());
}

/// One refusal of `start`, with the exact message, no promise and the state unchanged.
fn expect_refusal(
    s: &mut Strategy,
    who: &str,
    ts: u64,
    gas: Gas,
    balance: u128,
    point: i32,
    msg: &str,
) {
    let before = snap(s);
    let m = refused(|| {
        let _ = start_at(s, who, ts, gas, balance, point);
    });
    assert_eq!(m, msg, "{who} {ts} {point}");
    assert!(calls().is_empty(), "{msg}");
    assert_eq!(snap(s), before, "{msg}");
}

/// EC-C167: the first checks in principle 5's order, each refusal changing nothing and sending
/// no promise; the boundaries at the limit and one past; each pair of adjacent checks failing at
/// once reports the earlier (test audit M2, M3).
#[test]
fn start_refusals_in_order() {
    let deadline = config().start_deadline_ns.0;
    let (g, low) = (MIN_GAS_START, Gas::from_gas(MIN_GAS_START.as_gas() - 1));
    // Status first, for anyone: Cancelled and Running, even with everything else wrong.
    for st in [Status::Cancelled, Status::Running] {
        let mut s = ready();
        s.status = st;
        for who in ["outsider.near", "creator.near"] {
            expect_refusal(
                &mut s,
                who,
                deadline,
                Gas::from_tgas(1),
                0,
                9_999_999,
                "LIMIT: wrong status",
            );
        }
    }
    let mut s = ready();
    // The caller before the deadline, the gas and the point.
    for who in [
        "outsider.near",
        "agent.near",
        "platform.near",
        "deliverer.near",
        ME,
    ] {
        expect_refusal(
            &mut s,
            who,
            deadline,
            Gas::from_tgas(1),
            0,
            9_999_999,
            "AUTH: creator only",
        );
    }
    // The deadline before a held lock (the lock and the deadline both failing reports the deadline).
    hold(&mut s);
    expect_refusal(
        &mut s,
        "creator.near",
        deadline,
        low,
        0,
        9_999_999,
        "LIMIT: start deadline passed",
    );
    // The lock before the gas and the point.
    expect_refusal(
        &mut s,
        "creator.near",
        NOW,
        low,
        0,
        9_999_999,
        "LIMIT: operation pending",
    );
    s.lock = None;
    s.next_op_id = 0;
    // The gas before the point; the point before funding; funding before registrations;
    // registrations before the reserve.
    s.principal = 0;
    s.registrations.dcl_storage.state = RegState::Pending;
    expect_refusal(&mut s, "creator.near", NOW, low, 0, 9_999_999, "LIMIT: gas");
    for p in [800_001, -800_001, i32::MAX, i32::MIN] {
        expect_refusal(&mut s, "creator.near", NOW, g, 0, p, "LIMIT: point");
    }
    expect_refusal(
        &mut s,
        "creator.near",
        NOW,
        g,
        0,
        POINT,
        "LIMIT: not funded",
    );
    s.principal = 1;
    expect_refusal(
        &mut s,
        "creator.near",
        NOW,
        g,
        0,
        POINT,
        "LIMIT: registrations not ok",
    );
    s.registrations.dcl_storage.state = RegState::Ok;
    expect_refusal(
        &mut s,
        "creator.near",
        NOW,
        g,
        0,
        POINT,
        "LIMIT: storage reserve",
    );
    assert_eq!(s.get_lock(), None);
    // A principal of 1 is enough (funded means above 0), and the bounds start: one nanosecond
    // before the deadline, a point of 800,000 and of -800,000.
    for p in [800_000, -800_000, 0] {
        let mut t = ready();
        let _ = start_at(&mut t, "creator.near", deadline - 1, g, BAL, p);
        assert!(t.get_lock().is_some(), "{p}");
    }
}

fn hold(s: &mut Strategy) {
    s.lock = Some(Lock {
        op_id: U64(0),
        op: Op::Start,
        stage: Stage::ReadStart,
        promise_block: U64(BLOCK),
    });
    s.next_op_id = 1;
}

/// EC-C167: each registration not `Ok` (`Pending` and `Failed`) refuses, nothing changed.
#[test]
fn start_needs_every_registration_ok() {
    for t in TARGETS {
        for st in [RegState::Pending, RegState::Failed] {
            let mut s = ready();
            s.registrations.get_mut(t).state = st;
            let before = snap(&s);
            let m = refused(|| {
                let _ = start_at(&mut s, "creator.near", NOW, MIN_GAS_START, BAL, POINT);
            });
            assert_eq!(m, "LIMIT: registrations not ok");
            assert_eq!(snap(&s), before);
        }
    }
}

/// EC-C167, EC-C13: the NEAR reserve, at the limit and one yocto below. A funded principal of 1
/// token unit is enough.
#[test]
fn start_needs_the_storage_reserve() {
    let mut s = ready();
    let byte = near_sdk::env::storage_byte_cost().as_yoctonear();
    let need = USAGE as u128 * byte
        + storage_reserve(
            s.deploy_ns,
            s.config.run_end_ns.0,
            s.config.exit_grace_ns.0,
            s.limits.max_actions_per_24h,
            s.limits.min_action_interval_s.0,
            byte,
        );
    let before = snap(&s);
    assert_eq!(
        refused(|| {
            let _ = start_at(&mut s, "creator.near", NOW, MIN_GAS_START, need - 1, POINT);
        }),
        "LIMIT: storage reserve"
    );
    assert_eq!(snap(&s), before);
    let _ = start_at(&mut s, "creator.near", NOW, MIN_GAS_START, need, POINT);
    assert!(s.get_lock().is_some());
}

/// EC-C13: the reserve in yoctoNEAR equals the architecture's worked examples exactly, `D` rounds
/// up at N days + 1 ns, and the 24-hour count caps at `floor(86_400 / interval) + 1`.
#[test]
fn storage_reserve_formula() {
    let byte = 10u128.pow(19);
    let rec = RECORD_BYTES as u128 * byte; // 0.015 NEAR
    let day = DAY_NS;
    // 30-day run (D = 31 with a one-day grace), 6 a day: (32 * 6 + 2 + 56 + 256) records.
    assert_eq!(
        storage_reserve(0, 30 * day, day, 6, 600, byte),
        (32 * 6 + 2 + 56 + 256) * rec
    );
    // At the bounds: D = 37, 48 a day, interval 300 s.
    assert_eq!(
        storage_reserve(0, 30 * day, 7 * day, 48, 300, byte),
        (38 * 48 + 2 + 56 + 256) * rec
    );
    // D at exactly N days and N days + 1 ns.
    assert_eq!(
        storage_reserve(0, 3 * day, 0, 6, 600, byte),
        (4 * 6 + 2 + 56 + 256) * rec
    );
    assert_eq!(
        storage_reserve(0, 3 * day + 1, 0, 6, 600, byte),
        (5 * 6 + 2 + 56 + 256) * rec
    );
    // Where max_actions and floor(86_400 / interval) + 1 cross: interval 3,600 gives 25.
    assert_eq!(
        storage_reserve(0, 3 * day, 0, 25, 3_600, byte),
        (4 * 25 + 2 + 56 + 256) * rec
    );
    assert_eq!(
        storage_reserve(0, 3 * day, 0, 26, 3_600, byte),
        (4 * 25 + 2 + 56 + 256) * rec
    );
    assert_eq!(
        storage_reserve(0, 3 * day, 0, 24, 3_600, byte),
        (4 * 24 + 2 + 56 + 256) * rec
    );
    // `deploy_ns` after the end of the run: no days left, one batch day (D = 0, so D + 1 = 1).
    assert_eq!(
        storage_reserve(10 * day, 5 * day, 0, 6, 600, byte),
        (6 + 2 + 56 + 256) * rec
    );
    // A zero interval is read as one second (never a division by zero), capping at max_actions.
    assert_eq!(
        storage_reserve(0, day, 0, 6, 0, byte),
        (2 * 6 + 2 + 56 + 256) * rec
    );
    // The product saturates at `u128::MAX` instead of wrapping, for any argument.
    assert_eq!(
        storage_reserve(u64::MAX, 0, 0, u32::MAX, 0, u128::MAX),
        u128::MAX
    );
    assert_eq!(
        storage_reserve(0, u64::MAX, u64::MAX, u32::MAX, 1, u128::MAX),
        u128::MAX
    );
}

/// EC-C136: drift at `max_observation_drift_bps` points allowed (both sides), one past refused.
#[test]
fn the_callback_checks_the_pool_point() {
    let d = drift();
    for (p, good_) in [
        (POINT as i64 + d, true),
        (POINT as i64 - d, true),
        (POINT as i64 + d + 1, false),
        (POINT as i64 - d - 1, false),
    ] {
        let mut v = good();
        v[0] = pool(p, "Running", &quote(), &base());
        if good_ {
            let mut s = ready();
            do_start(&mut s);
            callback_start(&mut s, results(&v));
            assert_eq!(s.get_status(), Status::Running, "{p}");
            assert_eq!(last_event()["data"][0]["point"], p);
        } else {
            refuses_with(v, "drift");
        }
    }
}

/// EC-C167: a pool that isn't ours, isn't running or has no usable point is `pool`.
#[test]
fn the_callback_checks_the_pool() {
    let (q, b) = (quote(), base());
    let mut cases: Vec<String> = vec![
        pool(POINT as i64, "Paused", &q, &b),
        pool(POINT as i64, "Locked", &q, &b),
        pool(POINT as i64, "Running", "other.near", &b),
        pool(POINT as i64, "Running", &q, "other.near"),
        pool(POINT as i64, "Running", &q, &q),
        pool(800_001, "Running", &q, &b),
        pool(-800_001, "Running", &q, &b),
        pool(POINT as i64, "Running", &b.to_uppercase(), &q),
        r#"{"token_x":"a","token_y":"b"}"#.into(),
        "[]".into(),
        r#"{"pool_id":"x|y|100","token_x":"q","token_y":"b"}"#.into(),
    ];
    // current_point as a string or a float is not a point.
    cases.push(pool(POINT as i64, "Running", &q, &b).replace("401312", "\"401312\""));
    cases.push(pool(POINT as i64, "Running", &q, &b).replace("401312", "401312.5"));
    // pool_id of another pool
    cases.push(pool(POINT as i64, "Running", &q, &b).replace("|100", "|2000"));
    for c in cases {
        let mut v = good();
        v[0] = c.clone();
        let mut s = ready();
        do_start(&mut s);
        callback_start(&mut s, results(&v));
        assert_refused_start(&s, "pool");
    }
}

/// EC-C167 (EC-C109): free slots at `MIN_FREE_SLOTS` allowed, one fewer refused; order slots
/// count too; a missing or non-numeric field is a failed read.
#[test]
fn the_callback_checks_the_free_slots() {
    let mut v = good();
    v[1] = slots(190, 160, 0); // 30 free
    let mut s = ready();
    do_start(&mut s);
    callback_start(&mut s, results(&v));
    assert_eq!(s.get_status(), Status::Running);
    for sl in [
        slots(190, 161, 0),
        slots(190, 160, 1),
        slots(190, 190, 0),
        slots(10, 20, 0),
        slots(0, 0, 0),
        slots(29, 0, 0),
    ] {
        let mut v = good();
        v[1] = sl;
        refuses_with(v, "slots");
    }
    for bad in [
        r#"{"max_slots":190,"cur_liquidity_slots":0}"#,
        r#"{"max_slots":"190","cur_order_slots":0,"cur_liquidity_slots":0}"#,
        "null",
        "[]",
        r#"{"max_slots":-1,"cur_order_slots":0,"cur_liquidity_slots":0}"#,
    ] {
        let mut v = good();
        v[1] = bad.into();
        refuses_with(v, "read failed");
    }
}

/// EC-C136: each of the four payee registrations missing (`null`) is refused; an object of any
/// shape counts as registered; a non-object that isn't null is not registered.
#[test]
fn the_callback_checks_every_payee_at_both_tokens() {
    for i in 2..6 {
        let mut v = good();
        v[i] = "null".into();
        refuses_with(v, "payee not registered");
    }
    let mut v = good();
    v[2] = r#"{"total":"1","available":"0"}"#.into();
    v[3] = "{}".into();
    let mut s = ready();
    do_start(&mut s);
    callback_start(&mut s, results(&v));
    assert_eq!(s.get_status(), Status::Running);
    for bad in ["0", "true", "[]", "\"x\""] {
        let mut v = good();
        v[4] = bad.into();
        refuses_with(v, "payee not registered");
    }
}

/// EC-C136: the quote dust at exactly 10^-3 of `max_principal` allowed, one unit above refused;
/// the base dust at the largest amount worth that much allowed, one unit above refused.
#[test]
fn the_callback_checks_the_dust_thresholds() {
    let net = network();
    let limit = cap() / 1_000;
    let set = |s: &mut Strategy, q: u128, b: u128| {
        s.limits.dust_threshold = vec![
            (acc(&net.quote_token), U128(q)),
            (acc(&net.base_token), U128(b)),
        ];
    };
    let run = |q: u128, b: u128| -> Strategy {
        let mut s = ready();
        set(&mut s, q, b);
        do_start(&mut s);
        callback_start(&mut s, results(&good()));
        s
    };
    assert_eq!(run(limit, 1).get_status(), Status::Running);
    let s = run(limit + 1, 1);
    assert_refused_start(&s, "dust threshold");
    // The base token: the smallest amount worth more than the limit (quote is token_x here).
    let worth = |d: u128| price::base_to_quote(d, POINT, true).unwrap();
    let (mut lo, mut hi) = (1u128, u128::MAX / 2);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if worth(mid) > limit {
            hi = mid
        } else {
            lo = mid + 1
        }
    }
    assert!(worth(lo - 1) <= limit && worth(lo) > limit);
    assert_eq!(run(1, lo - 1).get_status(), Status::Running);
    assert_refused_start(&run(1, lo), "dust threshold");
    // An amount so large its value overflows `* 1_000` is refused, never wrapped.
    assert_refused_start(&run(1, u128::MAX), "dust threshold");
    assert_refused_start(&run(u128::MAX, 1), "dust threshold");
}

/// EC-C136: when the quote token is `token_y` the base token's value is the other conversion.
#[test]
fn the_dust_valuation_follows_the_pool_order() {
    let (q, b) = (quote(), base());
    let limit = cap() / 1_000;
    let mut v = good();
    v[0] = pool(POINT as i64, "Running", &b, &q); // quote is token_y
    let worth = |d: u128| price::base_to_quote(d, POINT, false).unwrap();
    // The base dust is 1 wNEAR-yocto-scale unit: worth almost nothing at either order, but with
    // quote as y a base unit is worth far more per unit; find the boundary again.
    let (mut lo, mut hi) = (1u128, u128::MAX / 2);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if worth(mid) > limit {
            hi = mid
        } else {
            lo = mid + 1
        }
    }
    let net = network();
    for (d, started) in [(lo - 1, true), (lo, false)] {
        let mut s = ready();
        s.limits.dust_threshold = vec![
            (acc(&net.quote_token), U128(1)),
            (acc(&net.base_token), U128(d)),
        ];
        do_start(&mut s);
        callback_start(&mut s, results(&v));
        if started {
            assert_eq!(s.get_status(), Status::Running);
        } else {
            assert_refused_start(&s, "dust threshold");
        }
    }
}

/// EC-C167: a failed, over-long or non-JSON read, and the wrong number of results, are failed reads.
#[test]
fn the_callback_survives_bad_reads() {
    for i in 0..2 {
        let mut s = ready();
        do_start(&mut s);
        let mut res = results(&good());
        res[i] = PromiseResult::Failed;
        callback_start(&mut s, res);
        assert_refused_start(&s, "read failed");
    }
    // A failed payee read is a payee not registered (it can't be shown registered).
    let mut s = ready();
    do_start(&mut s);
    let mut res = results(&good());
    res[3] = PromiseResult::Failed;
    callback_start(&mut s, res);
    assert_refused_start(&s, "payee not registered");
    // Non-JSON and over 4 KB.
    for body in ["not json".to_string(), "x".repeat(5_000)] {
        let mut s = ready();
        do_start(&mut s);
        let mut res = results(&good());
        res[0] = ok(&body);
        callback_start(&mut s, res);
        assert_refused_start(&s, "read failed");
    }
    // Five and seven results.
    for n in [0usize, 5, 7] {
        let mut s = ready();
        do_start(&mut s);
        let mut res = results(&good());
        res.truncate(n);
        while res.len() < n {
            res.push(ok("null"));
        }
        callback_start(&mut s, res);
        assert_refused_start(&s, "read failed");
    }
}

/// EC-C63, EC-C167: the callback re-checks status and the deadline (the status can only change
/// without the lock through a stale resolution, so it is set directly), and ignores a start whose
/// deadline passed while the reads were in flight.
#[test]
fn the_callback_rechecks_status_and_deadline() {
    let mut s = ready();
    do_start(&mut s);
    s.status = Status::Cancelled;
    callback_start(&mut s, results(&good()));
    assert_eq!(s.get_lock(), None);
    assert_eq!(s.get_status(), Status::Cancelled);
    assert_eq!(last_event()["event"], "start_refused");
    assert_eq!(last_event()["data"][0]["reason"], "LIMIT: wrong status");

    let deadline = config().start_deadline_ns.0;
    for (ts, started) in [(deadline - 1, true), (deadline, false)] {
        let mut s = ready();
        do_start(&mut s);
        let mut b = ctx(ME, BAL, GAS_ON_BALANCE_FOR_TESTS, BLOCK + 12);
        b.block_timestamp(ts);
        testing_env!(
            b.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results(&good())
        );
        s.on_start_reads(U64(0), POINT);
        if started {
            assert_eq!(s.get_status(), Status::Running);
            assert_eq!(s.get_started_at(), Some(U64(ts)));
        } else {
            assert_refused_start(&s, "start deadline passed");
        }
    }
}
const GAS_ON_BALANCE_FOR_TESTS: Gas = Gas::from_tgas(50);

/// EC-C11, EC-C167: callbacks by outsiders are refused; a callback for another op or with no lock
/// does nothing but log `callback_ignored`; a late callback after a stale resolution can't start
/// a strategy whose lock is gone.
#[test]
fn the_callback_acts_only_on_its_own_lock() {
    let mut s = ready();
    do_start(&mut s);
    let before = snap(&s);
    for who in ["creator.near", "outsider.near", "platform.near"] {
        testing_env!(
            ctx(who, BAL, GAS_ON_BALANCE_FOR_TESTS, BLOCK + 12).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results(&good())
        );
        assert_eq!(
            refused(|| s.on_start_reads(U64(0), POINT)),
            "AUTH: callback only"
        );
    }
    assert_eq!(snap(&s), before);
    as_callback(BLOCK + 12, results(&good()));
    s.on_start_reads(U64(7), POINT);
    assert_eq!(snap(&s), before);
    assert_eq!(last_event()["event"], "callback_ignored");
    // No lock at all.
    let mut s = ready();
    let before = snap(&s);
    as_callback(BLOCK + 12, results(&good()));
    s.on_start_reads(U64(0), POINT);
    assert_eq!(snap(&s), before);
    assert_eq!(events().len(), 1);
}

/// EC-C63: `cancel` is refused while `start` is in flight; `resolve_stale` releases a lost start
/// after `stale_after_blocks`, the creator can start again, and the lost callback arriving late
/// is ignored.
#[test]
fn cancel_and_stale_around_a_start_in_flight() {
    let stale = config().stale_after_blocks.0;
    let mut s = ready();
    do_start(&mut s); // lock launched at BLOCK + 10
    at("creator.near", BLOCK + 11, NOW, Gas::from_tgas(10));
    assert_eq!(refused(|| s.cancel()), "LIMIT: operation pending");
    assert_eq!(s.get_status(), Status::Open);
    // resolve_stale one block early refused, at it released.
    at(
        "outsider.near",
        BLOCK + 10 + stale - 1,
        NOW,
        Gas::from_tgas(10),
    );
    assert_eq!(refused(|| s.resolve_stale()), "LIMIT: not stale yet");
    at("outsider.near", BLOCK + 10 + stale, NOW, Gas::from_tgas(10));
    s.resolve_stale();
    assert_eq!(s.get_lock(), None);
    assert_eq!(s.get_status(), Status::Open);
    assert_eq!(last_event()["data"][0]["op"], "Start");
    // The creator starts again (op 1); the old callback (op 0) arrives late and is ignored.
    let _ = start_at(&mut s, "creator.near", NOW, MIN_GAS_START, BAL, POINT);
    assert_eq!(s.get_lock().unwrap().op_id.0, 1);
    as_callback(BLOCK + stale + 20, results(&good()));
    s.on_start_reads(U64(0), POINT);
    assert_eq!(s.get_status(), Status::Open);
    assert_eq!(s.get_lock().unwrap().op_id.0, 1);
    // The new callback starts it.
    as_callback(BLOCK + stale + 21, results(&good()));
    s.on_start_reads(U64(1), POINT);
    assert_eq!(s.get_status(), Status::Running);
}

/// EC-C167: `new` records the deploy block (a hint for the page, interface audit M-2) and no start time.
#[test]
fn new_records_the_deploy_block() {
    let s = deployed();
    assert_eq!(s.get_deploy_block(), U64(BLOCK));
    assert_eq!(s.get_started_at(), None);
}

/// EC-C13, EC-C167: once `Running`, `withdraw` and `cancel` are refused and the strategy has no
/// way back to `Open` or `Cancelled`.
#[test]
fn running_cannot_cancel_or_withdraw() {
    let mut s = started();
    at("creator.near", BLOCK + 500, NOW, MIN_GAS_WITHDRAW);
    assert_eq!(refused(|| s.cancel()), "LIMIT: wrong status");
    assert_eq!(
        refused(|| {
            let _ = s.withdraw(quote());
        }),
        "LIMIT: wrong status"
    );
    assert_eq!(s.get_status(), Status::Running);
}

/// Test audit (low): the callback with the status already `Running`, and the precedence of its
/// checks: a wrong result count first, then the status, then the deadline, then the answers.
#[test]
fn the_callback_check_order() {
    let deadline = config().start_deadline_ns.0;
    let mut s = ready();
    do_start(&mut s);
    s.status = Status::Running;
    callback_start(&mut s, results(&good()));
    assert_eq!(s.get_lock(), None);
    assert_eq!(s.get_status(), Status::Running);
    assert_eq!(last_event()["event"], "start_refused");
    assert_eq!(last_event()["data"][0]["reason"], "LIMIT: wrong status");
    // Five results and a changed status: the count first.
    let mut s = ready();
    do_start(&mut s);
    s.status = Status::Cancelled;
    callback_start(&mut s, results(&good()[..5]));
    assert_eq!(last_event()["data"][0]["reason"], "LIMIT: read failed");
    // A changed status and a passed deadline: the status first.
    let mut s = ready();
    do_start(&mut s);
    s.status = Status::Cancelled;
    let mut b = ctx(ME, BAL, Gas::from_tgas(50), BLOCK + 12);
    b.block_timestamp(deadline);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results(&good())
    );
    s.on_start_reads(U64(0), POINT);
    assert_eq!(last_event()["data"][0]["reason"], "LIMIT: wrong status");
    // A passed deadline and a failed pool read: the deadline first.
    let mut s = ready();
    do_start(&mut s);
    let mut res = results(&good());
    res[0] = PromiseResult::Failed;
    let mut b = ctx(ME, BAL, Gas::from_tgas(50), BLOCK + 12);
    b.block_timestamp(deadline);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        res
    );
    s.on_start_reads(U64(0), POINT);
    assert_eq!(
        last_event()["data"][0]["reason"],
        "LIMIT: start deadline passed"
    );
    // The pool before the drift; the drift before the slots; the slots before the payees; the
    // payees before the dust.
    let mut v = good();
    v[0] = pool(900_000, "Running", &quote(), &base());
    v[1] = slots(0, 0, 0);
    refuses_with(v, "pool");
    let mut v = good();
    v[0] = pool(POINT as i64 + 100, "Running", &quote(), &base());
    v[1] = slots(0, 0, 0);
    refuses_with(v, "drift");
    let mut v = good();
    v[1] = slots(0, 0, 0);
    v[2] = "null".into();
    refuses_with(v, "slots");
}

proptest::proptest! {
    #![proptest_config(proptest::prelude::ProptestConfig::with_cases(48))]
    /// Test audit (low): the drift check is exactly `|point - expected| <= max_observation_drift_bps`,
    /// and the free-slot check is exactly `free >= MIN_FREE_SLOTS`, for any point and slot counts.
    #[test]
    fn drift_and_slots_are_exact(d in -120i64..=120, free in 0u64..=60) {
        let mut v = good();
        v[0] = pool(POINT as i64 + d, "Running", &quote(), &base());
        v[1] = slots(190, 190 - free, 0);
        let mut s = ready();
        do_start(&mut s);
        callback_start(&mut s, results(&v));
        let started = s.get_status() == Status::Running;
        proptest::prop_assert_eq!(started, d.abs() <= drift() && free >= MIN_FREE_SLOTS);
    }
}

/// Starts `ready()`'s strategy as the creator with the given balance (viewing-key tests).
pub(super) fn start_at_for_keys(s: &mut Strategy, balance: u128) {
    let _ = start_at(s, "creator.near", NOW, MIN_GAS_START, balance, POINT);
}
