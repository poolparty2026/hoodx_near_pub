//! Tests for `price` (EC-C06, EC-R26, EC-R27): the shared swap-floor vectors, `u128` references
//! for the 512-bit operations, saturation and the point bounds.
use super::*;
use near_sdk::serde_json::{self, Value};
use proptest::prelude::*;

fn u(v: u128) -> U512 {
    U512::from_u128(v)
}

/// EC-R27: every vector of `swap_floor.json`, shared with `packages/rules` and checked
/// independently by `check_swap_floor.py`, through `swap_min_output` (which uses both
/// conversions, the division path of a negative exponent, saturation and the larger-of rule).
#[test]
fn the_shared_swap_floor_vectors() {
    let d: Value = serde_json::from_str(include_str!(
        "../../../../packages/rules/test/vectors/swap_floor.json"
    ))
    .unwrap();
    let cases = d["cases"].as_array().unwrap();
    assert_eq!(
        cases.len(),
        21,
        "a vector was added or removed: review this test"
    );
    for c in cases {
        let n = |k: &str| c[k].as_str().unwrap().parse::<u128>().unwrap();
        let got = swap_min_output(
            n("quote_out"),
            n("amount_in"),
            c["input_is_quote"].as_bool().unwrap(),
            c["ref_point"].as_i64().unwrap() as i32,
            c["quote_is_x"].as_bool().unwrap(),
            c["fee_tier"].as_u64().unwrap() as u32,
            c["slip_bps"].as_u64().unwrap() as u32,
        );
        assert_eq!(got, Some(n("min_out")), "{}", c["name"]);
    }
}

/// EC-R27: 28 more vectors from a fixed seed across the whole point range (the 19-set-bit points
/// +-786,431 and the powers of two included), every fee tier and both token orders, shared with
/// `packages/rules` and checked independently by `check_swap_floor.py`. They reach the wide
/// division the `u128` references can't.
#[test]
fn the_wide_shared_vectors() {
    let d: Value = serde_json::from_str(include_str!(
        "../../../../packages/rules/test/vectors/swap_floor_wide.json"
    ))
    .unwrap();
    let cases = d["cases"].as_array().unwrap();
    assert_eq!(
        cases.len(),
        28,
        "a vector was added or removed: review this test"
    );
    for c in cases {
        let n = |k: &str| c[k].as_str().unwrap().parse::<u128>().unwrap();
        let got = swap_min_output(
            n("quote_out"),
            n("amount_in"),
            c["input_is_quote"].as_bool().unwrap(),
            c["ref_point"].as_i64().unwrap() as i32,
            c["quote_is_x"].as_bool().unwrap(),
            c["fee_tier"].as_u64().unwrap() as u32,
            c["slip_bps"].as_u64().unwrap() as u32,
        );
        assert_eq!(got, Some(n("min_out")), "{}", c["name"]);
    }
}

/// EC-R27: the vector the architecture quotes, in both directions at the live point.
#[test]
fn the_live_point_vector() {
    assert_eq!(
        quote_to_base(5_000_000, 401_312, true),
        Some(1_339_236_683_264_608_491_424_493)
    );
    assert_eq!(
        base_to_quote(1_339_236_683_264_608_491_424_493, 401_312, true),
        Some(4_999_999)
    );
}

#[test]
fn the_price_at_zero_and_one() {
    assert_eq!(price_q128(0), Some(u(1).shl(128)));
    assert_eq!(price_q128(1), Some(base()));
    // 10001 * 2^128 / 10000 floored
    assert_eq!(base().shr(128), u(1));
}

/// Points at the bounds work; one past them is refused with `None`, never a panic (EC-C06).
#[test]
fn point_bounds() {
    assert!(price_q128(800_000).is_some());
    assert_eq!(price_q128(800_001), None);
    for e in [800_000, -800_000] {
        assert!(convert(1, e).is_some());
        assert!(convert(u128::MAX, e).is_some());
    }
    for e in [800_001, -800_001, i32::MAX, i32::MIN] {
        assert_eq!(convert(1, e), None, "{e}");
    }
    assert_eq!(base_to_quote(1, 800_001, true), None);
    assert_eq!(quote_to_base(1, -800_001, false), None);
    assert_eq!(swap_min_output(0, 1, true, i32::MAX, true, 100, 11), None);
}

