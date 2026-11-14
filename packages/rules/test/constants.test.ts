import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PAIR_WINDOW_S, isPairedOpen } from "../src/constants.ts";
import * as api from "../src/index.ts";
import { readFileSync } from "node:fs";
import { evaluate, nextConfirmRun, type ConfirmRun, type MarketState } from "../src/evaluate.ts";
import { validateRules } from "../src/schema.ts";
import { readU128 } from "../src/read.ts";
import type { JsonValue } from "../src/json.ts";

const W = BigInt(PAIR_WINDOW_S) * 1_000_000_000n;

describe("isPairedOpen: an Open and the Swap before it are one decision (EC-R29, EC-C158)", () => {
  it("uses a one-hour window", () => {
    expect(PAIR_WINDOW_S).toBe(3600);
  });
  it("pairs at PAIR_WINDOW_S - 1 ns and not at it, comparing with the Swap's result timestamp", () => {
    const t = 1_700_000_000_000_000_000n;
    expect(isPairedOpen(t, t)).toBe(true);
    expect(isPairedOpen(t, t + W - 1n)).toBe(true);
    expect(isPairedOpen(t, t + W)).toBe(false);
    expect(isPairedOpen(t, t + W + 1n)).toBe(false);
  });
  it("never pairs an Open that starts before the Swap's result", () => {
    expect(isPairedOpen(10n, 9n)).toBe(false);
  });
  it.each([
    ["number result", 1 as never, 2n],
    ["number open", 1n, 2 as never],
    ["negative result", -1n, 2n],
    ["above u64", 1n << 64n, (1n << 64n) + 1n],
  ])("refuses a bad timestamp: %s", (_n, a, b) => {
    expect(() => isPairedOpen(a, b)).toThrow("STATE: timestamp must be a u64 of nanoseconds");
  });
  it("agrees with the plain definition (property)", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), fc.bigInt({ min: -2n * W, max: 2n * W }), (r, d) => {
      const n = r + d;
      if (n < 0n || n > (1n << 64n) - 1n) return;
      expect(isPairedOpen(r, n)).toBe(d >= 0n && d < W);
    }), { numRuns: 2000 });
  });
});

describe("the public API of v1", () => {
  it("exports the v1 helpers and constants, and nothing of rebalance", () => {
    for (const k of ["quoteToBase", "swapFloor", "SWAP_SLIPPAGE_BPS", "closeDue", "nextConfirmRun", "checkConfirmation", "missedClose", "closeConfirmed", "isPairedOpen",
      "PAIR_WINDOW_S", "PAYOUT_SETTLE_BLOCKS", "OFFCHAIN_MARGIN_BLOCKS", "CONFIRM_MAX_BLOCKS", "DENSE_STEP_BLOCKS"]) {
      expect(k in api).toBe(true);
    }
    expect("rebalanceTriggered" in api).toBe(false);
    expect("nextConfirmFrom" in api).toBe(false);
    expect(Object.keys(api.BOUNDS).sort()).toEqual(["close_after_s", "stop_loss_bps", "take_profit_bps", "width_bps"]);
  });
});

describe("shared confirmation and pairing vectors (test/vectors/confirmation.json, for the Rust port)", () => {
  type Cond = Record<string, unknown>;
  const V = JSON.parse(readFileSync(new URL("./vectors/confirmation.json", import.meta.url), "utf8")) as {
    rules: JsonValue; base_state: Cond; conditions: Record<string, Cond>;
    walks: { name: string; obs: [number, string, number][]; expect: { run: { from_block: number; reason: string } | null; decision: unknown }[] }[];
    pairing: { swap_result_ns: string; open_start_ns: string; paired: boolean }[];
  };
  const R = validateRules(V.rules);
  const state = (c: string, block: number, cf: number | null): MarketState => {
    const o = { ...V.base_state, ...V.conditions[c] } as Record<string, unknown>;
    const a = (x: unknown) => { const y = x as Record<string, string>; return { quote: readU128(y["quote"]!), base: readU128(y["base"]!) }; };
    return { ...(o as object), principal: readU128(o["principal"] as string), holdings: a(o["holdings"]), fees: a(o["fees"]), block, confirmFromBlock: cf } as MarketState;
  };
  it("has the thirteen walks and five pairing cases", () => {
    expect(V.walks.length).toBe(13);
    expect(V.pairing.length).toBe(5);
  });
  it.each(V.walks.map((w) => [w.name, w] as const))("replays the walk: %s", (_n, w) => {
    let run: ConfirmRun | null = null;
    w.obs.forEach(([b, c, sf], i) => {
      run = nextConfirmRun(R, state(c, b, null), run, sf);
      const e = w.expect[i]!;
      expect(run === null ? null : { from_block: run.fromBlock, reason: run.reason }).toEqual(e.run);
      expect(evaluate(R, state(c, b, run?.fromBlock ?? null))).toEqual(e.decision);
    });
  });
  it.each(V.pairing.map((p) => [p.swap_result_ns, p.open_start_ns, p] as const))("pairs %s and %s as the vector says", (_a, _b, p) => {
    expect(isPairedOpen(BigInt(p.swap_result_ns), BigInt(p.open_start_ns))).toBe(p.paired);
  });
});
