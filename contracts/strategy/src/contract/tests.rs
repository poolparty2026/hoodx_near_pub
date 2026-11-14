//! Slice 2 unit tests (EC-C165; EC-C11 for callbacks; EC-C54 and EC-C56 through `new`).
//! Cross-contract behaviour (real gas, DCL's and the tokens' answers, `#[init]` twice and
//! `#[private]` in the wasm) is for the sandbox tests of slice 2b.
use super::*;
use crate::limits::{DAY_NS, NANOS_PER_S, ONE_NEAR};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use std::panic::{catch_unwind, AssertUnwindSafe};

pub(super) const NOW: u64 = 1_700_000_000 * NANOS_PER_S;
pub(super) const BLOCK: u64 = 5_000;
pub(super) const USAGE: u64 = 323_000; // about the size of the wasm
pub(super) const BAL: u128 = 20 * ONE_NEAR;

pub(super) fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
pub(super) fn me() -> AccountId {
    acc(ME)
}
pub(super) fn config() -> ConfigArgs {
    let n = network();
    ConfigArgs {
        creator: acc("creator.near"),
        agent: acc("agent.near"),
        deliverer: acc("deliverer.near"),
        platform_account: acc("platform.near"),
        quote_token: acc(&n.quote_token),
        dcl_contract: acc(&n.dcl_contract),
        rules_hash: "ab".repeat(32),
        rules_ciphertext: Base64VecU8(vec![1; 300]),
        platform_bps: 500,
        key_price: U128(ONE_NEAR / 10),
        max_key_sales: 20,
        key_delivery_window_ns: U64(3_600 * NANOS_PER_S),
        start_deadline_ns: U64(NOW + DAY_NS),
        run_end_ns: U64(NOW + 6 * DAY_NS),
        exit_grace_ns: U64(DAY_NS),
        platform_claim_window_ns: U64(2 * DAY_NS),
        stale_after_blocks: U64(1_000),
        stale_cooldown_blocks: U64(1_500),
        dcl_storage: U128(2 * ONE_NEAR),
        attested: false,
    }
}
pub(super) fn limits_args() -> LimitsArgs {
    let n = network();
    LimitsArgs {
        max_principal: U128(limits::MAX_PRINCIPAL_CAP),
        pool: n.pool.clone(),
        max_slippage_bps: 50,
        max_swap_slippage_bps: 60,
        max_swap_step_bps: 6_000,
        max_observation_drift_bps: 30,
        max_observation_age_blocks: U64(20),
        min_range_width_bps: 1_000,
        max_range_width_bps: 2_000,
        min_action_interval_s: U64(600),
        max_actions_per_24h: 6,
        dust_threshold: vec![
            (acc(&n.quote_token), U128(1_000)),
            (acc(&n.base_token), U128(10u128.pow(18))),
        ],
    }
}
/// A context as `pred`, at block `block`, with a balance and prepaid gas.
pub(super) fn ctx(pred: &str, balance: u128, gas: Gas, block: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(me())
        .predecessor_account_id(acc(pred))
        .signer_account_id(acc(pred))
        .block_timestamp(NOW)
        .block_height(block)
        .storage_usage(USAGE)
        .prepaid_gas(gas)
        .account_balance(NearToken::from_yoctonear(balance));
    b
}
// A sandbox build refuses `new` outside `.test.near`.
#[cfg(not(feature = "sandbox"))]
pub(super) const ME: &str = "strategy-1.poolside.near";
#[cfg(feature = "sandbox")]
pub(super) const ME: &str = "strategy-1.test.near";
pub(super) fn deployed() -> Strategy {
    testing_env!(ctx(ME, BAL, Gas::from_tgas(300), BLOCK).build());
    Strategy::new(config(), limits_args())
}
pub(super) fn result(ok: bool) -> PromiseResult {
    if ok {
        PromiseResult::Successful(br#"{"total":"1250000000000000000000","available":"0"}"#.to_vec())
    } else {
        PromiseResult::Failed
    }
}
fn callback_with(s: &mut Strategy, t: Target, nonce: u32, check: bool, res: Vec<PromiseResult>) {
    testing_env!(
        ctx(ME, BAL, Gas::from_tgas(10), BLOCK).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        res
    );
    s.on_registered(t, nonce, check);
}
pub(super) fn callback(s: &mut Strategy, t: Target, ok: bool) {
    let n = s.get_registrations().get(t).nonce;
    callback_with(s, t, n, false, vec![result(ok)]);
}
fn as_creator(s: &mut Strategy, t: Target, balance: u128, block: u64) {
    testing_env!(ctx("creator.near", balance, Gas::from_tgas(300), block).build());
    s.retry_registration(t);
}
/// Every function call `get_created_receipts` holds: (receiver, method, args, deposit, gas, weight).
pub(super) fn calls() -> Vec<(String, String, String, u128, u64, u64)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    prepaid_gas,
                    gas_weight,
                    ..
                } => Some((
                    to.clone(),
                    String::from_utf8(method_name).unwrap(),
                    String::from_utf8(args).unwrap(),
                    attached_deposit.as_yoctonear(),
                    prepaid_gas.as_gas(),
                    gas_weight.0,
                )),
                _ => None,
            })
        })
        .collect()
}
/// What the contract keeps for its storage stake after a spend: storage used plus the margin.
pub(super) fn stake() -> u128 {
    env::storage_byte_cost().as_yoctonear() * (USAGE + STORAGE_MARGIN_BYTES) as u128
}
/// The refusal message of `f`: `env::panic_str` in the mocked blockchain surfaces as a
/// `GuestPanic { panic_msg: "..." }` unwrap, so the message is taken from inside it.
pub(super) fn refused(f: impl FnOnce()) -> String {
    let e = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a refusal");
    let raw = e
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    match raw.split_once("panic_msg: \"") {
        Some((_, rest)) => rest
            .split_once('"')
            .map(|(m, _)| m.to_string())
            .unwrap_or(rest.to_string()),
        None => raw,
    }
}

