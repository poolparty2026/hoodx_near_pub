import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BASE, ONE, baseToQuote, priceQ128, quoteToBase } from "../src/price.ts";
import { U128_MAX } from "../src/swap.ts";
import { RulesError } from "../src/errors.ts";

const PRICE_401452 = 92428647068100861400711211280649110949622759379682233681n;
const PRICE_800000 = 18778501584204822221115757967868942162761981817534242746385008477639715637n;

describe("priceQ128 (fixed-point 1.0001^point, gate 3 semantics, EC-R06)", () => {
  it("matches pinned vectors that the Rust contract tests must reproduce", () => {
    expect(BASE).toBe(340316395157630557309720944892511388277n);
    expect(priceQ128(0)).toBe(ONE);
    expect(priceQ128(1)).toBe(340316395157630557309720944892511388277n);
    expect(priceQ128(6932)).toBe(680577094201047317719750879891571936759n);
    // Checked against 400-digit decimals: at or below the true value, within 2.1e-33 relative.
    expect(priceQ128(401_452)).toBe(PRICE_401452);
    expect(priceQ128(800_000)).toBe(PRICE_800000);
  });
  it("stays within 1e-8 relative of floating-point 1.0001^point (float itself drifts at large points)", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 700_000 }), (p) => {
      const exact = Number(priceQ128(p)) / Number(ONE);
      expect(Math.abs(exact / Math.pow(1.0001, p) - 1)).toBeLessThan(1e-8);
    }), { numRuns: 300 });
  });
  it("never decreases with the point, and strictly increases where precision allows", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 799_999 }), (p) => {
      expect(priceQ128(p + 1) > priceQ128(p)).toBe(true);
    }), { numRuns: 300 });
  });
  it.each([800_001, -800_001, 1.5, Number.NaN])("refuses the point %s", (p) => {
    expect(() => priceQ128(p)).toThrow("STATE: point must be an integer within ±800000");
    expect(() => baseToQuote(1n, p, true)).toThrow("STATE: point must be an integer within ±800000");
  });
  it.each([-1, -800_000])("refuses the negative point %i, whose reciprocal would lose precision (re-audit L-2)", (p) => {
    expect(() => priceQ128(p)).toThrow("STATE: priceQ128 takes points >= 0; use priceRatio or baseToQuote below zero");
  });
  it("accepts the exact bounds 0 and 800,000", () => {
    expect(priceQ128(0)).toBe(ONE);
    expect(priceQ128(800_000) > 0n).toBe(true);
  });
});

describe("baseToQuote (EC-R06)", () => {
  it("keeps full precision at very negative effective exponents (L1)", () => {
    // quoteIsX at point 800000 divides by price(800000): reference = floor(10^40 * 2^128 / priceQ128(800000)).
    const ref = ((10n ** 40n) << 128n) / priceQ128(800_000);
    expect(baseToQuote(10n ** 40n, 800_000, true)).toBe(ref);
    expect(ref).toBe(181208n);
  });
  it("converts y to x by dividing by the price, and x to y by multiplying, rounding down", () => {
    // At point 6932, price ≈ 2 y per x.
    expect(baseToQuote(2_000_000n, 6932, true)).toBe(999_981n);
    expect(baseToQuote(1_000_000n, 6932, false)).toBe(2_000_036n);
    expect(baseToQuote(0n, 6932, true)).toBe(0n);
  });
  it.each([
    // [amount, point, quoteIsX, expected]: division path (negative effective exponent).
    // Each expected value is the floor of the exact amount * 1.0001^e, checked with
    // 200-digit decimals; shared with the Rust tests (re-audit L-3).
    [10n ** 24n, 6932, true, 499_990_919_207_187_760_968_835n],
    [10n ** 30n, -400_000, false, 4_256_858_898_639n],
    [10n ** 36n, -800_000, false, 18n],
    [123_456_789n * 10n ** 18n, 1, true, 123_444_444_555_544_445_555_444_455n],
  ] as const)("pins the division path: %s at point %s (quote is x: %s)", (a, p, q, want) => {
    expect(baseToQuote(a, p, q)).toBe(want);
  });
  it("never decreases with the point on either side of zero, in both directions (rules-verifier Info-2)", () => {
    fc.assert(fc.property(fc.integer({ min: -800_000, max: 799_999 }), fc.boolean(), (p, q) => {
      const a = 10n ** 30n;
      // Quote is y: value grows with the point. Quote is x: value shrinks.
      const lo = baseToQuote(a, p, q), hi = baseToQuote(a, p + 1, q);
      expect(q ? hi <= lo : hi >= lo).toBe(true);
    }), { numRuns: 1000 });
  });
  it("refuses negative or non-bigint amounts", () => {
    expect(() => baseToQuote(-1n, 0, true)).toThrow("STATE: amount must be a non-negative bigint");
    expect(() => baseToQuote(5 as never, 0, true)).toThrow(RulesError);
  });
});

