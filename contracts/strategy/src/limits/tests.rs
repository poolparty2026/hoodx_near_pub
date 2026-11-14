//! EC-C56: every bound of `new` at the limit (allowed) and one past it (refused), at 0 and at
//! the type maximum, the cross-limits in order, and a property for the add ratio bound.
use super::*;
use proptest::prelude::*;

/// The add ratio bound at the centring limit for a range of `w` points and drift `d`
/// (ARCHITECTURE 5.6): `ceil(10_000 * d * w / (a * (w - a)))`, `a = floor(w / 4)`. Test-only:
/// the contract's own ADD_RATIO_BPS uses the operation's real `(ref - left) * (right - ref)`.
fn add_ratio_at_centring_limit(d: u64, w: u64) -> u64 {
    let a = w / 4;
    (10_000 * d * w).div_ceil(a * (w - a))
}

const NOW: u64 = 1_700_000_000 * NANOS_PER_S;
const SELF: &str = "strategy-1.poolside.near";

fn net() -> Network {
    Network::mainnet()
}
fn config() -> Config {
    Config {
        creator: "creator.near".into(),
        agent: "agent.near".into(),
        deliverer: "deliverer.near".into(),
        platform_account: "platform.near".into(),
        quote_token: net().quote_token,
        dcl_contract: net().dcl_contract,
        rules_hash: [7; 32],
        rules_ciphertext: vec![1; 300],
        platform_bps: 500,
        key_price: ONE_NEAR / 10,
        max_key_sales: 20,
        key_delivery_window_ns: 3_600 * NANOS_PER_S,
        start_deadline_ns: NOW + DAY_NS,
        run_end_ns: NOW + 6 * DAY_NS,
        exit_grace_ns: DAY_NS,
        platform_claim_window_ns: 2 * DAY_NS,
        stale_after_blocks: 1_000,
        stale_cooldown_blocks: 1_500,
        dcl_storage: 2 * ONE_NEAR,
        attested: false,
    }
}
fn limits() -> PublicLimits {
    PublicLimits {
        max_principal: MAX_PRINCIPAL_CAP,
        pool: net().pool,
        max_slippage_bps: 50,
        max_swap_slippage_bps: 60,
        max_swap_step_bps: 6_000,
        max_observation_drift_bps: 30,
        max_observation_age_blocks: 20,
        min_range_width_bps: 1_000,
        max_range_width_bps: 2_000,
        min_action_interval_s: 600,
        max_actions_per_24h: 6,
        dust_threshold: vec![
            (net().quote_token, 1_000),
            (net().base_token, 10u128.pow(18)),
        ],
    }
}
fn check(c: &Config, l: &PublicLimits) -> Result<(), String> {
    validate(c, l, &net(), NOW, SELF)
}
fn c_with(f: impl FnOnce(&mut Config)) -> Result<(), String> {
    let mut c = config();
    f(&mut c);
    check(&c, &limits())
}
fn l_with(f: impl FnOnce(&mut PublicLimits)) -> Result<(), String> {
    let mut l = limits();
    f(&mut l);
    check(&config(), &l)
}
fn err(s: &str) -> Result<(), String> {
    Err(format!("LIMIT: {s}"))
}

#[test]
fn accepts_the_baseline() {
    assert_eq!(check(&config(), &limits()), Ok(()));
}

/// EC-C64 (the pool other than fee 100) and EC-C56 (the network constants).
#[test]
fn network_constants() {
    assert_eq!(
        c_with(|c| c.quote_token = "usdc.fake.near".into()),
        err("not the network constant")
    );
    assert_eq!(
        c_with(|c| c.dcl_contract = "dclv3.ref-labs.near".into()),
        err("not the network constant")
    );
    assert_eq!(
        l_with(|l| l.pool = format!("{}|wrap.near|400", net().quote_token)),
        err("not the network constant")
    );
}

/// EC-C54: every pair of roles, and every role against the strategy itself, DCL and both tokens.
#[test]
fn accounts_must_be_distinct() {
    type Role = fn(&mut Config) -> &mut String;
    let roles: [(&str, Role); 4] = [
        ("creator", |c| &mut c.creator),
        ("agent", |c| &mut c.agent),
        ("deliverer", |c| &mut c.deliverer),
        ("platform_account", |c| &mut c.platform_account),
    ];
    let mut pairs = 0;
    for (i, (ni, ri)) in roles.iter().enumerate() {
        for (nj, rj) in roles.iter().skip(i + 1) {
            let mut c = config();
            let v = ri(&mut c).clone();
            *rj(&mut c) = v;
            assert_eq!(
                check(&c, &limits()),
                err("accounts not distinct"),
                "{ni} = {nj}"
            );
            pairs += 1;
        }
    }
    assert_eq!(pairs, 6);
    let others = [
        SELF.to_string(),
        net().dcl_contract,
        net().quote_token,
        net().base_token,
    ];
    let mut cross = 0;
    for (n, r) in roles.iter() {
        for o in &others {
            let mut c = config();
            *r(&mut c) = o.clone();
            assert_eq!(
                check(&c, &limits()),
                err("accounts not distinct"),
                "{n} = {o}"
            );
            cross += 1;
        }
    }
    assert_eq!(cross, 16);
}

