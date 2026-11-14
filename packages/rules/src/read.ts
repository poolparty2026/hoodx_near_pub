import { RulesError } from "./errors.ts";
import { strictParse, type JsonValue } from "./json.ts";
import { checkState, withinRules, type MarketState, type Verdict } from "./evaluate.ts";
import { U128_MAX } from "./swap.ts";
import type { RulesV1 } from "./schema.ts";

/**
 * The one way to read an action from text: model output, an agent message or a
 * record replayed by the check page (EC-R25). Never use JSON.parse for actions:
 * it accepts 1e2, 100.0 and duplicate keys, which a Rust port reads differently.
 */
export function readAction(text: string): JsonValue {
  return strictParse(text);
}

/** A verdict on text: within or outside the rules, or the text couldn't be read at all. */
export type TextVerdict = Verdict | { readonly ok: false; readonly unreadable: true; readonly reason: string };

/**
 * Checks the state, then reads the text with readAction, then applies withinRules.
 * Text that can't be read gives `unreadable: true`, which the check page shows as
 * "can't check this action", never as outside the rules (security re-audit of 2276e67, L-2).
 * An invalid state throws STATE whatever the text is (rules-verifier L-3).
 */
export function withinRulesText(rules: RulesV1, s: MarketState, text: string): TextVerdict {
  checkState(s);
  let action: JsonValue;
  try {
    action = readAction(text);
  } catch (e) {
    // strictParse only throws RulesError; anything else would also be refused (fails closed).
    return { ok: false, unreadable: true, reason: (e as Error).message };
  }
  return withinRules(rules, s, action);
}

function readDecimal(text: string, max: bigint, name: string): bigint {
  if (typeof text !== "string" || !/^(0|[1-9][0-9]*)$/.test(text) || text.length > String(max).length) {
    throw new RulesError("STATE", `value must be a decimal ${name} without sign, spaces or leading zeros`);
  }
  const v = BigInt(text);
  if (v > max) throw new RulesError("STATE", `value must fit in ${name}`);
  return v;
}

/**
 * Reads a u128 written as a decimal string (how records encode amounts): digits
 * only, no sign, no leading zeros, no spaces, no 0x, at most 2^128 - 1. BigInt()
 * alone would accept "", " 1 ", "0x10" and "+5". Rust's `str::parse::<u128>()` also
 * accepts "+5" and "007" (checked with rustc, rules-verifier re-audit of 20e4ceb), so a
 * Rust port must match ^(0|[1-9][0-9]*)$ before parsing, as this function does.
 */
export function readU128(text: string): bigint {
  return readDecimal(text, U128_MAX, "u128");
}

export const U64_MAX = (1n << 64n) - 1n;

/** Reads a u64 written as a decimal string (how records encode timestamps), at most 2^64 - 1. */
export function readU64(text: string): bigint {
  return readDecimal(text, U64_MAX, "u64");
}

/**
 * NEAR block timestamps are nanoseconds; MarketState uses whole seconds. Every
 * caller converts with this one function: floor division by 10^9, so the agent
 * and the check page agree at every boundary (rules-verifier M-2).
 */
export function nsToS(ns: bigint): number {
  if (typeof ns !== "bigint" || ns < 0n || ns > U64_MAX) throw new RulesError("STATE", "timestamp must be a u64 of nanoseconds");
  return Number(ns / 1_000_000_000n);
}