/// A sandbox build refuses `new` outside `.test.near` (contract review L5).
#[cfg(feature = "sandbox")]
#[test]
fn a_sandbox_build_refuses_outside_test_near() {
    let mut b = ctx(ME, BAL, Gas::from_tgas(300), BLOCK);
    b.current_account_id(acc("strategy-1.poolside.near"))
        .predecessor_account_id(acc("strategy-1.poolside.near"));
    testing_env!(b.build());
    assert_eq!(
        refused(|| {
            Strategy::new(config(), limits_args());
        }),
        "LIMIT: sandbox build"
    );
}

#[test]
fn default_build_is_mainnet() {
    // CI also checks the release wasm contains no sandbox account (security L-4, contract review L5).
    #[cfg(not(feature = "sandbox"))]
    {
        let n = network();
        let m = Network::mainnet();
        assert_eq!(
            (n.quote_token, n.base_token, n.dcl_contract, n.pool),
            (m.quote_token, m.base_token, m.dcl_contract, m.pool)
        );
    }
}

/// EC-C165: stored unchanged, three registrations Pending at nonce 1, and exactly these calls out.
#[test]
fn new_stores_the_configuration_and_sends_exactly_three_registrations() {
    let s = deployed();
    assert_eq!(s.get_status(), Status::Open);
    assert_eq!(s.get_config(), &config());
    assert_eq!(s.get_limits(), &limits_args());
    let p = Registration {
        state: RegState::Pending,
        nonce: 1,
        launched_block: BLOCK,
        deposit_may_have_landed: false,
        deposit_block: 0,
    };
    // DCL storage's deposit is out, so it may have landed.
    let d = Registration {
        deposit_may_have_landed: true,
        deposit_block: BLOCK,
        ..p
    };
    assert_eq!(
        s.get_registrations(),
        Registrations {
            quote_token: p,
            base_token: p,
            dcl_storage: d
        }
    );
    let n = network();
    let token_args = format!(r#"{{"account_id":"{ME}","registration_only":true}}"#);
    let c = calls();
    let out: Vec<_> = c.iter().filter(|x| x.0 != ME).cloned().collect();
    assert_eq!(
        out,
        vec![
            (
                n.quote_token.clone(),
                "storage_deposit".into(),
                token_args.clone(),
                TOKEN_STORAGE.as_yoctonear(),
                GAS_REGISTER.as_gas(),
                0
            ),
            (
                n.base_token.clone(),
                "storage_deposit".into(),
                token_args,
                TOKEN_STORAGE.as_yoctonear(),
                GAS_REGISTER.as_gas(),
                0
            ),
            (
                n.dcl_contract.clone(),
                "storage_deposit".into(),
                format!(r#"{{"account_id":"{ME}"}}"#),
                2 * ONE_NEAR,
                GAS_REGISTER.as_gas(),
                0
            ),
        ]
    );
    // DCL's register_tokens is never sent (gate 3: it panics E104 and isn't needed).
    assert!(c.iter().all(|x| x.1 != "register_tokens"));
    // Each callback is on_registered for its own target and nonce, with fixed gas and no share of unused gas.
    let cbs: Vec<_> = c.iter().filter(|x| x.0 == ME).cloned().collect();
    assert_eq!(cbs.len(), 3);
    for (t, cb) in ["QuoteToken", "BaseToken", "DclStorage"].iter().zip(&cbs) {
        assert_eq!(cb.1, "on_registered");
        assert_eq!(
            cb.2,
            format!(r#"{{"target":"{t}","nonce":1,"check_only":false}}"#)
        );
        assert_eq!((cb.3, cb.4, cb.5), (0, GAS_CALLBACK.as_gas(), 0));
    }
    let logs = get_logs();
    assert_eq!(
        logs[0],
        r#"EVENT_JSON:{"standard":"poolside","version":"1.0.0","event":"new","data":[{"creator":"creator.near","rules_hash":"abababababababababababababababababababababababababababababababab"}]}"#
    );
    assert_eq!(
        logs[1],
        r#"EVENT_JSON:{"standard":"poolside","version":"1.0.0","event":"registration_started","data":[{"target":"QuoteToken","nonce":1,"check_only":false}]}"#
    );
}

/// Test F1: to_pure copies every field to its own place (each field a distinct value).
#[test]
fn to_pure_maps_every_field() {
    let c = ConfigArgs {
        creator: acc("c1.near"),
        agent: acc("c2.near"),
        deliverer: acc("c3.near"),
        platform_account: acc("c4.near"),
        quote_token: acc("c5.near"),
        dcl_contract: acc("c6.near"),
        rules_hash: String::new(),
        rules_ciphertext: Base64VecU8(vec![7, 8, 9]),
        platform_bps: 11,
        key_price: U128(12),
        max_key_sales: 13,
        key_delivery_window_ns: U64(14),
        start_deadline_ns: U64(15),
        run_end_ns: U64(16),
        exit_grace_ns: U64(17),
        platform_claim_window_ns: U64(18),
        stale_after_blocks: U64(19),
        stale_cooldown_blocks: U64(20),
        dcl_storage: U128(21),
        attested: true,
    };
    let l = LimitsArgs {
        max_principal: U128(31),
        pool: "p.near".into(),
        max_slippage_bps: 32,
        max_swap_slippage_bps: 33,
        max_swap_step_bps: 6_000,
        max_observation_drift_bps: 34,
        max_observation_age_blocks: U64(35),
        min_range_width_bps: 36,
        max_range_width_bps: 37,
        min_action_interval_s: U64(38),
        max_actions_per_24h: 39,
        dust_threshold: vec![(acc("d1.near"), U128(40)), (acc("d2.near"), U128(41))],
    };
    let (pc, pl) = to_pure(&c, &l, [42; 32]);
    let want_c = limits::Config {
        creator: "c1.near".into(),
        agent: "c2.near".into(),
        deliverer: "c3.near".into(),
        platform_account: "c4.near".into(),
        quote_token: "c5.near".into(),
        dcl_contract: "c6.near".into(),
        rules_hash: [42; 32],
        rules_ciphertext: vec![7, 8, 9],
        platform_bps: 11,
        key_price: 12,
        max_key_sales: 13,
        key_delivery_window_ns: 14,
        start_deadline_ns: 15,
        run_end_ns: 16,
        exit_grace_ns: 17,
        platform_claim_window_ns: 18,
        stale_after_blocks: 19,
        stale_cooldown_blocks: 20,
        dcl_storage: 21,
        attested: true,
    };
    let want_l = limits::PublicLimits {
        max_principal: 31,
        pool: "p.near".into(),
        max_slippage_bps: 32,
        max_swap_slippage_bps: 33,
        max_swap_step_bps: 6_000,
        max_observation_drift_bps: 34,
        max_observation_age_blocks: 35,
        min_range_width_bps: 36,
        max_range_width_bps: 37,
        min_action_interval_s: 38,
        max_actions_per_24h: 39,
        dust_threshold: vec![("d1.near".into(), 40), ("d2.near".into(), 41)],
    };
    assert_eq!(format!("{pc:?}"), format!("{want_c:?}"));
    assert_eq!(format!("{pl:?}"), format!("{want_l:?}"));
}

/// EC-C56 through `new`: a bound one past its limit on the JSON arguments gives that field's message, nothing stored.
#[test]
fn new_refuses_each_bound_one_past_its_limit() {
    type Edit = Box<dyn Fn(&mut ConfigArgs, &mut LimitsArgs)>;
    let cases: Vec<(&str, Edit)> = vec![
        (
            "LIMIT: max principal",
            Box::new(|_, l| l.max_principal = U128(limits::MAX_PRINCIPAL_CAP + 1)),
        ),
        ("LIMIT: slippage", Box::new(|_, l| l.max_slippage_bps = 301)),
        (
            "LIMIT: swap slippage",
            Box::new(|_, l| l.max_swap_slippage_bps = 101),
        ),
        (
            "LIMIT: stale cooldown blocks",
            Box::new(|c, _| c.stale_cooldown_blocks = U64(2_001)),
        ),
        (
            "LIMIT: rules ciphertext size",
            Box::new(|c, _| c.rules_ciphertext = Base64VecU8(vec![0; limits::MAX_CIPHERTEXT + 1])),
        ),
        (
            "LIMIT: key price",
            Box::new(|c, _| c.key_price = U128(ONE_NEAR + 1)),
        ),
        (
            "LIMIT: dcl storage",
            Box::new(|c, _| c.dcl_storage = U128(10 * ONE_NEAR + 1)),
        ),
        (
            "LIMIT: actions per 24h bound",
            Box::new(|_, l| l.max_actions_per_24h = 49),
        ),
        (
            "LIMIT: accounts not distinct",
            Box::new(|c, _| c.agent = c.creator.clone()),
        ),
        (
            "LIMIT: accounts not distinct",
            Box::new(|c, _| c.deliverer = me()),
        ),
        ("LIMIT: attested", Box::new(|c, _| c.attested = true)),
        (
            "LIMIT: rules hash",
            Box::new(|c, _| c.rules_hash = "ab".repeat(31)),
        ),
    ];
    for (msg, edit) in cases {
        let (mut c, mut l) = (config(), limits_args());
        edit(&mut c, &mut l);
        testing_env!(ctx(ME, BAL, Gas::from_tgas(300), BLOCK).build());
        assert_eq!(
            refused(|| {
                Strategy::new(c, l);
            }),
            msg
        );
        assert!(get_created_receipts().is_empty(), "{msg}: nothing sent");
    }
}

/// Contract review M2, security M-2: only the strategy account itself (its deploy batch) may call `new`.
#[test]
fn new_by_anyone_else_is_refused() {
    testing_env!(ctx("attacker.near", BAL, Gas::from_tgas(300), BLOCK).build());
    assert_eq!(
        refused(|| {
            Strategy::new(config(), limits_args());
        }),
        "AUTH: new only by the strategy account or its parent"
    );
    assert!(get_created_receipts().is_empty());
}

/// Principle 8: `new` at MIN_GAS_NEW is allowed, one gas unit less refused, nothing sent.
#[test]
fn new_needs_its_minimum_gas() {
    testing_env!(ctx(ME, BAL, MIN_GAS_NEW, BLOCK).build());
    Strategy::new(config(), limits_args());
    testing_env!(ctx(ME, BAL, Gas::from_gas(MIN_GAS_NEW.as_gas() - 1), BLOCK).build());
    assert_eq!(
        refused(|| {
            Strategy::new(config(), limits_args());
        }),
        "LIMIT: gas"
    );
    assert!(get_created_receipts().is_empty());
}

/// Contract review M1, security L-1: the balance check counts the contract's own storage; at the limit allowed, one below refused.
#[test]
fn new_needs_the_registrations_cost_plus_its_storage_stake() {
    let limit = registration_cost(2 * ONE_NEAR) + stake();
    testing_env!(ctx(ME, limit, Gas::from_tgas(300), BLOCK).build());
    Strategy::new(config(), limits_args());
    testing_env!(ctx(ME, limit - 1, Gas::from_tgas(300), BLOCK).build());
    assert_eq!(
        refused(|| {
            Strategy::new(config(), limits_args());
        }),
        "LIMIT: balance for registration"
    );
    assert!(get_created_receipts().is_empty());
}

#[test]
fn registration_cost_is_exact() {
    assert_eq!(
        registration_cost(2 * ONE_NEAR),
        2 * 1_250_000_000_000_000_000_000 + 2 * ONE_NEAR
    );
    assert_eq!(
        launch_cost(Target::QuoteToken, 2 * ONE_NEAR, false),
        1_250_000_000_000_000_000_000
    );
    assert_eq!(
        launch_cost(Target::BaseToken, 2 * ONE_NEAR, true),
        1_250_000_000_000_000_000_000
    );
    assert_eq!(
        launch_cost(Target::DclStorage, 2 * ONE_NEAR, false),
        2 * ONE_NEAR
    );
    assert_eq!(launch_cost(Target::DclStorage, 2 * ONE_NEAR, true), 0);
}

#[test]
fn parse_hash_accepts_only_64_lowercase_hex() {
    assert_eq!(parse_hash(&"0f".repeat(32)), Some([0x0f; 32]));
    for bad in [
        "0F".repeat(32),
        "0g".repeat(32),
        "0".repeat(63),
        "0".repeat(65),
        String::new(),
        "é".repeat(32),
    ] {
        assert_eq!(parse_hash(&bad), None, "{bad}");
    }
}

/// EC-C165, test F4: a realistic storage_deposit answer is Ok, failure and no result are Failed, an answer over 4 KB is Failed; each target.
#[test]
fn callbacks_record_each_outcome_for_each_target() {
    for t in TARGETS {
        for ok in [true, false] {
            let mut s = deployed();
            callback(&mut s, t, ok);
            assert_eq!(
                s.get_registrations().get(t).state,
                if ok { RegState::Ok } else { RegState::Failed },
                "{t:?} {ok}"
            );
            // The others are untouched.
            for o in TARGETS.iter().filter(|o| **o != t) {
                assert_eq!(s.get_registrations().get(*o).state, RegState::Pending);
            }
            // No callback starts a promise (security M-1).
            assert!(get_created_receipts().is_empty());
            assert_eq!(
                get_logs().last().unwrap(),
                &format!(
                    r#"EVENT_JSON:{{"standard":"poolside","version":"1.0.0","event":"registration","data":[{{"target":"{t:?}","nonce":1,"check_only":false,"ok":{ok}}}]}}"#
                )
            );
        }
    }
    let mut s = deployed();
    callback_with(&mut s, Target::QuoteToken, 1, false, vec![]);
    assert_eq!(s.get_registrations().quote_token.state, RegState::Failed);
    let mut s = deployed();
    callback_with(
        &mut s,
        Target::QuoteToken,
        1,
        false,
        vec![PromiseResult::Successful(vec![b'x'; 4_097])],
    );
    assert_eq!(s.get_registrations().quote_token.state, RegState::Failed);
    let mut s = deployed();
    callback_with(
        &mut s,
        Target::QuoteToken,
        1,
        false,
        vec![PromiseResult::Successful(vec![b' '; 4_096])],
    );
    assert_eq!(s.get_registrations().quote_token.state, RegState::Ok);
}

/// EC-C11: a callback called by anyone but the contract is refused, nothing changed.
#[test]
fn a_callback_called_directly_is_refused() {
    let mut s = deployed();
    testing_env!(
        ctx("outsider.near", BAL, Gas::from_tgas(10), BLOCK).build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result(true)]
    );
    assert_eq!(
        refused(|| s.on_registered(Target::QuoteToken, 1, false)),
        "AUTH: callback only"
    );
    assert_eq!(s.get_registrations().quote_token.state, RegState::Pending);
}

/// Contract review L3: a callback with an old nonce, or for a registration no longer Pending, is ignored.
#[test]
fn a_late_or_repeated_callback_is_ignored() {
    let mut s = deployed();
    callback(&mut s, Target::BaseToken, false);
    as_creator(&mut s, Target::BaseToken, BAL, BLOCK);
    assert_eq!(
        s.get_registrations().base_token,
        Registration {
            state: RegState::Pending,
            nonce: 2,
            launched_block: BLOCK,
            deposit_may_have_landed: false,
            deposit_block: 0
        }
    );
    // The first launch's callback arrives late: ignored.
    callback_with(&mut s, Target::BaseToken, 1, false, vec![result(true)]);
    assert_eq!(s.get_registrations().base_token.state, RegState::Pending);
    assert_eq!(
        get_logs().last().unwrap(),
        r#"EVENT_JSON:{"standard":"poolside","version":"1.0.0","event":"registration_ignored","data":[{"target":"BaseToken","nonce":1}]}"#
    );
    callback_with(&mut s, Target::BaseToken, 2, false, vec![result(true)]);
    assert_eq!(s.get_registrations().base_token.state, RegState::Ok);
    // And a second callback for an Ok registration is ignored.
    callback_with(
        &mut s,
        Target::BaseToken,
        2,
        false,
        vec![PromiseResult::Failed],
    );
    assert_eq!(s.get_registrations().base_token.state, RegState::Ok);
}

/// EC-C165: a failed registration retried by the creator: Pending at the next nonce, the same call out again.
#[test]
fn retry_of_a_failed_registration_sends_it_again() {
    for t in TARGETS {
        let mut s = deployed();
        callback(&mut s, t, false);
        as_creator(&mut s, t, BAL, BLOCK + 7);
        assert_eq!(
            s.get_registrations().get(t),
            Registration {
                state: RegState::Pending,
                nonce: 2,
                launched_block: BLOCK + 7,
                deposit_may_have_landed: t == Target::DclStorage,
                deposit_block: if t == Target::DclStorage {
                    BLOCK + 7
                } else {
                    0
                }
            }
        );
        let c = calls();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].1, "storage_deposit");
        assert_eq!(
            c[1].2,
            format!(r#"{{"target":"{t:?}","nonce":2,"check_only":false}}"#)
        );
    }
}

/// Contract review H1, security M-1: a Pending registration whose callback was lost can be retried
/// once stale_after_blocks have passed, at exactly that block and not one before.
#[test]
fn a_stale_pending_registration_can_be_retried() {
    let mut s = deployed();
    let at = BLOCK + 1_000;
    testing_env!(ctx("creator.near", BAL, Gas::from_tgas(300), at - 1).build());
    assert_eq!(
        refused(|| s.retry_registration(Target::QuoteToken)),
        "LIMIT: registration not failed"
    );
    assert!(get_created_receipts().is_empty());
    as_creator(&mut s, Target::QuoteToken, BAL, at);
    assert_eq!(
        s.get_registrations().quote_token,
        Registration {
            state: RegState::Pending,
            nonce: 2,
            launched_block: at,
            deposit_may_have_landed: false,
            deposit_block: 0
        }
    );
    // A token's stale retry repeats storage_deposit: registration_only refunds if it was already registered.
    assert_eq!(calls()[0].1, "storage_deposit");
}

/// A stale DCL storage is only re-checked with storage_balance_of, no deposit: a balance means Ok, null means Failed.
#[test]
fn a_stale_dcl_storage_is_rechecked_not_deposited_again() {
    for (answer, want) in [
        (
            &br#"{"total":"2000000000000000000000000","available":"0"}"#[..],
            RegState::Ok,
        ),
        (&b"null"[..], RegState::Failed),
    ] {
        let mut s = deployed();
        as_creator(&mut s, Target::DclStorage, BAL, BLOCK + 1_000);
        let c = calls();
        assert_eq!(
            (c[0].0.as_str(), c[0].1.as_str(), c[0].2.clone(), c[0].3),
            (
                network().dcl_contract.as_str(),
                "storage_balance_of",
                format!(r#"{{"account_id":"{ME}"}}"#),
                0
            )
        );
        assert_eq!(
            c[1].2,
            r#"{"target":"DclStorage","nonce":2,"check_only":true}"#
        );
        callback_with(
            &mut s,
            Target::DclStorage,
            2,
            true,
            vec![PromiseResult::Successful(answer.to_vec())],
        );
        assert_eq!(s.get_registrations().dcl_storage.state, want);
    }
    // A failed re-check view is Failed too, and the deposit may still have landed, so the next retry re-checks again (re-review L-2).
    let mut s = deployed();
    as_creator(&mut s, Target::DclStorage, BAL, BLOCK + 1_000);
    callback_with(
        &mut s,
        Target::DclStorage,
        2,
        true,
        vec![PromiseResult::Failed],
    );
    assert_eq!(s.get_registrations().dcl_storage.state, RegState::Failed);
    as_creator(&mut s, Target::DclStorage, BAL, BLOCK + 1_001);
    assert_eq!(
        (calls()[0].1.as_str(), calls()[0].3),
        ("storage_balance_of", 0)
    );
}

/// EC-C165: retry refusals, each with nothing changed and nothing sent.
#[test]
fn retry_refusals_change_nothing() {
    let mut s = deployed();
    callback(&mut s, Target::QuoteToken, true);
    callback(&mut s, Target::BaseToken, false);
    let before = s.get_registrations();
    let cases: Vec<(&str, u128, Gas, Target, &str)> = vec![
        (
            "agent.near",
            BAL,
            Gas::from_tgas(300),
            Target::BaseToken,
            "AUTH: creator only",
        ),
        // The caller is checked before the gas.
        (
            "agent.near",
            BAL,
            Gas::from_tgas(1),
            Target::BaseToken,
            "AUTH: creator only",
        ),
        (
            "creator.near",
            BAL,
            Gas::from_gas(MIN_GAS_RETRY.as_gas() - 1),
            Target::BaseToken,
            "LIMIT: gas",
        ),
        (
            "creator.near",
            BAL,
            Gas::from_tgas(300),
            Target::QuoteToken,
            "LIMIT: registration not failed",
        ),
        (
            "creator.near",
            BAL,
            Gas::from_tgas(300),
            Target::DclStorage,
            "LIMIT: registration not failed",
        ),
        (
            "creator.near",
            TOKEN_STORAGE.as_yoctonear() + stake() - 1,
            Gas::from_tgas(300),
            Target::BaseToken,
            "LIMIT: balance for registration",
        ),
    ];
    for (who, bal, gas, t, msg) in cases {
        testing_env!(ctx(who, bal, gas, BLOCK).build());
        assert_eq!(refused(|| s.retry_registration(t)), msg);
        assert_eq!(s.get_registrations(), before, "{msg}");
        assert!(get_created_receipts().is_empty(), "{msg}");
    }
}

/// Retry at exactly MIN_GAS_RETRY and exactly the cost plus the storage stake is allowed, for each target.
#[test]
fn retry_at_its_gas_and_balance_limits() {
    for t in TARGETS {
        let mut s = deployed();
        callback(&mut s, t, false);
        let cost = launch_cost(t, 2 * ONE_NEAR, false) + stake();
        testing_env!(ctx("creator.near", cost, MIN_GAS_RETRY, BLOCK).build());
        s.retry_registration(t);
        assert_eq!(s.get_registrations().get(t).state, RegState::Pending);
        let mut s = deployed();
        callback(&mut s, t, false);
        testing_env!(ctx("creator.near", cost - 1, MIN_GAS_RETRY, BLOCK).build());
        assert_eq!(
            refused(|| s.retry_registration(t)),
            "LIMIT: balance for registration"
        );
    }
}

/// Contract re-review H-1: the parent, which signs the deploy batch that creates the account, may call `new`;
/// a grandparent, a sibling or a child may not.
#[test]
fn new_by_the_parent_is_allowed_and_by_no_other_relative() {
    let parent = ME.split_once('.').unwrap().1;
    testing_env!(ctx(parent, BAL, Gas::from_tgas(300), BLOCK).build());
    Strategy::new(config(), limits_args());
    let grand = parent.split_once('.').map(|x| x.1).unwrap_or("near");
    let sibling = format!("strategy-2.{parent}");
    let child = format!("x.{ME}");
    for who in [grand.to_string(), sibling, child] {
        testing_env!(ctx(&who, BAL, Gas::from_tgas(300), BLOCK).build());
        assert_eq!(
            refused(|| {
                Strategy::new(config(), limits_args());
            }),
            "AUTH: new only by the strategy account or its parent",
            "{who}"
        );
        assert!(get_created_receipts().is_empty());
    }
}

/// Test re-audit M-2: roles are checked by the predecessor, never the signer.
#[test]
fn roles_are_the_predecessor_not_the_signer() {
    // new: a contract the strategy account calls is not the strategy account.
    let mut b = ctx("attacker.near", BAL, Gas::from_tgas(300), BLOCK);
    b.signer_account_id(me());
    testing_env!(b.build());
    assert_eq!(
        refused(|| {
            Strategy::new(config(), limits_args());
        }),
        "AUTH: new only by the strategy account or its parent"
    );
    assert!(get_created_receipts().is_empty());
    // retry: a contract the creator calls is not the creator.
    let mut s = deployed();
    callback(&mut s, Target::BaseToken, false);
    let before = s.get_registrations();
    let mut b = ctx("attacker.near", BAL, Gas::from_tgas(300), BLOCK);
    b.signer_account_id(acc("creator.near"));
    testing_env!(b.build());
    assert_eq!(
        refused(|| s.retry_registration(Target::BaseToken)),
        "AUTH: creator only"
    );
    assert_eq!(s.get_registrations(), before);
    assert!(get_created_receipts().is_empty());
}

/// Test re-audit L-6: `new` checks the caller before the gas.
#[test]
fn new_checks_the_caller_before_the_gas() {
    testing_env!(ctx("attacker.near", BAL, Gas::from_tgas(1), BLOCK).build());
    assert_eq!(
        refused(|| {
            Strategy::new(config(), limits_args());
        }),
        "AUTH: new only by the strategy account or its parent"
    );
}

/// Test re-audit M-1: an Ok registration is never retried, stale or not.
#[test]
fn an_ok_registration_is_never_retried_even_when_stale() {
    for t in TARGETS {
        let mut s = deployed();
        callback(&mut s, t, true);
        let before = s.get_registrations();
        for block in [BLOCK, BLOCK + 1_000, BLOCK + 1_000_000] {
            testing_env!(ctx("creator.near", BAL, Gas::from_tgas(300), block).build());
            assert_eq!(
                refused(|| s.retry_registration(t)),
                "LIMIT: registration not failed",
                "{t:?} at {block}"
            );
            assert_eq!(s.get_registrations(), before);
            assert!(get_created_receipts().is_empty());
        }
    }
}

/// Test re-audit M-3: a re-check only counts a JSON object as a balance; anything else is Failed.
#[test]
fn a_recheck_counts_only_a_json_object() {
    for answer in [&b"garbage"[..], b"\"0\"", b"[]", b"true", b"", b"0", b"{"] {
        let mut s = deployed();
        as_creator(&mut s, Target::DclStorage, BAL, BLOCK + 1_000);
        callback_with(
            &mut s,
            Target::DclStorage,
            2,
            true,
            vec![PromiseResult::Successful(answer.to_vec())],
        );
        assert_eq!(
            s.get_registrations().dcl_storage.state,
            RegState::Failed,
            "{:?}",
            String::from_utf8_lossy(answer)
        );
        assert_eq!(
            get_logs().last().unwrap(),
            r#"EVENT_JSON:{"standard":"poolside","version":"1.0.0","event":"registration","data":[{"target":"DclStorage","nonce":2,"check_only":true,"ok":false}]}"#
        );
        // And the deposit may still have landed, so the next retry re-checks again, never deposits.
        assert!(s.get_registrations().dcl_storage.deposit_may_have_landed);
        as_creator(&mut s, Target::DclStorage, BAL, BLOCK + 1_001);
        assert_eq!(
            (calls()[0].1.as_str(), calls()[0].3),
            ("storage_balance_of", 0)
        );
    }
}

/// Contract re-review L-2: DCL storage is never paid twice. A failed deposit whose NEAR came back clears the flag;
/// an answer over the size limit, a failed re-check view or anything but null leaves it set, so retries re-check.
#[test]
fn dcl_storage_is_never_deposited_twice() {
    // The deposit's receipt failed: NEAR back, flag cleared, the retry deposits.
    let mut s = deployed();
    callback(&mut s, Target::DclStorage, false);
    assert!(!s.get_registrations().dcl_storage.deposit_may_have_landed);
    as_creator(&mut s, Target::DclStorage, BAL, BLOCK);
    assert_eq!(
        (calls()[0].1.as_str(), calls()[0].3),
        ("storage_deposit", 2 * ONE_NEAR)
    );
    // The deposit's answer was too long to read: it may have landed, so the retry re-checks.
    let mut s = deployed();
    callback_with(
        &mut s,
        Target::DclStorage,
        1,
        false,
        vec![PromiseResult::Successful(vec![b' '; 4_097])],
    );
    assert_eq!(s.get_registrations().dcl_storage.state, RegState::Failed);
    assert!(s.get_registrations().dcl_storage.deposit_may_have_landed);
    as_creator(&mut s, Target::DclStorage, BAL, BLOCK);
    assert_eq!(
        (calls()[0].1.as_str(), calls()[0].3),
        ("storage_balance_of", 0)
    );
    // The re-check view itself failed: still re-checks.
    callback_with(
        &mut s,
        Target::DclStorage,
        2,
        true,
        vec![PromiseResult::Failed],
    );
    as_creator(&mut s, Target::DclStorage, BAL, BLOCK);
    assert_eq!(
        (calls()[0].1.as_str(), calls()[0].3),
        ("storage_balance_of", 0)
    );
    // A null re-check launched before 2 x stale_after_blocks after the deposit doesn't clear the flag: the deposit
    // may still be in flight (security re-review L-1). The deposit went out at BLOCK; 2 x 1,000 blocks later is BLOCK + 2,000.
    callback_with(
        &mut s,
        Target::DclStorage,
        3,
        true,
        vec![PromiseResult::Successful(b"null".to_vec())],
    );
    assert!(s.get_registrations().dcl_storage.deposit_may_have_landed);
    as_creator(&mut s, Target::DclStorage, BAL, BLOCK + 1_999);
    assert_eq!(
        (calls()[0].1.as_str(), calls()[0].3),
        ("storage_balance_of", 0)
    );
    callback_with(
        &mut s,
        Target::DclStorage,
        4,
        true,
        vec![PromiseResult::Successful(b"null".to_vec())],
    );
    assert!(
        s.get_registrations().dcl_storage.deposit_may_have_landed,
        "launched at BLOCK + 1,999: still too early"
    );
    // Launched at exactly BLOCK + 2,000: a null proves it didn't land; flag cleared, and only then does a retry deposit.
    as_creator(&mut s, Target::DclStorage, BAL, BLOCK + 2_000);
    callback_with(
        &mut s,
        Target::DclStorage,
        5,
        true,
        vec![PromiseResult::Successful(b"null".to_vec())],
    );
    assert!(!s.get_registrations().dcl_storage.deposit_may_have_landed);
    as_creator(&mut s, Target::DclStorage, BAL, BLOCK + 2_001);
    assert_eq!(
        (calls()[0].1.as_str(), calls()[0].3),
        ("storage_deposit", 2 * ONE_NEAR)
    );
    assert_eq!(
        s.get_registrations().dcl_storage.deposit_block,
        BLOCK + 2_001
    );
    // A late callback of the first deposit (old nonce) changes nothing.
    let before = s.get_registrations();
    callback_with(&mut s, Target::DclStorage, 1, false, vec![result(true)]);
    assert_eq!(s.get_registrations(), before);
}

/// Test re-audit L-1: a DCL re-check needs only the storage stake, no deposit: allowed at it, refused one below.
#[test]
fn a_recheck_needs_only_the_storage_stake() {
    let mut s = deployed();
    testing_env!(ctx("creator.near", stake(), MIN_GAS_RETRY, BLOCK + 1_000).build());
    s.retry_registration(Target::DclStorage);
    assert_eq!(calls()[0].1, "storage_balance_of");
    let mut s = deployed();
    testing_env!(ctx("creator.near", stake() - 1, MIN_GAS_RETRY, BLOCK + 1_000).build());
    assert_eq!(
        refused(|| s.retry_registration(Target::DclStorage)),
        "LIMIT: balance for registration"
    );
}

/// Test re-audit L-2, F2/F3, F7: a stale retry of each target, in full: the call, its callback's flag and the event.
#[test]
fn a_stale_retry_of_each_target_in_full() {
    let n = network();
    for t in TARGETS {
        let mut s = deployed();
        testing_env!(ctx("creator.near", BAL, Gas::from_tgas(300), BLOCK + 999).build());
        assert_eq!(
            refused(|| s.retry_registration(t)),
            "LIMIT: registration not failed",
            "{t:?} one block early"
        );
        as_creator(&mut s, t, BAL, BLOCK + 1_000);
        let c = calls();
        let (to, method, args, dep, check) = match t {
            Target::QuoteToken => (
                n.quote_token.clone(),
                "storage_deposit",
                format!(r#"{{"account_id":"{ME}","registration_only":true}}"#),
                TOKEN_STORAGE.as_yoctonear(),
                false,
            ),
            Target::BaseToken => (
                n.base_token.clone(),
                "storage_deposit",
                format!(r#"{{"account_id":"{ME}","registration_only":true}}"#),
                TOKEN_STORAGE.as_yoctonear(),
                false,
            ),
            Target::DclStorage => (
                n.dcl_contract.clone(),
                "storage_balance_of",
                format!(r#"{{"account_id":"{ME}"}}"#),
                0,
                true,
            ),
        };
        assert_eq!(
            (c[0].0.clone(), c[0].1.clone(), c[0].2.clone(), c[0].3),
            (to, method.to_string(), args, dep)
        );
        assert_eq!(
            c[1].2,
            format!(r#"{{"target":"{t:?}","nonce":2,"check_only":{check}}}"#)
        );
        assert_eq!(
            get_logs().last().unwrap(),
            &format!(
                r#"EVENT_JSON:{{"standard":"poolside","version":"1.0.0","event":"registration_started","data":[{{"target":"{t:?}","nonce":2,"check_only":{check}}}]}}"#
            )
        );
    }
}

/// Test re-audit L-3: a callback with more than one promise result is Failed.
#[test]
fn a_callback_with_two_results_is_failed() {
    let mut s = deployed();
    callback_with(
        &mut s,
        Target::QuoteToken,
        1,
        false,
        vec![result(true), result(true)],
    );
    assert_eq!(s.get_registrations().quote_token.state, RegState::Failed);
}

/// Test re-audit L-4: the sandbox guard needs the dot.
#[cfg(feature = "sandbox")]
#[test]
fn a_sandbox_build_refuses_a_lookalike_suffix() {
    let mut b = ctx("strategy-1.eviltest.near", BAL, Gas::from_tgas(300), BLOCK);
    b.current_account_id(acc("strategy-1.eviltest.near"));
    testing_env!(b.build());
    assert_eq!(
        refused(|| {
            Strategy::new(config(), limits_args());
        }),
        "LIMIT: sandbox build"
    );
}

/// Test re-audit L-5: the largest state `new` writes fits in the storage margin the balance check keeps.
#[test]
fn the_largest_state_fits_the_storage_margin() {
    let mut c = config();
    c.rules_ciphertext = Base64VecU8(vec![0; limits::MAX_CIPHERTEXT]);
    let long = |p: &str| acc(&format!("{}.{p}", "a".repeat(64 - p.len() - 1)));
    c.creator = long("c.near");
    c.agent = long("a.near");
    c.deliverer = long("d.near");
    c.platform_account = long("p.near");
    testing_env!(ctx(ME, BAL, Gas::from_tgas(300), BLOCK).build());
    let s = Strategy::new(c, limits_args());
    let bytes = near_sdk::borsh::to_vec(&s).unwrap().len() as u64;
    // State plus its key (b"STATE") and the per-record overhead the runtime charges (40 bytes).
    assert!(
        bytes + 5 + 40 <= STORAGE_MARGIN_BYTES,
        "state {bytes} bytes"
    );
}

/// Contract re-review L-1: a re-check is Ok only when DCL holds at least dcl_storage for us; an outsider's 0.5 NEAR
/// registration, or any balance below dcl_storage, is Failed, and clears the flag only when late enough.
#[test]
fn a_recheck_needs_at_least_dcl_storage() {
    let bal = |t: u128| format!(r#"{{"total":"{t}","available":"0"}}"#).into_bytes();
    for (answer, at, ok, cleared) in [
        (bal(2 * ONE_NEAR), BLOCK + 1_000, true, false),
        (bal(2 * ONE_NEAR + 1), BLOCK + 1_000, true, false),
        (bal(2 * ONE_NEAR - 1), BLOCK + 1_000, false, false),
        (bal(ONE_NEAR / 2), BLOCK + 1_000, false, false),
        // One block before 2 x stale_after_blocks after the deposit: the low total doesn't clear it yet.
        (bal(ONE_NEAR / 2), BLOCK + 1_999, false, false),
        (bal(ONE_NEAR / 2), BLOCK + 2_000, false, true),
        (
            br#"{"available":"0"}"#.to_vec(),
            BLOCK + 2_000,
            false,
            false,
        ),
        (
            br#"{"total":2000000000000000000000000}"#.to_vec(),
            BLOCK + 2_000,
            false,
            false,
        ),
        (br#"{"total":"x"}"#.to_vec(), BLOCK + 2_000, false, false),
    ] {
        let mut s = deployed();
        as_creator(&mut s, Target::DclStorage, BAL, at);
        callback_with(
            &mut s,
            Target::DclStorage,
            2,
            true,
            vec![PromiseResult::Successful(answer.clone())],
        );
        let r = s.get_registrations().dcl_storage;
        assert_eq!(
            r.state,
            if ok { RegState::Ok } else { RegState::Failed },
            "{}",
            String::from_utf8_lossy(&answer)
        );
        assert_eq!(
            r.deposit_may_have_landed,
            !cleared,
            "{} at {at}",
            String::from_utf8_lossy(&answer)
        );
    }
}

/// Test re-audit F1: a re-check the flag forces before the stale point needs only the stake; one below is refused with nothing changed.
#[test]
fn a_flag_driven_recheck_needs_only_the_storage_stake() {
    let mut s = deployed();
    callback_with(
        &mut s,
        Target::DclStorage,
        1,
        false,
        vec![PromiseResult::Successful(vec![b' '; 4_097])],
    );
    testing_env!(ctx("creator.near", stake(), MIN_GAS_RETRY, BLOCK).build());
    s.retry_registration(Target::DclStorage);
    assert_eq!(
        (calls()[0].1.as_str(), calls()[0].3),
        ("storage_balance_of", 0)
    );
    let mut s = deployed();
    callback_with(
        &mut s,
        Target::DclStorage,
        1,
        false,
        vec![PromiseResult::Successful(vec![b' '; 4_097])],
    );
    let before = s.get_registrations();
    testing_env!(ctx("creator.near", stake() - 1, MIN_GAS_RETRY, BLOCK).build());
    assert_eq!(
        refused(|| s.retry_registration(Target::DclStorage)),
        "LIMIT: balance for registration"
    );
    assert_eq!(s.get_registrations(), before);
    assert!(get_created_receipts().is_empty());
}

/// Test re-audit F2: two results on a DCL deposit are not a definite failure: the flag stays and the retry re-checks.
#[test]
fn two_results_on_a_dcl_deposit_keep_the_flag() {
    let mut s = deployed();
    callback_with(
        &mut s,
        Target::DclStorage,
        1,
        false,
        vec![result(true), result(true)],
    );
    assert_eq!(s.get_registrations().dcl_storage.state, RegState::Failed);
    assert!(s.get_registrations().dcl_storage.deposit_may_have_landed);
    assert_eq!(
        get_logs().last().unwrap(),
        r#"EVENT_JSON:{"standard":"poolside","version":"1.0.0","event":"registration","data":[{"target":"DclStorage","nonce":1,"check_only":false,"ok":false}]}"#
    );
    as_creator(&mut s, Target::DclStorage, BAL, BLOCK);
    assert_eq!(
        (calls()[0].1.as_str(), calls()[0].3),
        ("storage_balance_of", 0)
    );
}

/// Test re-audit F3: the parent's new does exactly what the account's own does; an account with no dot has no parent.
#[test]
fn the_parents_new_is_the_same_new_and_a_top_level_account_has_no_parent() {
    let parent = ME.split_once('.').unwrap().1;
    testing_env!(ctx(parent, BAL, Gas::from_tgas(300), BLOCK).build());
    let s = Strategy::new(config(), limits_args());
    assert_eq!(s.get_config(), &config());
    let r = s.get_registrations();
    assert!(TARGETS
        .iter()
        .all(|t| r.get(*t).state == RegState::Pending && r.get(*t).nonce == 1));
    assert!(r.dcl_storage.deposit_may_have_landed);
    assert_eq!(calls().iter().filter(|c| c.0 != ME).count(), 3);
    // A top-level strategy account: only itself may call new.
    #[cfg(not(feature = "sandbox"))]
    {
        let top = "strategytoplevelaccount";
        let mut b = ctx("near", BAL, Gas::from_tgas(300), BLOCK);
        b.current_account_id(acc(top));
        testing_env!(b.build());
        assert_eq!(
            refused(|| {
                Strategy::new(config(), limits_args());
            }),
            "AUTH: new only by the strategy account or its parent"
        );
        let mut b = ctx(top, BAL, Gas::from_tgas(300), BLOCK);
        b.current_account_id(acc(top));
        testing_env!(b.build());
        Strategy::new(config(), limits_args());
    }
}

/// Security check of 80222b1, L-1: `late` is measured from the latest deposit, not the first one.
#[test]
fn the_late_window_counts_from_the_latest_deposit() {
    let mut s = deployed();
    // The first deposit's receipt failed: flag cleared; the retry deposits again at BLOCK + 500.
    callback(&mut s, Target::DclStorage, false);
    as_creator(&mut s, Target::DclStorage, BAL, BLOCK + 500);
    assert_eq!(s.get_registrations().dcl_storage.deposit_block, BLOCK + 500);
    // Its callback is lost; a stale re-check at BLOCK + 2,000 is 1,500 blocks after it: a null doesn't clear.
    as_creator(&mut s, Target::DclStorage, BAL, BLOCK + 2_000);
    callback_with(
        &mut s,
        Target::DclStorage,
        3,
        true,
        vec![PromiseResult::Successful(b"null".to_vec())],
    );
    assert!(s.get_registrations().dcl_storage.deposit_may_have_landed);
    // At BLOCK + 2,500 (2,000 after the latest deposit) it does.
    as_creator(&mut s, Target::DclStorage, BAL, BLOCK + 2_500);
    callback_with(
        &mut s,
        Target::DclStorage,
        4,
        true,
        vec![PromiseResult::Successful(b"null".to_vec())],
    );
    assert!(!s.get_registrations().dcl_storage.deposit_may_have_landed);
}

/// Security check of 80222b1, L-2: the parent's `new` sends exactly the calls and stores exactly the state the account's own does.
#[test]
fn the_parents_new_sends_exactly_the_same_calls() {
    let parent = ME.split_once('.').unwrap().1;
    testing_env!(ctx(ME, BAL, Gas::from_tgas(300), BLOCK).build());
    let own = Strategy::new(config(), limits_args());
    let own_calls = calls();
    testing_env!(ctx(parent, BAL, Gas::from_tgas(300), BLOCK).build());
    let by_parent = Strategy::new(config(), limits_args());
    assert_eq!(calls(), own_calls);
    assert_eq!(by_parent.get_registrations(), own.get_registrations());
    assert_eq!(by_parent.get_config(), own.get_config());
}
