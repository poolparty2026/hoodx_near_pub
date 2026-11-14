import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MAX_JOIN_UNITS, exit, initialJoin, join, parseAmount, pct, shareBps, usdc } from "../src/lib/journey/join.ts";

describe("join: amount validation", () => {
  it("at the limit is accepted, one cent over is refused with the exact text", () => {
    expect(parseAmount("500")).toEqual({ ok: true, units: MAX_JOIN_UNITS });
    expect(parseAmount("500.00")).toEqual({ ok: true, units: MAX_JOIN_UNITS });
    expect(parseAmount("500.01")).toEqual({ ok: false, error: "The simulation accepts at most 500 USDC, the recorded maximum principal of this strategy." });
  });
  it("the smallest amount, 0.01, is accepted; zero and 0.00 are refused", () => {
    expect(parseAmount("0.01")).toEqual({ ok: true, units: 10_000n });
    expect(parseAmount("0")).toEqual({ ok: false, error: "The amount must be more than zero." });
    expect(parseAmount("0.00")).toEqual({ ok: false, error: "The amount must be more than zero." });
  });
  it("2 decimals ok, 3 refused", () => {
    expect(parseAmount("25.5")).toEqual({ ok: true, units: 25_500_000n });
    expect(parseAmount("25.50")).toEqual({ ok: true, units: 25_500_000n });
    expect(parseAmount("25.501")).toEqual({ ok: false, error: "Use at most 2 decimals." });
  });
  it.each(["", "abc", "-5", "+5", "1e3", "1,5", " ", "5 USDC", "0x10", "."])("refuses %j", (t) => expect(parseAmount(t).ok).toBe(false));
});

describe("join: share arithmetic", () => {
  it("amount / (principal + amount), rounded down to 0.01 percent", () => {
    expect(shareBps(500_000_000n, 500_000_000n)).toBe(5000n); // 50.00%
    expect(pct(5000n)).toBe("50.00%");
    expect(shareBps(100_000_000n, 500_000_000n)).toBe(1666n); // 16.66% (1/6, rounded down)
    expect(pct(1666n)).toBe("16.66%");
    expect(pct(5n)).toBe("0.05%");
    expect(shareBps(10_000n, 500_000_000n)).toBe(0n);
  });
  it("property: share is between 0 and 5000 bps for any allowed amount and never exceeds the exact ratio", () => {
    fc.assert(fc.property(fc.bigInt({ min: 10_000n, max: MAX_JOIN_UNITS }), (a) => {
      const s = shareBps(a, 500_000_000n);
      return s >= 0n && s <= 5000n && s * (500_000_000n + a) <= a * 10_000n;
    }));
  });
  it("usdc formats two decimals", () => { expect(usdc(25_500_000n)).toBe("25.50 USDC"); expect(usdc(10_000n)).toBe("0.01 USDC"); });
});

describe("join and exit state", () => {
  it("join sets the position; a second join changes nothing; exit returns exactly the amount and clears it", () => {
    const s1 = join(initialJoin, 100_000_000n);
    expect(s1.position).toEqual({ amount: 100_000_000n, shareBps: 1666n });
    expect(join(s1, 1n)).toBe(s1);
    const { state, returned } = exit(s1);
    expect(returned).toBe(100_000_000n);
    expect(state).toEqual({ position: null, exited: true });
    expect(exit(state)).toEqual({ state, returned: 0n }); // nothing to exit twice
  });
});