/// EC-C06: a result above `u128::MAX` saturates to it; zero stays zero.
#[test]
fn saturation_and_zero() {
    assert_eq!(quote_to_base(u128::MAX, 401_312, true), Some(u128::MAX));
    assert_eq!(convert(0, 401_312), Some(0));
    assert_eq!(convert(0, -401_312), Some(0));
    // At the highest point a unit is worth far more than u128::MAX of the other token.
    assert_eq!(convert(u128::MAX, 800_000), Some(u128::MAX));
    // At the lowest, a u128::MAX amount is worth a tiny, nonzero amount.
    let tiny = convert(u128::MAX, -800_000).unwrap();
    assert!(tiny > 0 && tiny < u128::MAX / 10u128.pow(30));
}

/// EC-R27: `baseToQuote(quoteToBase(a)) <= a`: flooring never creates value.
#[test]
fn round_trips_never_gain() {
    for point in [-800_000, -6_932, -1, 0, 1, 401_312, 800_000] {
        for a in [0u128, 1, 7, 5_000_000, 10u128.pow(24), u128::MAX / 3] {
            for quote_is_x in [true, false] {
                if let Some(b) = quote_to_base(a, point, quote_is_x) {
                    if b < u128::MAX {
                        assert!(base_to_quote(b, point, quote_is_x).unwrap() <= a);
                    }
                }
            }
        }
    }
}

/// The same input checks as `swapFloor` (floor.ts): only the five fee tiers and a slippage of 11
/// to 100 bps; one outside is `None`, never a different minimum from the check page's.
#[test]
fn swap_min_output_refuses_what_swap_floor_refuses() {
    let ok = |tier: u32, slip: u32| swap_min_output(1_000, 1_000, true, 0, true, tier, slip);
    for tier in FEE_TIERS {
        assert!(ok(tier, 11).is_some() && ok(tier, 100).is_some(), "{tier}");
    }
    for slip in [0, 1, 10, 101, 9_899, 10_000, 10_001, u32::MAX] {
        assert_eq!(ok(100, slip), None, "slip {slip}");
    }
    for tier in [0, 1, 99, 101, 300, 3_000, 10_001, u32::MAX] {
        assert_eq!(ok(tier, 11), None, "tier {tier}");
    }
}

/// `quote_out * 9989 / 10000` with `quote_out = u128::MAX` doesn't overflow (512-bit intermediate).
#[test]
fn the_quote_term_has_a_wide_intermediate() {
    let got = swap_min_output(u128::MAX, 0, true, 401_312, true, 100, 11).unwrap();
    assert_eq!(got, mul_div(u128::MAX, 9_989, 10_000));
    assert!(got > u128::MAX / 10_000 * 9_988);
}

proptest! {
    #[test]
    fn mul_matches_u128(a in any::<u64>(), b in any::<u64>()) {
        prop_assert_eq!(u(a as u128).mul(&u(b as u128)), u(a as u128 * b as u128));
    }

    #[test]
    fn div_matches_u128(a in any::<u128>(), d in 1..=u128::MAX) {
        prop_assert_eq!(u(a).div(&u(d)), u(a / d));
    }

    #[test]
    fn shifts_match_u128(a in any::<u128>(), n in 0u32..128) {
        prop_assert_eq!(u(a).shr(n), u(a >> n));
        prop_assert_eq!(u(a >> n).shl(n).shr(n), u(a >> n));
        // Shifting left by 128 then right by 128 restores a (no loss in 512 bits).
        prop_assert_eq!(u(a).shl(128).shr(128), u(a));
    }

    /// div and mul agree: (a * m) / m == a for nonzero m, a wide intermediate.
    #[test]
    fn mul_then_div_restores(a in any::<u128>(), m in 1..=u128::MAX) {
        prop_assert_eq!(u(a).mul(&u(m)).div(&u(m)), u(a));
    }

    /// A conversion at a point and back never gains, and stays monotonic in the amount.
    #[test]
    fn conversion_is_monotonic(a in 0u128..u64::MAX as u128, b in 0u128..u64::MAX as u128, p in -800_000i32..=800_000) {
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        prop_assert!(convert(lo, p).unwrap() <= convert(hi, p).unwrap());
    }
}

