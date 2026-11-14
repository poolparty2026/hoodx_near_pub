import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nsToS, readAction, readU128, readU64, withinRulesText, U64_MAX } from "../src/read.ts";
import { RulesError } from "../src/errors.ts";
import { U128_MAX } from "../src/swap.ts";
import { evaluate, targetRange, type MarketState } from "../src/evaluate.ts";
import { strictParse } from "../src/json.ts";
import { rules } from "./fixtures.ts";
import { readFileSync } from "node:fs";

const AMOUNTS = (JSON.parse(readFileSync(new URL("./vectors/amounts.json", import.meta.url), "utf8")) as
  { cases: { fn: string; input: string; result: { value?: string; error?: string } }[] }).cases;

const R = rules();
const base: MarketState = {
  nowS: 10_000, startedAtS: 1_000, point: -400, valuationPoint: -400, block: 50_000, confirmFromBlock: null, position: null,
  closedBy: null, principal: 250_000_000n, holdings: { quote: 250_000_000n, base: 0n }, fees: { quote: 0n, base: 0n },
};

describe("readAction and withinRulesText (EC-R25)", () => {
  it("accepts a plain-integer action and judges it", () => {
    expect(withinRulesText(R, base, '{"kind":"open","left":-800,"right":0}')).toEqual({ ok: true });
    expect(readAction('{"kind":"hold"}')).toEqual({ kind: "hold" });
  });
  it.each([
    ['{"kind":"open","left":-800,"right":-0}', "JSON_NUMBER: -0 is not allowed at offset 35"],
    ['{"kind":"open","left":-800,"right":1e2}', "JSON_NUMBER: only integers are allowed at offset 35"],
    ['{"kind":"open","left":-800,"right":0,"right":0}', 'JSON_DUPLICATE_KEY: duplicate key "right" at offset 44'],
    ['{"kind":"open","left":-800,"right":0', "JSON_SYNTAX: expected ',' or '}' at offset 36"],
  ])("marks text %s unreadable with the parser's reason, where JSON.parse would accept some", (text, reason) => {
    expect(withinRulesText(R, base, text)).toEqual({ ok: false, unreadable: true, reason });
  });
  it("marks a non-string unreadable rather than throwing", () => {
    expect(withinRulesText(R, base, 5 as never)).toEqual({ ok: false, unreadable: true, reason: "JSON_SYNTAX: input must be a string" });
  });
  it("keeps a real rules refusal distinct from unreadable text (security re-audit of 2276e67, L-2)", () => {
    const r = withinRulesText(R, base, '{"kind":"open","left":-800,"right":40}');
    expect(r).toEqual({ ok: false, reason: "range isn't the rules' target range at the observed point" });
    expect("unreadable" in r).toBe(false);
  });
  it("checks the state before the text, so an invalid state throws whatever the text is (rules-verifier L-3)", () => {
    const bad = { ...base, principal: 1 as never };
    expect(() => withinRulesText(R, bad, "not json")).toThrow("STATE: principal must be a non-negative bigint");
    expect(() => withinRulesText(R, bad, '{"kind":"hold"}')).toThrow("STATE: principal must be a non-negative bigint");
  });
  it("judges evaluate's own decisions the same after a round trip through text (rules-verifier L-4)", () => {
    fc.assert(fc.property(fc.integer({ min: -790_000, max: 790_000 }), fc.boolean(), (p, hasPos) => {
      const t = targetRange(R, p);
      const s: MarketState = { ...base, point: p, valuationPoint: p, position: hasPos && t ? { left: t.left - 5000, right: t.left - 4000 } : null };
      const d = evaluate(R, s);
      expect(withinRulesText(R, s, JSON.stringify(d))).toEqual({ ok: true });
    }), { numRuns: 2000 });
  });
});

describe("strictParse refuses text a Rust String can't hold (EC-R25)", () => {
  it.each([
    ['{"kind":"\\ud800"}', "JSON_SYNTAX: lone surrogate escape in string at offset 16"],
    ['{"kind":"\\udc00x"}', "JSON_SYNTAX: lone surrogate escape in string at offset 17"],
    ['{"kind":"\ud800"}', "JSON_SYNTAX: input is not well-formed UTF-16 (lone surrogate)"],
    // A lone low surrogate right after a valid pair (test re-audit of 2276e67, L-1).
    ['{"kind":"\\ud800\\udc00\\udc00"}', "JSON_SYNTAX: lone surrogate escape in string at offset 28"],
    ['{"kind":"\ud800\udc00\udc00"}', "JSON_SYNTAX: input is not well-formed UTF-16 (lone surrogate)"],
  ])("refuses %j", (text, msg) => {
    expect(() => strictParse(text)).toThrow(msg);
  });
  it("accepts a proper surrogate pair, escaped or not", () => {
    expect(strictParse('{"k":"\\ud83d\\ude00"}')).toEqual({ k: "\u{1F600}" });
    expect(strictParse('{"k":"\u{1F600}"}')).toEqual({ k: "\u{1F600}" });
  });
});

