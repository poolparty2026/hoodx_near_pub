// The missed-close windows, built from views (EC-W21, EC-W27, EC-W28). A recording carries the strategy's views at the first height of
// each 20-block window (DENSE_STEP_BLOCKS) and at the action blocks. For each window the page reads that height only:
//   - not recorded or not readable: "unreadable" (can't check, never a gap);
//   - the strategy is not quiet there (a lock is held) or the height is before the settled-from block: "gap" (a gap never ends a stretch);
//   - otherwise the state at that height, rebuilt from views (src/lib/state.ts).
// This is narrower than `gridPoint`, which looks at all 20 heights of a window for the first quiet, settled one: a recording that
// carries one height per window can't offer the others, so a window that is not quiet at its first height is a gap here, not a
// later sample. The page says "sampled every 20 blocks" and nothing finer.
import { OFFCHAIN_MARGIN_BLOCKS, DENSE_STEP_BLOCKS, nsToS, readU64, RulesError, type CloseReason, type JsonValue, type RulesV1 } from "@poolside/rules";
import type { ActionRecord } from "./record.ts";
import type { GridWindow } from "./missed.ts";
import type { RunSource } from "./run.ts";
import { blockTimeNs, readAt, stateAtBlock } from "./state.ts";

export interface WindowsResult { readonly windows: GridWindow[]; readonly endBlock: number; readonly endS: number }

const isObj = (v: JsonValue | undefined): v is { [k: string]: JsonValue } => v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);

/** The last block a position was held: the earliest successful exit removal or close, else the head. */
function endOf(records: readonly ActionRecord[], head: number): { block: number; ns: bigint | null } {
  let best: { block: number; ns: bigint | null } | null = null;
  for (const r of records) {
    if ((r.kind === "ExitRemove" || r.kind === "ClosePosition") && r.result === "ok" && r.resultBlock !== null && (best === null || r.resultBlock < best.block)) best = { block: r.resultBlock, ns: r.resultTsNs };
  }
  return best ?? { block: head, ns: null };
}

export async function windowsFromViews(src: RunSource, rules: RulesV1, records: readonly ActionRecord[], closedBy: CloseReason | null = null): Promise<WindowsResult | undefined> {
  const blocks = src.snapshotBlocks;
  if (blocks.length === 0) return undefined;
  const have = new Set(blocks);
  const end = endOf(records, src.head);
  const first = Math.ceil(blocks[0]! / DENSE_STEP_BLOCKS) * DENSE_STEP_BLOCKS;
  const last = Math.floor(end.block / DENSE_STEP_BLOCKS) * DENSE_STEP_BLOCKS;
  if (last < first) return undefined;
  const one = async (w: number): Promise<GridWindow> => {
    if (!have.has(w)) return "unreadable";
    try {
      const lock = await readAt(src, src.account, "get_lock", {}, w);
      const sw = await readAt(src, src.account, "get_settle_window", {}, w);
      if (lock === undefined || sw === undefined || !isObj(sw)) return "unreadable";
      const settledFrom = Math.max(Number(readU64(String(sw.settle_until_block))), Number(readU64(String(sw.last_payout_callback_block))) + OFFCHAIN_MARGIN_BLOCKS);
      if (lock !== null || settledFrom > w) return "gap";
      return await stateAtBlock(src, { pool: rules.pool, quoteToken: rules.quote_token, closedBy, confirmFromBlock: null }, w);
    } catch (e) {
      if (e instanceof RulesError) return "unreadable";
      throw e;
    }
  };
  const starts: number[] = [];
  for (let w = first; w <= last; w += DENSE_STEP_BLOCKS) starts.push(w);
  const windows: GridWindow[] = [];
  for (let i = 0; i < starts.length; i += 16) windows.push(...(await Promise.all(starts.slice(i, i + 16).map(one))));
  // missedClose needs a sample at every landed close's O2 block (rules-verifier L-3): one extra sample, in block order, after the last
  // window that starts at or before it. A window that starts AT the O2 block already is that sample.
  for (const o2 of [...new Set(records.filter((r) => r.kind === "ClosePosition" && r.result === "ok").map((r) => r.observed.block))].sort((x, y) => x - y)) {
    if (starts.includes(o2)) continue;
    let k = starts.filter((w) => w <= o2).length; // windows before the O2 block
    if (k === 0) continue;
    const st = await (async (): Promise<GridWindow> => {
      try { return await stateAtBlock(src, { pool: rules.pool, quoteToken: rules.quote_token, closedBy, confirmFromBlock: null }, o2); }
      catch (e) { if (e instanceof RulesError) return "unreadable"; throw e; }
    })();
    // the extra sample sits after the window states already placed, plus the extras inserted before it
    const extrasBefore = windows.length - starts.length;
    k += extrasBefore;
    windows.splice(k, 0, st);
  }
  try {
    const ns = end.ns ?? (await blockTimeNs(src, end.block));
    return { windows, endBlock: end.block, endS: nsToS(ns) };
  } catch (e) {
    if (e instanceof RulesError) return undefined;
    throw e;
  }
}
