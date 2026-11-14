import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { feesEarned, marketHoldings, positionPieces, tokenHoldings } from "../src/holdings.ts";

const MAX = (1n << 128n) - 1n;
const r = (wallet: bigint, internal: bigint, platformOwed: bigint, positions: bigint) => ({ wallet, internal, platformOwed, positions });

// EC-R34: the holdings formula, one copy for the agent and the page.
describe("holdings (EC-R34)", () => {
  it("is spendable plus positions, where spendable is clamped at 0 BEFORE the positions are added", () => {
    expect(tokenHoldings(r(100n, 50n, 30n, 7n))).toBe(127n);
    expect(tokenHoldings(r(100n, 0n, 100n, 7n))).toBe(7n); // owed equals the balance: spendable 0
    expect(tokenHoldings(r(100n, 0n, 101n, 7n))).toBe(7n); // owed above the balance: clamped, positions untouched
    expect(tokenHoldings(r(0n, 0n, 0n, 0n))).toBe(0n);
    expect(tokenHoldings(r(0n, 0n, 5n, 9n))).toBe(9n);
  });
  it("sums quote and base independently", () => {
    expect(marketHoldings(r(10n, 1n, 2n, 3n), r(20n, 0n, 0n, 4n))).toEqual({ quote: 12n, base: 24n });
  });
  it("refuses inputs outside u128 and a sum above it, at the limit and one over", () => {
    expect(tokenHoldings(r(MAX, 0n, 0n, 0n))).toBe(MAX);
    expect(() => tokenHoldings(r(MAX, 0n, 0n, 1n))).toThrow(/holdings exceed/);
    expect(tokenHoldings(r(MAX, 1n, 1n, 0n))).toBe(MAX);
    expect(() => tokenHoldings(r(MAX + 1n, 0n, 0n, 0n))).toThrow(/wallet must be a u128/);
    expect(() => tokenHoldings(r(-1n, 0n, 0n, 0n))).toThrow(/wallet must be a u128/);
    expect(() => tokenHoldings(r(0n, 0n, MAX + 1n, 0n))).toThrow(/platformOwed must be a u128/);
    expect(() => tokenHoldings(r(0n, 0n, 0n, MAX + 1n))).toThrow(/positions must be a u128/);
    expect(() => tokenHoldings(r(1 as unknown as bigint, 0n, 0n, 0n))).toThrow(/STATE|u128/);
  });
  it("maps the position's x and y to quote and base by the pool's token order", () => {
    expect(positionPieces(true, [5n, 6n], [1n, 2n])).toEqual({ positions: { quote: 5n, base: 6n }, unclaimedFees: { quote: 1n, base: 2n } });
    expect(positionPieces(false, [5n, 6n], [1n, 2n])).toEqual({ positions: { quote: 6n, base: 5n }, unclaimedFees: { quote: 2n, base: 1n } });
    expect(() => positionPieces(true, [-1n, 0n], [0n, 0n])).toThrow(/STATE|u128/);
  });
  it("fees are what was collected plus what is unclaimed", () => {
    expect(feesEarned({ quote: 3n, base: 4n }, { quote: 1n, base: 2n })).toEqual({ quote: 4n, base: 6n });
    expect(() => feesEarned({ quote: MAX, base: 0n }, { quote: 1n, base: 0n })).toThrow(/fees exceed/);
  });
  it("property: holdings never fall below the positions, nor exceed wallet + internal + positions", () => {
    const a = fc.bigInt({ min: 0n, max: MAX / 4n });
    fc.assert(fc.property(a, a, a, a, (w, i, o, p) => {
      const h = tokenHoldings(r(w, i, o, p));
      return h >= p && h <= w + i + p && (o >= w + i ? h === p : h === w + i - o + p);
    }), { numRuns: 300 });
  });
});
