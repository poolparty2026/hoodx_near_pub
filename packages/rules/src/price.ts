import { RulesError } from "./errors.ts";

const U128_MAX = (1n << 128n) - 1n;

/**
 * Exact, platform-independent fixed-point arithmetic for DCL prices.
 * Gate 3 confirmed: price = token_y per token_x = 1.0001^point, points in ±800,000.
 *
 * Algorithm (the Rust contract tests must mirror it exactly):
 *   BASE = floor(1.0001 * 2^128) = floor(10001 * 2^128 / 10000)
 *   pow(n >= 0): binary exponentiation; every product is floored: (a * b) >> 128
 * The result is at or below the true 1.0001^point * 2^128, within 2.1e-33
 * relative over 0..800,000 (checked with 400-digit decimals, 6 November 2026).
 * Negative points are refused: 2^256 / pow(|n|) loses up to 3.3e-5 of precision
 * at -800,000 (security re-audit L-2). Use priceRatio or baseToQuote, which
 * divide by pow(|n|) instead.
 * Integer widths for the Rust mirror: use U512 throughout. The loop squares `b`
 * once more than needed (keep that loop shape); for |point| >= 524288, `b` reaches
 * 280 bits, `b * b` 408 bits and `result * b` 372 bits. Valuation also needs U512:
 * baseToQuote of a u128 amount reaches 372 bits before the shift (244 after), and
 * closeCondition multiplies the sum by 10,000.
 */
export const Q = 128n;
export const ONE = 1n << Q;
export const BASE = (10001n << Q) / 10000n;
export const MIN_POINT = -800_000;
export const MAX_POINT = 800_000;

/** Refuses anything but an integer point within DCL's bounds. */
export function checkPoint(point: number): void {
  if (!Number.isSafeInteger(point) || point < MIN_POINT || point > MAX_POINT) throw new RulesError("STATE", "point must be an integer within ±800000");
}

/** 1.0001^point in Q128, for points 0..800,000 only (see the header). */
export function priceQ128(point: number): bigint {
  checkPoint(point);
  if (point < 0) throw new RulesError("STATE", "priceQ128 takes points >= 0; use priceRatio or baseToQuote below zero");
  let e = point;
  let result = ONE;
  let b = BASE;
  while (e > 0) {
    if (e & 1) result = (result * b) >> Q;
    b = (b * b) >> Q;
    e >>>= 1;
  }
  return result;
}

/**
 * Converts an amount of the non-quote token into quote-token units at `point`,
 * rounded down. `quoteIsX` says whether the quote token is the pool's token_x.
 */
export function baseToQuote(amountBase: bigint, point: number, quoteIsX: boolean): bigint {
  checkPoint(point);
  if (typeof amountBase !== "bigint" || amountBase < 0n) throw new RulesError("STATE", "amount must be a non-negative bigint");
  // Quote is x: x-equivalent of y = y / price(point).  Quote is y: x * price(point).
  // Divide by the positive-exponent price directly instead of multiplying by a
  // quantised reciprocal, so precision holds at very negative points (L1).
  const e = quoteIsX ? -point : point;
  if (e >= 0) return (amountBase * priceQ128(e)) >> Q;
  return (amountBase << Q) / priceQ128(-e);
}

/**
 * Converts an amount of the quote token into the non-quote (base) token at `point`,
 * rounded down: the other direction of baseToQuote, with the same two paths and the
 * effective exponent e = +point when the quote token is token_x (so on the live
 * USDC/wNEAR pool, point about 401,312, it multiplies). Used for the swap floor's
 * reference value in the output token (ARCHITECTURE 5.6, EC-R27).
 *
 * A result above u128::MAX saturates to it: as a swap minimum that makes the swap fail
 * safely, and nothing throws. The Rust mirror needs U512 intermediates (314 bits for a
 * u128 amount at point 800,000). Once floored it is not an exact inverse:
 * baseToQuote(quoteToBase(a)) <= a.
 */
export function quoteToBase(amountQuote: bigint, point: number, quoteIsX: boolean): bigint {
  checkPoint(point);
  if (typeof amountQuote !== "bigint" || amountQuote < 0n) throw new RulesError("STATE", "amount must be a non-negative bigint");
  if (amountQuote > U128_MAX) throw new RulesError("STATE", "amount must fit in u128");
  const e = quoteIsX ? point : -point;
  const out = e >= 0 ? (amountQuote * priceQ128(e)) >> Q : (amountQuote << Q) / priceQ128(-e);
  return out > U128_MAX ? U128_MAX : out;
}