#[test]
fn attested_refused_until_gate_2_passes() {
    const _: () = assert!(!ATTESTATION_ENABLED, "gate 2 hasn't passed");
    assert_eq!(c_with(|c| c.attested = true), err("attested"));
    assert_eq!(c_with(|c| c.attested = false), Ok(()));
}

#[test]
fn ciphertext_size_at_both_ends() {
    assert_eq!(c_with(|c| c.rules_ciphertext = vec![0; 41]), Ok(()));
    assert_eq!(
        c_with(|c| c.rules_ciphertext = vec![0; 40]),
        err("rules ciphertext size")
    );
    assert_eq!(
        c_with(|c| c.rules_ciphertext = vec![0; MAX_CIPHERTEXT]),
        Ok(())
    );
    assert_eq!(
        c_with(|c| c.rules_ciphertext = vec![0; MAX_CIPHERTEXT + 1]),
        err("rules ciphertext size")
    );
    assert_eq!(
        c_with(|c| c.rules_ciphertext = vec![]),
        err("rules ciphertext size")
    );
}

#[test]
fn platform_bps_exactly_500() {
    for v in [0, 499, 501, u16::MAX] {
        assert_eq!(c_with(|c| c.platform_bps = v), err("platform bps"));
    }
}

/// Every simple bound: (field setter, lowest allowed, highest allowed, message), with 0 and the
/// type maximum tried as well.
macro_rules! bound {
    ($name:ident, $with:ident, $field:ident, $t:ty, $lo:expr, $hi:expr, $msg:expr) => {
        #[test]
        fn $name() {
            let (lo, hi): ($t, $t) = ($lo, $hi);
            assert_eq!($with(|x| x.$field = lo), Ok(()), "at the low bound");
            assert_eq!($with(|x| x.$field = hi), Ok(()), "at the high bound");
            if lo > 0 {
                assert_eq!($with(|x| x.$field = lo - 1), err($msg), "one below");
            }
            if hi < <$t>::MAX {
                assert_eq!($with(|x| x.$field = hi + 1), err($msg), "one above");
            }
            if lo > 0 {
                assert_eq!($with(|x| x.$field = 0), err($msg), "at 0");
            }
            if hi < <$t>::MAX {
                assert_eq!(
                    $with(|x| x.$field = <$t>::MAX),
                    err($msg),
                    "at the type maximum"
                );
            }
        }
    };
}
bound!(key_price, c_with, key_price, u128, 0, ONE_NEAR, "key price");
bound!(key_sales, c_with, max_key_sales, u32, 0, 50, "key sales");
bound!(
    key_delivery_window,
    c_with,
    key_delivery_window_ns,
    u64,
    600 * NANOS_PER_S,
    DAY_NS,
    "key delivery window"
);
bound!(
    exit_grace,
    c_with,
    exit_grace_ns,
    u64,
    3_600 * NANOS_PER_S,
    7 * DAY_NS,
    "exit grace"
);
bound!(
    platform_claim_window,
    c_with,
    platform_claim_window_ns,
    u64,
    DAY_NS,
    7 * DAY_NS,
    "platform claim window"
);
bound!(
    dcl_storage,
    c_with,
    dcl_storage,
    u128,
    2 * ONE_NEAR,
    10 * ONE_NEAR,
    "dcl storage"
);
bound!(
    max_principal,
    l_with,
    max_principal,
    u128,
    1,
    MAX_PRINCIPAL_CAP,
    "max principal"
);
bound!(slippage, l_with, max_slippage_bps, u16, 1, 300, "slippage");
bound!(
    observation_age,
    l_with,
    max_observation_age_blocks,
    u64,
    1,
    100,
    "observation age"
);
bound!(
    action_interval,
    l_with,
    min_action_interval_s,
    u64,
    300,
    3_600,
    "action interval"
);