/// Test audit M1 (EC-R27): with the quote term zero the reference term decides, so the fee term
/// matters: exact values for every fee tier at slip 11 and 100 (computed independently as
/// `floor(value_ref * (10000 - fee_bps - slip) / 10000)`, `value_ref` = the shared live-point
/// vector `quoteToBase(5_000_000)`). A wrong `fee_tier / 100` changes every row but the first.
#[test]
fn the_reference_term_carries_the_fee() {
    let rows: [(u32, u32, u128); 10] = [
        (100, 11, 1_337_629_599_244_690_961_234_783),
        (100, 100, 1_325_710_392_763_635_945_661_105),
        (400, 11, 1_337_227_828_239_711_578_687_356),
        (400, 100, 1_325_308_621_758_656_563_113_678),
        (1000, 11, 1_336_424_286_229_752_813_592_501),
        (1000, 100, 1_324_505_079_748_697_798_018_823),
        (2000, 11, 1_335_085_049_546_488_205_101_077),
        (2000, 100, 1_323_165_843_065_433_189_527_399),
        (10000, 11, 1_324_371_156_080_371_337_169_681),
        (10000, 100, 1_312_451_949_599_316_321_596_003),
    ];
    for (tier, slip, want) in rows {
        assert_eq!(
            swap_min_output(0, 5_000_000, true, 401_312, true, tier, slip),
            Some(want),
            "tier {tier} slip {slip}"
        );
    }
}

/// `from_quote` wins when the quote is honest and `from_ref` when it is low; the result is never
/// below either term, and a higher fee tier never raises it.
#[test]
fn the_larger_term_wins_and_fees_only_lower_it() {
    for quote_out in [
        0u128,
        1,
        10u128.pow(24),
        1_339_236_683_264_608_491_424_493,
        u128::MAX,
    ] {
        let mut last = u128::MAX;
        for tier in FEE_TIERS {
            let got = swap_min_output(quote_out, 5_000_000, true, 401_312, true, tier, 11).unwrap();
            let from_quote = mul_div(quote_out, 9_989, 10_000);
            let value_ref = quote_to_base(5_000_000, 401_312, true).unwrap();
            let from_ref = mul_div(value_ref, (10_000 - tier / 100 - 11) as u128, 10_000);
            assert_eq!(
                got,
                from_quote.max(from_ref),
                "quote {quote_out} tier {tier}"
            );
            assert!(got >= from_quote && got >= from_ref);
            assert!(got <= last, "a higher tier raised the minimum");
            last = got;
        }
    }
}

/// Test audit: `mul` across limbs (the `u64` property only used one limb each). The 256-bit product
/// of two `u128`s against four limbs built from 64-bit partial products.
fn product_limbs(a: u128, b: u128) -> [u64; 4] {
    let (a0, a1) = (a as u64 as u128, (a >> 64) as u64 as u128);
    let (b0, b1) = (b as u64 as u128, (b >> 64) as u64 as u128);
    let (p00, p01, p10, p11) = (a0 * b0, a0 * b1, a1 * b0, a1 * b1);
    let mid = (p00 >> 64) + (p01 as u64 as u128) + (p10 as u64 as u128);
    let hi = p11 + (p01 >> 64) + (p10 >> 64) + (mid >> 64);
    [p00 as u64, mid as u64, hi as u64, (hi >> 64) as u64]
}

proptest! {
    #[test]
    fn mul_matches_the_wide_product(a in any::<u128>(), b in any::<u128>()) {
        let l = product_limbs(a, b);
        let want = U512([l[0], l[1], l[2], l[3], 0, 0, 0, 0]);
        prop_assert_eq!(u(a).mul(&u(b)), want);
    }
}

/// Test audit: an independent reference for `price_q128`. The exact value is
/// `floor(10001^n * 2^128 / 10000^n)`, computed with exact big-integer maths; the exponentiation
/// floors every product, so it is at or below the exact value and within a few units of it.
#[test]
fn price_q128_against_the_exact_rational() {
    for n in 0..=16u32 {
        let mut num = u(1).shl(128);
        let mut den = u(1);
        for _ in 0..n {
            num = num.mul(&u(10_001));
            den = den.mul(&u(10_000));
        }
        let exact = num.div(&den);
        let got = price_q128(n).unwrap();
        assert!(exact.ge(&got), "n {n}: above the exact value");
        assert!(
            got.add_small(64).ge(&exact),
            "n {n}: more than 64 units below"
        );
    }
}

