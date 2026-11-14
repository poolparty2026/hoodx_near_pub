import { RulesError } from "./errors.ts";
import { baseToQuote, quoteToBase } from "./price.ts";
import { FEE_TIER_POINT_DELTA } from "./schema.ts";

const U128_MAX = (1n << 128n) - 1n;

/** `max_swap_slippage_bps` bounds of v1 (ARCHITECTURE 5.3): the pool fee of 1 bp plus 9 bp, plus at least 1 for the drift cross-limit. */
export const SWAP_SLIPPAGE_BPS = Object.freeze([11, 100] as const);

export interface SwapFloorInput {
  /** `quote_out` of the same-chain DCL quote for `amountIn`, in the output token. */
  readonly quoteOut: bigint;
  /** The swap's input amount. */
  readonly amountIn: bigint;
  /** Whether the input token is the rules' quote token (USDC to wNEAR in a quote-funded run). */
  readonly inputIsQuote: boolean;
  /** The operation's reference point (the contract's own read, 5.6). */
  readonly refPoint: number;
  /** Whether the quote token is the pool's token_x. */
  readonly quoteIsX: boolean;
  /** The pool's DCL fee tier (100, 400, 1000, 2000 or 10000); fee_bps = feeTier / 100. */
  readonly feeTier: number;
  /** `max_swap_slippage_bps`, 11 .. 100. */
  readonly slipBps: number;
}

function u128(v: unknown, name: string): bigint {
  if (typeof v !== "bigint" || v < 0n || v > U128_MAX) throw new RulesError("STATE", `${name} must be a u128 bigint`);
  return v;
}

/**
 * The swap's `min_output_amount` (ARCHITECTURE 5.6, EC-R27): the larger of
 *   floor(quote_out × (10_000 − slip) / 10_000) and
 *   floor(value_ref(amount_in) × (10_000 − fee_bps − slip) / 10_000),
 * where value_ref converts amount_in into the **output** token at the reference point:
 * quoteToBase when the input is the quote token, else baseToQuote, each saturated at
 * u128::MAX (a saturated minimum makes the swap fail safely). The result never exceeds
 * u128::MAX. The Rust contract must give the same integer on test/vectors/swap_floor.json.
 */
export function swapFloor(i: SwapFloorInput): bigint {
  if (i === null || typeof i !== "object") throw new RulesError("STATE", "swap floor input must be an object");
  const quoteOut = u128(i.quoteOut, "quoteOut");
  const amountIn = u128(i.amountIn, "amountIn");
  if (typeof i.inputIsQuote !== "boolean" || typeof i.quoteIsX !== "boolean") throw new RulesError("STATE", "inputIsQuote and quoteIsX must be booleans");
  if (!Number.isSafeInteger(i.feeTier) || FEE_TIER_POINT_DELTA[i.feeTier] === undefined) throw new RulesError("STATE", "feeTier must be a DCL fee tier");
  const [lo, hi] = SWAP_SLIPPAGE_BPS;
  if (!Number.isSafeInteger(i.slipBps) || i.slipBps < lo || i.slipBps > hi) throw new RulesError("STATE", `slipBps must be an integer between ${lo} and ${hi}`);
  const fee = BigInt(i.feeTier / 100);
  const slip = BigInt(i.slipBps);
  const raw = i.inputIsQuote ? quoteToBase(amountIn, i.refPoint, i.quoteIsX) : baseToQuote(amountIn, i.refPoint, i.quoteIsX);
  const valueRef = raw > U128_MAX ? U128_MAX : raw;
  const fromQuote = (quoteOut * (10_000n - slip)) / 10_000n;
  const fromRef = (valueRef * (10_000n - fee - slip)) / 10_000n;
  return fromQuote > fromRef ? fromQuote : fromRef;
}
