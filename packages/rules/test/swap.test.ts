import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { priceRatio, swapForRange, U128_MAX, type PoolAmounts } from "../src/swap.ts";
import { MAX_POINT, MIN_POINT } from "../src/evaluate.ts";
import { priceQ128 } from "../src/price.ts";

interface Vector {
  holdings: { x: string; y: string };
  need: { x: string; y: string };
  point: number;
  result: { tokenIn: "x" | "y"; amountIn: string } | null;
}
// Shared with the Rust tests (EC-R17). The exact values come from this library;
// test/vectors/check_swap.py (run in CI, no shared code) confirms each is within
// one unit plus 1e-32 relative of the answer at the true price 1.0001^point.
const VECTORS = JSON.parse(readFileSync(new URL("./vectors/swap.json", import.meta.url), "utf8")) as Vector[];
const amounts = (o: { x: string; y: string }): PoolAmounts => ({ x: BigInt(o.x), y: BigInt(o.y) });
const u128 = fc.bigInt({ min: 0n, max: U128_MAX });
const point = fc.integer({ min: MIN_POINT, max: MAX_POINT });
const EXTREMES = [0, 6932, -401_452, MAX_POINT, MIN_POINT];

describe("swapForRange (D27)", () => {
  it.each(VECTORS.map((v) => [`${v.holdings.x},${v.holdings.y} need ${v.need.x}:${v.need.y} at ${v.point}`, v] as const))(
    "matches shared vector %s (EC-R16, EC-R17)", (_n, v) => {
      const s = swapForRange(amounts(v.holdings), amounts(v.need), v.point);
      expect(s === null ? null : { tokenIn: s.tokenIn, amountIn: `${s.amountIn}` }).toEqual(v.result);
    });

  it("swaps nothing when holdings already match the ratio (EC-R16)", () => {
    expect(swapForRange({ x: 100n, y: 200n }, { x: 1n, y: 2n }, 0)).toBeNull();
    expect(swapForRange({ x: 0n, y: 0n }, { x: 1n, y: 1n }, 0)).toBeNull();
  });
  it("swaps half at price 1 to reach 1:1, in either direction (EC-R16)", () => {
    expect(swapForRange({ x: 250n, y: 0n }, { x: 5n, y: 5n }, 0)).toEqual({ tokenIn: "x", amountIn: 125n });
    expect(swapForRange({ x: 0n, y: 250n }, { x: 5n, y: 5n }, 0)).toEqual({ tokenIn: "y", amountIn: 125n });
  });
  it("uses the price at the point: 6932 is about 2 y per x (EC-R16)", () => {
    // Exact rational answer 600e6 / (2 + p) = 149,998,637.87 (Python fractions).
    expect(swapForRange({ x: 300_000_000n, y: 0n }, { x: 1n, y: 2n }, 6932)).toEqual({ tokenIn: "x", amountIn: 149_998_637n });
  });
  it("swaps 1 unit at the rounding edge and nothing just below it (EC-R16)", () => {
    expect(swapForRange({ x: 2n, y: 0n }, { x: 1n, y: 1n }, 0)).toEqual({ tokenIn: "x", amountIn: 1n });
    expect(swapForRange({ x: 1n, y: 0n }, { x: 1n, y: 1n }, 0)).toBeNull();
    expect(swapForRange({ x: 0n, y: 2n }, { x: 1n, y: 1n }, 0)).toEqual({ tokenIn: "y", amountIn: 1n });
    expect(swapForRange({ x: 0n, y: 1n }, { x: 1n, y: 1n }, 0)).toBeNull();
  });
  it.each(EXTREMES)("swaps exactly everything of the other token when need is one-sided, at point %i (EC-R16)", (p) => {
    expect(swapForRange({ x: 7n, y: 3n }, { x: 0n, y: 1n }, p)).toEqual({ tokenIn: "x", amountIn: 7n });
    expect(swapForRange({ x: 3n, y: 9n }, { x: 1n, y: 0n }, p)).toEqual({ tokenIn: "y", amountIn: 9n });
    expect(swapForRange({ x: U128_MAX, y: 0n }, { x: 0n, y: U128_MAX }, p)).toEqual({ tokenIn: "x", amountIn: U128_MAX });
    expect(swapForRange({ x: 0n, y: U128_MAX }, { x: U128_MAX, y: 0n }, p)).toEqual({ tokenIn: "y", amountIn: U128_MAX });
    expect(swapForRange({ x: 0n, y: 5n }, { x: 0n, y: 1n }, p)).toBeNull();
  });
  it("accepts u128::MAX and refuses u128::MAX + 1 in every field (EC-R16)", () => {
    expect(swapForRange({ x: U128_MAX, y: 0n }, { x: 1n, y: 1n }, 0)).toEqual({ tokenIn: "x", amountIn: U128_MAX / 2n });
    const over = U128_MAX + 1n;
    expect(() => swapForRange({ x: over, y: 0n }, { x: 1n, y: 1n }, 0)).toThrow("STATE: holdings.x must fit in u128");
    expect(() => swapForRange({ x: 0n, y: over }, { x: 1n, y: 1n }, 0)).toThrow("STATE: holdings.y must fit in u128");
    expect(() => swapForRange({ x: 1n, y: 0n }, { x: over, y: 1n }, 0)).toThrow("STATE: need.x must fit in u128");
    expect(() => swapForRange({ x: 1n, y: 0n }, { x: 1n, y: over }, 0)).toThrow("STATE: need.y must fit in u128");
  });
  it("refuses need (0, 0) whatever the holdings (EC-R16)", () => {
    for (const h of [{ x: 1n, y: 0n }, { x: 0n, y: 5n }, { x: 0n, y: 0n }, { x: 3n, y: 3n }]) {
      expect(() => swapForRange(h, { x: 0n, y: 0n }, 0)).toThrow("STATE: need must not be zero in both tokens");
    }
  });
  it.each([
    ["negative holdings.x", { x: -1n, y: 0n }, { x: 1n, y: 1n }, "STATE: holdings.x must be a non-negative bigint"],
    ["negative holdings.y", { x: 0n, y: -1n }, { x: 1n, y: 1n }, "STATE: holdings.y must be a non-negative bigint"],
    ["negative need.x", { x: 1n, y: 0n }, { x: -1n, y: 1n }, "STATE: need.x must be a non-negative bigint"],
    ["number need.x", { x: 1n, y: 0n }, { x: 1, y: 1n }, "STATE: need.x must be a non-negative bigint"],
    ["number need.y", { x: 1n, y: 1n }, { x: 1n, y: 1 }, "STATE: need.y must be a non-negative bigint"],
    ["null holdings", null, { x: 1n, y: 1n }, "STATE: holdings must be an object"],
    ["number holdings", 5, { x: 1n, y: 1n }, "STATE: holdings must be an object"],
    ["string need", { x: 1n, y: 1n }, "x", "STATE: need must be an object"],
  ] as const)("refuses %s with an exact message (EC-R16)", (_n, h, n, msg) => {
    expect(() => swapForRange(h as never, n as never, 0)).toThrow(msg);
  });
  it.each([MAX_POINT + 1, MIN_POINT - 1, 1.5, Number.NaN])("refuses point %s (EC-R16)", (p) => {
    expect(() => swapForRange({ x: 2n, y: 0n }, { x: 1n, y: 1n }, p)).toThrow("STATE: point must be an integer within ±800000");
  });

  it("never overshoots, never exceeds holdings, and leaves at most one rounding unit, up to u128 (EC-R16)", () => {
    fc.assert(fc.property(u128, u128, u128, u128, point, (x, y, nx, ny, p) => {
      fc.pre(nx + ny > 0n);
      const { a, b } = priceRatio(p);
      const before = x * ny - y * nx;
      const s = swapForRange({ x, y }, { x: nx, y: ny }, p);
      if (before === 0n) { expect(s).toBeNull(); return; }
      const d = s?.amountIn ?? 0n;
      if (s) {
        expect(d > 0n && d <= (s.tokenIn === "x" ? x : y)).toBe(true);
        expect(s.tokenIn).toBe(before > 0n ? "x" : "y");
      }
      // In exact terms, the remaining excess times b is cross*b - d*denom (x in excess)
      // or -cross*a - d*denom (y in excess). It must stay >= 0 (no overshoot) and be
      // below one more unit of swap, so `d` is the largest swap that doesn't overshoot.
      const denom = ny * b + nx * a;
      const left = before > 0n ? before * b - d * denom : -before * a - d * denom;
      expect(left >= 0n && left < denom).toBe(true);
    }), { numRuns: 3000 });
  });
  it("takes the price ratio from priceQ128(|point|) exactly, on both sides of zero (EC-R17)", () => {
    fc.assert(fc.property(point, (p) => {
      const one = 1n << 128n;
      expect(priceRatio(p)).toEqual(p >= 0 ? { a: priceQ128(p), b: one } : { a: one, b: priceQ128(-p) });
    }), { numRuns: 500 });
    expect(priceRatio(-401_452)).toEqual({ a: 1n << 128n, b: 92428647068100861400711211280649110949622759379682233681n });
  });
  it("is unchanged when need is scaled, and depends on need only through its ratio (EC-R16)", () => {
    fc.assert(fc.property(u128, u128, fc.bigInt({ min: 0n, max: 2n ** 60n }), fc.bigInt({ min: 0n, max: 2n ** 60n }), fc.bigInt({ min: 1n, max: 2n ** 60n }), point,
      (x, y, nx, ny, k, p) => {
        fc.pre(nx + ny > 0n);
        expect(swapForRange({ x, y }, { x: nx * k, y: ny * k }, p)).toEqual(swapForRange({ x, y }, { x: nx, y: ny }, p));
      }), { numRuns: 1000 });
  });
  it("swaps everything of the other token whenever need is one-sided (EC-R16)", () => {
    fc.assert(fc.property(u128, u128, fc.bigInt({ min: 1n, max: U128_MAX }), point, fc.boolean(), (x, y, n, p, onlyY) => {
      const s = swapForRange({ x, y }, onlyY ? { x: 0n, y: n } : { x: n, y: 0n }, p);
      const all = onlyY ? x : y;
      expect(s).toEqual(all === 0n ? null : { tokenIn: onlyY ? "x" : "y", amountIn: all });
    }), { numRuns: 1000 });
  });
});
