import { describe, expect, it } from "vitest";
import { CONFIRM_MAX_BLOCKS, DENSE_STEP_BLOCKS, parseRules, type MarketState } from "@poolside/rules";
import { checkMissedClose, landedCloses, reasonText, type CloseRecord, type GridWindow } from "../src/lib/missed.ts";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const R = parseRules(JSON.stringify({
  version: 1, pool: `${USDC}|wrap.near|100`, quote_token: USDC, range: { width_bps: 800, centre: "mid" },
  take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432_000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
}));
const limits = { maxObservationAgeBlocks: 10, minActionIntervalS: 300, maxActionsPer24h: 6, agentLocks: [] };
const T = CONFIRM_MAX_BLOCKS + limits.maxObservationAgeBlocks; // 410
// A stop loss that holds: holdings far below principal, position held.
const sl = (b: number): MarketState => ({
  nowS: 1_000_000 + b, startedAtS: 900_000 + b, point: 0, valuationPoint: 0, block: b, confirmFromBlock: null,
  position: { left: -400, right: 400 }, closedBy: null, principal: 250_000_000n,
  holdings: { quote: 1n, base: 0n }, fees: { quote: 0n, base: 0n },
});
const grid = (from: number, to: number): GridWindow[] => {
  const out: GridWindow[] = [];
  for (let b = from; b <= to; b += DENSE_STEP_BLOCKS) out.push(sl(b));
  return out;
};
const end = (b: number) => ({ block: b, nowS: 1_000_000 + b });

describe("EC-W25 which closes are passed", () => {
  const recs: CloseRecord[] = [
    { result: "Ok", o2Block: 100, resultBlock: 102 },
    { result: "Refused", o2Block: 200, resultBlock: 201 },
    { result: "Failed", o2Block: 300, resultBlock: 301 },
    { result: "Unknown", o2Block: 400, resultBlock: 401 },
  ];
  it("only Ok closes are passed", () => {
    expect(landedCloses(recs)).toEqual([{ o2Block: 100, resultBlock: 102 }]);
  });
  it("the contract's own result shapes: only the string Ok is a close, every other variant and unknown shape is not", () => {
    const shapes: unknown[] = ["Pending", "Aborted", "Unknown", { Failed: "Remove" }, { Refused: "paused" }, { SlotsFull: { cur: 1, max: 1 } }, { SwapRefused: { used: "0", forwarded_gas: "1" } }, { Ok: {} }, "ok", null, 1];
    const records = shapes.map((result, i) => ({ result, o2Block: i, resultBlock: i }));
    expect(landedCloses([...records, { result: "Ok", o2Block: 99, resultBlock: 101 }])).toEqual([{ o2Block: 99, resultBlock: 101 }]);
  });
  it("no closes at all gives none", () => expect(landedCloses([])).toEqual([]));
});

