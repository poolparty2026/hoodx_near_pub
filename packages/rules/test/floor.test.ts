import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { swapFloor, SWAP_SLIPPAGE_BPS, type SwapFloorInput } from "../src/floor.ts";
import { baseToQuote, quoteToBase } from "../src/price.ts";
import { U128_MAX } from "../src/swap.ts";

// Shared with the Rust tests; checked independently by test/vectors/check_swap_floor.py (run in CI).
const V = (JSON.parse(readFileSync(new URL("./vectors/swap_floor.json", import.meta.url), "utf8")) as {
  cases: { name: string; quote_out: string; amount_in: string; input_is_quote: boolean; ref_point: number; quote_is_x: boolean; fee_tier: number; slip_bps: number; min_out: string; larger: string }[];
}).cases;
const input = (c: (typeof V)[number]): SwapFloorInput => ({
  quoteOut: BigInt(c.quote_out), amountIn: BigInt(c.amount_in), inputIsQuote: c.input_is_quote,
  refPoint: c.ref_point, quoteIsX: c.quote_is_x, feeTier: c.fee_tier, slipBps: c.slip_bps,
});
const terms = (i: SwapFloorInput) => {
  const raw = i.inputIsQuote ? quoteToBase(i.amountIn, i.refPoint, i.quoteIsX) : baseToQuote(i.amountIn, i.refPoint, i.quoteIsX);
  const ref = raw > U128_MAX ? U128_MAX : raw;
  return { q: (i.quoteOut * BigInt(10_000 - i.slipBps)) / 10_000n, r: (ref * BigInt(10_000 - i.feeTier / 100 - i.slipBps)) / 10_000n };
};

// Extra vectors from a fixed seed across the whole point range; shared with the Rust tests and checked
// independently by test/vectors/check_swap_floor.py (run in CI).
const W = (JSON.parse(readFileSync(new URL("./vectors/swap_floor_wide.json", import.meta.url), "utf8")) as { cases: typeof V }).cases;

describe("swapFloor, wide shared vectors (EC-R27)", () => {
  it("has the vectors the Rust tests expect", () => {
    expect(W.length).toBe(28);
    expect(W.some((c) => Math.abs(c.ref_point) === 786_431)).toBe(true);
  });
  it.each(W.map((c) => [c.name, c] as const))("matches %s", (_n, c) => {
    expect(swapFloor(input(c))).toBe(BigInt(c.min_out));
  });
});

