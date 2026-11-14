import { RulesError } from "./errors.ts";

/**
 * Block and time constants shared by the contract, the agent and the check page
 * (ARCHITECTURE section 5, principle 6). The Rust contract must use the same values.
 *
 * PAYOUT_SETTLE_BLOCKS is **proposed** (gate 3 part C saw a payout one block after its
 * callback); it is measured on mainnet and in the sandbox before deployment (5.11), and
 * the two derived constants follow it.
 */
export const PAYOUT_SETTLE_BLOCKS = 20;
/** A block counts as settled for a decision only this long after the last own payout-producing callback. */
export const OFFCHAIN_MARGIN_BLOCKS = 2 * PAYOUT_SETTLE_BLOCKS;
/** The longest span between a close's first confirming observation (O1) and the close (O2). A fixed constant. */
export const CONFIRM_MAX_BLOCKS = 10 * OFFCHAIN_MARGIN_BLOCKS;
/** The check page's dense-sampling step after a true sample (principle 6, EC-W23). */
export const DENSE_STEP_BLOCKS = OFFCHAIN_MARGIN_BLOCKS / 2;
/** How often the agent observes (ARCHITECTURE 7). */
export const AGENT_OBSERVE_INTERVAL_S = 60;
/**
 * Seconds an honest agent may need, once it can act, to close a due condition: an
 * observation, a restart's margin and a second observation, with room (D53). Part of the
 * missed-close allowance with CONFIRM_MAX_BLOCKS + max_observation_age_blocks in blocks.
 */
export const MISSED_CLOSE_GRACE_S = 3 * AGENT_OBSERVE_INTERVAL_S;
/** An Open starting within this long after its Swap's result is the same decision as the Swap (D47). */
export const PAIR_WINDOW_S = 3600;

const U64_MAX = (1n << 64n) - 1n;
const PAIR_WINDOW_NS = BigInt(PAIR_WINDOW_S) * 1_000_000_000n;

/**
 * Whether an Open pairs with the Swap before it (EC-C158): `swapResultNs` is the Swap
 * record's `result_ts_ns` and `openStartNs` the Open record's `timestamp_ns` (the block
 * of the `agent_open` call, where the contract makes the same comparison), both NEAR
 * block timestamps in nanoseconds: paired at
 * `PAIR_WINDOW_S` less one nanosecond, not at it, and never before the Swap's result.
 */
export function isPairedOpen(swapResultNs: bigint, openStartNs: bigint): boolean {
  for (const t of [swapResultNs, openStartNs]) {
    if (typeof t !== "bigint" || t < 0n || t > U64_MAX) throw new RulesError("STATE", "timestamp must be a u64 of nanoseconds");
  }
  return openStartNs >= swapResultNs && openStartNs - swapResultNs < PAIR_WINDOW_NS;
}