#[test]
fn stale_thresholds() {
    assert_eq!(
        c_with(|c| {
            c.stale_after_blocks = 500;
            c.stale_cooldown_blocks = 500
        }),
        Ok(())
    );
    assert_eq!(
        c_with(|c| {
            c.stale_after_blocks = 10_000;
            c.stale_cooldown_blocks = 20_000
        }),
        Ok(())
    );
    assert_eq!(
        c_with(|c| {
            c.stale_after_blocks = 499;
            c.stale_cooldown_blocks = 600
        }),
        err("stale after blocks")
    );
    assert_eq!(
        c_with(|c| {
            c.stale_after_blocks = 10_001;
            c.stale_cooldown_blocks = 10_001
        }),
        err("stale after blocks")
    );
    assert_eq!(
        c_with(|c| {
            c.stale_after_blocks = u64::MAX;
            c.stale_cooldown_blocks = u64::MAX
        }),
        err("stale after blocks")
    );
    assert_eq!(
        c_with(|c| c.stale_after_blocks = 0),
        err("stale after blocks")
    );
    // The cooldown: from stale_after_blocks to twice it.
    assert_eq!(
        c_with(|c| c.stale_cooldown_blocks = 999),
        err("stale cooldown blocks")
    );
    assert_eq!(c_with(|c| c.stale_cooldown_blocks = 2_000), Ok(()));
    assert_eq!(
        c_with(|c| c.stale_cooldown_blocks = 2_001),
        err("stale cooldown blocks")
    );
    assert_eq!(
        c_with(|c| c.stale_cooldown_blocks = u64::MAX),
        err("stale cooldown blocks")
    );
    assert_eq!(
        c_with(|c| c.stale_cooldown_blocks = 0),
        err("stale cooldown blocks")
    );
}

#[test]
fn deadlines() {
    assert_eq!(c_with(|c| c.start_deadline_ns = NOW), err("start deadline"));
    assert_eq!(c_with(|c| c.start_deadline_ns = NOW + 1), Ok(()));
    // The run end is set past the deadline here, so the start deadline's own bound is what's tested.
    assert_eq!(
        c_with(|c| {
            c.start_deadline_ns = NOW + 7 * DAY_NS;
            c.run_end_ns = NOW + 8 * DAY_NS
        }),
        Ok(())
    );
    assert_eq!(
        c_with(|c| {
            c.start_deadline_ns = NOW + 7 * DAY_NS + 1;
            c.run_end_ns = NOW + 8 * DAY_NS
        }),
        err("start deadline")
    );
    assert_eq!(c_with(|c| c.start_deadline_ns = 0), err("start deadline"));
    assert_eq!(
        c_with(|c| c.start_deadline_ns = u64::MAX),
        err("start deadline")
    );
    assert_eq!(
        c_with(|c| c.run_end_ns = c.start_deadline_ns),
        err("run end")
    );
    assert_eq!(c_with(|c| c.run_end_ns = c.start_deadline_ns + 1), Ok(()));
    assert_eq!(c_with(|c| c.run_end_ns = NOW + 30 * DAY_NS), Ok(()));
    assert_eq!(
        c_with(|c| c.run_end_ns = NOW + 30 * DAY_NS + 1),
        err("run end")
    );
    assert_eq!(c_with(|c| c.run_end_ns = u64::MAX), err("run end"));
    // At 0 and below now: refused by the first comparison, never an underflow (test M-1).
    assert_eq!(c_with(|c| c.run_end_ns = 0), err("run end"));
    assert_eq!(c_with(|c| c.run_end_ns = NOW - 1), err("run end"));
}

/// EC-C56, EC-C170: the swap step cap (Q16, provisional) is 5,000 to 6,000 bps, at the bounds and
/// one past, at 0 and at the type's maximum; its refusal names `swap step`.
#[test]
fn swap_step_cap_is_5000_to_6000() {
    for v in [0u16, 1, 4_999, 6_001, 10_000, u16::MAX] {
        assert_eq!(l_with(|l| l.max_swap_step_bps = v), err("swap step"), "{v}");
    }
    for v in [5_000u16, 5_500, 6_000] {
        assert_eq!(l_with(|l| l.max_swap_step_bps = v), Ok(()), "{v}");
    }
}