describe("readU128 (EC-R25)", () => {
  it.each(["0", "1", "250000000", "340282366920938463463374607431768211455"])("reads %s", (t) => {
    expect(readU128(t)).toBe(BigInt(t));
  });
  it.each(["", " 1", "1 ", "0x10", "0b1", "+5", "-1", "007", "1.0", "1e2", "1".repeat(40)])(
    "refuses %j by its format, which BigInt() or a Rust parse would read differently", (t) => {
      expect(() => readU128(t)).toThrow("STATE: value must be a decimal u128 without sign, spaces or leading zeros");
    });
  it("refuses 2^128 by its range (test re-audit of 2276e67, L-2)", () => {
    expect(() => readU128("340282366920938463463374607431768211456")).toThrow("STATE: value must fit in u128");
  });
  it("refuses a non-string", () => {
    expect(() => readU128(5 as never)).toThrow("STATE: value must be a decimal u128 without sign, spaces or leading zeros");
  });
});

describe("readU64 and nsToS for record timestamps (EC-R25, rules-verifier M-2)", () => {
  it("reads u64 decimals up to the limit and refuses one more", () => {
    expect(readU64("18446744073709551615")).toBe(U64_MAX);
    expect(() => readU64("18446744073709551616")).toThrow("STATE: value must fit in u64");
    expect(() => readU64("184467440737095516150")).toThrow("STATE: value must be a decimal u64 without sign, spaces or leading zeros");
    expect(() => readU64("01")).toThrow("STATE: value must be a decimal u64 without sign, spaces or leading zeros");
  });
  it("converts nanoseconds to whole seconds by floor, at the boundaries", () => {
    expect(nsToS(0n)).toBe(0);
    expect(nsToS(999_999_999n)).toBe(0);
    expect(nsToS(1_000_000_000n)).toBe(1);
    expect(nsToS(1_762_400_000_999_999_999n)).toBe(1_762_400_000);
    expect(nsToS(U64_MAX)).toBe(18_446_744_073);
  });
  it.each([-1n, U64_MAX + 1n, 5 as never])("refuses %s", (v) => {
    expect(() => nsToS(v as bigint)).toThrow("STATE: timestamp must be a u64 of nanoseconds");
  });
});

describe("shared amount and timestamp vectors (EC-R25)", () => {
  it("has all the shared amount vectors", () => { expect(AMOUNTS.length).toBe(52); });
  it.each(AMOUNTS.map((c) => [c.fn, c.input, c] as const))("%s(%j) matches the vector", (_f, _i, c) => {
    let got: { value?: string; error?: string };
    try {
      if (!["u128", "u64", "ns_to_s"].includes(c.fn)) throw new Error(`unknown vector fn ${c.fn}`);
      const v = c.fn === "u128" ? readU128(c.input) : c.fn === "u64" ? readU64(c.input) : nsToS(readU64(c.input));
      got = { value: String(v) };
    } catch (e) { got = { error: (e as Error).message }; }
    expect(got).toEqual(c.result);
  });
});

describe("properties of the record readers (EC-R25, test re-audit of 20e4ceb, Low 6)", () => {
  it("read back every value they would write, for u128 and u64", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: U128_MAX }), (x) => { expect(readU128(String(x))).toBe(x); }), { numRuns: 2000 });
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: U64_MAX }), (x) => { expect(readU64(String(x))).toBe(x); }), { numRuns: 2000 });
  });
  it("refuse every string that isn't a plain decimal within range, with a RulesError", () => {
    // Mixed sources: near-plain decimals, any unit strings, and digit-heavy strings (rules-verifier, re-audit of 520b106).
    const near = fc.stringMatching(/^[+ 0-9\n\t-]{0,42}$/);
    fc.assert(fc.property(fc.oneof(near, fc.string({ maxLength: 45, unit: "grapheme" }), fc.string({ maxLength: 45 })), (t) => {
      const plain = /^(0|[1-9][0-9]*)$/.test(t);
      for (const [read, max] of [[readU128, U128_MAX], [readU64, U64_MAX]] as const) {
        if (plain && BigInt(t) <= max) expect(read(t)).toBe(BigInt(t));
        else {
          expect(() => read(t)).toThrow(RulesError);
          // The right class: range for a plain decimal above the maximum, format otherwise (test re-audit of 520b106, L-4).
          const cls = plain && t.length <= String(max).length ? /value must fit in/ : /value must be a decimal/;
          expect(() => read(t)).toThrow(cls);
        }
      }
    }), { numRuns: 5000 });
  });
  it("convert nanoseconds by floor at every value", () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: U64_MAX }), (n) => {
      const s = BigInt(nsToS(n));
      expect(s * 1_000_000_000n <= n && n < (s + 1n) * 1_000_000_000n).toBe(true);
    }), { numRuns: 5000 });
  });
});