describe("swapFloor (EC-R27)", () => {
  it("has every required kind of vector: quote-based larger, reference-based larger, a tie, slip 11 and 100 with fee_bps 1, 0 and u128::MAX", () => {
    expect(V.length).toBe(21);
    expect(new Set(V.map((c) => c.larger))).toEqual(new Set(["quote", "reference", "tie"]));
    for (const s of SWAP_SLIPPAGE_BPS) expect(V.some((c) => c.slip_bps === s && c.fee_tier === 100)).toBe(true);
    expect(V.some((c) => c.amount_in === String(U128_MAX))).toBe(true);
    expect(V.some((c) => c.quote_out === String(U128_MAX))).toBe(true);
    expect(V.some((c) => !c.input_is_quote)).toBe(true);
  });
  it.each(V.map((c) => [c.name, c] as const))("matches the shared vector: %s", (_n, c) => {
    expect(swapFloor(input(c))).toBe(BigInt(c.min_out));
  });
  it("pins the 5 USDC swap at the live point: the honest quote gives the quote term, a sandwiched quote the reference term", () => {
    const i = { quoteOut: 1_339_236_683_264_608_491_424_493n, amountIn: 5_000_000n, inputIsQuote: true, refPoint: 401_312, quoteIsX: true, feeTier: 100, slipBps: 11 };
    expect(swapFloor(i)).toBe(1_337_763_522_913_017_422_083_926n);
    // A quote 2% low can't pull the minimum below the reference term.
    expect(swapFloor({ ...i, quoteOut: 0n })).toBe(1_337_629_599_244_690_961_234_783n);
  });
  it("uses fee_bps = fee_tier / 100: a higher tier lowers only the reference term", () => {
    const i = { quoteOut: 0n, amountIn: 5_000_000n, inputIsQuote: true, refPoint: 401_312, quoteIsX: true, feeTier: 100, slipBps: 50 };
    const ref = quoteToBase(5_000_000n, 401_312, true);
    expect(swapFloor(i)).toBe((ref * (10_000n - 1n - 50n)) / 10_000n);
    expect(swapFloor({ ...i, feeTier: 2000 })).toBe((ref * (10_000n - 20n - 50n)) / 10_000n);
    expect(swapFloor({ ...i, feeTier: 10000 })).toBe((ref * (10_000n - 100n - 50n)) / 10_000n);
  });
  it("is the larger term, at least each term and at most u128::MAX (property)", () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 0n, max: U128_MAX }), fc.bigInt({ min: 0n, max: U128_MAX }), fc.boolean(), fc.integer({ min: -800_000, max: 800_000 }), fc.boolean(),
      fc.constantFrom(100, 400, 1000, 2000, 10000), fc.integer({ min: 11, max: 100 }),
      (quoteOut, amountIn, inputIsQuote, refPoint, quoteIsX, feeTier, slipBps) => {
        const i = { quoteOut, amountIn, inputIsQuote, refPoint, quoteIsX, feeTier, slipBps };
        const f = swapFloor(i);
        const { q, r } = terms(i);
        expect(f >= q && f >= r).toBe(true);
        expect(f === q || f === r).toBe(true);
        expect(f <= U128_MAX).toBe(true);
        // Never above the quote itself: a swap paying the full quote always passes.
        expect(f <= quoteOut || f === r).toBe(true);
      }), { numRuns: 2000 });
  });
  it("never decreases with the quote or the amount in (property)", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.integer({ min: 0, max: 600_000 }), (a, b, c, p) => {
      const i = { quoteOut: a, amountIn: c, inputIsQuote: true, refPoint: p, quoteIsX: true, feeTier: 100, slipBps: 11 };
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      expect(swapFloor({ ...i, quoteOut: lo }) <= swapFloor({ ...i, quoteOut: hi })).toBe(true);
      expect(swapFloor({ ...i, amountIn: lo }) <= swapFloor({ ...i, amountIn: hi })).toBe(true);
    }), { numRuns: 1000 });
  });
  const ok = { quoteOut: 1n, amountIn: 1n, inputIsQuote: true, refPoint: 0, quoteIsX: true, feeTier: 100, slipBps: 11 };
  it.each([
    ["slip 10, one below the bound", { slipBps: 10 }, "slipBps must be an integer between 11 and 100"],
    ["slip 101, one above the bound", { slipBps: 101 }, "slipBps must be an integer between 11 and 100"],
    ["fractional slip", { slipBps: 11.5 }, "slipBps must be an integer between 11 and 100"],
    ["unknown fee tier", { feeTier: 300 }, "feeTier must be a DCL fee tier"],
    ["negative quote", { quoteOut: -1n }, "quoteOut must be a u128 bigint"],
    ["quote above u128", { quoteOut: U128_MAX + 1n }, "quoteOut must be a u128 bigint"],
    ["amount above u128", { amountIn: U128_MAX + 1n }, "amountIn must be a u128 bigint"],
    ["number amount", { amountIn: 1 }, "amountIn must be a u128 bigint"],
    ["non-boolean direction", { inputIsQuote: 1 }, "inputIsQuote and quoteIsX must be booleans"],
    ["point out of range", { refPoint: 800_001 }, "point must be an integer within ±800000"],
  ] as const)("refuses %s", (_n, over, msg) => {
    expect(() => swapFloor({ ...ok, ...over } as never)).toThrow(`STATE: ${msg}`);
  });
  it("accepts the slip bounds exactly and refuses a null input", () => {
    expect(() => swapFloor({ ...ok, slipBps: 11 })).not.toThrow();
    expect(() => swapFloor({ ...ok, slipBps: 100 })).not.toThrow();
    expect(() => swapFloor(null as never)).toThrow("STATE: swap floor input must be an object");
  });
});
