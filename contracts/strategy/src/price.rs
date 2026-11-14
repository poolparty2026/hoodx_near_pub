//! Exact DCL price arithmetic, the Rust mirror of `packages/rules/src/price.ts` and
//! `swap.ts`/`floor.ts` (ARCHITECTURE 5.6, EC-C06, EC-R27). Price is token_y per token_x
//! = 1.0001^point in Q128; every product is floored, the loop shape is the same as the
//! TypeScript one, and 512-bit intermediates mean nothing overflows. A result above
//! `u128::MAX` saturates to it. Points outside DCL's +-800,000 give `None`, never a panic.
//! Tested against `packages/rules/test/vectors/swap_floor.json` (checked independently by
//! `check_swap_floor.py` in CI) and against `u128` arithmetic.

pub const MIN_POINT: i32 = -800_000;
pub const MAX_POINT: i32 = 800_000;
/// DCL fee tiers (gate 3): the same table as `FEE_TIER_POINT_DELTA` in `packages/rules`.
pub const FEE_TIERS: [u32; 5] = [100, 400, 1000, 2000, 10000];

/// An unsigned 512-bit integer, little-endian 64-bit limbs. Only what the price maths needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct U512([u64; 8]);

impl U512 {
    pub const ZERO: U512 = U512([0; 8]);

    pub fn from_u128(v: u128) -> U512 {
        let mut l = [0u64; 8];
        l[0] = v as u64;
        l[1] = (v >> 64) as u64;
        U512(l)
    }

    /// The value as a `u128`, or `u128::MAX` if it is larger.
    pub fn saturating_u128(&self) -> u128 {
        if self.0[2..].iter().any(|l| *l != 0) {
            u128::MAX
        } else {
            self.0[0] as u128 | (self.0[1] as u128) << 64
        }
    }

    /// The product. Both operands here are bounded far below 2^256 (a price is at most 2^244
    /// and an amount at most 2^128), so the 512-bit result cannot overflow; if it ever did,
    /// the product saturates to the maximum rather than wrapping.
    #[allow(clippy::needless_range_loop)] // schoolbook: `i + j` indexes the result
    pub fn mul(&self, o: &U512) -> U512 {
        let mut r = [0u64; 16];
        for i in 0..8 {
            let mut carry = 0u128;
            for j in 0..8 {
                let cur = r[i + j] as u128 + self.0[i] as u128 * o.0[j] as u128 + carry;
                r[i + j] = cur as u64;
                carry = cur >> 64;
            }
            r[i + 8] = r[i + 8].wrapping_add(carry as u64);
        }
        if r[8..].iter().any(|l| *l != 0) {
            return U512([u64::MAX; 8]);
        }
        U512(r[..8].try_into().unwrap())
    }

    pub fn shl(&self, n: u32) -> U512 {
        let (w, b) = ((n / 64) as usize, n % 64);
        let mut r = [0u64; 8];
        for i in (0..8).rev() {
            if i >= w {
                let lo = self.0[i - w] << b;
                let hi = if b > 0 && i > w {
                    self.0[i - w - 1] >> (64 - b)
                } else {
                    0
                };
                r[i] = lo | hi;
            }
        }
        U512(r)
    }

    #[allow(clippy::needless_range_loop)] // limbs are read at `i + w` and `i + w + 1`
    pub fn shr(&self, n: u32) -> U512 {
        let (w, b) = ((n / 64) as usize, n % 64);
        let mut r = [0u64; 8];
        for i in 0..8 {
            if i + w < 8 {
                let lo = self.0[i + w] >> b;
                let hi = if b > 0 && i + w + 1 < 8 {
                    self.0[i + w + 1] << (64 - b)
                } else {
                    0
                };
                r[i] = lo | hi;
            }
        }
        U512(r)
    }

    pub(crate) fn ge(&self, o: &U512) -> bool {
        for i in (0..8).rev() {
            if self.0[i] != o.0[i] {
                return self.0[i] > o.0[i];
            }
        }
        true
    }

    /// `self - o`, for `self >= o`.
    pub(crate) fn sub(&self, o: &U512) -> U512 {
        let mut r = [0u64; 8];
        let mut borrow = false;
        for (i, out) in r.iter_mut().enumerate() {
            let (a, b1) = self.0[i].overflowing_sub(o.0[i]);
            let (c, b2) = a.overflowing_sub(borrow as u64);
            *out = c;
            borrow = b1 || b2;
        }
        U512(r)
    }