#[test]
fn swap_slippage_and_its_cross_limit_never_underflow() {
    // EC-C56: 9, 10 and 101 refused by the bound, 11 (with drift 1) and 100 allowed, whatever the drift.
    for v in [0u16, 9, 10, 101, u16::MAX] {
        assert_eq!(
            l_with(|l| {
                l.max_swap_slippage_bps = v;
                l.max_observation_drift_bps = 300
            }),
            err("swap slippage")
        );
    }
    assert_eq!(
        l_with(|l| {
            l.max_swap_slippage_bps = 11;
            l.max_observation_drift_bps = 1
        }),
        Ok(())
    );
    assert_eq!(
        l_with(|l| {
            l.max_swap_slippage_bps = 11;
            l.max_observation_drift_bps = 2
        }),
        err("drift above slippage")
    );
    assert_eq!(
        l_with(|l| {
            l.max_swap_slippage_bps = 100;
            l.max_observation_drift_bps = 90
        }),
        Ok(())
    );
    assert_eq!(
        l_with(|l| {
            l.max_swap_slippage_bps = 100;
            l.max_observation_drift_bps = 91
        }),
        err("drift above slippage")
    );
}

#[test]
fn drift_bounds_and_the_width_cross_limit() {
    let w = |width: u32, drift: u16| {
        l_with(|l| {
            l.min_range_width_bps = width;
            l.max_range_width_bps = 5_000;
            l.max_observation_drift_bps = drift;
            l.max_swap_slippage_bps = 100
        })
    };
    // EC-C56 vectors, with the exact rule (2 D W <= a (W - a)).
    assert_eq!(w(50, 4), Ok(()));
    assert_eq!(w(50, 5), err("drift above width bound"));
    assert_eq!(w(1_000, 90), Ok(()));
    assert_eq!(w(1_000, 93), err("drift above slippage")); // allowed by width (93), refused by slippage (90)
    assert_eq!(w(1_000, 94), err("drift above width bound"));
    assert_eq!(w(75, 6), Ok(()));
    assert_eq!(w(75, 7), err("drift above width bound")); // floor(3W/32) allowed 7 and the ratio 5,117
    assert_eq!(max_drift_for_width(50), 4);
    assert_eq!(max_drift_for_width(75), 6);
    assert_eq!(max_drift_for_width(1_000), 93);
    assert_eq!(max_drift_for_width(5_000), 468);
    // Drift's own bound comes first: 0 and 301 refused as "drift" even where the width would allow it.
    assert_eq!(w(5_000, 0), err("drift"));
    assert_eq!(w(5_000, 301), err("drift"));
    assert_eq!(w(5_000, u16::MAX), err("drift"));
}

#[test]
fn range_widths() {
    let w = |min: u32, max: u32| {
        l_with(|l| {
            l.min_range_width_bps = min;
            l.max_range_width_bps = max;
            l.max_observation_drift_bps = 4
        })
    };
    assert_eq!(w(50, 50), Ok(()));
    assert_eq!(w(49, 100), err("min range width"));
    assert_eq!(w(0, 100), err("min range width"));
    assert_eq!(w(5_000, 5_000), Ok(()));
    assert_eq!(w(5_001, 5_001), err("min range width"));
    assert_eq!(w(u32::MAX, u32::MAX), err("min range width"));
    assert_eq!(w(100, 99), err("max range width"));
    assert_eq!(w(100, 5_001), err("max range width"));
    assert_eq!(w(100, u32::MAX), err("max range width"));
    assert_eq!(w(100, 0), err("max range width"));
}

#[test]
fn actions_per_24h() {
    for v in [0u32, 3, 49, u32::MAX] {
        assert_eq!(
            l_with(|l| l.max_actions_per_24h = v),
            err("actions per 24h bound")
        );
    }
    assert_eq!(l_with(|l| l.max_actions_per_24h = 4), Ok(()));
    assert_eq!(l_with(|l| l.max_actions_per_24h = 48), Ok(()));
}

#[test]
fn dust_threshold_exactly_the_two_pool_tokens() {
    let q = net().quote_token;
    let b = net().base_token;
    assert_eq!(
        l_with(|l| l.dust_threshold = vec![(b.clone(), 1), (q.clone(), 1)]),
        Ok(())
    );
    assert_eq!(
        l_with(|l| l.dust_threshold = vec![(q.clone(), 1)]),
        err("dust threshold tokens")
    );
    assert_eq!(
        l_with(|l| l.dust_threshold = vec![(q.clone(), 1), (q.clone(), 2)]),
        err("dust threshold tokens")
    );
    assert_eq!(
        l_with(|l| l.dust_threshold = vec![(q.clone(), 1), (b.clone(), 1), (b.clone(), 1)]),
        err("dust threshold tokens")
    );
    assert_eq!(
        l_with(|l| l.dust_threshold = vec![(q.clone(), 1), ("usdt.tether-token.near".into(), 1)]),
        err("dust threshold tokens")
    );
    assert_eq!(
        l_with(|l| l.dust_threshold = vec![]),
        err("dust threshold tokens")
    );
    // Each at least 1 (contract review L-2): 1 allowed, 0 refused for either token.
    assert_eq!(
        l_with(|l| l.dust_threshold = vec![(q.clone(), 1), (b.clone(), 1)]),
        Ok(())
    );
    assert_eq!(
        l_with(|l| l.dust_threshold = vec![(q.clone(), 0), (b.clone(), 1)]),
        err("dust threshold zero")
    );
    assert_eq!(
        l_with(|l| l.dust_threshold = vec![(q.clone(), 1), (b.clone(), 0)]),
        err("dust threshold zero")
    );
    // The token check comes first.
    assert_eq!(
        l_with(|l| l.dust_threshold = vec![(q.clone(), 0)]),
        err("dust threshold tokens")
    );
}