describe("quoteToBase (EC-R27)", () => {
  const LIVE = 401_312; // the live USDC/wNEAR point, USDC is token_x
  it.each([
    [1n, 267_847_336_652_921_698n],
    [5_000_000n, 1_339_236_683_264_608_491_424_493n],
    [500_000_000n, 133_923_668_326_460_849_142_449_389n],
  ] as const)("pins %s raw USDC to its wNEAR amount at the live point (shared with the Rust tests)", (a, want) => {
    expect(quoteToBase(a, LIVE, true)).toBe(want);
  });
  it("saturates at u128::MAX, exactly one unit past the largest amount that fits (test L-2)", () => {
    expect(quoteToBase(U128_MAX, LIVE, true)).toBe(U128_MAX);
    expect(quoteToBase(U128_MAX, 800_000, true)).toBe(U128_MAX);
    const p = priceQ128(LIVE);
    // The largest amount whose floor(a * p / 2^128) fits: floor((2^256 - 1) / p).
    const limit = (((U128_MAX + 1n) << 128n) - 1n) / p;
    expect(limit).toBe(1_270_434_013_543_612_506_870n);
    expect(quoteToBase(limit, LIVE, true)).toBe((limit * p) >> 128n);
    expect(quoteToBase(limit, LIVE, true) <= U128_MAX).toBe(true);
    // One more and the raw result passes u128::MAX, so it saturates.
    expect(((limit + 1n) * p) >> 128n > U128_MAX).toBe(true);
    expect(quoteToBase(limit + 1n, LIVE, true)).toBe(U128_MAX);
  });
  it.each([
    // [wNEAR amount, USDC at the live point]: the matching amounts of EC-R27 and u128::MAX.
    [267_847_336_652_921_698n, 0n],
    [1_339_236_683_264_608_491_424_493n, 4_999_999n],
    [133_923_668_326_460_849_142_449_389n, 499_999_999n],
    [U128_MAX, 1_270_434_013_543_612_506_870n],
  ] as const)("pins baseToQuote of %s yocto-wNEAR at the live point (EC-R27)", (w, want) => {
    expect(baseToQuote(w, LIVE, true)).toBe(want);
  });
  it.each([[1n, 0n], [5_000_000n, 4_999_999n], [500_000_000n, 499_999_999n]] as const)("round-trips %s raw USDC to %s", (a, want) => {
    expect(baseToQuote(quoteToBase(a, LIVE, true), LIVE, true)).toBe(want);
  });
  it("round-trips 5 USDC to 4,999,999 (never more than it started with)", () => {
    expect(baseToQuote(quoteToBase(5_000_000n, LIVE, true), LIVE, true)).toBe(4_999_999n);
  });
  it("is the inverse direction of baseToQuote: multiplies when quote is x at a positive point, divides otherwise", () => {
    expect(quoteToBase(1_000_000n, 6932, true)).toBe(2_000_036n); // = baseToQuote(1_000_000, 6932, false)
    expect(quoteToBase(2_000_000n, 6932, false)).toBe(999_981n); // = baseToQuote(2_000_000, 6932, true)
    expect(quoteToBase(10n ** 30n, -800_000, true)).toBe(0n);
    expect(quoteToBase(0n, LIVE, true)).toBe(0n);
  });
  it("equals baseToQuote with the quote side swapped, below saturation (property)", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: U128_MAX }), fc.integer({ min: -800_000, max: 800_000 }), fc.boolean(), (a, p, q) => {
      const ref = baseToQuote(a, p, !q);
      expect(quoteToBase(a, p, q)).toBe(ref > U128_MAX ? U128_MAX : ref);
    }), { numRuns: 2000 });
  });
  it("never gives back more than it started with, and never decreases with the amount, on both paths (properties)", () => {
    const paths = new Set<string>();
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: U128_MAX }), fc.bigInt({ min: 0n, max: U128_MAX }), fc.integer({ min: -800_000, max: 800_000 }), fc.boolean(), (a, b, p, q) => {
      const out = quoteToBase(a, p, q);
      paths.add((q ? p : -p) >= 0 ? "multiply" : "divide");
      if (out < U128_MAX) expect(baseToQuote(out, p, q) <= a).toBe(true);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      expect(quoteToBase(lo, p, q) <= quoteToBase(hi, p, q)).toBe(true);
    }), { numRuns: 3000 });
    expect(paths).toEqual(new Set(["multiply", "divide"]));
  });
  it("is within 2.2e-33 relative plus one unit of the exact rational floor, below it on the multiply path and at or above it on the division path (test M-1)", () => {
    // Exact: a * 10001^e / 10000^e, with bigints, independent of priceQ128.
    const exactFloor = (a: bigint, e: number) => (e >= 0 ? (a * 10001n ** BigInt(e)) / 10000n ** BigInt(e) : (a * 10000n ** BigInt(-e)) / 10001n ** BigInt(-e));
    const tol = (x: bigint) => (x * 22n) / 10n ** 34n + 1n;
    let maxAbove = 0n;
    fc.assert(fc.property(fc.oneof(fc.bigInt({ min: 0n, max: 10n ** 24n }), fc.bigInt({ min: 0n, max: U128_MAX })), fc.integer({ min: -4000, max: 4000 }), fc.boolean(), (a, p, q) => {
      const e = q ? p : -p;
      const exact = exactFloor(a, e);
      const got = quoteToBase(a, p, q);
      if (exact >= U128_MAX) { expect(got).toBe(U128_MAX); return; }
      if (e >= 0) { expect(got <= exact).toBe(true); expect(exact - got <= tol(exact)).toBe(true); }
      else { expect(got >= exact).toBe(true); expect(got - exact <= tol(got)).toBe(true); if (got - exact > maxAbove) maxAbove = got - exact; }
    }), { numRuns: 1500 });
    // The division path does come out above the exact floor at large amounts (section 4).
    expect(maxAbove > 0n).toBe(true);
  });
  it("refuses bad amounts and points like baseToQuote", () => {
    expect(() => quoteToBase(-1n, 0, true)).toThrow("STATE: amount must be a non-negative bigint");
    expect(() => quoteToBase(5 as never, 0, true)).toThrow("STATE: amount must be a non-negative bigint");
    expect(() => quoteToBase(U128_MAX + 1n, 0, true)).toThrow("STATE: amount must fit in u128");
    expect(() => quoteToBase(1n, 800_001, true)).toThrow("STATE: point must be an integer within ±800000");
  });
});
