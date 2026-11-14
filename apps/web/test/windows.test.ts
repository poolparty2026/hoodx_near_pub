import { describe, expect, it } from "vitest";
import { DENSE_STEP_BLOCKS, OFFCHAIN_MARGIN_BLOCKS, parseRules, type MarketState } from "@poolside/rules";
import { FIXTURE_STATES, stateViewsSource } from "../src/lib/fixtures.ts";
import { parseActionRecord } from "../src/lib/record.ts";
import { windowsFromViews } from "../src/lib/windows.ts";
import { buildFixture } from "../src/lib/fixtures.ts";

// Window states use the hand-made state at `block` (flat shape, moved in time): enough to tell a state from a gap.
const at = (block: number): MarketState => ({ ...FIXTURE_STATES.flat, block, nowS: 1_000_000 + block });
const RULES = parseRules(JSON.stringify({
  version: 1, pool: `${"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"}|wrap.near|100`, quote_token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  range: { width_bps: 800, centre: "mid" }, take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432_000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
}));
const rec = (kind: string, resultBlock: number, observed: number, resultTsNs: bigint, result = "Ok") => parseActionRecord(JSON.stringify({
  index: "0", op_id: "1", kind, caller: "agent.fixture.near", left_point: -400, right_point: 400, observed: { block: String(observed), point: -400 }, reference: null,
  decision_hash: kind === "ExitRemove" ? "" : "a".repeat(64), chain_head: null, call_block: String(observed + 1), timestamp_ns: "1000000000000000", result_block: String(resultBlock),
  result_ts_ns: String(resultTsNs), result, round: null, swap: null, open: null, remove: null,
}));

type Spec = { blocks: number[]; lock?: (b: number) => unknown; settle?: (b: number) => { last: number; until: number }; head?: number };
const make = (spec: Spec) => {
  const src = stateViewsSource(spec.blocks.map(at), spec.head ?? 1000, () => false, (put) => {
    for (const b of spec.blocks) {
      put("strategy.fixture.near", "get_lock", {}, (spec.lock?.(b) ?? null) as never, b);
      const s = spec.settle?.(b) ?? { last: 0, until: 0 };
      put("strategy.fixture.near", "get_settle_window", {}, { last_payout_callback_block: String(s.last), settle_window_class: "Outsider", settle_until_block: String(s.until) }, b);
    }
  });
  return { ...src, snapshotBlocks: spec.blocks };
};
const blockOf = (w: unknown) => (typeof w === "string" ? w : (w as MarketState).block);

describe("windows from views (EC-W21, EC-W27, EC-W28)", () => {
  it("window starts: every multiple of 20 from the first one at or after the first snapshot to the last one at or before the end", async () => {
    const blocks = [100, 120, 140, 160, 180, 200];
    const src = make({ blocks });
    const w = await windowsFromViews(src, RULES, [rec("ExitRemove", 205, 190, 1_000_205_000_000_000n)]);
    expect(w!.windows.map(blockOf)).toEqual([100, 120, 140, 160, 180, 200]);
    expect(w!.endBlock).toBe(205);
    expect(w!.endS).toBe(1_000_205);
  });
  it("the first window starts at the first multiple of 20 at or after the first snapshot (a snapshot at 110 starts at 120)", async () => {
    const w = await windowsFromViews(make({ blocks: [110, 120, 140] }), RULES, [rec("ExitRemove", 150, 140, 1_000_150_000_000_000n)]);
    expect(w!.windows.map(blockOf)).toEqual([120, 140]);
  });
  it("a window whose first height is not recorded is 'unreadable', never a gap", async () => {
    const w = await windowsFromViews(make({ blocks: [100, 140] }), RULES, [rec("ExitRemove", 150, 140, 1_000_150_000_000_000n)]);
    expect(w!.windows.map((x) => (typeof x === "string" ? x : "state"))).toEqual(["state", "unreadable", "state"]);
  });
  it("a window that is not quiet or not yet settled at its first height is a 'gap'", async () => {
    const w = await windowsFromViews(make({
      blocks: [100, 120, 140],
      lock: (b) => (b === 120 ? { op_id: "1", op: "Swap", stage: "x", promise_block: "1" } : null),
      settle: (b) => (b === 140 ? { last: 130, until: 0 } : { last: 0, until: 0 }), // settled from 130 + the margin: after 140
    }), RULES, [rec("ExitRemove", 150, 140, 1_000_150_000_000_000n)]);
    expect(w!.windows.map((x) => (typeof x === "string" ? x : "state"))).toEqual(["state", "gap", "gap"]);
    expect(OFFCHAIN_MARGIN_BLOCKS).toBeGreaterThan(10);
  });
  it("the held-position span ends at the earliest successful close or exit removal (a later one is ignored), not at the head", async () => {
    const blocks = [100, 120, 140, 160, 180, 200];
    const w = await windowsFromViews(make({ blocks, head: 1000 }), RULES, [rec("ExitRemove", 170, 160, 1_000_170_000_000_000n), rec("ExitRemove", 190, 180, 1_000_190_000_000_000n)]);
    expect(w!.endBlock).toBe(170);
    expect(w!.windows.map(blockOf)).toEqual([100, 120, 140, 160]);
  });
  it("the O2 block of a landed close gets one extra sample, in block order after its window; a window that starts at O2 is that sample", async () => {
    const blocks = [100, 120, 130, 140, 160];
    const close = rec("ClosePosition", 150, 130, 1_000_150_000_000_000n);
    const w = await windowsFromViews(make({ blocks }), RULES, [close]);
    expect(w!.windows.map(blockOf)).toEqual([100, 120, 130, 140]);
    const atStart = await windowsFromViews(make({ blocks: [100, 120, 140] }), RULES, [rec("ClosePosition", 150, 140, 1_000_150_000_000_000n)]);
    expect(atStart!.windows.map(blockOf)).toEqual([100, 120, 140]);
  });
  it("no snapshots, or an end before the first window, gives nothing (can't check)", async () => {
    expect(await windowsFromViews({ ...make({ blocks: [100] }), snapshotBlocks: [] }, RULES, [])).toBeUndefined();
    expect(await windowsFromViews(make({ blocks: [100, 120] }), RULES, [rec("ExitRemove", 90, 80, 1_000_090_000_000_000n)])).toBeUndefined();
    void DENSE_STEP_BLOCKS; void buildFixture;
  });
});