describe("checkMissedClose (EC-W23, EC-W28)", () => {
  const base = { rules: R, limits };
  it("a stop loss held past the allowance with no close is not matching", () => {
    const f = checkMissedClose({ ...base, windows: grid(0, T + 40), closeRecords: [], end: end(T + 40) });
    expect(f.verdict).toBe("not_matching");
    expect(f.text).toBe("A close was missed: stop loss was due from block 0 to block 440.");
  });
  it("a refused or failed close does not end the stretch, and the same close with result Ok does (EC-W25)", () => {
    for (const result of ["Refused", "Failed", "Unknown"] as const) {
      const f = checkMissedClose({ ...base, windows: grid(0, T + 40), closeRecords: [{ result, o2Block: 40, resultBlock: 42 }], end: end(T + 40) });
      expect(f).toEqual({ verdict: "not_matching", text: "A close was missed: stop loss was due from block 0 to block 440." });
    }
    const ok = checkMissedClose({ ...base, windows: grid(0, T + 40), closeRecords: [{ result: "Ok", o2Block: 40, resultBlock: 42 }], end: end(T + 40) });
    expect(ok.verdict).not.toBe("not_matching");
  });
  it("one block past the allowance is missed, exactly the allowance is not (EC-W23, test M3)", () => {
    // Grid samples every 20 blocks, then a last sample off the grid but in its own window: held 410 and 411 blocks.
    const atT = checkMissedClose({ ...base, windows: [...grid(0, 380), sl(410)], closeRecords: [], end: end(410) });
    const past = checkMissedClose({ ...base, windows: [...grid(0, 380), sl(411)], closeRecords: [], end: end(411) });
    expect(atT).toEqual({ verdict: "matching", text: "No close was missed at the sampled blocks." });
    expect(past).toEqual({ verdict: "not_matching", text: "A close was missed: stop loss was due from block 0 to block 411." });
  });
  it("a close landing past the allowance is a late close with its own wording (EC-W23)", () => {
    const f = checkMissedClose({ ...base, windows: grid(0, 460), closeRecords: [{ result: "Ok", o2Block: 460, resultBlock: 462 }], end: end(462) });
    expect(f).toEqual({ verdict: "not_matching", text: "A close came late: stop loss was due from block 0 to block 460." });
  });
  it("(security M-1) no samples, or only gaps, is can't check, never No close was missed", () => {
    const none = { verdict: "unverifiable", text: "Can't check for a missed close: no samples were read." };
    expect(checkMissedClose({ ...base, windows: [], closeRecords: [], end: end(999_999) })).toEqual(none);
    expect(checkMissedClose({ ...base, windows: ["gap", "gap"], closeRecords: [], end: end(999_999) })).toEqual(none);
  });
  it("(test H1, deliberate) a provable miss with one unreadable window is still can't check: a dropped window would look like a gap", () => {
    const w = grid(0, T + 40);
    w[2] = "unreadable";
    expect(checkMissedClose({ ...base, windows: w, closeRecords: [], end: end(T + 40) }).verdict).toBe("unverifiable");
  });
  it("held exactly to the allowance is not missed", () => {
    const f = checkMissedClose({ ...base, windows: grid(0, T), closeRecords: [], end: end(T) });
    expect(f.verdict).toBe("matching");
  });
  it("no due condition is matching", () => {
    const ok = { ...sl(0), holdings: { quote: 250_000_000n, base: 0n } };
    expect(checkMissedClose({ ...base, windows: [ok], closeRecords: [], end: end(0) }).verdict).toBe("matching");
  });
  it("an unreadable window is can't check, never a gap or matching (EC-W28)", () => {
    const w = grid(0, T + 40);
    w[3] = "unreadable";
    const f = checkMissedClose({ ...base, windows: w, closeRecords: [], end: end(T + 40) });
    expect(f).toEqual({ verdict: "unverifiable", text: "Can't check for a missed close: some of the run could not be read." });
  });
  it("a real gap window is skipped and does not end the stretch", () => {
    const w = grid(0, T + 40);
    w[5] = "gap";
    expect(checkMissedClose({ ...base, windows: w, closeRecords: [], end: end(T + 40) }).verdict).toBe("not_matching");
  });
  it("an end of range before the last sample is can't check (EC-W28, endBlock too early)", () => {
    const f = checkMissedClose({ ...base, windows: grid(0, T + 40), closeRecords: [], end: end(100) });
    expect(f.verdict).toBe("unverifiable");
  });
  it("one true sample alone is can't check", () => {
    const f = checkMissedClose({ ...base, windows: [sl(0)], closeRecords: [], end: end(0) });
    expect(f).toEqual({ verdict: "unverifiable", text: "Can't check one close condition: only one sample showed it." });
  });
  it("a landed close with no sample at its O2 is can't check", () => {
    const f = checkMissedClose({ ...base, windows: grid(0, 200), closeRecords: [{ result: "Ok", o2Block: 111, resultBlock: 113 }], end: end(200) });
    expect(f.verdict).toBe("unverifiable");
  });
  it("a close that lands inside the allowance is matching", () => {
    const f = checkMissedClose({ ...base, windows: grid(0, 200), closeRecords: [{ result: "Ok", o2Block: 200, resultBlock: 202 }], end: end(202) });
    expect(f.verdict).toBe("matching");
  });
  it("a gap where the agent could first act needs the clock points (EC-W27): without them can't check, with them judged", () => {
    // Samples at block 0 and block 400, a long gap between. The agent's last open lock plus its interval falls at block 200.
    const lim = { ...limits, agentLocks: [{ ts: 999_900, close: false }] };
    const windows = [sl(0), sl(400)];
    const without = checkMissedClose({ rules: R, windows, limits: lim, closeRecords: [], end: end(400) });
    expect(without.verdict).toBe("unverifiable");
    const withClock = checkMissedClose({
      rules: R, windows, limits: lim, closeRecords: [], end: end(400),
      clock: [{ block: 199, nowS: 1_000_199 }, { block: 200, nowS: 1_000_200 }],
    });
    expect(withClock).toEqual({ verdict: "matching", text: "No close was missed at the sampled blocks." });
  });
  it("EC-W27: a clock that shows the agent could act at block 200 gives a miss, not only a pass", () => {
    const lim = { ...limits, agentLocks: [{ ts: 999_900, close: false }] };
    const windows = [sl(0), ...grid(400, 640)];
    const clock = [{ block: 199, nowS: 1_000_199 }, { block: 200, nowS: 1_000_200 }];
    expect(checkMissedClose({ rules: R, windows, limits: lim, closeRecords: [], end: end(640) }).verdict).toBe("unverifiable");
    expect(checkMissedClose({ rules: R, windows, limits: lim, closeRecords: [], end: end(640), clock })).toEqual({
      verdict: "not_matching", text: "A close was missed: stop loss was due from block 0 to block 640." });
  });
  it("EC-W27: a clock whose entries are not adjacent heights is can't check", () => {
    const lim = { ...limits, agentLocks: [{ ts: 999_900, close: false }] };
    const clock = [{ block: 150, nowS: 1_000_150 }, { block: 200, nowS: 1_000_200 }];
    expect(checkMissedClose({ rules: R, windows: [sl(0), ...grid(400, 640)], limits: lim, closeRecords: [], end: end(640), clock }).verdict).toBe("unverifiable");
  });
  it("the reason text turns every underscore into a space", () => {
    expect(reasonText("stop_loss")).toBe("stop loss");
    expect(reasonText("a_b_c")).toBe("a b c");
  });
});