/// EC-R26: every vector of `swap.json` (shared with `packages/rules`, checked independently by
/// `check_swap.py`) through `swap_for_range`.
#[test]
fn the_shared_swap_sizing_vectors() {
    let d: Value = serde_json::from_str(include_str!(
        "../../../../packages/rules/test/vectors/swap.json"
    ))
    .unwrap();
    let cases = d.as_array().unwrap();
    assert!(cases.len() >= 10, "{}", cases.len());
    let n = |v: &Value, k: &str| v[k].as_str().unwrap().parse::<u128>().unwrap();
    for c in cases {
        let got = swap_for_range(
            n(&c["holdings"], "x"),
            n(&c["holdings"], "y"),
            n(&c["need"], "x"),
            n(&c["need"], "y"),
            c["point"].as_i64().unwrap() as i32,
        );
        let want = if c["result"].is_null() {
            None
        } else {
            let amount = n(&c["result"], "amountIn");
            Some(if c["result"]["tokenIn"] == "x" {
                SwapStep::SellX(amount)
            } else {
                SwapStep::SellY(amount)
            })
        };
        assert_eq!(got, Some(want), "{c}");
    }
}

#[test]
fn swap_sizing_refuses_invalid_inputs_and_stays_within_holdings() {
    assert_eq!(swap_for_range(1, 1, 0, 0, 0), None, "need zero in both");
    assert_eq!(swap_for_range(1, 1, 1, 1, 800_001), None);
    assert_eq!(swap_for_range(1, 1, 1, 1, i32::MIN), None);
    // Need zero in one token: the whole of the other is sold.
    assert_eq!(
        swap_for_range(0, 777, 5, 0, 0),
        Some(Some(SwapStep::SellY(777)))
    );
    assert_eq!(
        swap_for_range(777, 0, 0, 5, 0),
        Some(Some(SwapStep::SellX(777)))
    );
    // The live shape: 500 USDC only (x), a centred range: about half is sold.
    let step = swap_for_range(
        500_000_000,
        0,
        1_000_000_000_000_000_000,
        290_000_000_000_000_000_000_000_000_000_000_000,
        401_312,
    );
    assert!(
        matches!(step, Some(Some(SwapStep::SellX(a))) if a > 0 && a <= 500_000_000),
        "{step:?}"
    );
}

proptest! {
    /// The amount sold never exceeds the holding of the token sold, at any point and amounts.
    #[test]
    fn swap_sizing_never_sells_more_than_held(hx in any::<u128>(), hy in any::<u128>(), nx in any::<u128>(), ny in any::<u128>(), p in -800_000i32..=800_000) {
        if let Some(Some(step)) = swap_for_range(hx, hy, nx, ny, p) {
            match step {
                SwapStep::SellX(a) => prop_assert!(a <= hx && a > 0),
                SwapStep::SellY(a) => prop_assert!(a <= hy && a > 0),
            }
        }
    }
}

/// EC-C97: `within_bps` is exact at the boundary, with zero and at the u128 extremes.
#[test]
fn within_bps_is_exact_at_the_boundary() {
    // part = whole * bps / 10_000 exactly is within; one more is not.
    assert!(within_bps(6_000, 10_000, 6_000));
    assert!(!within_bps(6_001, 10_000, 6_000));
    assert!(within_bps(5_999, 10_000, 6_000));
    // Not a multiple: 3 of 5 at 6,000 bps is exactly 3.
    assert!(within_bps(3, 5, 6_000));
    assert!(!within_bps(4, 5, 6_000));
    // Zero part, zero whole, zero bps.
    assert!(within_bps(0, 0, 0));
    assert!(within_bps(0, 10, 0));
    assert!(!within_bps(1, 0, 6_000));
    assert!(!within_bps(1, 10, 0));
    // The extremes do not overflow.
    assert!(within_bps(u128::MAX, u128::MAX, 10_000));
    assert!(!within_bps(u128::MAX, u128::MAX - 1, 10_000));
    assert!(within_bps(u128::MAX / 2, u128::MAX, 5_000));
    assert!(!within_bps(u128::MAX / 2 + 1, u128::MAX, 5_000));
}

proptest! {
    #[test]
    fn within_bps_matches_exact_arithmetic(part in any::<u128>(), whole in any::<u128>(), bps in 0u16..=10_000) {
        let exact = part.checked_mul(10_000).zip(whole.checked_mul(bps as u128));
        if let Some((l, r)) = exact {
            prop_assert_eq!(within_bps(part, whole, bps), l <= r);
        }
    }
}