#[test]
fn the_order_of_checks_names_the_earliest_failure() {
    // Two failures at once: the earlier check's message.
    assert_eq!(
        l_with(|l| {
            l.max_slippage_bps = 0;
            l.max_actions_per_24h = 0
        }),
        err("slippage")
    );
    let mut c = config();
    c.agent = c.creator.clone();
    c.platform_bps = 0;
    assert_eq!(check(&c, &limits()), err("accounts not distinct"));
    let mut c = config();
    c.quote_token = "x.near".into();
    c.agent = c.creator.clone();
    assert_eq!(check(&c, &limits()), err("not the network constant"));
}

#[test]
fn max_drift_below_four_points_is_zero_not_a_panic() {
    assert_eq!(max_drift_for_width(0), 0);
    assert_eq!(max_drift_for_width(3), 0);
    assert_eq!(max_drift_for_width(4), 0);
    // No overflow at the type maximum (u64 maths).
    assert_eq!(max_drift_for_width(u32::MAX), 402_653_183);
}

/// The claim behind the width bound, checked for every pair: for every minimum width
/// 50..=5,000 and every range width from it to 5,000, the drift `new` can accept keeps the
/// add ratio at or below 5,000 (security L-3, contract review L-4). The drift is also at
/// most 90 because of `max_swap_slippage_bps - 10`; the check uses the width bound alone,
/// which is stricter.
#[test]
fn width_bound_holds_for_every_width() {
    for min_w in 50u64..=5_000 {
        let d = max_drift_for_width(min_w as u32).min(300);
        // And it is the largest such drift: one more breaks the bound at the minimum width (test L-1).
        assert!(
            d == 300 || add_ratio_at_centring_limit(d + 1, min_w) > 5_000,
            "min width {min_w}: drift {d} isn't the largest"
        );
        for w in min_w..=5_000 {
            let r = add_ratio_at_centring_limit(d, w);
            assert!(r <= 5_000, "min width {min_w}, width {w}, drift {d}: {r}");
        }
    }
    // And W / (a (W - a)) never increases, so the minimum width is the worst case.
    for w in 50u64..5_000 {
        let (a0, a1) = (w / 4, (w + 1) / 4);
        assert!((w + 1) * (a0 * (w - a0)) <= w * (a1 * (w + 1 - a1)), "{w}");
    }
}

#[test]
fn add_ratio_vectors() {
    assert_eq!(add_ratio_at_centring_limit(4, 50), 4_386);
    assert_eq!(add_ratio_at_centring_limit(7, 75), 5_117);
    assert_eq!(add_ratio_at_centring_limit(6, 75), 4_386);
    assert_eq!(add_ratio_at_centring_limit(6, 64), 5_000);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(4_000))]
    /// Every configuration `new` accepts keeps the add ratio bound at or below 5,000 for every range
    /// width it allows (EC-C56), so `10_000 - ADD_RATIO_BPS` stays positive.
    #[test]
    fn accepted_configurations_keep_add_ratio_at_most_5000(min_w in 50u32..=5_000, extra in 0u32..=5_000, drift in 0u16..=310, swap in 0u16..=110, probe in 0u32..=5_000) {
        let max_w = (min_w + extra).min(5_000);
        let mut l = limits();
        l.min_range_width_bps = min_w; l.max_range_width_bps = max_w; l.max_observation_drift_bps = drift; l.max_swap_slippage_bps = swap;
        if check(&config(), &l).is_ok() {
            let w = min_w + probe % (max_w - min_w + 1);
            prop_assert!(add_ratio_at_centring_limit(drift as u64, w as u64) <= 5_000, "w {} d {}", w, drift);
        }
    }
}