    /// `self / d` rounded down, by shift-and-subtract. `d` must not be zero (the divisors here
    /// are prices, at least 2^128). The remainder stays below `d`, so shifting it left cannot
    /// overflow while `d` is below 2^511.
    pub fn div(&self, d: &U512) -> U512 {
        assert!(*d != U512::ZERO, "division by zero");
        let (mut q, mut rem) = ([0u64; 8], U512::ZERO);
        for bit in (0..512).rev() {
            rem = rem.shl(1);
            rem.0[0] |= (self.0[(bit / 64) as usize] >> (bit % 64)) & 1;
            if rem.ge(d) {
                rem = rem.sub(d);
                q[(bit / 64) as usize] |= 1 << (bit % 64);
            }
        }
        U512(q)
    }
}

const Q: u32 = 128;

fn base() -> U512 {
    // floor(10001 * 2^128 / 10000)
    U512::from_u128(10_001).shl(Q).div(&U512::from_u128(10_000))
}

/// 1.0001^n in Q128 for `0 <= n <= 800_000`: binary exponentiation, every product floored, the
/// same loop (including the extra final squaring) as `priceQ128`.
pub fn price_q128(n: u32) -> Option<U512> {
    if n > MAX_POINT as u32 {
        return None;
    }
    let mut e = n;
    let mut result = U512::ZERO.add_one().shl(Q);
    let mut b = base();
    while e > 0 {
        if e & 1 == 1 {
            result = result.mul(&b).shr(Q);
        }
        b = b.mul(&b).shr(Q);
        e >>= 1;
    }
    Some(result)
}

impl U512 {
    /// `self + n`, for the tests' tolerance comparisons only.
    #[cfg(test)]
    pub(crate) fn add_small(&self, n: u64) -> U512 {
        let mut r = *self;
        for _ in 0..n {
            r = r.add_one();
        }
        r
    }

    /// `self + o`, saturating at the maximum (the sums here stay below 2^374).
    pub(crate) fn add_wide(&self, o: &U512) -> U512 {
        let mut r = [0u64; 8];
        let mut carry = false;
        for (i, out) in r.iter_mut().enumerate() {
            let (v1, c1) = self.0[i].overflowing_add(o.0[i]);
            let (v2, c2) = v1.overflowing_add(carry as u64);
            *out = v2;
            carry = c1 || c2;
        }
        if carry {
            U512([u64::MAX; 8])
        } else {
            U512(r)
        }
    }

    fn add_one(&self) -> U512 {
        let mut r = self.0;
        for l in r.iter_mut() {
            let (v, c) = l.overflowing_add(1);
            *l = v;
            if !c {
                break;
            }
        }
        U512(r)
    }
}

/// `amount * 1.0001^e`, floored: a multiply for `e >= 0`, a division by the price of `-e`
/// below, as `convert` in `check_swap_floor.py`. Saturates at `u128::MAX`; `None` for a point
/// outside the bounds.
pub fn convert(amount: u128, e: i32) -> Option<u128> {
    let a = U512::from_u128(amount);
    if e >= 0 {
        Some(a.mul(&price_q128(e as u32)?).shr(Q).saturating_u128())
    } else {
        let p = price_q128(e.checked_neg()? as u32)?;
        Some(a.shl(Q).div(&p).saturating_u128())
    }
}

/// The one swap that brings holdings to the ratio a range needs (`swapForRange`, swap.ts): the
/// token to sell (in the pool's own order) and the amount, rounded down.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapStep {
    SellX(u128),
    SellY(u128),
}

/// `price = a / b`, both positive, as in `priceRatio` (so precision holds at negative points).
fn price_ratio(point: i32) -> Option<(U512, U512)> {
    let one = U512::from_u128(1).shl(Q);
    if point >= 0 {
        Some((price_q128(point as u32)?, one))
    } else {
        Some((one, price_q128(point.checked_neg()? as u32)?))
    }
}

/// Mirror of `swapForRange(holdings, need, point)` with 512-bit intermediates. Outer `None` for an
/// invalid input (`need` zero in both tokens, or a point out of bounds); `Some(None)` when no swap
/// is needed or it rounds to zero. Compares `x * ny` with `y * nx` and subtracts the smaller, so no
/// signed arithmetic is needed; the result never exceeds the holding of the token sold.
pub fn swap_for_range(
    hold_x: u128,
    hold_y: u128,
    need_x: u128,
    need_y: u128,
    point: i32,
) -> Option<Option<SwapStep>> {
    if need_x == 0 && need_y == 0 {
        return None;
    }
    let (a, b) = price_ratio(point)?;
    let big = |v: u128| U512::from_u128(v);
    let (xy, yx) = (big(hold_x).mul(&big(need_y)), big(hold_y).mul(&big(need_x)));
    if xy == yx {
        return Some(None);
    }
    let denom_part = |n: u128, m: &U512| big(n).mul(m);
    let ny_b = denom_part(need_y, &b);
    let nx_a = denom_part(need_x, &a);
    let denom = U512::from_u128(0).add_wide(&ny_b).add_wide(&nx_a);
    if xy.ge(&yx) {
        let dx = xy.sub(&yx).mul(&b).div(&denom).saturating_u128();
        Some((dx != 0).then_some(SwapStep::SellX(dx)))
    } else {
        let dy = yx.sub(&xy).mul(&a).div(&denom).saturating_u128();
        Some((dy != 0).then_some(SwapStep::SellY(dy)))
    }
}