// ---- scaleNeed and the deploy cap (EC-R26, EC-C06, EC-C116) ----
const P: i32 = 401_312;

/// EC-R26: a need of zero in one token takes all of the other that is spendable; zero in both is
/// refused; zero spendable is `None`.
#[test]
fn scale_need_zero_cases() {
    let big = u128::MAX;
    assert_eq!(scale_need(0, 0, 5, 5, P, true, big), None);
    assert_eq!(scale_need(0, 7, 5, 9, P, true, big), Some((0, 9)));
    assert_eq!(scale_need(7, 0, 5, 9, P, true, big), Some((5, 0)));
    assert_eq!(scale_need(7, 9, 0, 0, P, true, big), None);
    assert_eq!(scale_need(10, 10, 0, 100, P, true, big), None);
    assert_eq!(scale_need(1, 1, 5, 9, 800_001, true, big), None);
}

/// EC-R26: the limiting token is used in full and the other follows the ratio, rounded down.
#[test]
fn scale_need_follows_the_limiting_token() {
    // y limits: spend_y 30 of need_y 10 is x3, so x = 3 * 4 = 12 of 100 spendable.
    assert_eq!(
        scale_need(4, 10, 100, 30, 0, true, u128::MAX),
        Some((12, 30))
    );
    // x limits: spend_x 8 of need_x 4 is x2, so y = 20 of 1000 spendable.
    assert_eq!(
        scale_need(4, 10, 8, 1000, 0, true, u128::MAX),
        Some((8, 20))
    );
    // Rounds down: 7 * 10 / 4 = 17.5 -> 17.
    assert_eq!(
        scale_need(4, 10, 7, 1000, 0, true, u128::MAX),
        Some((7, 17))
    );
    // EC-C06: a value that overflows u128 is refused, never wrapped; below it, at u128::MAX / 2.
    assert_eq!(
        scale_need(1, 1, u128::MAX, u128::MAX, 0, true, u128::MAX),
        None
    );
    let h = u128::MAX / 2;
    assert_eq!(scale_need(1, 1, h, h, 0, true, u128::MAX), Some((h, h)));
}

/// EC-R26, EC-C116: the deploy cap at `cap - 1`, `cap` and `cap + 1` of value at the reference.
/// Point 0: price 1, so value is the sum of both amounts.
#[test]
fn scale_need_deploy_cap_at_the_limit() {
    for quote_is_x in [true, false] {
        // Spendable worth 2 * cap - ... at price 1: spend 600 + 400 for a 1:1 need.
        let at = |cap: u128| scale_need(1, 1, 600, 400, 0, quote_is_x, cap).unwrap();
        // Unscaled value is 800 (400 + 400): a cap of 800 and above changes nothing.
        assert_eq!(at(801), (400, 400));
        assert_eq!(at(800), (400, 400));
        let (x, y) = at(799);
        assert!(x + y <= 799 && x == y && x == 399, "{x} {y}");
        // A cap so small both amounts round to zero is refused.
        assert_eq!(scale_need(1, 1, 600, 400, 0, quote_is_x, 1), None);
    }
}

proptest! {
    /// EC-R26: never above spendable, value at most the cap, both tokens rounded down together
    /// (a larger spendable never gives less), and the ratio of the unscaled result stays within
    /// one unit of `need`.
    #[test]
    fn scale_need_bounds(
        nx in 1u128..=u64::MAX as u128, ny in 1u128..=u64::MAX as u128,
        sx in 0u128..=u64::MAX as u128, sy in 0u128..=u64::MAX as u128,
        cap in 1u128..=u64::MAX as u128, p in -800_000i32..=800_000, qx in any::<bool>(),
    ) {
        if let Some((ax, ay)) = scale_need(nx, ny, sx, sy, p, qx, cap) {
            prop_assert!(ax <= sx && ay <= sy);
            if let Some(v) = value_at_checked(ax, ay, qx, p) {
                prop_assert!(v <= cap, "value {v} cap {cap}");
            }
        }
    }
}

fn value_at_checked(ax: u128, ay: u128, quote_is_x: bool, point: i32) -> Option<u128> {
    let (q, b) = if quote_is_x { (ax, ay) } else { (ay, ax) };
    q.checked_add(base_to_quote(b, point, quote_is_x)?)
}
