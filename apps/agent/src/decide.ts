import { decisionHash, decisionRecordText, evaluate, type Decision, type MarketState, type RulesV1 } from "@poolside/rules";

/**
 * The agent's decide step. It is `evaluate` from packages/rules and nothing else: the same function
 * the check page replays, so a decision here is a decision the page can re-derive (rules-verifier).
 * No clock, network or randomness is read: every input is in `state`.
 */

/** What the agent sends for a decision, given what the contract has already recorded. */
export type Plan =
  | { readonly kind: "wait"; readonly decision: Decision }
  /** Nothing the agent can do moves the run on: it logs this and stops, and the creator can close (audit round 6). */
  | { readonly kind: "stalled"; readonly decision: Decision; readonly reason: string }
  | { readonly kind: "send"; readonly decision: Decision; readonly method: "agent_swap" | "agent_open" | "agent_close_position"; readonly left?: number; readonly right?: number };

export interface Progress {
  /** Swaps already recorded this run (the contract's `get_swaps_used`). */
  readonly swapsUsed: number;
  /** Whether the one allowed open has happened (`get_opened`). */
  readonly opened: boolean;
  /**
   * The previous Swap's decision hash when that swap moved tokens and finished inside `PAIR_WINDOW_S`:
   * an open under it is the same decision (D47), so it is sent with this hash, not a new one.
   */
  readonly pairedHash?: string | null;
  /**
   * Whether the open needs a swap first (`swapForRange` over the holdings and DCL's `need` is not
   * zero). `false` skips the swap and opens straight away; `undefined` is unknown and swaps as
   * before (security audit M3, rules-verifier H4: a swap with nothing to do is refused and
   * would be sent again every round).
   */
  readonly swapNeeded?: boolean;
  /** The previous trading record was refused or failed less than an hour ago: send nothing now. */
  readonly recentRefusal?: boolean;
  /** Whether the latest recorded `Swap` was refused or failed (its tokens did not move). */
  readonly swapFailed?: boolean;
  /** How many recorded `Open` actions were refused or failed (`get_actions`): after `MAX_OPEN_TRIES` the agent stops. */
  readonly refusedOpens?: number;
}

/** The contract's cap on swaps per run (`start.rs` `MAX_SWAPS_PER_RUN`); every recorded swap counts, refused and failed included. */
export const MAX_SWAPS_PER_RUN = 2;
/** After this many refused or failed opens the agent stops instead of trying again every hour. */
export const MAX_OPEN_TRIES = 2;

/**
 * v1: one swap, then one open, then one close (D55). A swap comes first only when the rules say `open`
 * and no swap has been recorded. After the open there is nothing to do until a close is due.
 */
export function plan(rules: RulesV1, state: MarketState, progress: Progress): Plan {
  const decision = evaluate(rules, state);
  // A refused or failed swap or open is not tried again at once: each try writes a record and costs gas.
  // A due close is never held back by this (the contract's own interval already spaces closes).
  if (decision.kind === "open" && !progress.opened) {
    // A run that cannot be opened any more stops here rather than sending the same call every hour (audit round 6).
    if ((progress.refusedOpens ?? 0) >= MAX_OPEN_TRIES) return { kind: "stalled", decision, reason: `${progress.refusedOpens ?? 0} opens were refused or failed; the creator can close the run` };
    const needsSwap = progress.swapsUsed === 0 || (progress.swapFailed === true && progress.swapNeeded !== false);
    if (needsSwap) {
      // A refused or failed swap counts against the contract's cap, so a retry is only possible while the cap
      // allows it; without a swap the holdings are unbalanced and an open would be wrong (audit round 6).
      if (progress.swapsUsed >= MAX_SWAPS_PER_RUN) return { kind: "stalled", decision, reason: "the swap failed and the run's swaps are used up; the creator can close the run" };
      if (progress.recentRefusal === true) return { kind: "wait", decision };
      if (progress.swapsUsed === 0 && progress.swapNeeded === false) return { kind: "send", decision, method: "agent_open", left: decision.left, right: decision.right };
      return { kind: "send", decision, method: "agent_swap", left: decision.left, right: decision.right };
    }
    if (progress.recentRefusal === true) return { kind: "wait", decision };
    return { kind: "send", decision, method: "agent_open", left: decision.left, right: decision.right };
  }
  if (progress.recentRefusal === true && decision.kind === "open") return { kind: "wait", decision };
  if (decision.kind === "open") return { kind: "wait", decision };
  if (decision.kind === "close") return { kind: "send", decision, method: "agent_close_position" };
  return { kind: "wait", decision };
}

/**
 * The decision record text and its hash, from the one helper the check page also imports
 * (`packages/rules` `decision.ts`, EC-R31): the hash is the SHA-256 of the published text, so the page
 * can recompute it and re-run `evaluate` on the recorded state.
 */
export function record(rules: RulesV1, state: MarketState, decision: Decision, strategy: string): { readonly text: string; readonly hash: string } {
  const text = decisionRecordText(rules, state, decision, strategy);
  return { text, hash: decisionHash(text) };
}
