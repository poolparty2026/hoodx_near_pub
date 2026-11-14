import { RulesError } from "./errors.ts";
import type { Amounts } from "./evaluate.ts";
import { U128_MAX } from "./swap.ts";

/**
 * Holdings as the contract defines them (ARCHITECTURE 5.2, INTERFACE section 5; EC-R34), the one
 * formula the agent and the check page both import. Per pool token:
 *
 *     spendable = max(0, wallet + internal - platform_owed)      (clamped BEFORE adding positions)
 *     holdings  = spendable + positions                          (positions = predict_remove_liquidity of the own position)
 *
 * Gifted positions never count; the caller passes only the strategy's own position. Whether
 * `predict_remove_liquidity` already includes uncollected fees is unverified (gate 3 Part D); this
 * function does the sum the reads give and decides nothing about that. Pure: every input is a bigint
 * read at one block, no clock, network or randomness (EC-R06).
 */
export interface TokenReads {
  readonly wallet: bigint;
  readonly internal: bigint;
  readonly platformOwed: bigint;
  readonly positions: bigint;
}

function amount(v: bigint, what: string): bigint {
  if (typeof v !== "bigint" || v < 0n || v > U128_MAX) throw new RulesError("STATE", `${what} must be a u128`);
  return v;
}

/** One token's holdings. Throws `RulesError` STATE for an input outside u128 or a sum above it. */
export function tokenHoldings(r: TokenReads): bigint {
  const total = amount(r.wallet, "wallet") + amount(r.internal, "internal");
  const owed = amount(r.platformOwed, "platformOwed");
  const spendable = total > owed ? total - owed : 0n;
  const out = spendable + amount(r.positions, "positions");
  if (out > U128_MAX) throw new RulesError("STATE", "holdings exceed the largest u128");
  return out;
}

/** The pair `evaluate` judges on. */
export function marketHoldings(quote: TokenReads, base: TokenReads): Amounts {
  return { quote: tokenHoldings(quote), base: tokenHoldings(base) };
}

/**
 * The own position's pieces mapped from the pool's token_x/token_y order to quote/base: its
 * `predict_remove_liquidity` result `[x, y]` and its unclaimed fees `[x, y]`. `quoteIsX` is whether the
 * quote token is the pool's token_x.
 */
export function positionPieces(quoteIsX: boolean, predict: readonly [bigint, bigint], unclaimed: readonly [bigint, bigint]): { readonly positions: Amounts; readonly unclaimedFees: Amounts } {
  const [px, py, ux, uy] = [amount(predict[0], "predict x"), amount(predict[1], "predict y"), amount(unclaimed[0], "unclaimed x"), amount(unclaimed[1], "unclaimed y")];
  return quoteIsX
    ? { positions: { quote: px, base: py }, unclaimedFees: { quote: ux, base: uy } }
    : { positions: { quote: py, base: px }, unclaimedFees: { quote: uy, base: ux } };
}

/** Fees earned: collected at removals plus unclaimed on the own position (EC-R34). */
export function feesEarned(collected: Amounts, unclaimed: Amounts): Amounts {
  const out = { quote: amount(collected.quote, "collected.quote") + amount(unclaimed.quote, "unclaimed.quote"), base: amount(collected.base, "collected.base") + amount(unclaimed.base, "unclaimed.base") };
  if (out.quote > U128_MAX || out.base > U128_MAX) throw new RulesError("STATE", "fees exceed the largest u128");
  return out;
}
