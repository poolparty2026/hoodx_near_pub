// Per-item checks for the check page. Each one returns a verdict and a plain-text line.
// The judging is done by @poolside/rules; the agent imports the same package (not yet exercised end to end); nothing is re-implemented here.
import { decisionHash, hashRules, parseRules, toHex, withinRulesText, RulesError, type MarketState } from "@poolside/rules";
import type { Verdict } from "./verdict.ts";

export interface Finding {
  readonly verdict: Verdict;
  /** Plain text only. Never rendered as HTML (EC-W04, EC-W11). */
  readonly text: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** EC-W01, EC-W09: the revealed rules must hash to the on-chain commitment. */
export function checkRulesReveal(revealedText: string | null, onChainHashHex: string): Finding {
  if (!HEX64.test(onChainHashHex)) return { verdict: "unverifiable", text: "The on-chain rules hash could not be read." };
  if (revealedText === null) return { verdict: "unverifiable", text: "Unverifiable: not revealed." };
  try {
    const got = toHex(hashRules(parseRules(revealedText)));
    return got === onChainHashHex
      ? { verdict: "matching", text: "The revealed rules match the commitment." }
      : { verdict: "not_matching", text: "The revealed rules do not match the commitment." };
  } catch (e) {
    if (e instanceof RulesError) return { verdict: "not_matching", text: "The revealed rules could not be read as valid rules." };
    throw e;
  }
}

/** EC-W05: a decision record must hash to the value the agent committed on-chain. */
export function checkDecisionRecord(recordText: string | null, committedHashHex: string): Finding {
  if (!HEX64.test(committedHashHex)) return { verdict: "unverifiable", text: "The committed decision hash could not be read." };
  if (recordText === null) return { verdict: "not_matching", text: "The decision record is not published." };
  const got = decisionHash(recordText);
  return got === committedHashHex
    ? { verdict: "matching", text: "The decision record matches its hash." }
    : { verdict: "not_matching", text: "The decision record does not match its hash." };
}

/**
 * EC-W18: judge one action from its text. `source` says who wrote the text.
 * - "agent": text the agent committed to by hash. Unreadable is the agent's fault: not matching.
 * - "contract": a record the contract or RPC produced. Unreadable means we cannot check it: unverifiable.
 */
export function checkAction(
  rulesRevealed: ReturnType<typeof parseRules>,
  state: MarketState,
  actionText: string,
  source: "agent" | "contract",
): Finding {
  let v: ReturnType<typeof withinRulesText>;
  try {
    v = withinRulesText(rulesRevealed, state, actionText);
  } catch (e) {
    // An invalid rebuilt state (bad RPC data) is "can't check", never a crash and never matching.
    if (e instanceof RulesError) return { verdict: "unverifiable", text: "Can't check this action: the state it was judged on could not be read." };
    throw e;
  }
  if ("unreadable" in v) {
    return source === "agent"
      ? { verdict: "not_matching", text: "The agent's committed text could not be read." }
      : { verdict: "unverifiable", text: "Can't check this action: its record could not be read." };
  }
  return v.ok
    ? { verdict: "matching", text: "The action is within the rules." }
    : { verdict: "not_matching", text: `The action is outside the rules: ${v.reason}` };
}