/// Whether `part <= whole * bps / 10_000`, exact, with 512-bit products (no rounding, no overflow).
pub fn within_bps(part: u128, whole: u128, bps: u16) -> bool {
    let big = U512::from_u128;
    big(whole)
        .mul(&big(bps as u128))
        .ge(&big(part).mul(&big(10_000)))
}

/// An amount of the base token valued in the quote token at `point` (`baseToQuote`).
pub fn base_to_quote(amount_base: u128, point: i32, quote_is_x: bool) -> Option<u128> {
    convert(amount_base, if quote_is_x { -point } else { point })
}

/// An amount of the quote token converted into the base token at `point` (`quoteToBase`).
pub fn quote_to_base(amount_quote: u128, point: i32, quote_is_x: bool) -> Option<u128> {
    convert(amount_quote, if quote_is_x { point } else { -point })
}

/// `a * m / d` rounded down with a 512-bit intermediate, saturating (`d` must not be zero).
fn mul_div(a: u128, m: u128, d: u128) -> u128 {
    U512::from_u128(a)
        .mul(&U512::from_u128(m))
        .div(&U512::from_u128(d))
        .saturating_u128()
}

/// `scaleNeed` (EC-R26): the largest amounts in the ratio of `need` that fit in `spend`, both
/// tokens scaled together and rounded down, then scaled down again (both together, rounding down)
/// so their value at `point` in the quote token is at most `cap` (`max_principal`, D4). Never above
/// `spend` per token. `None` for a `need` of zero in both tokens, a point out of bounds, or a
/// result of zero in both tokens.
pub fn scale_need(
    need_x: u128,
    need_y: u128,
    spend_x: u128,
    spend_y: u128,
    point: i32,
    quote_is_x: bool,
    cap: u128,
) -> Option<(u128, u128)> {
    let big = U512::from_u128;
    let (mut ax, mut ay) = match (need_x, need_y) {
        (0, 0) => return None,
        (0, _) => (0, spend_y),
        (_, 0) => (spend_x, 0),
        _ => {
            // The token that runs out first sets the size; the other follows the ratio.
            if big(spend_x)
                .mul(&big(need_y))
                .ge(&big(spend_y).mul(&big(need_x)))
            {
                // y is the limiting token (or equal)
                (mul_div(spend_y, need_x, need_y), spend_y)
            } else {
                (spend_x, mul_div(spend_x, need_y, need_x))
            }
        }
    };
    let (aq, ab) = if quote_is_x { (ax, ay) } else { (ay, ax) };
    let value = aq.checked_add(base_to_quote(ab, point, quote_is_x)?)?;
    if value > cap {
        ax = mul_div(ax, cap, value);
        ay = mul_div(ay, cap, value);
    }
    (ax != 0 || ay != 0).then_some((ax, ay))
}

/// The swap minimum of `agent_swap` (5.6, EC-R27):
/// `max(floor(quote_out * (10000 - slip) / 10000), floor(value_ref * (10000 - fee_bps - slip) / 10000))`,
/// `value_ref` the input converted into the output token at `ref_point`, `fee_bps = fee_tier / 100`.
/// `None` for a point out of bounds, an unknown fee tier or a slippage outside 11..=100 bps.
pub fn swap_min_output(
    quote_out: u128,
    amount_in: u128,
    input_is_quote: bool,
    ref_point: i32,
    quote_is_x: bool,
    fee_tier: u32,
    slip_bps: u32,
) -> Option<u128> {
    // The same input checks as `swapFloor` (floor.ts): a known fee tier and a swap slippage in
    // 11..=100 bps (a fee of 1 bp plus 9, and the drift cross-limit needs one more), so the
    // contract and the check page refuse the same inputs.
    if !FEE_TIERS.contains(&fee_tier) || !(11..=100).contains(&slip_bps) {
        return None;
    }
    let fee_bps = fee_tier / 100;
    let factor = 10_000u32.checked_sub(fee_bps)?.checked_sub(slip_bps)?;
    if factor == 0 || slip_bps > 10_000 {
        return None;
    }
    let value_ref = if input_is_quote {
        quote_to_base(amount_in, ref_point, quote_is_x)?
    } else {
        base_to_quote(amount_in, ref_point, quote_is_x)?
    };
    let from_quote = mul_div(quote_out, (10_000 - slip_bps) as u128, 10_000);
    let from_ref = mul_div(value_ref, factor as u128, 10_000);
    Some(from_quote.max(from_ref))
}

#[cfg(test)]
mod tests;
