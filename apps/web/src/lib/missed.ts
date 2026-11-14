// The check page's input to missedClose (EC-W25, EC-W28) and its verdict mapping.
// GUESS: the record and window shapes below stand in for the contract's ActionRecord and views,
// which are not frozen yet (docs/BRIEFING-backend.md, section 4). Change them with that pull request.
import {
  missedClose, RulesError, type MarketState, type MissedCloseLimits, type RulesV1, type Sample,
} from "@poolside/rules";
import type { Finding } from "./checks.ts";

/**
 * A ClosePosition record's `result` as the contract writes it (docs/INTERFACE.md on the backend branch, draft):
 * "Pending", "Ok", "Aborted", "Unknown", {"Failed": stage}, {"Refused": reason}, {"SlotsFull": ...}, {"SwapRefused": ...}.
 * Only the exact string "Ok" is a close (EC-W25). Anything else, including a shape not known yet, is not one:
 * the check fails closed, so a new variant can never end a stretch by accident.
 */
export type CloseResult = unknown;
export interface CloseRecord { readonly result: CloseResult; readonly o2Block: number; readonly resultBlock: number }

/**
 * One grid window as the page read it:
 * - a state: the window's gridPoint, read;
 * - "gap": the window has no quiet, settled height (a real gap, never ends a stretch);
 * - "unreadable": the page could not read the window (RPC error, providers disagree). Never a gap (EC-W28).
 */
export type GridWindow = MarketState | "gap" | "unreadable";

export interface MissedInput {
  readonly rules: RulesV1;
  /** Every window from the first due sample to the end, in order, and each landed close's O2 state. */
  readonly windows: readonly GridWindow[];
  readonly limits: Omit<MissedCloseLimits, "closes" | "endBlock" | "endS" | "clock">;
  /** Block heights with timestamps for gaps where the agent could first act (EC-W27). Read by the page from archival blocks. */
  readonly clock?: MissedCloseLimits["clock"];
  readonly closeRecords: readonly CloseRecord[];
  /** While running: the head. Closed: the last block a position was held. Never just the last sample (EC-W28). */
  readonly end: { readonly block: number; readonly nowS: number };
}

/** EC-W25: only `Ok` closes are passed on; refused, failed and unknown ones leave the stretch running. */
export function landedCloses(records: readonly CloseRecord[]): { o2Block: number; resultBlock: number }[] {
  return records.filter((r) => r.result === "Ok").map((r) => ({ o2Block: r.o2Block, resultBlock: r.resultBlock }));
}

/** The reason as plain words: "stop_loss" becomes "stop loss". */
export const reasonText = (reason: string): string => reason.replaceAll("_", " ");

export function checkMissedClose(input: MissedInput): Finding {
  // An unreadable window is "can't check", never a gap (EC-W28). This is judged before the rest on purpose:
  // dropping a window would make it look like a gap, and a gap never ends a stretch, so a miss reported from
  // the readable windows alone could be wrong. (Account checks differ: a key change is definite on its own.)
  if (input.windows.some((w) => w === "unreadable")) {
    return { verdict: "unverifiable", text: "Can't check for a missed close: some of the run could not be read." };
  }
  const samples: Sample[] = input.windows.flatMap((w) => (typeof w === "string" ? [] : [{ state: w }]));
  // Nothing sampled is nothing checked: never "No close was missed" (security audit M-1, EC-W28).
  if (samples.length === 0) return { verdict: "unverifiable", text: "Can't check for a missed close: no samples were read." };
  try {
    const found = missedClose(input.rules, samples, {
      ...input.limits, closes: landedCloses(input.closeRecords), endBlock: input.end.block, endS: input.end.nowS,
      ...(input.clock !== undefined ? { clock: input.clock } : {}),
    });
    if (found.some((f) => f.kind === "missed" || f.kind === "late_close")) {
      const f = found.find((x) => x.kind === "missed" || x.kind === "late_close")!;
      return {
        verdict: "not_matching",
        text: `${f.kind === "missed" ? "A close was missed" : "A close came late"}: ${reasonText(f.reason)} was due from block ${f.fromBlock} to block ${f.toBlock}.`,
      };
    }
    if (found.length > 0) return { verdict: "unverifiable", text: "Can't check one close condition: only one sample showed it." };
    return { verdict: "matching", text: "No close was missed at the sampled blocks." };
  } catch (e) {
    // A refusal means the page's inputs were wrong or incomplete (a missing clock point, a bad window): can't check.
    if (e instanceof RulesError) return { verdict: "unverifiable", text: "Can't check for a missed close: the inputs were incomplete." };
    throw e;
  }
}
