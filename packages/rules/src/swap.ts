import { RulesError } from "./errors.ts";
import { Q, checkPoint, priceQ128 } from "./price.ts";

/** Token amounts by the pool's own order: token_x and token_y. */
export interface PoolAmounts {
  readonly x: bigint;
  readonly y: bigint;
}

export const U128_MAX = (1n << 128n) - 1n;

export type SwapStep = { readonly tokenIn: "x" | "y"; readonly amountIn: bigint } | null;

function checkPair(a: unknown, name: string): asserts a is PoolAmounts {
  if (a === null || typeof a !== "object") throw new RulesError("STATE", `${name} must be an object`);
  const o = a as Record<string, unknown>;
  for (const k of ["x", "y"]) {
    const v = o[k];
    if (typeof v !== "bigint" || v < 0n) throw new RulesError("STATE", `${name}.${k} must be a non-negative bigint`);
    // Token balances are u128 on NEAR; larger inputs would make Rust and TypeScript disagree.
    if (v > U128_MAX) throw new RulesError("STATE", `${name}.${k} must fit in u128`);
  }
}

/**
 * The deterministic swap step before an open (D27; v1 has no rebalance, D47). Given what the
 * strategy holds and the token amounts DCL's `predict_add_liquidity` gives for
 * the target range, returns the one swap that brings the holdings to that ratio
 * at the observed point, ignoring swap fees, rounded down. Returns null when no
 * swap is needed or it rounds to zero. Where `need` comes from, and at which
 * probe liquidity, is fixed by the contract design (security audit M1): DCL
 * rounds the predicted amounts, so the probe must be large.
 *
 * The price p = token_y per token_x at the point (gate 3) is taken as a ratio
 * A / B: for point >= 0, A = priceQ128(point) and B = 2^128; for point < 0,
 * A = 2^128 and B = priceQ128(-point), so precision holds at very negative
 * points (as in baseToQuote). With cross = x * ny - y * nx:
 *   x in excess: dx = cross * B / (ny * B + nx * A)
 *   y in excess: dy = -cross * A / (ny * B + nx * A)
 * When need is zero in one token, the whole of the other token is swapped,
 * exactly. The Rust contract mirrors this with U512: the numerators reach 500
 * bits and the denominator 372 bits at u128 amounts and points of ±800,000.
 * `cross` is signed (up to 257 bits); on unsigned integers compare x * ny with
 * y * nx and subtract the smaller from the larger, branching before any division.
 */
export function swapForRange(holdings: PoolAmounts, need: PoolAmounts, point: number): SwapStep {
  checkPair(holdings, "holdings");
  checkPair(need, "need");
  if (need.x === 0n && need.y === 0n) throw new RulesError("STATE", "need must not be zero in both tokens");
  const { a, b } = priceRatio(point);
  const cross = holdings.x * need.y - holdings.y * need.x;
  if (cross === 0n) return null;
  const denom = need.y * b + need.x * a;
  if (cross > 0n) {
    const dx = (cross * b) / denom;
    return dx === 0n ? null : { tokenIn: "x", amountIn: dx };
  }
  const dy = (-cross * a) / denom;
  return dy === 0n ? null : { tokenIn: "y", amountIn: dy };
}

/** The price at `point` as a ratio a / b of positive integers (see swapForRange). */
export function priceRatio(point: number): { a: bigint; b: bigint } {
  checkPoint(point);
  const one = 1n << Q;
  return point >= 0 ? { a: priceQ128(point), b: one } : { a: one, b: priceQ128(-point) };
}
