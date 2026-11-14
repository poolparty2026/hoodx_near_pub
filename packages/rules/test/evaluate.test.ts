import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  evaluate, withinRules, requiredAction, targetRange, closeCondition, valueInQuote, nextConfirmRun, checkConfirmation, confirmGrid, gridPoint, MAX_WINDOW_START, missedClose, closeConfirmed, MIN_POINT, MAX_POINT,
  type Decision, type MarketState, type ConfirmRun, type Sample, type CloseReason, type ConfirmationInput, type MissedCloseLimits, type AgentLock, type HeightState, closeDue,
} from "../src/evaluate.ts";
import { PAYOUT_SETTLE_BLOCKS, OFFCHAIN_MARGIN_BLOCKS, CONFIRM_MAX_BLOCKS, DENSE_STEP_BLOCKS, AGENT_OBSERVE_INTERVAL_S, MISSED_CLOSE_GRACE_S } from "../src/constants.ts";
import { rules, POOL_2000, WNEAR, USDC } from "./fixtures.ts";
import { parsePoolId } from "../src/schema.ts";
import { canonicalize, strictParse, type JsonValue } from "../src/json.ts";
import { RulesError } from "../src/errors.ts";
import { validateRules } from "../src/schema.ts";
import { readU128, withinRulesText } from "../src/read.ts";
import { readFileSync } from "node:fs";

// Shared with the Rust tests; parse side checked independently by test/vectors/check_number_spellings.py.
const NUMBER_SPELLINGS = JSON.parse(readFileSync(new URL("./vectors/number_spellings.json", import.meta.url), "utf8")) as {
  rules: JsonValue; state: Record<string, unknown>;
  cases: { point: number; raw: string; result: { verdict?: { ok: boolean; reason?: string }; parseError?: string } }[];
};
const TARGET_VECTORS = JSON.parse(readFileSync(new URL("./vectors/target_range.json", import.meta.url), "utf8")) as
  { tier: number; width_bps: number; centre: number; range: { left: number; right: number } | null }[];

const R = rules(); // pool tier 100 (point spacing 1), width 800, quote USDC = token_x
const R2000 = rules({ pool: POOL_2000 });
// Holdings are all in the quote token, so moving the point doesn't change the value;
// valuation of the base token is tested separately.
const base: MarketState = {
  // Confirmed by default (span exactly OFFCHAIN_MARGIN_BLOCKS), so close tests read as before;
  // the confirmation tests (EC-R30) set confirmFromBlock themselves.
  nowS: 10_000, startedAtS: 1_000, point: 0, valuationPoint: 0, block: 50_000, confirmFromBlock: 50_000 - OFFCHAIN_MARGIN_BLOCKS,
  position: { left: -400, right: 400 }, closedBy: null, principal: 250_000_000n,
  holdings: { quote: 250_000_000n, base: 0n }, fees: { quote: 0n, base: 0n },
};
// The valuation point follows the spot point unless a test sets it explicitly.
const st = (o: Partial<MarketState>): MarketState => ({ ...base, valuationPoint: o.point ?? base.valuationPoint, ...o });

describe("evaluate (EC-R06)", () => {
  it("holds inside the range and opens the target range without a position", () => {
    expect(evaluate(R, base)).toEqual({ kind: "hold" });
    expect(evaluate(R, st({ position: null }))).toEqual({ kind: "open", left: -400, right: 400 });
  });
  it("holds with a position wherever the point is: v1 never rebalances (EC-R29)", () => {
    for (const p of [-401, -400, 399, 400, 5000, -5000]) expect(evaluate(R, st({ point: p }))).toEqual({ kind: "hold" });
  });
  it("closes on time, stop loss and take profit at exact boundaries, in that order", () => {
    expect(evaluate(R, st({ nowS: 433_000 }))).toEqual({ kind: "close", reason: "time" });
    expect(evaluate(R, st({ nowS: 432_999 })).kind).toBe("hold");
    expect(evaluate(R, st({ holdings: { quote: 225_000_000n, base: 0n } }))).toEqual({ kind: "close", reason: "stop_loss" });
    expect(evaluate(R, st({ holdings: { quote: 225_000_001n, base: 0n } })).kind).toBe("hold");
    expect(evaluate(R, st({ fees: { quote: 7_500_000n, base: 0n } }))).toEqual({ kind: "close", reason: "take_profit" });
    expect(evaluate(R, st({ fees: { quote: 7_499_999n, base: 0n } })).kind).toBe("hold");
    expect(evaluate(R, st({ nowS: 433_000, holdings: { quote: 0n, base: 0n }, fees: { quote: 10n ** 12n, base: 0n } }))).toEqual({ kind: "close", reason: "time" });
  });
  it("values the base token at the valuation point for stop loss and take profit (unclaimed fees included by the caller)", () => {
    // At point 6932 a unit of base (y) is worth ~0.5 quote (x).
    const s = st({ point: 6932, position: { left: 6532, right: 7332 }, holdings: { quote: 0n, base: 450_000_000n } });
    expect(valueInQuote(R, 6932, s.holdings)).toBe(224_995_913n);
    expect(evaluate(R, s)).toEqual({ kind: "close", reason: "stop_loss" });
    // At point 0 a unit of base is worth exactly one unit of quote.
    expect(evaluate(R, st({ fees: { quote: 0n, base: 7_500_000n } }))).toEqual({ kind: "close", reason: "take_profit" });
    expect(evaluate(R, st({ fees: { quote: 0n, base: 7_499_999n } })).kind).toBe("hold");
  });
  it("treats zero holdings with principal as a stop loss, and never stops with zero principal", () => {
    expect(evaluate(R, st({ holdings: { quote: 0n, base: 0n } }))).toEqual({ kind: "close", reason: "stop_loss" });
    expect(evaluate(R, st({ principal: 0n, holdings: { quote: 0n, base: 0n } })).kind).toBe("hold");
  });
  it("latches after the agent closes: never asks to reopen after a stop loss (EC-R13)", () => {
    const after = st({ closedBy: "stop_loss", position: null, holdings: { quote: 240_000_000n, base: 0n } });
    expect(closeCondition(R, after)).toBeNull();
    expect(evaluate(R, after)).toEqual({ kind: "done" });
    expect(requiredAction(R, after)).toBeNull();
    expect(evaluate(R, st({ closedBy: "time" }))).toEqual({ kind: "close", reason: "time" });
  });
  it("is done when a close condition holds and there's no position", () => {
    expect(evaluate(R, st({ nowS: 433_000, position: null }))).toEqual({ kind: "done" });
  });
  it("rounds ranges outward to the point spacing and returns no range at DCL bounds (L1)", () => {
    expect(targetRange(R2000, 401_452)).toEqual({ left: 401_040, right: 401_880 });
    expect(targetRange(R2000, -401_452)).toEqual({ left: -401_880, right: -401_040 });
    expect(targetRange(R, MAX_POINT)).toBeNull();
    expect(targetRange(R, MAX_POINT - 401)).toEqual({ left: MAX_POINT - 801, right: MAX_POINT - 1 });
    expect(targetRange(R, MIN_POINT)).toBeNull();
    expect(evaluate(R, st({ point: MAX_POINT, position: null }))).toEqual({ kind: "hold" });
    expect(evaluate(R, st({ point: MIN_POINT, position: { left: MIN_POINT, right: MIN_POINT + 800 } }))).toEqual({ kind: "hold" });
  });
  it("never emits rebalance or claim_fees, for any rules and state (EC-R29)", () => {
    fc.assert(fc.property(arbRules, arbState, (r, s) => {
      expect(["hold", "open", "close", "done"]).toContain(evaluate(r, s).kind);
    }), { numRuns: 3000 });
  });
  it.each([
    ["nowS -1", { nowS: -1 }, "nowS must be an integer"],
    ["non-integer now", { nowS: 1.5 }, "nowS must be an integer"],
    ["start after now", { startedAtS: 20_000 }, "startedAtS must be an integer"],
    ["point out of range", { point: MAX_POINT + 1 }, "point must be an integer"],
    ["block -1", { block: -1 }, "block must be an integer between 0 and 9007199254740991"],
    ["non-integer block", { block: 1.5 }, "block must be an integer"],
    ["negative zero block", { block: -0 }, "block must be an integer"],
    ["string block", { block: "50000" as never }, "block must be an integer"],
    ["confirmFromBlock after block", { confirmFromBlock: 50_001 }, "confirmFromBlock must be an integer between 0 and 50000"],
    ["confirmFromBlock -1", { confirmFromBlock: -1 }, "confirmFromBlock must be an integer between 0 and 50000"],
    ["non-integer confirmFromBlock", { confirmFromBlock: 49_000.5 }, "confirmFromBlock must be an integer"],
    ["undefined confirmFromBlock", { confirmFromBlock: undefined as never }, "confirmFromBlock must be an integer"],
    ["position.left out of range", { position: { left: MIN_POINT - 1, right: 0 } }, "position.left must be an integer"],
    ["position.right out of range", { position: { left: 0, right: MAX_POINT + 1 } }, "position.right must be an integer"],
    ["inverted position", { position: { left: 5, right: 5 } }, "position must have left < right"],
    ["unknown closedBy", { closedBy: "bored" }, "closedBy must be a close reason"],
    ["negative principal", { principal: -1n }, "principal must be a non-negative bigint"],
    ["number principal", { principal: 1 }, "principal must be a non-negative bigint"],
    ["negative holdings", { holdings: { quote: -1n, base: 0n } }, "holdings.quote must be a non-negative bigint"],
    ["number holdings", { holdings: { quote: 0n, base: 1 } }, "holdings.base must be a non-negative bigint"],
    ["negative fees", { fees: { quote: 0n, base: -1n } }, "fees.base must be a non-negative bigint"],
    ["null fees", { fees: null }, "fees must be an object"],
    ["negative zero point (EC-R25)", { point: -0 }, "point must be an integer between -800000 and 800000"],
    ["negative zero position.left from JSON (EC-R25)", { position: JSON.parse('{"left":-0,"right":80}'), point: 1, valuationPoint: 1 }, "position.left must be an integer between -800000 and 800000"],
    ["negative zero valuationPoint (EC-R25)", { point: 1, valuationPoint: -0 }, "valuationPoint must be an integer between -800000 and 800000"],
    ["principal above u128", { principal: 1n << 128n }, "principal must fit in u128"],
    ["holdings above u128", { holdings: { quote: 1n << 128n, base: 0n } }, "holdings.quote must fit in u128"],
    ["fees above u128", { fees: { quote: 0n, base: 1n << 128n } }, "fees.base must fit in u128"],
    ["non-object position", { position: 5 }, "position must be an object or null"],
  ])("refuses a bad state: %s", (_n, o, msg) => {
    expect(() => evaluate(R, st(o as Partial<MarketState>))).toThrow(`STATE: ${msg as string}`);
  });
  it("accepts u128::MAX amounts", () => {
    const m = (1n << 128n) - 1n;
    // Fees equal to principal: take profit (stop loss doesn't hold since holdings are at the maximum).
    expect(evaluate(R, st({ principal: m, holdings: { quote: m, base: m }, fees: { quote: m, base: m } }))).toEqual({ kind: "close", reason: "take_profit" });
  });
  it("refuses a null state", () => {
    expect(() => evaluate(R, null as never)).toThrow("STATE: state must be an object");
  });
  it("is deterministic", () => {
    fc.assert(fc.property(fc.integer({ min: MIN_POINT, max: MAX_POINT }), (p) => {
      expect(evaluate(R, st({ point: p }))).toEqual(evaluate(R, st({ point: p })));
    }), { numRuns: 300 });
  });
});

const arbRules = fc.record({
  width: fc.integer({ min: 50, max: 5000 }),
  tier: fc.constantFrom(100, 400, 1000, 2000, 10000),
  tp: fc.integer({ min: 1, max: 10_000 }),
  sl: fc.integer({ min: 1, max: 9_999 }),
  closeAfter: fc.integer({ min: 3600, max: 30 * 86_400 }),
  quoteX: fc.boolean(),
}).map((a) => {
  return rules({
    pool: POOL_2000.replace("|2000", `|${a.tier}`), quote_token: a.quoteX ? USDC : WNEAR,
    range: { width_bps: a.width, centre: "mid" },
    take_profit_bps: a.tp, stop_loss_bps: a.sl, close_after_s: a.closeAfter,
  });
});
// Mostly realistic sizes, sometimes up to u128::MAX (test re-audit L-2).
const amt = fc.oneof({ arbitrary: fc.bigInt({ min: 0n, max: 10n ** 15n }), weight: 4 }, { arbitrary: fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }), weight: 1 });
const arbState = fc.record({
  start: fc.integer({ min: 0, max: 1_000_000 }), elapsed: fc.integer({ min: 0, max: 40 * 86_400 }),
  // Confirmation spans from none through every bound to well past CONFIRM_MAX_BLOCKS (EC-R30).
  block: fc.integer({ min: 0, max: 1_000_000_000 }), back: fc.option(fc.integer({ min: 0, max: 2 * CONFIRM_MAX_BLOCKS })), point: fc.integer({ min: MIN_POINT, max: MAX_POINT }), vpoint: fc.integer({ min: MIN_POINT, max: MAX_POINT }),
  hasPos: fc.boolean(), posLeft: fc.integer({ min: MIN_POINT, max: MAX_POINT - 1 }), posWidth: fc.integer({ min: 1, max: 20_000 }),
  closed: fc.constantFrom(null, "time", "stop_loss", "take_profit"),
  principal: amt, hq: amt, hb: amt, fq: amt, fb: amt,
}).map((a): MarketState => {
  const now = a.start + a.elapsed;
  return {
    nowS: now, startedAtS: a.start, point: a.point, valuationPoint: a.vpoint,
    block: a.block, confirmFromBlock: a.back === null ? null : Math.max(0, a.block - a.back),
    position: a.hasPos ? { left: a.posLeft, right: Math.min(MAX_POINT, a.posLeft + a.posWidth) } : null,
    closedBy: a.closed as MarketState["closedBy"], principal: a.principal,
    holdings: { quote: a.hq, base: a.hb }, fees: { quote: a.fq, base: a.fb },
  };
});

describe("withinRules (EC-R07)", () => {
  it("accepts every decision evaluate makes", () => {
    fc.assert(fc.property(arbRules, arbState, (r, s) => {
      expect(withinRules(r, s, evaluate(r, s))).toEqual({ ok: true });
    }), { numRuns: 2000 });
  });
  it("accepts every decision evaluate makes after a round trip through text, for every kind (EC-R07, EC-R25)", () => {
    const kinds = new Set<string>();
    fc.assert(fc.property(arbRules, arbState, (r, s) => {
      const d = evaluate(r, s);
      kinds.add(d.kind);
      expect(withinRulesText(r, s, JSON.stringify(d))).toEqual({ ok: true });
    }), { numRuns: 3000 });
    for (const k of ["hold", "open", "close", "done"]) expect(kinds.has(k)).toBe(true);
  });
  it("refuses evaluate's own decisions when an integer in them is re-spelled (EC-R25, test re-audit of 2276e67, L-3)", () => {
    // Each re-spelling with its exact code (test re-audit of 20e4ceb, Low 3).
    const spellings = [(n: number) => `${n}.0`, (n: number) => `${n}e0`, (n: number) => (n < 0 ? `-0${-n}` : `0${n}`), (n: number) => `+${n}`];
    const codeFor = (k: number, n: number) => (k <= 1 ? "JSON_NUMBER" : k === 3 ? "JSON_SYNTAX" : n < 0 ? "JSON_NUMBER" : "JSON_SYNTAX");
    let tried = 0;
    const classes = new Set<string>();
    fc.assert(fc.property(arbRules, arbState, fc.integer({ min: 0, max: 3 }), (r, s0, k) => {
      // Nothing due to close and no position, so evaluate opens wherever a target fits.
      const s: MarketState = { ...s0, closedBy: null, principal: 0n, nowS: s0.startedAtS, position: null };
      const d = evaluate(r, s);
      if (!("left" in d)) return;
      const n = (d as { left: number }).left;
      const text = JSON.stringify(d).replace(/"left":(-?[0-9]+)/, () => `"left":${spellings[k]!(n)}`);
      expect(withinRulesText(r, s, text)).toEqual({ ok: false, unreadable: true, reason: expect.stringMatching(new RegExp(`^${codeFor(k, n)}:`)) });
      tried++;
      classes.add(`${k}:${Math.sign(n)}`);
    }), { numRuns: 3000 });
    expect(tried).toBeGreaterThan(2000);
    // Every spelling ran with negative and positive left edges (test re-audit of 520b106, I-2).
    for (const k of [0, 1, 2, 3]) for (const sg of [-1, 1]) expect(classes.has(`${k}:${sg}`)).toBe(true);
    // -0 for a zero edge.
    const z = withinRulesText(R, st({ point: -400, position: null }), '{"kind":"open","left":-800,"right":-0}');
    expect(z).toEqual({ ok: false, unreadable: true, reason: "JSON_NUMBER: -0 is not allowed at offset 35" });
  });
  it("accepts, and canonicalises, every open evaluate makes from realistic states with no close due, and holds with a position (EC-R07, EC-R15, EC-R29)", () => {
    let opens = 0, holds = 0;
    fc.assert(fc.property(arbRules, arbState, fc.integer({ min: -3000, max: 3000 }), fc.boolean(), fc.integer({ min: 0, max: 100 }),
      (r, s0, drift, hasPos, elapsedFrac) => {
        // The position, if any, is an earlier target; the point has drifted since. Time runs inside the run.
        const earlier = targetRange(r, s0.point);
        const point = Math.max(MIN_POINT, Math.min(MAX_POINT, s0.point + drift));
        const nowS = s0.startedAtS + Math.floor(((r.close_after_s - 1) * elapsedFrac) / 100);
        const s: MarketState = { ...s0, point, closedBy: null, principal: 0n, nowS, position: hasPos ? earlier : null };
        const d = evaluate(r, s);
        const t = targetRange(r, point);
        if (s.position === null) expect(d).toEqual(t ? { kind: "open", ...t } : { kind: "hold" });
        else expect(d).toEqual({ kind: "hold" });
        if (d.kind === "open") opens++; else holds++;
        expect(withinRules(r, s, d)).toEqual({ ok: true });
        expect(() => canonicalize(d as unknown as JsonValue)).not.toThrow();
      }), { numRuns: 5000 });
    expect(opens).toBeGreaterThan(1000);
    expect(holds).toBeGreaterThan(1000);
  });
  it("canonicalises any action withinRules accepts, arbitrary JSON and near-valid shapes included (EC-R07, EC-R15)", () => {
    const point = fc.oneof(fc.integer({ min: -900_000, max: 900_000 }), fc.constantFrom(-0, 0.5, Number.NaN, 1e300), fc.string());
    const shaped = fc.record({ kind: fc.constantFrom("open", "rebalance", "hold", "close", "claim_fees", "done", "x"), left: point, right: point, reason: fc.constantFrom("time", "stop_loss", "take_profit", 1) }, { requiredKeys: ["kind"] });
    fc.assert(fc.property(arbRules, arbState, fc.oneof(fc.jsonValue(), shaped), (r, s, a) => {
      if (withinRules(r, s, a).ok) expect(() => canonicalize(a as JsonValue)).not.toThrow();
    }), { numRuns: 5000 });
    // Near the target: the exact target, or one field changed to -0, +-1 or a float (rules-verifier, re-audit of 50c8267).
    let acceptedRanges = 0, zeroEdges = 0;
    const perCombo = new Map<string, number>();
    fc.assert(fc.property(arbRules, arbState, fc.constantFrom("none", "zero", "plus", "minus", "float"), fc.boolean(), (r, s0, change, onLeft) => {
      // For the -0 case, place the point so the chosen edge is exactly 0, so -0 is the only difference.
      const half = Math.floor(r.range.width_bps / 2);
      // Right edge 0: with spacing 1 the point -half gives right = 0; otherwise -half - 1 (rules-verifier Info-1).
      const { pointDelta } = parsePoolId(r.pool);
      const point = change === "zero" ? (onLeft ? half : (pointDelta === 1 ? -half : -half - 1)) : s0.point;
      const s: MarketState = { ...s0, point, valuationPoint: s0.valuationPoint, closedBy: null, principal: 0n, nowS: s0.startedAtS, position: null };
      const t = targetRange(r, s.point);
      if (t === null) return;
      if (change === "zero" && (onLeft ? t.left : t.right) !== 0) return;
      const a: Record<string, unknown> = { kind: "open", left: t.left, right: t.right };
      const k = onLeft ? "left" : "right";
      const v = a[k] as number;
      if (change === "zero") a[k] = -0;
      if (change === "plus") a[k] = v + 1;
      if (change === "minus") a[k] = v - 1;
      if (change === "float") a[k] = v + 0.5;
      const ok = withinRules(r, s, a).ok;
      // Exactly the unchanged target is accepted; every variant, -0 included, is refused (rules-verifier, re-audit of 342e8b9).
      expect(ok).toBe(change === "none");
      if (change === "none") acceptedRanges++;
      if (change === "zero") { zeroEdges++; const k2 = `${parsePoolId(r.pool).pointDelta}${onLeft ? "L" : "R"}`; perCombo.set(k2, (perCombo.get(k2) ?? 0) + 1); }
      if (ok) expect(() => canonicalize(a as JsonValue)).not.toThrow();
    }), { numRuns: 5000 });
    expect(acceptedRanges).toBeGreaterThan(500);
    expect(zeroEdges).toBeGreaterThan(500);
    // Every tier spacing and edge side runs, tier 100's right edge included (test re-audit of b185558, L-1).
    for (const d of [1, 8, 20, 40, 200]) for (const side of ["L", "R"]) expect(perCombo.get(`${d}${side}`) ?? 0).toBeGreaterThan(30);
  });
  it("refuses -0 as the right edge on tier 100, where the target's right edge is 0 (EC-R15, rules-verifier re-audit of b185558)", () => {
    // Tier 100 (spacing 1), width 800, point -400: target [-800, 0).
    const s = st({ point: -400, position: null });
    expect(targetRange(R, -400)).toEqual({ left: -800, right: 0 });
    expect(withinRules(R, s, { kind: "open", left: -800, right: 0 })).toEqual({ ok: true });
    expect(withinRules(R, s, JSON.parse('{"kind":"open","left":-800,"right":-0}'))).toEqual({ ok: false, reason: "right must be an integer point" });
  });
  it("has all the shared number-spelling vectors (security re-audit of 20e4ceb, L-4)", () => {
    expect(NUMBER_SPELLINGS.cases.length).toBe(68);
  });
  it.each(NUMBER_SPELLINGS.cases.map((c) => [c.raw, c] as const))("reads %s with strictParse and judges it as the shared vector says (EC-R25)", (_raw, c) => {
    // Rules and state come from the vector file, so a Rust port can run the same cases on their own.
    const r = validateRules(NUMBER_SPELLINGS.rules);
    const v = NUMBER_SPELLINGS.state as Record<string, unknown> & { holdings: Record<string, string>; fees: Record<string, string> };
    const s: MarketState = {
      ...(v as unknown as MarketState), point: c.point, valuationPoint: c.point,
      principal: readU128(v["principal"] as string),
      holdings: { quote: readU128(v.holdings["quote"]!), base: readU128(v.holdings["base"]!) },
      fees: { quote: readU128(v.fees["quote"]!), base: readU128(v.fees["base"]!) },
    };
    // Only the parse is inside the try, so a RulesError from withinRules can't pass as a parse error.
    let parsed: unknown, got: unknown;
    try { parsed = strictParse(c.raw); } catch (e) { got = { parseError: (e as RulesError).code }; }
    if (got === undefined) got = { verdict: withinRules(r, s, parsed) };
    expect(got).toEqual(c.result);
    // The same through withinRulesText, the function callers use (test re-audit of 2276e67, L-5).
    const t = withinRulesText(r, s, c.raw);
    if (c.result.parseError !== undefined) {
      expect(t.ok).toBe(false);
      expect("unreadable" in t && t.unreadable).toBe(true);
      expect(t.ok === false && t.reason.startsWith(`${c.result.parseError}:`)).toBe(true);
    } else expect(t).toEqual(c.result.verdict);
  });
  it("only accepts open ranges that are exactly the target, and no open with a position (EC-R14, EC-R22)", () => {
    fc.assert(fc.property(arbRules, arbState, fc.integer({ min: -3, max: 3 }), fc.integer({ min: -2000, max: 2000 }), (r, s, k, w) => {
      const t = targetRange(r, s.point);
      if (t === null) return;
      const cand = { kind: "open", left: t.left + k * 37, right: t.right + k * 37 + w } as Decision;
      if (withinRules(r, s, cand).ok && "left" in cand) {
        expect(s.position).toBeNull();
        expect({ left: cand.left, right: cand.right }).toEqual(t);
      }
    }), { numRuns: 20000 });
  });
  it("refuses a range wider than the target even if a nearby centre would round to it (EC-R14, EC-R21)", () => {
    const r = rules({ pool: POOL_2000, range: { width_bps: 50, centre: "mid" } });
    const s = st({ point: 0, position: null });
    expect(targetRange(r, 0)).toEqual({ left: -40, right: 40 });
    expect(withinRules(r, s, { kind: "open", left: -80, right: 40 })).toEqual({ ok: false, reason: "range isn't the rules' target range at the observed point" });
    expect(withinRules(r, s, { kind: "open", left: -40, right: 40 })).toEqual({ ok: true });
    // Same width, shifted by one spacing, still contains the point: refused, only the exact target is accepted (EC-R22).
    expect(withinRules(r, s, { kind: "open", left: 0, right: 80 })).toEqual({ ok: false, reason: "range isn't the rules' target range at the observed point" });
    // Shifted the other way it no longer contains the point (half-open): refused.
    expect(withinRules(r, s, { kind: "open", left: -80, right: 0 })).toEqual({ ok: false, reason: "range must contain the current point" });
    // The wide variant on the other side: refused for width.
    expect(withinRules(r, s, { kind: "open", left: -40, right: 80 })).toEqual({ ok: false, reason: "range isn't the rules' target range at the observed point" });
  });
  it("refuses a range narrower than the target even if a nearby centre would round to it (EC-R21)", () => {
    const r = rules({ pool: POOL_2000, range: { width_bps: 50, centre: "mid" } });
    expect(targetRange(r, 20)).toEqual({ left: -40, right: 80 });
    expect(targetRange(r, 15)).toEqual({ left: -40, right: 40 });
    expect(withinRules(r, st({ point: 20, position: null }), { kind: "open", left: -40, right: 40 })).toEqual({ ok: false, reason: "range isn't the rules' target range at the observed point" });
  });
  it("refuses with a RulesError-free reason when no target range fits at the point (EC-R15, EC-R21)", () => {
    expect(targetRange(R, MAX_POINT - 1)).toBeNull();
    expect(withinRules(R, st({ point: MAX_POINT - 1, position: null }), { kind: "open", left: MAX_POINT - 800, right: MAX_POINT })).toEqual({ ok: false, reason: "range isn't the rules' target range at the observed point" });
  });
  it("accepts only the exact target among near misses: nearby centres and edges moved by a spacing (EC-R14, EC-R21, EC-R22)", () => {
    let accepted = 0;
    fc.assert(fc.property(arbRules, arbState, fc.integer({ min: -2, max: 2 }), fc.integer({ min: -1, max: 1 }), fc.integer({ min: -1, max: 1 }), fc.integer({ min: 0, max: 100 }),
      (r, s0, dk, el, er, frac) => {
        // A state with no close condition and no position, so the width check is reached.
        const s: MarketState = { ...s0, closedBy: null, position: null, principal: 0n, nowS: s0.startedAtS };
        const { pointDelta } = parsePoolId(r.pool);
        const d = Math.round((dk * pointDelta * frac) / 100) + (dk === 0 ? 0 : Math.sign(dk));
        const t0 = targetRange(r, s.point);
        const near = targetRange(r, Math.max(MIN_POINT, Math.min(MAX_POINT, s.point + d)));
        if (near === null) return;
        const cand = { kind: "open", left: near.left + el * pointDelta, right: near.right + er * pointDelta } as Decision;
        const ok = withinRules(r, s, cand).ok;
        // The exact target is always accepted (rules-verifier, re-audit of 5cc2724).
        if (t0 !== null && "left" in cand && cand.left === t0.left && cand.right === t0.right) expect(ok).toBe(true);
        if (ok && "left" in cand) {
          expect(t0).not.toBeNull();
          // Only the exact target at the observed point is accepted (EC-R22).
          expect({ left: cand.left, right: cand.right }).toEqual(t0);
          expect(cand.right - cand.left).toBe(t0!.right - t0!.left);
          expect(cand.left <= s.point && s.point < cand.right).toBe(true);
          accepted++;
        }
      }), { numRuns: 20000 });
    // The property must actually exercise acceptance (security re-audit L-6).
    // About 1 in 45 candidates is the exact target (no centre or edge shift).
    expect(accepted).toBeGreaterThan(200);
  });
  it.each(TARGET_VECTORS.map((v) => [v.tier, v.width_bps, v.centre, v] as const))(
    "matches the shared targetRange vector on tier %i, width %i at centre %i (EC-R06, EC-R14, EC-R23)", (_t, _w, _c, v) => {
      const r = rules({ pool: POOL_2000.replace("|2000", `|${v.tier}`), range: { width_bps: v.width_bps, centre: "mid" } });
      const got = targetRange(r, v.centre);
      expect(got).toEqual(v.range);
      // Never -0, which canonicalize refuses (rules-verifier M-1).
      if (got) expect(Object.is(got.left, -0) || Object.is(got.right, -0)).toBe(false);
    });
  it("accepts only the exact target at an aligned point; a centre one spacing away is refused (EC-R07, EC-R14, EC-R22)", () => {
    const p = 401_440;
    const s = st({ point: p, position: null });
    expect(withinRules(R2000, s, { kind: "open", ...targetRange(R2000, p)! })).toEqual({ ok: true });
    for (const c of [p + 40, p - 40, p + 41, p - 41]) {
      const t = targetRange(R2000, c)!;
      expect(withinRules(R2000, s, { kind: "open", ...t })).toEqual({ ok: false, reason: "range isn't the rules' target range at the observed point" });
    }
  });
  it("refuses a narrow range that doesn't contain the point on a wide fee tier (EC-R14)", () => {
    const r = rules({ pool: POOL_2000, range: { width_bps: 50, centre: "mid" } });
    const s = st({ point: 400_000, position: null });
    expect(withinRules(r, s, { kind: "open", left: 399_920, right: 400_000 })).toEqual({ ok: false, reason: "range must contain the current point" });
  });
  it("refuses ranges centred one or two spacings away at an unaligned point (EC-R22)", () => {
    const s = st({ position: null, point: 401_452 });
    const up1 = targetRange(R2000, 401_452 + 40); const down1 = targetRange(R2000, 401_452 - 40);
    const up2 = targetRange(R2000, 401_452 + 81); const down2 = targetRange(R2000, 401_452 - 81);
    expect(withinRules(R2000, s, { kind: "open", ...targetRange(R2000, 401_452)! })).toEqual({ ok: true });
    expect(withinRules(R2000, s, { kind: "open", ...up1! })).toEqual({ ok: false, reason: "range isn't the rules' target range at the observed point" });
    expect(withinRules(R2000, s, { kind: "open", ...down1! })).toEqual({ ok: false, reason: "range isn't the rules' target range at the observed point" });
    expect(withinRules(R2000, s, { kind: "open", ...up2! })).toEqual({ ok: false, reason: "range isn't the rules' target range at the observed point" });
    expect(withinRules(R2000, s, { kind: "open", ...down2! })).toEqual({ ok: false, reason: "range isn't the rules' target range at the observed point" });
  });
  it.each([["time", { nowS: 433_000 }], ["stop_loss", { holdings: { quote: 1n, base: 0n } }], ["take_profit", { fees: { quote: 10n ** 9n, base: 0n } }]] as const)(
    "refuses open, rebalance, hold and claim_fees while %s is due and confirmed, and needs the matching reason", (reason, o) => {
      const s = st({ ...o, point: 5000 });
      const t = targetRange(R, 5000)!;
      expect(withinRules(R, s, { kind: "rebalance", ...t })).toEqual({ ok: false, reason: "rebalance is not available in v1" });
      expect(withinRules(R, s, { kind: "hold" })).toEqual({ ok: false, reason: "a close condition holds" });
      expect(withinRules(R, s, { kind: "claim_fees" })).toEqual({ ok: false, reason: "claim_fees is not available in v1" });
      expect(withinRules(R, s, { kind: "done" })).toEqual({ ok: false, reason: "a close condition holds" });
      expect(withinRules(R, { ...s, position: null }, { kind: "open", ...t })).toEqual({ ok: false, reason: "a close condition holds" });
      expect(withinRules(R, s, { kind: "close", reason })).toEqual({ ok: true });
      const wrong = reason === "time" ? "stop_loss" : "time";
      expect(withinRules(R, s, { kind: "close", reason: wrong })).toEqual({ ok: false, reason: "close reason doesn't match the condition that holds" });
    });
  it("refuses reopening, rebalancing, claiming or closing again after a latched close (EC-R13)", () => {
    const after = st({ closedBy: "stop_loss", position: null, holdings: { quote: 240_000_000n, base: 0n } });
    expect(withinRules(R, after, { kind: "open", ...targetRange(R, 0)! })).toEqual({ ok: false, reason: "a close condition holds" });
    expect(withinRules(R, after, { kind: "done" })).toEqual({ ok: true });
    expect(withinRules(R, after, { kind: "close", reason: "stop_loss" })).toEqual({ ok: false, reason: "a close condition holds" });
    expect(withinRules(R, after, { kind: "rebalance", ...targetRange(R, 0)! })).toEqual({ ok: false, reason: "rebalance is not available in v1" });
    expect(withinRules(R, after, { kind: "claim_fees" })).toEqual({ ok: false, reason: "claim_fees is not available in v1" });
  });
  it("refuses close and done when they don't apply", () => {
    expect(withinRules(R, base, { kind: "close", reason: "time" })).toEqual({ ok: false, reason: "no close condition holds" });
    expect(withinRules(R, base, { kind: "done" })).toEqual({ ok: false, reason: "the strategy isn't done" });
  });
  it("refuses claim_fees and rebalance in every state, even where v2 would allow them (EC-R29)", () => {
    const t = targetRange(R, 0)!;
    for (const s of [base, st({ position: null }), st({ point: 5000 }), st({ point: 5000, confirmFromBlock: null })]) {
      expect(withinRules(R, s, { kind: "claim_fees" })).toEqual({ ok: false, reason: "claim_fees is not available in v1" });
      expect(withinRules(R, s, { kind: "rebalance", ...targetRange(R, s.point)! })).toEqual({ ok: false, reason: "rebalance is not available in v1" });
    }
    // Shape errors in a rebalance are still reported as v1-unavailable, never accepted.
    expect(withinRules(R, base, { kind: "rebalance", left: "x" })).toEqual({ ok: false, reason: "rebalance is not available in v1" });
    expect(withinRules(R, base, { kind: "open", ...t })).toEqual({ ok: false, reason: "a position is already open" });
  });
  it.each([
    ["null", null, "action must be an object"],
    ["array", [], "action must be an object"],
    ["unknown kind", { kind: "swap", amount: 1 }, "unknown action"],
    ["extra field on hold", { kind: "hold", note: "x" }, "unexpected fields"],
    ["extra field on close", { kind: "close", reason: "time", x: 1 }, "unexpected fields"],
    ["unknown close reason", { kind: "close", reason: "bored" }, "unknown close reason"],
    ["missing right", { kind: "open", left: 1 }, "unexpected fields"],
    ["string point", { kind: "open", left: "1", right: 5 }, "left must be an integer point"],
    ["point beyond the bound", { kind: "open", left: 0, right: MAX_POINT + 1 }, "right must be an integer point"],
    ["negative zero, which canonicalize refuses (EC-R25)", JSON.parse('{"kind":"open","left":-80,"right":-0}'), "right must be an integer point"],
    ["negative zero left (EC-R25)", JSON.parse('{"kind":"open","left":-0,"right":80}'), "left must be an integer point"],
    ["float left", { kind: "open", left: 0.5, right: 80 }, "left must be an integer point"],
    ["NaN left", { kind: "open", left: Number.NaN, right: 80 }, "left must be an integer point"],
    ["Infinity right", { kind: "open", left: 0, right: Number.POSITIVE_INFINITY }, "right must be an integer point"],
    ["left below the bound", { kind: "open", left: MIN_POINT - 1, right: 80 }, "left must be an integer point"],
  ])("refuses a malformed action (%s), never failing open (EC-R15)", (_n, a, reason) => {
    expect(withinRules(R, st({ position: null }), a)).toEqual({ ok: false, reason });
  });
});

describe("audit regressions", () => {
  it("values base holdings just above the stop-loss threshold as a hold (EC-R06)", () => {
    expect(evaluate(R, st({ point: 6932, position: { left: 6532, right: 7332 }, holdings: { quote: 0n, base: 460_000_000n } }))).toEqual({ kind: "hold" });
  });
  it("reports stop loss before take profit when both hold", () => {
    expect(closeCondition(R, st({ holdings: { quote: 1n, base: 0n }, fees: { quote: 10n ** 9n, base: 0n } }))).toBe("stop_loss");
  });
  it("splits odd widths with the smaller half and matches DCL bounds exactly (EC-R14)", () => {
    expect(targetRange(rules({ range: { width_bps: 801, centre: "mid" } }), 0)).toEqual({ left: -400, right: 400 });
    expect(targetRange(R, MIN_POINT + 400)).toEqual({ left: MIN_POINT, right: MIN_POINT + 800 });
    expect(targetRange(R, MAX_POINT - 401)).toEqual({ left: MAX_POINT - 801, right: MAX_POINT - 1 });
    expect(targetRange(R, MAX_POINT - 400)).toEqual({ left: MAX_POINT - 800, right: MAX_POINT });
  });
  it("passes the containment check for a range whose left edge equals the point, then refuses it as off-target (EC-R14, EC-R22)", () => {
    const r = rules({ pool: POOL_2000, range: { width_bps: 50, centre: "mid" } });
    expect(withinRules(r, st({ point: 400_000, position: null }), { kind: "open", left: 400_000, right: 400_080 })).toEqual({ ok: false, reason: "range isn't the rules' target range at the observed point" });
    expect(withinRules(r, st({ point: 400_000, position: null }), { kind: "open", left: 399_960, right: 400_040 })).toEqual({ ok: true });
  });
  it("refuses a malformed state in withinRules too (EC-R15)", () => {
    expect(() => withinRules(R, st({ nowS: Number.NaN }), { kind: "hold" })).toThrow("STATE: nowS must be an integer");
    expect(() => withinRules(R, st({ valuationPoint: MAX_POINT + 1 }), { kind: "hold" })).toThrow("STATE: valuationPoint must be an integer");
  });
  it("values close conditions at the valuation point, so a one-block spot move can't close (M-1, EC-R19)", () => {
    const s = st({ point: 1054, valuationPoint: 0, position: { left: -400, right: 400 }, holdings: { quote: 0n, base: 250_000_000n } });
    expect(closeCondition(R, s)).toBeNull();
    expect(withinRules(R, s, { kind: "close", reason: "stop_loss" })).toEqual({ ok: false, reason: "no close condition holds" });
    expect(closeCondition(R, { ...s, valuationPoint: 1054 })).toBe("stop_loss");
  });
  it("values take-profit fees at the valuation point too, so a spot spike can't take profit (EC-R19)", () => {
    // 7,000,000 base in fees: worth 7.0M quote at point 0 (below 3% of 250M = 7.5M), but
    // about 7.76M at spot point -1030 (base worth more), which would cross the threshold.
    const s = st({ point: -1030, valuationPoint: 0, position: { left: -1400, right: -600 }, fees: { quote: 0n, base: 7_000_000n } });
    expect(closeCondition(R, s)).toBeNull();
    expect(withinRules(R, s, { kind: "close", reason: "take_profit" })).toEqual({ ok: false, reason: "no close condition holds" });
    expect(closeCondition(R, { ...s, valuationPoint: -1030 })).toBe("take_profit");
  });
  it("stops exactly at the threshold when valuing base at a non-zero valuation point (EC-R18)", () => {
    // 450,008,173 base is worth exactly 225,000,000 quote at point 6932; 450,008,175 is worth 225,000,001.
    const at = (b: bigint) => st({ point: 6932, position: { left: 6532, right: 7332 }, holdings: { quote: 0n, base: b } });
    expect(valueInQuote(R, 6932, at(450_008_173n).holdings)).toBe(225_000_000n);
    expect(valueInQuote(R, 6932, at(450_008_175n).holdings)).toBe(225_000_001n);
    expect(evaluate(R, at(450_008_173n))).toEqual({ kind: "close", reason: "stop_loss" });
    expect(evaluate(R, at(450_008_175n))).toEqual({ kind: "hold" });
    expect(withinRules(R, at(450_008_173n), { kind: "close", reason: "stop_loss" })).toEqual({ ok: true });
    expect(withinRules(R, at(450_008_175n), { kind: "close", reason: "stop_loss" })).toEqual({ ok: false, reason: "no close condition holds" });
  });
  it("refuses a rebalance to the range already held with the v1 reason, not the v2 one (EC-R20 is v2 only)", () => {
    const s = st({ point: 10, position: { left: 0, right: 400 } });
    expect(withinRules(R, s, { kind: "rebalance", left: 0, right: 400 })).toEqual({ ok: false, reason: "rebalance is not available in v1" });
  });
});

describe("requiredAction (EC-R08)", () => {
  it("is null when holding or done, and the decision otherwise", () => {
    expect(requiredAction(R, base)).toBeNull();
    expect(requiredAction(R, st({ nowS: 433_000, position: null }))).toBeNull();
    expect(requiredAction(R, st({ holdings: { quote: 1n, base: 0n } }))).toEqual({ kind: "close", reason: "stop_loss" });
    expect(requiredAction(R, st({ point: 6000 }))).toBeNull();
    expect(requiredAction(R, st({ position: null }))).toEqual({ kind: "open", left: -400, right: 400 });
    // A stop loss waiting for its confirmation requires nothing yet (EC-R30).
    expect(requiredAction(R, st({ holdings: { quote: 1n, base: 0n }, confirmFromBlock: null }))).toBeNull();
  });
  it("marks a hold as outside the rules whenever a close is required (missed close)", () => {
    fc.assert(fc.property(arbRules, arbState, (r, s) => {
      const req = requiredAction(r, s);
      if (req?.kind === "close") expect(withinRules(r, s, { kind: "hold" }).ok).toBe(false);
    }), { numRuns: 1000 });
  });
});

describe("close confirmation (EC-R30)", () => {
  const SL = { holdings: { quote: 1n, base: 0n } } as const; // stop loss holds
  const TP = { fees: { quote: 10n ** 9n, base: 0n } } as const; // take profit holds
  const TIME = { nowS: 433_000 } as const; // time holds
  const at = (o: Partial<MarketState>, span: number | null) => st({ ...o, block: 50_000, confirmFromBlock: span === null ? null : 50_000 - span });

  it("uses the stated constants: margin twice the settle window, maximum ten margins", () => {
    expect(PAYOUT_SETTLE_BLOCKS).toBe(20);
    expect(OFFCHAIN_MARGIN_BLOCKS).toBe(2 * PAYOUT_SETTLE_BLOCKS);
    expect(OFFCHAIN_MARGIN_BLOCKS).toBe(40);
    expect(CONFIRM_MAX_BLOCKS).toBe(10 * OFFCHAIN_MARGIN_BLOCKS);
    expect(CONFIRM_MAX_BLOCKS).toBe(400);
  });
  it.each([["stop_loss", SL], ["take_profit", TP], ["time", TIME]] as const)(
    "closes on %s only with a span from OFFCHAIN_MARGIN_BLOCKS to CONFIRM_MAX_BLOCKS", (reason, o) => {
      expect(evaluate(R, at(o, null))).toEqual({ kind: "hold" });
      expect(evaluate(R, at(o, 0))).toEqual({ kind: "hold" });
      expect(evaluate(R, at(o, OFFCHAIN_MARGIN_BLOCKS - 1))).toEqual({ kind: "hold" });
      expect(evaluate(R, at(o, OFFCHAIN_MARGIN_BLOCKS))).toEqual({ kind: "close", reason });
      expect(evaluate(R, at(o, CONFIRM_MAX_BLOCKS))).toEqual({ kind: "close", reason });
      expect(evaluate(R, at(o, CONFIRM_MAX_BLOCKS + 1))).toEqual({ kind: "hold" });
      expect(closeConfirmed(at(o, OFFCHAIN_MARGIN_BLOCKS - 1))).toBe(false);
      expect(closeConfirmed(at(o, OFFCHAIN_MARGIN_BLOCKS))).toBe(true);
      expect(closeConfirmed(at(o, CONFIRM_MAX_BLOCKS))).toBe(true);
      expect(closeConfirmed(at(o, CONFIRM_MAX_BLOCKS + 1))).toBe(false);
      expect(closeConfirmed(at(o, null))).toBe(false);
    });
  it.each([["stop_loss", SL], ["take_profit", TP], ["time", TIME]] as const)(
    "while %s waits for confirmation, accepts only hold, with exact reasons", (reason, o) => {
      for (const span of [null, 0, OFFCHAIN_MARGIN_BLOCKS - 1, CONFIRM_MAX_BLOCKS + 1]) {
        const s = at(o, span);
        expect(withinRules(R, s, { kind: "hold" })).toEqual({ ok: true });
        const early = span === CONFIRM_MAX_BLOCKS + 1 ? "the confirmation span is above CONFIRM_MAX_BLOCKS" : "the close condition isn't confirmed yet";
        expect(withinRules(R, s, { kind: "close", reason })).toEqual({ ok: false, reason: early });
        expect(withinRules(R, s, { kind: "done" })).toEqual({ ok: false, reason: "a close condition holds" });
        expect(withinRules(R, { ...s, position: null }, { kind: "open", ...targetRange(R, 0)! })).toEqual({ ok: false, reason: "a close condition holds" });
        expect(withinRules(R, s, { kind: "rebalance", ...targetRange(R, 0)! })).toEqual({ ok: false, reason: "rebalance is not available in v1" });
      }
      // Confirmed: hold is now a missed close.
      expect(withinRules(R, at(o, OFFCHAIN_MARGIN_BLOCKS), { kind: "hold" })).toEqual({ ok: false, reason: "a close condition holds" });
      expect(withinRules(R, at(o, OFFCHAIN_MARGIN_BLOCKS), { kind: "close", reason })).toEqual({ ok: true });
    });
  it("refuses an open with a position held during confirmation with the confirmation reason (test L-3)", () => {
    const s = at(SL, OFFCHAIN_MARGIN_BLOCKS - 1);
    expect(s.position).not.toBeNull();
    expect(withinRules(R, s, { kind: "open", ...targetRange(R, 0)! })).toEqual({ ok: false, reason: "a close condition holds" });
  });
  it("waits for confirmation after a latched close too: hold accepted, the close refused until confirmed (test L-3)", () => {
    const s = st({ closedBy: "stop_loss", confirmFromBlock: null });
    expect(evaluate(R, s)).toEqual({ kind: "hold" });
    expect(withinRules(R, s, { kind: "hold" })).toEqual({ ok: true });
    expect(withinRules(R, s, { kind: "close", reason: "stop_loss" })).toEqual({ ok: false, reason: "the close condition isn't confirmed yet" });
    expect(evaluate(R, { ...s, confirmFromBlock: s.block - OFFCHAIN_MARGIN_BLOCKS })).toEqual({ kind: "close", reason: "stop_loss" });
  });
  it("accepts block at Number.MAX_SAFE_INTEGER and refuses one above (test L-3)", () => {
    expect(evaluate(R, st({ block: Number.MAX_SAFE_INTEGER }))).toEqual({ kind: "hold" });
    expect(() => evaluate(R, st({ block: Number.MAX_SAFE_INTEGER + 1 }))).toThrow("STATE: block must be an integer between 0 and 9007199254740991");
  });
  it("checks the reason before the confirmation, so a wrong reason is named even when unconfirmed", () => {
    expect(withinRules(R, at(SL, 0), { kind: "close", reason: "time" })).toEqual({ ok: false, reason: "close reason doesn't match the condition that holds" });
  });
  it("is done without a position whether or not the condition is confirmed", () => {
    expect(evaluate(R, { ...at(SL, null), position: null })).toEqual({ kind: "done" });
    expect(withinRules(R, { ...at(SL, null), position: null }, { kind: "done" })).toEqual({ ok: true });
  });
  it("reports stop loss before take profit when both hold, and time before both (section 4 order)", () => {
    expect(evaluate(R, at({ ...SL, ...TP }, OFFCHAIN_MARGIN_BLOCKS))).toEqual({ kind: "close", reason: "stop_loss" });
    expect(evaluate(R, at({ ...SL, ...TP, ...TIME }, OFFCHAIN_MARGIN_BLOCKS))).toEqual({ kind: "close", reason: "time" });
  });
  it("closeDue reports the due condition whether or not it is confirmed, the latch first (for page samples)", () => {
    expect(closeDue(R, at(SL, null))).toBe("stop_loss");
    expect(closeDue(R, at(SL, OFFCHAIN_MARGIN_BLOCKS))).toBe("stop_loss");
    expect(closeDue(R, at({}, null))).toBeNull();
    expect(closeDue(R, st({ closedBy: "take_profit", confirmFromBlock: null }))).toBe("take_profit");
    expect(() => closeDue(R, st({ block: -1 }))).toThrow("STATE: block must be an integer");
  });
  it("ignores confirmFromBlock when no condition holds", () => {
    expect(evaluate(R, at({}, OFFCHAIN_MARGIN_BLOCKS))).toEqual({ kind: "hold" });
    expect(withinRules(R, at({}, OFFCHAIN_MARGIN_BLOCKS), { kind: "close", reason: "stop_loss" })).toEqual({ ok: false, reason: "no close condition holds" });
  });

  describe("nextConfirmRun: the agent's and the page's one way to carry O1 between observations", () => {
    type C = "sl" | "tp" | "time" | "sltp" | "none" | "latched" | "latched_tp";
    const COND: Record<C, Partial<MarketState>> = { sl: SL, tp: TP, time: TIME, sltp: { ...SL, ...TP }, none: {}, latched: { closedBy: "stop_loss" }, latched_tp: { closedBy: "stop_loss", ...TP } };
    // One observation: its block, which condition holds there, and the settled-from block (default 0).
    type Obs = readonly [number, C, number?];
    const stateAt = ([block, c]: Obs, cf: number | null = null): MarketState => st({ ...COND[c], block, nowS: c === "time" ? 433_000 : 10_000, confirmFromBlock: cf });
    // Walks the observations the way the agent does: the run after each, and evaluate's decision with its O1.
    const walk = (obs: readonly Obs[]) => {
      let run: ConfirmRun | null = null;
      return obs.map((o) => {
        run = nextConfirmRun(R, stateAt(o), run, o[2] ?? 0);
        return { run, d: evaluate(R, stateAt(o, run?.fromBlock ?? null)) };
      });
    };
    const froms = (r: ReturnType<typeof walk>) => r.map((x) => x.run?.fromBlock ?? null);
    const kinds = (r: ReturnType<typeof walk>) => r.map((x) => x.d.kind);
    it("starts at the first true observation and closes at the margin, not one block before", () => {
      const r = walk([[1000, "sl"], [1020, "sl"], [1039, "sl"], [1040, "sl"]]);
      expect(froms(r)).toEqual([1000, 1000, 1000, 1000]);
      expect(kinds(r)).toEqual(["hold", "hold", "hold", "close"]);
      expect(r[3]!.run).toEqual({ fromBlock: 1000, reason: "stop_loss" });
    });
    it("restarts after a false reading: true, false, true counts from the second true", () => {
      const r = walk([[1000, "sl"], [1030, "none"], [1035, "sl"], [1070, "sl"], [1075, "sl"]]);
      expect(froms(r)).toEqual([1000, null, 1035, 1035, 1035]);
      expect(kinds(r)).toEqual(["hold", "hold", "hold", "hold", "close"]);
    });
    it("restarts from the latest true observation once the span would pass CONFIRM_MAX_BLOCKS", () => {
      expect(froms(walk([[1000, "sl"], [1400, "sl"]]))).toEqual([1000, 1000]);
      const r = walk([[1000, "sl"], [1401, "sl"], [1441, "sl"]]);
      expect(froms(r)).toEqual([1000, 1401, 1401]);
      expect(kinds(r)).toEqual(["hold", "hold", "close"]);
    });
    it("keeps O1 across a change between stop loss and take profit: some close was due throughout (D53, re-audit security M-1)", () => {
      const r = walk([[1000, "tp"], [1050, "sl"], [1089, "sl"], [1090, "sl"]]);
      expect(froms(r)).toEqual([1000, 1000, 1000, 1000]);
      expect(kinds(r)).toEqual(["hold", "close", "close", "close"]);
      expect(r.map((x) => x.run?.reason)).toEqual(["take_profit", "stop_loss", "stop_loss", "stop_loss"]);
      expect(r[1]!.d).toEqual({ kind: "close", reason: "stop_loss" });
      // Alternating every 30 blocks still confirms at the margin (re-audit security L-1 of the fix).
      const alt = walk([[1000, "sltp"], [1030, "tp"], [1060, "sltp"]]);
      expect(froms(alt)).toEqual([1000, 1000, 1000]);
      expect(alt[2]!.d).toEqual({ kind: "close", reason: "stop_loss" });
      expect(froms(walk([[1000, "sl"], [1050, "tp"]]))).toEqual([1000, 1000]);
    });
    it("keeps O1 when the time condition becomes true during a stop-loss confirmation, and closes for time", () => {
      const r = walk([[1000, "sl"], [1040, "time"]]);
      expect(r[1]!.run).toEqual({ fromBlock: 1000, reason: "time" });
      expect(r[1]!.d).toEqual({ kind: "close", reason: "time" });
    });
    it("restarts when a later payout or lock makes O1 unsettled, so the contract won't refuse it (security L-1)", () => {
      // A payout callback at 1010 makes blocks before 1050 unsettled.
      const r = walk([[1000, "sl", 0], [1060, "sl", 1050], [1099, "sl", 1050], [1100, "sl", 1050]]);
      expect(froms(r)).toEqual([1000, 1060, 1060, 1060]);
      expect(kinds(r)).toEqual(["hold", "hold", "hold", "close"]);
      // O1 exactly at the settled block is kept.
      expect(froms(walk([[1050, "sl", 0], [1090, "sl", 1050]]))).toEqual([1050, 1050]);
      expect(() => nextConfirmRun(R, stateAt([1049, "sl"]), null, 1050)).toThrow("STATE: settledFromBlock must be an integer between 0 and 1049");
    });
    it("is null whenever no condition holds, and the latched closedBy counts as holding", () => {
      expect(nextConfirmRun(R, st({ block: 2000, confirmFromBlock: null }), { fromBlock: 1500, reason: "stop_loss" }, 0)).toBeNull();
      expect(nextConfirmRun(R, st({ closedBy: "stop_loss", block: 2000, confirmFromBlock: null }), null, 0)).toEqual({ fromBlock: 2000, reason: "stop_loss" });
      expect(nextConfirmRun(R, st({ closedBy: "stop_loss", block: 2000, confirmFromBlock: null }), { fromBlock: 1990, reason: "stop_loss" }, 0)).toEqual({ fromBlock: 1990, reason: "stop_loss" });
    });
    it.each([
      ["a bad state", st({ block: 10, confirmFromBlock: 11 }), null, 0, "confirmFromBlock must be an integer between 0 and 10"],
      ["a null state", null, null, 0, "state must be an object"],
      ["prev after the block", st({ ...SL, block: 10, confirmFromBlock: null }), { fromBlock: 11, reason: "stop_loss" }, 0, "prev.fromBlock must be an integer between 0 and 10"],
      ["prev with an unknown reason", st({ ...SL, block: 10, confirmFromBlock: null }), { fromBlock: 1, reason: "bored" }, 0, "prev.reason must be a close reason"],
      ["prev not an object", st({ ...SL, block: 10, confirmFromBlock: null }), 5, 0, "prev must be a confirmation run or null"],
      ["settled-from not an integer", st({ ...SL, block: 10, confirmFromBlock: null }), null, 1.5, "settledFromBlock must be an integer"],
    ] as const)("refuses %s", (_n, s, prev, settled, msg) => {
      expect(() => nextConfirmRun(R, s as never, prev as never, settled as number)).toThrow(`STATE: ${msg}`);
    });
    const arbObs = fc.array(fc.tuple(fc.integer({ min: 1, max: 60 }), fc.constantFrom<C>("sl", "tp", "time", "sltp", "none", "none")), { minLength: 1, maxLength: 40 })
      // Time stays due once it is (it only grows), so its timestamps never go back (EC-W24).
      .map((steps) => { let b = 5_000, timed = false; return steps.map(([g, c]) => { b += g; timed ||= c === "time"; return [b, timed ? "time" : c] as Obs; }); });
    it("never closes on a single observation, and only closes when some condition held at every observation from O1 (property)", () => {
      let closes = 0;
      fc.assert(fc.property(arbObs, (obs) => {
        walk(obs).forEach((x, i) => {
          if (x.d.kind !== "close") return;
          closes++;
          const from = x.run!.fromBlock;
          const span = obs[i]![0] - from;
          expect(span).toBeGreaterThanOrEqual(OFFCHAIN_MARGIN_BLOCKS);
          expect(span).toBeLessThanOrEqual(CONFIRM_MAX_BLOCKS);
          const window = obs.slice(0, i + 1).filter(([b]) => b >= from);
          expect(window.length).toBeGreaterThanOrEqual(2);
          expect(window[0]![0]).toBe(from);
          // Every observation held a condition, and the reason is the one due at O2.
          expect(window.every(([, c]) => c !== "none")).toBe(true);
          const reason = (x.d as { reason: CloseReason }).reason;
          const first = (c: C) => (c === "sltp" || c === "sl" || c === "latched" || c === "latched_tp" ? "stop_loss" : c === "tp" ? "take_profit" : c);
          expect(reason).toBe(first(obs[i]![1]));
        });
      }), { numRuns: 3000 });
      expect(closes).toBeGreaterThan(300);
    });

    describe("checkConfirmation (EC-W22): O1, the grid between and O2, one replay for the agent and the page", () => {
      // Grid states: each window's start block, with the condition of the latest observation at or before it (an honest market).
      const grid = (obs: readonly Obs[], o1 = obs[0]![0], o2 = obs[obs.length - 1]![0], c?: C) =>
        confirmGrid(o1, o2).map((b) => stateAt([b, c ?? ([...obs].reverse().find(([ob]) => ob <= b)?.[1] ?? obs[0]![1])]));
      const cc = (obs: readonly Obs[], over: Partial<ConfirmationInput> = {}) =>
        checkConfirmation(R, { o1: stateAt(obs[0]!), o2: stateAt(obs[obs.length - 1]!), settledFromBlock: 0, ...over, grid: "grid" in over ? over.grid! : grid(obs) });
      it("accepts an honest confirmation and returns its run", () => {
        expect(cc([[1000, "sl"], [1040, "sl"]])).toEqual({ ok: true, run: { fromBlock: 1000, reason: "stop_loss" } });
        expect(cc([[1000, "sl"], [1040, "time"]])).toEqual({ ok: true, run: { fromBlock: 1000, reason: "time" } });
        expect(cc([[1000, "tp"], [1040, "sl"]])).toEqual({ ok: true, run: { fromBlock: 1000, reason: "stop_loss" } });
      });
      it("accepts a latched retry whose live condition has gone false, the latch winning over a live take profit (EC-W22)", () => {
        expect(cc([[2000, "latched"], [2040, "latched"]])).toEqual({ ok: true, run: { fromBlock: 2000, reason: "stop_loss" } });
        expect(cc([[2000, "latched_tp"], [2040, "latched_tp"]])).toEqual({ ok: true, run: { fromBlock: 2000, reason: "stop_loss" } });
      });
      it.each([
        ["an O1 where no condition holds (forged O1)", [[1000, "none"], [1040, "sl"]], {}, "no close condition holds at block 1000"],
        ["an O2 where no condition holds", [[1000, "sl"], [1040, "none"]], {}, "no close condition holds at block 1040"],
        ["a span one block short", [[1000, "sl"], [1039, "sl"]], {}, "the confirmation span is out of bounds"],
        ["a zero span", [[1000, "sl"], [1000, "sl"]], {}, "the confirmation span is out of bounds"],
        ["a span one block too long", [[1000, "sl"], [1401, "sl"]], {}, "the confirmation restarted at block 1401"],
        ["an O1 before the settled block", [[1000, "sl"], [1040, "sl"]], { settledFromBlock: 1001 }, "O1 is before the settled block"],
        ["an O2 inside the payout margin, as a verdict, not a throw", [[1000, "sl"], [1040, "sl"]], { settledFromBlock: 1041 }, "O2 is inside the payout margin"],
        ["O1 after O2", [[1040, "sl"], [1000, "sl"]], { grid: [] }, "O1 is after O2"],
      ] as const)("refuses %s", (_n, obs, over, reason) => {
        expect(cc(obs as readonly Obs[], over as Partial<ConfirmationInput>)).toEqual({ ok: false, reason });
      });
      it.each([
        ["the window in the middle", [[1000, "sl"], [1040, "sl"]], 1020],
        ["the window next to O1", [[999, "sl"], [1059, "sl"]], 1000],
        ["the window next to O2", [[999, "sl"], [1059, "sl"]], 1040],
      ] as const)("refuses a close whose endpoints hold when the grid state in %s doesn't (security M-2, test M-1)", (_n, obs, bad) => {
        const g = grid(obs as readonly Obs[]).map((x) => (x.block === bad ? stateAt([bad, "none"]) : x));
        expect(cc(obs as readonly Obs[], { grid: g })).toEqual({ ok: false, reason: `no close condition holds at block ${bad}` });
        expect(cc(obs as readonly Obs[], { grid: [...g].reverse() })).toEqual({ ok: false, reason: `no close condition holds at block ${bad}` });
      });
      it("requires the states at exactly the window starts, one each (re-audit security F2, L-3; test F1, G2)", () => {
        const msg = "STATE: grid must hold the states at exactly confirmGrid(O1, O2)";
        for (const g of [[1019], [1021], [1039], [1040], []]) {
          expect(() => cc([[1000, "sl"], [1040, "sl"]], { grid: g.map((b) => stateAt([b, "sl"])) })).toThrow(msg);
        }
        // O1 999, O2 1050: windows 1000, 1020, 1040; a state at or past O2 for the last window is refused.
        for (const g of [[1000, 1020, 1050], [1000, 1020, 1055], [1000, 1020], [1000, 1020, 1040, 1041], [1000, 1010, 1040], [1000, 1020, 1040, 1040], [1000, 1020, 1020]]) {
          expect(() => cc([[999, "sl"], [1050, "sl"]], { grid: g.map((b) => stateAt([b, "sl"])) })).toThrow(msg);
        }
        expect(cc([[999, "sl"], [1050, "sl"]], { grid: [1000, 1020, 1040].map((b) => stateAt([b, "sl"])) }).ok).toBe(true);
      });
      it("judges O1 and O2 before the grid, so a forged close is \"not matching\" even with a malformed grid (re-audit security F1)", () => {
        expect(cc([[1000, "none"], [1041, "sl"]], { grid: [stateAt([1020, "sl"])] })).toEqual({ ok: false, reason: "no close condition holds at block 1000" });
        expect(cc([[1000, "sl"], [1041, "none"]], { grid: [] })).toEqual({ ok: false, reason: "no close condition holds at block 1041" });
      });
      it("uses the fixed grid: every multiple of DENSE_STEP_BLOCKS strictly between O1 and O2", () => {
        expect(confirmGrid(1000, 1040)).toEqual([1020]);
        expect(confirmGrid(999, 1059)).toEqual([1000, 1020, 1040]);
        expect(confirmGrid(1000, 1020)).toEqual([]);
        expect(confirmGrid(1000, 1000)).toEqual([]);
        expect(confirmGrid(1000, 1400)).toHaveLength(19);
        expect(confirmGrid(1000, 1401)).toEqual([]);
        expect(() => confirmGrid(1000, 999)).toThrow("STATE: o2Block must be an integer between 1000");
        expect(() => confirmGrid(-1, 5)).toThrow("STATE: o1Block must be an integer");
      });
      it("accepts the span at exactly the margin and at exactly CONFIRM_MAX_BLOCKS, and O1 at the settled block", () => {
        expect(cc([[1000, "tp"], [1040, "tp"]]).ok).toBe(true);
        expect(cc([[1000, "tp"], [1400, "tp"]]).ok).toBe(true);
        expect(cc([[1000, "tp"], [1040, "tp"]], { settledFromBlock: 1000 }).ok).toBe(true);
        expect(cc([[1000, "tp"], [1040, "tp"]], { settledFromBlock: 1040 })).toEqual({ ok: false, reason: "O1 is before the settled block" });
      });
      it("throws only on malformed input, timestamps going back included (EC-W24)", () => {
        expect(() => checkConfirmation(R, null as never)).toThrow("STATE: confirmation input must be an object");
        expect(() => cc([[1000, "sl"], [1040, "sl"]], { grid: null as never })).toThrow("STATE: grid must be an array");
        expect(() => cc([[1000, "sl"], [1040, "sl"]], { o1: null as never })).toThrow("STATE: state must be an object");
        expect(() => cc([[1000, "sl"], [1040, "sl"]], { settledFromBlock: -1 })).toThrow("STATE: settledFromBlock must be an integer");
        expect(() => cc([[1000, "sl"], [1040, "sl"]], { grid: [{ ...stateAt([1020, "sl"]), point: 1.5 }] })).toThrow("STATE: point must be an integer");
        expect(() => cc([[1000, "sl"], [1040, "sl"]], { grid: [{ ...stateAt([1020, "sl"]), nowS: 9_000 }] })).toThrow("STATE: state timestamps must not decrease");
      });
      it("refuses a true O1 and O2 with one false grid state between, at exactly that block, whatever the conditions (property, test F1)", () => {
        fc.assert(fc.property(fc.integer({ min: 0, max: 50_000 }), fc.integer({ min: 40, max: 400 }), fc.nat(), fc.constantFrom<C>("sl", "tp", "sltp", "latched"), (o1, span, pick, c) => {
          const o2 = o1 + span;
          const blocks = confirmGrid(o1, o2);
          if (blocks.length === 0) return;
          const bad = blocks[pick % blocks.length]!;
          const g = blocks.map((b) => stateAt([b, b === bad ? "none" : c]));
          expect(checkConfirmation(R, { o1: stateAt([o1, c]), o2: stateAt([o2, c]), grid: g, settledFromBlock: 0 })).toEqual({ ok: false, reason: `no close condition holds at block ${bad}` });
          // And with that state true, it is accepted.
          expect(checkConfirmation(R, { o1: stateAt([o1, c]), o2: stateAt([o2, c]), grid: blocks.map((b) => stateAt([b, c])), settledFromBlock: 0 }).ok).toBe(true);
        }), { numRuns: 2000 });
      });
      it("accepts the grid walks where the agent's own walk closes (property)", () => {
        let agreed = 0;
        fc.assert(fc.property(arbObs, (obs) => {
          // The agent carries its confirmation over grid states only: here, observations at multiples of 20 and its O2.
          const gridObs = obs.filter(([b], k) => b % DENSE_STEP_BLOCKS === 0 || k === obs.length - 1);
          const dedup = gridObs.filter(([b], k) => k === 0 || Math.floor(b / DENSE_STEP_BLOCKS) !== Math.floor(gridObs[k - 1]![0] / DENSE_STEP_BLOCKS) || k === gridObs.length - 1);
          const r = walk(dedup);
          const last = r[r.length - 1]!;
          if (last.d.kind !== "close") return;
          const from = last.run!.fromBlock;
          const window = dedup.filter(([b]) => b >= from);
          const o2 = window[window.length - 1]!;
          const g = confirmGrid(from, o2[0]).map((w) => stateAt([w, [...window].reverse().find(([b]) => b <= w)![1]]));
          expect(checkConfirmation(R, { o1: stateAt(window[0]!), o2: stateAt(o2), grid: g, settledFromBlock: 0 })).toEqual({ ok: true, run: last.run });
          agreed++;
        }), { numRuns: 5000 });
        expect(agreed).toBeGreaterThan(50);
      });
    });
  });

  describe("missedClose (EC-W23, D53): no excuses, a fixed allowance, grid samples only", () => {
    // Allowance: CONFIRM_MAX_BLOCKS + age = 410 blocks and MISSED_CLOSE_GRACE_S = 180 s past the anchor.
    const L: MissedCloseLimits = { maxObservationAgeBlocks: 10, minActionIntervalS: 300, maxActionsPer24h: 6, agentLocks: [], closes: [], endBlock: 0, endS: 0 };
    const T = CONFIRM_MAX_BLOCKS + L.maxObservationAgeBlocks;
    // A sample at block b, one second per block from block 0 at second 1,000,000 unless told otherwise.
    // The run started 100,000 s before each sample (well inside close_after_s), so time isn't due unless a test says so.
    const at2 = (b: number, o: Partial<MarketState> = SL, t?: number): Sample => {
      const nowS = t ?? 1_000_000 + b;
      return { state: st({ startedAtS: Math.max(0, nowS - 100_000), ...o, block: b, nowS, confirmFromBlock: null }) };
    };
    // Grid samples every DENSE_STEP_BLOCKS from `from` (a multiple of 20) to `to`.
    const seq = (from: number, to: number, o: Partial<MarketState> = SL): Sample[] => {
      const out: Sample[] = [];
      for (let b = from; b <= to; b += DENSE_STEP_BLOCKS) out.push(at2(b, o));
      return out;
    };
    const open = (ts: number): AgentLock => ({ ts, close: false });
    const closeLock = (ts: number): AgentLock => ({ ts, close: true });
    // By default the judged range ends at the last sample (no trailing gap).
    const mc = (samples: Sample[], over: Partial<MissedCloseLimits> = {}) => {
      const last = samples.length > 0 && samples[samples.length - 1] !== null && typeof samples[samples.length - 1] === "object" ? samples[samples.length - 1]!.state : null;
      const end = last && typeof last === "object" && typeof last.block === "number" && last.block >= 0 ? { endBlock: last.block, endS: last.nowS } : { endBlock: 0, endS: 0 };
      return missedClose(R, samples, { ...L, ...end, ...over });
    };
    const miss = (fromBlock: number, toBlock: number, reason: CloseReason = "stop_loss") => [{ kind: "missed", reason, fromBlock, toBlock }];
    // Readings for the 20 heights of a window: quiet everywhere, settled from `from` (read at each height) unless told otherwise.
    const win = (from: number | ((k: number) => number), quiet: (k: number) => boolean = () => true): HeightState[] =>
      Array.from({ length: DENSE_STEP_BLOCKS }, (_x, k) => ({ quiet: quiet(k), settledFromBlock: typeof from === "number" ? from : from(k) }));
    it("samples each window at its gridPoint: the first quiet height at or after its own settled-from block, else none (EC-W21, EC-W27)", () => {
      expect(gridPoint(1000, win(0))).toBe(1000);
      expect(gridPoint(1000, win(1000))).toBe(1000);
      expect(gridPoint(1000, win(1019))).toBe(1019);
      expect(gridPoint(1000, win(1020))).toBeNull();
      expect(gridPoint(0, win(0))).toBe(0);
      expect(gridPoint(0, win(19))).toBe(19);
      expect(gridPoint(0, win(20))).toBeNull();
      expect(gridPoint(0, win(Number.MAX_SAFE_INTEGER))).toBeNull();
      // A callback inside the window moves the settled-from block read at later heights: 1015 is settled at 1000's
      // reading but not at its own, so the sample moves to 1050's window start... here, none in the window (test F2).
      expect(gridPoint(1000, win((k) => (k < 10 ? 1015 : 1050)))).toBeNull();
      expect(gridPoint(1000, win((k) => (k < 10 ? 1015 : 1012)))).toBe(1012);
      // A lock held across the start: the first quiet height after it (security L-1).
      expect(gridPoint(1000, win(0, (k) => k >= 7))).toBe(1007);
      expect(gridPoint(1000, win(0, () => false))).toBeNull();
    });
    it.each([
      ["a window start not a multiple of 20", 1001, win(0), "windowStart must be a multiple of DENSE_STEP_BLOCKS"],
      ["a negative window start", -20, win(0), "windowStart must be an integer"],
      ["a fractional window start", 1000.5, win(0), "windowStart must be an integer"],
      ["too few readings", 1000, win(0).slice(1), "heights must hold one reading per height of the window"],
      ["not an array", 1000, null, "heights must hold one reading per height of the window"],
      ["a reading without quiet", 1000, [{ settledFromBlock: 0 }, ...win(0).slice(1)], "each height reading must be { quiet, settledFromBlock }"],
      ["a fractional settled-from", 1000, [{ quiet: true, settledFromBlock: 1.5 }, ...win(0).slice(1)], "settledFromBlock must be an integer between 0 and 9007199254740991"],
      ["a settled-from of -1", 1000, [{ quiet: true, settledFromBlock: -1 }, ...win(0).slice(1)], "settledFromBlock must be an integer between 0 and 9007199254740991"],
      ["a settled-from of -0", 1000, [{ quiet: true, settledFromBlock: -0 }, ...win(0).slice(1)], "settledFromBlock must be an integer between 0 and 9007199254740991"],
      ["a settled-from past the maximum", 1000, [{ quiet: true, settledFromBlock: Number.MAX_SAFE_INTEGER + 1 }, ...win(0).slice(1)], "settledFromBlock must be an integer between 0 and 9007199254740991"],
      ["a settled-from that is a string", 1000, [{ quiet: true, settledFromBlock: "5" }, ...win(0).slice(1)], "settledFromBlock must be an integer between 0 and 9007199254740991"],
      ["21 readings", 1000, [...win(0), { quiet: true, settledFromBlock: 0 }], "heights must hold one reading per height of the window"],
      ["a null reading", 1000, [null, ...win(0).slice(1)], "each height reading must be { quiet, settledFromBlock }"],
      ["a bad reading behind a good first one (test L-5)", 1000, [...win(0).slice(0, 19), { quiet: "yes", settledFromBlock: 0 }], "each height reading must be { quiet, settledFromBlock }"],
      ["a fractional settled-from at the last height", 1000, [...win(0).slice(0, 19), { quiet: true, settledFromBlock: 0.5 }], "settledFromBlock must be an integer between 0 and 9007199254740991"],
      ["a window start one window past the maximum", MAX_WINDOW_START + 20, win(0), "windowStart must be an integer between 0 and 9007199254740960"],
    ] as const)("gridPoint refuses %s", (_n, ws, h, msg) => {
      expect(() => gridPoint(ws, h as never)).toThrow(`STATE: ${msg}`);
    });
    it("accepts the last safe window and returns its last height (test L-3)", () => {
      expect(MAX_WINDOW_START).toBe(9_007_199_254_740_960);
      expect(gridPoint(MAX_WINDOW_START, win(MAX_WINDOW_START + 19))).toBe(9_007_199_254_740_979);
      expect(Number.isSafeInteger(MAX_WINDOW_START + 19)).toBe(true);
    });
    it("is the first quiet height at or after its own settled-from block, and null only when there is none (property, EC-W27)", () => {
      fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), fc.array(fc.record({ quiet: fc.boolean(), settledFromBlock: fc.integer({ min: 0, max: 20_000_100 }) }), { minLength: 20, maxLength: 20 }), (k, h) => {
        const ws = 20 * k;
        const hs = h.map((x, i) => ({ quiet: x.quiet, settledFromBlock: x.settledFromBlock % 3 === 0 ? ws + (x.settledFromBlock % 25) : x.settledFromBlock % 2 === 0 ? 0 : ws + 30 + i }));
        const ok = (i: number) => hs[i]!.quiet && hs[i]!.settledFromBlock <= ws + i;
        const got = gridPoint(ws, hs);
        const first = hs.findIndex((_x, i) => ok(i));
        expect(got).toBe(first === -1 ? null : ws + first);
      }), { numRuns: 2000 });
    });
    it("gives gaps, not a throw, for a payout window over two grid windows, and the stretch is still missed (EC-W21)", () => {
      const pts: Sample[] = [];
      for (let w = 1000; w <= 1500; w += 20) {
        const b = gridPoint(w, win(w >= 1100 && w < 1145 ? 1145 : 0));
        if (b !== null) pts.push(at2(b));
      }
      const want = [];
      for (let w = 1000; w <= 1080; w += 20) want.push(w);
      want.push(1145);
      for (let w = 1160; w <= 1500; w += 20) want.push(w);
      expect(pts.map((x) => x.state.block)).toEqual(want);
      expect(mc(pts)).toEqual(miss(1000, 1500));
    });
    it("counts gaps from an outsider's payout window inside a stretch toward the allowance: at it nothing, one block past it a late close (T71, test L-1)", () => {
      // Stop loss from 1000; an outsider's payout at 1360 leaves windows 1360 and 1380 with no settled height.
      const pts = (o2: number): Sample[] => {
        const out: Sample[] = [];
        for (let w = 1000; w < o2; w += 20) { const b = gridPoint(w, win(w >= 1360 && w < 1400 ? 1400 : 0)); if (b !== null) out.push(at2(b)); }
        return [...out, at2(o2)];
      };
      expect(pts(1410).map((x) => x.state.block)).not.toContain(1360);
      expect(mc(pts(1000 + T), { closes: [{ o2Block: 1000 + T, resultBlock: 1000 + T + 2 }] })).toEqual([]);
      expect(mc(pts(1000 + T + 1), { closes: [{ o2Block: 1000 + T + 1, resultBlock: 1000 + T + 3 }] })).toEqual([{ kind: "late_close", reason: "stop_loss", fromBlock: 1000, toBlock: 1000 + T + 1 }]);
    });
    it("uses the stated constants", () => {
      expect(DENSE_STEP_BLOCKS).toBe(20);
      expect(AGENT_OBSERVE_INTERVAL_S).toBe(60);
      expect(MISSED_CLOSE_GRACE_S).toBe(180);
    });
    it("counts a stretch held one block past the block allowance, not one held exactly to it (a window's sample may sit anywhere in it)", () => {
      expect(mc([...seq(1000, 1380), at2(1000 + T)])).toEqual([]);
      expect(mc([...seq(1000, 1380), at2(1000 + T + 1)])).toEqual(miss(1000, 1411));
    });
    it("needs the seconds too: exactly MISSED_CLOSE_GRACE_S isn't counted, one second more is", () => {
      expect(mc([at2(1000, SL, 5_000), at2(1000 + T + 1, SL, 5_000 + MISSED_CLOSE_GRACE_S)])).toEqual([]);
      expect(mc([at2(1000, SL, 5_000), at2(1000 + T + 1, SL, 5_000 + MISSED_CLOSE_GRACE_S + 1)])).toEqual(miss(1000, 1411));
    });
    it("finds a stop loss held for two hours, and for three days, with no close", () => {
      expect(mc([at2(980, {}), ...seq(1000, 8200)])).toEqual(miss(1000, 8200));
      expect(mc(seq(0, 3 * 86_400))).toEqual(miss(0, 259_200));
    });
    it("lets nothing anyone sends end a stretch: gaps of any width, close attempts, refused closes (D53)", () => {
      expect(mc([...seq(1000, 1200), at2(1221), at2(1300), ...seq(1800, 1900)])).toEqual(miss(1000, 1900));
      expect(mc(seq(1000, 1900), { agentLocks: [closeLock(1_001_100), closeLock(1_001_400), closeLock(1_001_700)] })).toEqual(miss(1000, 1900));
    });
    it("measures from the agent's last non-close lock plus the interval, exact to the block (security M-1, test M-2)", () => {
      // An open lock at second 1,000,980, interval 3,600 s: the agent can act from second 1,004,580, block 4580.
      // A sample at 4579 (its own window) and one at 4580 make an anchor one block early show.
      const lim = { minActionIntervalS: 3600, agentLocks: [open(1_000_980)] };
      const base = [...seq(1000, 4540), at2(4579), ...seq(4580, 4960)];
      expect(mc([...base, at2(4580 + T)], lim)).toEqual([]);
      expect(mc([...base, at2(4580 + T + 1)], lim)).toEqual(miss(1000, 4991));
    });
    it("never lets the agent's close attempts inside a stretch fill the 24-hour count and move the anchor (test G1, G4)", () => {
      const six = [1, 2, 3, 4, 5, 6].map((k) => closeLock(1_001_000 + 100 * k));
      expect(mc(seq(1000, 1900), { agentLocks: six })).toEqual(miss(1000, 1900));
      // Five earlier locks plus a close attempt at the first sample's second fill the count: the anchor moves to the freed slot.
      const t0 = 1_001_000;
      const five = [t0 - 86_000, t0 - 80_000, t0 - 60_000, t0 - 40_000, t0 - 20_000].map(open);
      expect(mc([...seq(1000, 1360), at2(1399), ...seq(1400, 1780), at2(1400 + T)], { agentLocks: [...five, closeLock(t0)] })).toEqual([]);
      expect(mc([...seq(1000, 1360), at2(1399), ...seq(1400, 1780), at2(1400 + T)], { agentLocks: [...five, closeLock(t0 + 1)] })).toEqual(miss(1000, 1810));
    });
    it("counts a non-close lock at the stretch's first second, and never a close attempt (re-audit security F1, test F3)", () => {
      expect(mc(seq(1000, 1420), { minActionIntervalS: 3600, agentLocks: [open(1_001_000)] })).toEqual([]);
      expect(mc(seq(1000, 1420), { minActionIntervalS: 3600, agentLocks: [closeLock(1_001_000)] })).toEqual(miss(1000, 1420));
      expect(mc(seq(1000, 1420), { minActionIntervalS: 3600, agentLocks: [open(1_001_001)] })).toEqual(miss(1000, 1420));
    });
    it("uses the last of a swap and an open, not the first (EC-W26, test G3)", () => {
      const s = [at2(900, {}), ...seq(1000, 4960), at2(4970)];
      expect(mc(s, { minActionIntervalS: 3600, agentLocks: [open(1_000_900), open(1_000_960)], closes: [{ o2Block: 4970, resultBlock: 4972 }] })).toEqual([]);
    });
    it("doesn't blame an honest agent whose open lands just before a stop loss comes due (EC-W26, re-audit security F1)", () => {
      // Open at block 960 (second 1,000,960); its margin ends at 1000, where the stop loss is first seen;
      // the contract allows the close from second 1,004,560; the agent closes at 4660, landing at 4662.
      const close = { o2Block: 4660, resultBlock: 4662 };
      const s = [at2(940, {}), ...seq(1000, 4640), at2(4660), at2(4662)];
      expect(mc(s, { minActionIntervalS: 3600, agentLocks: [open(1_000_960)], closes: [close] })).toEqual([]);
    });
    it("measures from the freed 24-hour slot, exact to the block, and not when the oldest lock is exactly 24 hours old", () => {
      const t0 = 1_001_000;
      // Six locks in the last day, the oldest 86,000 s before the stretch: a slot frees at second t0 + 400, block 1400.
      const acts = [t0 - 86_000, t0 - 80_000, t0 - 60_000, t0 - 40_000, t0 - 20_000, t0 - 10_000].map(open);
      const base = [...seq(1000, 1360), at2(1399), ...seq(1400, 1780)];
      expect(mc([...base, at2(1400 + T)], { agentLocks: acts })).toEqual([]);
      expect(mc([...base, at2(1400 + T + 1)], { agentLocks: acts })).toEqual(miss(1000, 1811));
      // The oldest exactly 86,400 s before: out of the window, so a slot is free and the plain allowance applies.
      const edge = [open(t0 - 86_400), ...acts.slice(1)];
      expect(mc([...seq(1000, 1380), at2(1000 + T + 1)], { agentLocks: edge })).toEqual(miss(1000, 1411));
      // (Whether `>` or `>=` at exactly 86,400 s is pinned by the lock-list check below, test G8.)
      // Close locks count toward the 24-hour count too.
      const closes6 = acts.map((l) => closeLock(l.ts));
      expect(mc([...base, at2(1400 + T)], { agentLocks: closes6 })).toEqual([]);
    });
    it("blames nothing for a condition that came and went before the agent could act (test M-3)", () => {
      expect(mc([...seq(1000, 1500), at2(1520, {})], { agentLocks: [open(1_000_970)], minActionIntervalS: 3600 })).toEqual([]);
    });
    it("is not reset by a lock every T - 20 blocks inside the stretch (EC-W23)", () => {
      const locks = [1, 2, 3, 4].map((k) => closeLock(1_001_000 + k * (T - 20)));
      expect(mc(seq(1000, 3060), { agentLocks: locks, maxActionsPer24h: 48 })).toEqual(miss(1000, 3060));
    });
    it("calls a successful close past the allowance a late close, judged at its O2, and one inside it nothing", () => {
      expect(mc([...seq(1000, 1420), at2(1430), at2(1441)], { closes: [{ o2Block: 1430, resultBlock: 1441 }] })).toEqual([{ kind: "late_close", reason: "stop_loss", fromBlock: 1000, toBlock: 1430 }]);
      expect(mc([...seq(1000, 1100), at2(1101)], { closes: [{ o2Block: 1100, resultBlock: 1102 }] })).toEqual([]);
    });
    it("covers the samples from a close's O2 to its result block, so an honest close leaves no stray finding", () => {
      expect(mc([...seq(1000, 1100), at2(1110), at2(1120, {})], { closes: [{ o2Block: 1100, resultBlock: 1125 }] })).toEqual([]);
      expect(mc([at2(1100)], { closes: [{ o2Block: 1100, resultBlock: 1101 }] })).toEqual([]);
    });
    it("takes only successful closes: with close attempts but none in `closes`, the stretch is missed (EC-W25 is the page's filtering)", () => {
      expect(mc(seq(1000, 1820), { agentLocks: [closeLock(1_001_100), closeLock(1_001_400)] })).toEqual(miss(1000, 1820));
    });
    it("calls one true sample alone \"single\" (can't check), and a two-sample stretch nothing", () => {
      expect(mc([at2(980, {}), at2(1000), at2(1020, {})])).toEqual([{ kind: "single", reason: "stop_loss", fromBlock: 1000, toBlock: 1000 }]);
      expect(mc([...seq(1000, 1020), at2(1040, {})])).toEqual([]);
    });
    it("continues a stretch across a change of condition, reporting the one due at its end (D53)", () => {
      expect(mc([...seq(1000, 1200, TP), ...seq(1220, 1440)])).toEqual(miss(1000, 1440));
      // Stop loss crossing back and forth every 300 blocks while take profit holds, for six hours.
      const alt: Sample[] = [];
      for (let b = 1000; b <= 1000 + 6 * 3600; b += DENSE_STEP_BLOCKS) alt.push(at2(b, Math.floor((b - 1000) / 300) % 2 === 0 ? { ...SL, ...TP } : TP));
      expect(mc(alt)).toEqual(miss(1000, 22_600));
      expect(mc(alt.slice(0, -15))).toEqual(miss(1000, 22_300, "take_profit"));
      const toTime = [...seq(1000, 1200).map((x) => ({ state: { ...x.state, startedAtS: 0, nowS: 430_000 + x.state.block } })),
        ...seq(1220, 1440).map((x) => ({ state: { ...x.state, startedAtS: 0, nowS: 432_000 + x.state.block } }))];
      expect(mc(toTime)).toEqual(miss(1000, 1440, "time"));
    });
    it("takes grid samples only: a second sample in a window (an agent's own observation) is refused (re-audit security F3, test G5)", () => {
      const msg = "STATE: samples must be at most one per grid window, besides each close's O2";
      expect(() => mc([...seq(1000, 1200), at2(1210, {}), ...seq(1220, 1440)])).toThrow(msg);
      // After a close's O2 in a window, a grid sample there and another in the same window are still one too many.
      expect(() => mc([at2(1000), at2(1005), at2(1010, {})], { closes: [{ o2Block: 1005, resultBlock: 1030 }] })).toThrow(msg);
      // Doubled in the window just before a close's O2.
      expect(() => mc([at2(1000), at2(1010), at2(1025)], { closes: [{ o2Block: 1025, resultBlock: 1030 }] })).toThrow(msg);
    });
    it("finds a recorded stop loss that never runs: latched, position held, live condition gone", () => {
      expect(mc(seq(1000, 1500, { closedBy: "stop_loss" }))).toEqual(miss(1000, 1500));
      expect(mc(seq(1000, 1500, { closedBy: "stop_loss", ...TP }))[0]!.reason).toBe("stop_loss");
    });
    it("ignores samples with no position: nothing to close", () => {
      expect(mc(seq(1000, 1000 + 2 * T, { ...SL, position: null }))).toEqual([]);
    });
    it.each([
      ["non-array samples", 5, {}, "samples must be an array"],
      ["negative age", [], { maxObservationAgeBlocks: -1 }, "maxObservationAgeBlocks must be an integer"],
      ["fractional interval", [], { minActionIntervalS: 0.5 }, "minActionIntervalS must be an integer"],
      ["no actions allowed a day", [], { maxActionsPer24h: 0 }, "maxActionsPer24h must be an integer between 1"],
      ["locks out of order", [], { agentLocks: [open(5), open(4)] }, "agentLocks must be in time order"],
      ["seven locks in a day with a cap of six", [], { agentLocks: [0, 10, 20, 30, 40, 50, 86_399].map(open) }, "agentLocks has more locks in 24 hours than maxActionsPer24h allows"],
      ["a lock without a kind", [], { agentLocks: [{ ts: 5 }] }, "each lock must be { ts, close }"],
      ["a lock with a bad time", [], { agentLocks: [open(-1)] }, "lock ts must be an integer"],
      ["locks not an array", [], { agentLocks: null }, "agentLocks and closes must be arrays"],
      ["a null close", [], { closes: [null] }, "each close must be an object"],
      ["a close resulting before its O2", [], { closes: [{ o2Block: 10, resultBlock: 9 }] }, "resultBlock must be an integer between 10"],
      ["a null sample", [null], {}, "each sample must be an object"],
      ["out of order", [at2(40, {}), at2(5, {})], {}, "samples must be in strictly increasing block order"],
      ["a repeated block", [at2(10, {}), at2(10, {})], {}, "samples must be in strictly increasing block order"],
      ["timestamps going back (EC-W24)", [at2(10, {}, 100), at2(30, {}, 99)], {}, "sample timestamps must not decrease"],
      ["a bad state", [{ state: st({ block: -1 }) }], {}, "block must be an integer"],
      ["a close whose O2 wasn't sampled", [at2(10, {})], { closes: [{ o2Block: 20, resultBlock: 22 }] }, "a sample is needed at every close's O2 block"],
    ] as const)("refuses %s", (_n, samples, over, msg) => {
      expect(() => mc(samples as never, over as never)).toThrow(`STATE: ${msg}`);
    });
    it("refuses null limits, and a judged range ending before the last sample", () => {
      expect(() => missedClose(R, [], null as never)).toThrow("STATE: limits must be an object");
      expect(() => mc([at2(1000), at2(1020)], { endBlock: 1019 })).toThrow("STATE: endBlock and endS must be at or after the last sample");
      expect(() => mc([at2(1000), at2(1020)], { endS: 1_001_019 })).toThrow("STATE: endBlock and endS must be at or after the last sample");
      for (const v of [-1, -0, Number.MAX_SAFE_INTEGER + 1, "5", 1.5]) {
        expect(() => mc([], { endBlock: v as never })).toThrow("STATE: endBlock must be an integer between 0 and 9007199254740991");
        expect(() => mc([], { endS: v as never })).toThrow("STATE: endS must be an integer between 0 and 9007199254740991");
      }
      // Exactly at the last sample is accepted.
      expect(mc([at2(1000), at2(1020)], { endBlock: 1020, endS: 1_001_020 })).toEqual([]);
      // The clock's own checks.
      expect(() => mc([], { clock: 5 as never })).toThrow("STATE: clock must be an array");
      expect(() => mc([], { clock: [null as never] })).toThrow("STATE: each clock point must be { block, nowS }");
      expect(() => mc([], { clock: [{ block: -1, nowS: 0 }] })).toThrow("STATE: clock block must be an integer");
      expect(() => mc([], { clock: [{ block: 1, nowS: 0.5 }] })).toThrow("STATE: clock nowS must be an integer");
      expect(() => mc([], { clock: [{ block: 2, nowS: 5 }, { block: 2, nowS: 6 }] })).toThrow("STATE: clock must be in strictly increasing block order with timestamps not decreasing");
      expect(() => mc([], { clock: [{ block: 2, nowS: 5 }, { block: 3, nowS: 4 }] })).toThrow("STATE: clock must be in strictly increasing block order with timestamps not decreasing");
    });
    it("measures through trailing gaps the agent's own locks leave, to the end of the judged range (EC-W27, rules re-audit security M-1)", () => {
      // Due at 1000; the agent then holds its lock at every height, so every later window is a gap, until the run end at 2000.
      expect(mc([at2(980, {}), at2(1000)], { endBlock: 2000, endS: 1_002_000 })).toEqual(miss(1000, 2000));
      // And to the next non-due sample after a gap: due at 1000, gaps, then nothing due at 1500.
      expect(mc([at2(1000), at2(1500, {})])).toEqual(miss(1000, 1500));
      // At exactly the allowance after a gap: not counted; one block more: missed.
      expect(mc([at2(1000), at2(1000 + T, {}, 1_001_000 + T)])).toEqual([{ kind: "single", reason: "stop_loss", fromBlock: 1000, toBlock: 1000 + T }]);
      expect(mc([at2(1000), at2(1000 + T + 1, {}, 1_001_000 + T + 1)])).toEqual(miss(1000, 1000 + T + 1));
      // An adjacent non-due sample (no gap) ends the stretch at the last due sample, as before.
      expect(mc([...seq(1000, 1400), at2(1420, {})])).toEqual([]);
      // One empty window (1400) between the last due sample and the next is a gap: measured to 1420 (test L-2).
      expect(mc([...seq(1000, 1380), at2(1420, {})])).toEqual(miss(1000, 1420));
      expect(mc(seq(1000, 1380), { endBlock: 1420, endS: 1_001_420 })).toEqual(miss(1000, 1420));
      // An off-grid last sample (1395, window 1380): the next sample two windows later is a gap, one window later isn't.
      expect(mc([...seq(1000, 1360), at2(1395), at2(1420, {})])).toEqual(miss(1000, 1420));
      expect(mc([...seq(1000, 1360), at2(1395), at2(1400, {})])).toEqual([]);
      // The agent's interval ends inside the trailing gap (it can act from second 1,004,590, block 4590): the
      // allowance counts from the clock point at that block, at the block limit and one past it (test re-audit M-1).
      const lim = { minActionIntervalS: 3600, agentLocks: [open(1_000_990)], clock: [{ block: 4589, nowS: 1_004_589 }, { block: 4590, nowS: 1_004_590 }] };
      const single = (to: number) => [{ kind: "single", reason: "stop_loss", fromBlock: 1000, toBlock: to }];
      expect(mc([at2(980, {}), at2(1000)], { ...lim, endBlock: 4890, endS: 1_004_890 })).toEqual(single(4890));
      expect(mc([at2(980, {}), at2(1000)], { ...lim, endBlock: 4590 + T, endS: 1_005_000 + T })).toEqual(single(4590 + T));
      expect(mc([at2(980, {}), at2(1000)], { ...lim, endBlock: 4590 + T + 1, endS: 1_005_000 + T })).toEqual(miss(1000, 4590 + T + 1));
      // And the seconds limit: past the blocks, exactly the grace is nothing, one second more is missed.
      expect(mc([at2(980, {}), at2(1000)], { ...lim, endBlock: 9000, endS: 1_004_590 + MISSED_CLOSE_GRACE_S })).toEqual(single(9000));
      expect(mc([at2(980, {}), at2(1000)], { ...lim, endBlock: 9000, endS: 1_004_590 + MISSED_CLOSE_GRACE_S + 1 })).toEqual(miss(1000, 9000));
      // The security re-audit's probe: nothing sampled 1020..4770, the stop loss no longer due at 4771 (181 s and
      // 181 blocks after the agent could act). Less evidence never gives the harsher verdict: "can't check", not missed.
      expect(mc([at2(980, {}), at2(1000), at2(4771, {})], lim)).toEqual(single(1000).map((f) => ({ ...f, toBlock: 4771 })));
      // Without the clock point the page must read, the call is refused rather than guessing.
      expect(() => mc([at2(980, {}), at2(1000)], { ...lim, clock: [], endBlock: 9000, endS: 1_009_000 })).toThrow("STATE: clock needs the first block at or after the time the agent could first act, inside a gap");
      // A multi-sample stretch before the gap counts from the clock point too, not its first or last sample (test L-3).
      expect(mc([at2(980, {}), ...seq(1000, 1100)], { ...lim, endBlock: 4590 + T, endS: 1_005_000 + T })).toEqual([]);
      expect(mc([at2(980, {}), ...seq(1000, 1100)], { ...lim, endBlock: 4590 + T + 1, endS: 1_005_000 + T })).toEqual(miss(1000, 4590 + T + 1));
      // The range ends before the agent could act: no blame.
      expect(mc([at2(980, {}), at2(1000)], { ...lim, endBlock: 4000, endS: 1_004_000 })).toEqual(single(4000));
      // Within the allowance, a one-sample stretch followed by gaps is still "can't check".
      expect(mc([at2(1000)], { endBlock: 1100, endS: 1_001_100 })).toEqual([{ kind: "single", reason: "stop_loss", fromBlock: 1000, toBlock: 1100 }]);
    });
    it("accepts seven locks when the first is exactly 24 hours before the seventh", () => {
      expect(mc([], { agentLocks: [0, 10, 20, 30, 40, 50, 86_400].map(open) })).toEqual([]);
    });
    it("accepts equal timestamps on blocks in different windows (EC-W24)", () => {
      expect(mc([at2(10, {}, 100), at2(30, {}, 100)])).toEqual([]);
    });
    describe("the clock point inside any gap (EC-W23, EC-W27; test re-audit T-1 to T-4, security L-1, L-2)", () => {
      // The agent's open lock at second 1,000,990 with a 3,600 s interval: it can act from second 1,004,590, block 4590.
      const ck = (b: number) => ({ block: b, nowS: 1_000_000 + b });
      const lim = { minActionIntervalS: 3600, agentLocks: [open(1_000_990)], clock: [ck(4589), ck(4590)] };
      it("counts from it for a gap inside a stretch, at the allowance and one past it (T-1)", () => {
        expect(mc([at2(980, {}), at2(1000), ...seq(4800, 5000)], lim)).toEqual([]);
        expect(mc([at2(980, {}), at2(1000), ...seq(4800, 4980), at2(5001)], lim)).toEqual(miss(1000, 5001));
        expect(() => mc([at2(980, {}), at2(1000), ...seq(4800, 5000)], { ...lim, clock: [] })).toThrow("STATE: clock needs the first block at or after the time the agent could first act, inside a gap");
      });
      it("counts from it for a late close after a gap, at the allowance and one past it (T-1)", () => {
        expect(mc([at2(980, {}), at2(1000), at2(5000)], { ...lim, closes: [{ o2Block: 5000, resultBlock: 5002 }] })).toEqual([]);
        expect(mc([at2(980, {}), at2(1000), at2(5001)], { ...lim, closes: [{ o2Block: 5001, resultBlock: 5003 }] })).toEqual([{ kind: "late_close", reason: "stop_loss", fromBlock: 1000, toBlock: 5001 }]);
      });
      it("uses the first point at or after the moment among several, never an earlier or later one (T-2)", () => {
        const many = { ...lim, clock: [ck(2000), ck(4500), ck(4589), ck(4590), ck(4700), ck(9500)] };
        expect(mc([at2(980, {}), at2(1000)], { ...many, endBlock: 4590 + T, endS: 1_004_590 + T })).toEqual([{ kind: "single", reason: "stop_loss", fromBlock: 1000, toBlock: 4590 + T }]);
        expect(mc([at2(980, {}), at2(1000)], { ...many, endBlock: 4590 + T + 1, endS: 1_004_590 + T + 1 })).toEqual(miss(1000, 4590 + T + 1));
        // A point only past the anchor is refused, not used.
        expect(() => mc([at2(980, {}), at2(1000), ...seq(4800, 5000)], { ...lim, clock: [ck(4899), ck(4900)] })).toThrow("STATE: clock needs the first block at or after the time the agent could first act, inside a gap");
        // A later point without the one before it is refused (security L-1): the page must show it is the first.
        expect(() => mc([at2(980, {}), at2(1000)], { ...lim, clock: [ck(5000)], endBlock: 9000, endS: 1_009_000 })).toThrow("STATE: clock needs the last block before the time the agent could first act, just before the first at or after it");
        expect(() => mc([at2(980, {}), at2(1000)], { ...lim, clock: [ck(4590)], endBlock: 9000, endS: 1_009_000 })).toThrow("STATE: clock needs the last block before the time the agent could first act, just before the first at or after it");
        expect(() => mc([at2(980, {}), at2(1000)], { ...lim, clock: [ck(4590), ck(4600)], endBlock: 9000, endS: 1_009_000 })).toThrow("STATE: clock needs the last block before the time the agent could first act, just before the first at or after it");
        // An earlier entry that isn't the adjacent height doesn't show the point is the first (rules re-audit M-1, L-1).
        for (const c of [[ck(2000), ck(4900)], [ck(900), ck(4900)], [ck(4588), ck(4590)]]) {
          expect(() => mc([at2(980, {}), at2(1000)], { ...lim, clock: c, endBlock: 4590 + T + 1, endS: 1_004_590 + T + 1 })).toThrow("STATE: clock needs the last block before the time the agent could first act, just before the first at or after it");
        }
        // The adjacent pair is accepted and gives the exact verdict.
        expect(mc([at2(980, {}), at2(1000)], { ...lim, clock: [ck(4589), ck(4590)], endBlock: 4590 + T + 1, endS: 1_004_590 + T + 1 })).toEqual(miss(1000, 4590 + T + 1));
      });
      it("uses it at exactly one empty window between the last sample before the moment and the next (T-3)", () => {
        expect(mc([at2(980, {}), ...seq(1000, 4560), ...seq(4600, 4980), at2(5000)], lim)).toEqual([]);
        expect(mc([at2(980, {}), ...seq(1000, 4560), ...seq(4600, 4980), at2(5001)], lim)).toEqual(miss(1000, 5001));
      });
      it("counts from an earlier block in the same second as a sample at the moment, and accepts blocks sharing a second (T-4)", () => {
        // Can act from second 1,004,600; block 4599 is the first block at that second (two blocks share it).
        const same = { minActionIntervalS: 3600, agentLocks: [open(1_001_000)], clock: [{ block: 4598, nowS: 1_004_599 }, { block: 4599, nowS: 1_004_600 }] };
        expect(mc([at2(980, {}), at2(1000), ...seq(4600, 4980), at2(5010)], same)).toEqual(miss(1000, 5010));
        const eq = { ...lim, clock: [{ block: 4588, nowS: 1_004_589 }, { block: 4589, nowS: 1_004_590 }, ck(4590)] };
        expect(mc([at2(980, {}), at2(1000)], { ...eq, endBlock: 4589 + T, endS: 1_004_589 + T })).toEqual([{ kind: "single", reason: "stop_loss", fromBlock: 1000, toBlock: 4589 + T }]);
      });
      it("names its own refusal for a clock entry at the sample before the moment (rules test check L-1)", () => {
        // A non-due sample at 5020 makes the judge run inside the loop, before the cross-check.
        const s = [at2(980, {}), at2(1000), ...seq(4800, 5000), at2(5020, {})];
        expect(() => mc(s, { ...lim, clock: [{ block: 1000, nowS: 1_004_590 }, { block: 1001, nowS: 1_004_590 }] })).toThrow("STATE: clock needs the last block before");
        expect(() => mc(s, { ...lim, clock: [{ block: 999, nowS: 1_000_999 }, { block: 1000, nowS: 1_004_590 }] })).toThrow("STATE: clock needs the first block at or after");
      });
      it("refuses a non-adjacent pair inside a stretch and before a late close too (rules test check I-1)", () => {
        expect(() => mc([at2(980, {}), at2(1000), ...seq(4800, 5000)], { ...lim, clock: [ck(2000), ck(4700)] })).toThrow("STATE: clock needs the last block before");
        expect(() => mc([at2(980, {}), at2(1000), at2(5001)], { ...lim, clock: [ck(4588), ck(4590)], closes: [{ o2Block: 5001, resultBlock: 5003 }] })).toThrow("STATE: clock needs the last block before");
      });
      it("counts seconds from the moment, not from the clock point's timestamp, when a slow block follows it (test L-3)", () => {
        // Four blocks a second until block 4589 (second 1,004,589), then one slow block: 4590 lands at second 1,004,620.
        const slow = { minActionIntervalS: 3600, agentLocks: [open(1_000_990)], clock: [{ block: 4589, nowS: 1_004_589 }, { block: 4590, nowS: 1_004_620 }] };
        // Blocks are past the allowance; seconds decide: 180 s after the moment (1,004,590) nothing, 181 s missed.
        expect(mc([at2(980, {}), at2(1000)], { ...slow, endBlock: 9000, endS: 1_004_590 + MISSED_CLOSE_GRACE_S })).toEqual([{ kind: "single", reason: "stop_loss", fromBlock: 1000, toBlock: 9000 }]);
        expect(mc([at2(980, {}), at2(1000)], { ...slow, endBlock: 9000, endS: 1_004_590 + MISSED_CLOSE_GRACE_S + 1 })).toEqual(miss(1000, 9000));
      });
      it("refuses clock points that contradict the samples or the end of the range (security L-2)", () => {
        const msg = "STATE: clock points, samples and the end of the range must agree: one timestamp per block, never decreasing";
        // A clock point timed after the next sample.
        expect(() => mc([at2(1000), at2(1020)], { clock: [{ block: 1010, nowS: 1_001_030 }] })).toThrow(msg);
        // Consistent but implausible data (block 1001 at the moment) is not a contradiction: it gets the stricter clock refusal.
        expect(() => mc([at2(980, {}), at2(1000)], { ...lim, clock: [{ block: 1001, nowS: 1_004_590 }], endBlock: 1500, endS: 1_004_800 })).toThrow("STATE: clock needs the last block before");
        expect(() => mc([at2(980, {}), at2(1000)], { ...lim, clock: [{ block: 1000, nowS: 1_001_005 }], endBlock: 1500, endS: 1_001_500 })).toThrow(msg);
        expect(() => mc([at2(1000)], { clock: [{ block: 1600, nowS: 1_001_600 }], endBlock: 1500, endS: 1_001_700 })).toThrow(msg);
        // A smaller second timestamp for a sampled block, and for the end block; a clash in the first pair (test L-2).
        expect(() => mc([at2(1000), at2(1020)], { clock: [{ block: 1000, nowS: 1_000_990 }] })).toThrow(msg);
        expect(() => mc([at2(1000)], { clock: [{ block: 1500, nowS: 1_001_500 }], endBlock: 1500, endS: 1_001_600 })).toThrow(msg);
        expect(() => mc([at2(1000), at2(1020)], { clock: [{ block: 990, nowS: 1_001_010 }] })).toThrow(msg);
      });
    });
    it("never blames an agent still inside its allowance after a trailing gap, and always finds one past it (property, EC-W23, EC-W27, test M-1)", () => {
      fc.assert(fc.property(fc.integer({ min: 1, max: 3600 }), fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 2 * T }), (lockAgo, gapAfter, sinceAct) => {
        // Due from block 1000 (second 1,001,000); the open lock was lockAgo seconds before; interval 3600 s; one block a second.
        const lockS = 1_001_000 - lockAgo, actS = lockS + 3600, actB = actS - 1_000_000;
        const lastSampled = 1000 + 20 * Math.min(gapAfter, Math.floor((actB - 1000) / 20));
        const endB = actB + sinceAct;
        const got = mc([at2(980, {}), ...seq(1000, lastSampled)], { minActionIntervalS: 3600, agentLocks: [open(lockS)], clock: [{ block: actB - 1, nowS: actS - 1 }, { block: actB, nowS: actS }], endBlock: endB, endS: endB + 1_000_000 });
        const late = sinceAct > T && sinceAct > MISSED_CLOSE_GRACE_S;
        expect(got.some((f) => f.kind === "missed")).toBe(late);
      }), { numRuns: 1000 });
    });
    it("always finds a grid stretch held past the allowance in blocks and seconds, from its first sample (property)", () => {
      fc.assert(fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 21, max: 250 }), fc.constantFrom<Partial<MarketState>>(SL, TP), (k, m, o) => {
        const start = 20 * k;
        const got = mc([at2(start - 20, {}), ...seq(start, start + 20 * m, o)]);
        expect(got).toEqual(miss(start, start + 20 * m, o === SL ? "stop_loss" : "take_profit"));
      }), { numRuns: 300 });
    });
    it("never blames an honest agent, also when its interval or the block rate binds (property)", () => {
      fc.assert(fc.property(
        fc.integer({ min: 0, max: 3_600 }), fc.constantFrom(300, 3_600), fc.integer({ min: 0, max: 59 }), fc.constantFrom(1, 2, 4), fc.integer({ min: 0, max: 10 }),
        (lockAgo, interval, phase, bps, age) => {
          // bps blocks a second; the stop loss holds from second T0 (block B0); the agent swapped 30 s before
          // its open, whose lock was lockAgo seconds earlier; it carries its confirmation over the grid states and observes every 60 s at `phase`.
          const B0 = 100_000, T0 = 1_000_000;
          const blockAt = (t: number) => B0 + (t - T0) * bps;
          const canActS = Math.max(T0, T0 - lockAgo + interval);
          const stAt = (b: number) => st({ ...SL, block: b, nowS: T0 + Math.floor((b - B0) / bps), confirmFromBlock: null });
          let run: ConfirmRun | null = null, closeO2: number | null = null, g = B0;
          for (let t = T0 + phase; closeO2 === null; t += 60) {
            const b = blockAt(t);
            for (; g < b; g += DENSE_STEP_BLOCKS) run = nextConfirmRun(R, stAt(g), run, 0);
            const s = stAt(b);
            const r2 = nextConfirmRun(R, s, run, 0);
            if (t >= canActS && evaluate(R, { ...s, confirmFromBlock: r2!.fromBlock }).kind === "close") closeO2 = b;
          }
          const o2 = closeO2 + age;
          const samples: Sample[] = [];
          for (let b = B0; b <= o2 + 2; b += DENSE_STEP_BLOCKS) samples.push({ state: stAt(b) });
          if (!samples.some((x) => x.state.block === o2)) samples.push({ state: stAt(o2) });
          samples.sort((a, b) => a.state.block - b.state.block);
          const lastS = samples[samples.length - 1]!.state;
          const found = missedClose(R, samples, { maxObservationAgeBlocks: 10, minActionIntervalS: interval, maxActionsPer24h: 6, agentLocks: [open(T0 - lockAgo - 30), open(T0 - lockAgo)], closes: [{ o2Block: o2, resultBlock: o2 + 2 }], endBlock: lastS.block, endS: lastS.nowS });
          expect(found.filter((f) => f.kind !== "single")).toEqual([]);
        }), { numRuns: 1000 });
    });
  });
  it("never closes unless confirmed, for any rules and state (property)", () => {
    fc.assert(fc.property(arbRules, arbState, (r, s) => {
      if (evaluate(r, s).kind === "close") expect(closeConfirmed(s)).toBe(true);
      if (!closeConfirmed(s) && s.position !== null) expect(evaluate(r, s).kind).not.toBe("close");
    }), { numRuns: 3000 });
  });
  it("accepts every close evaluate produces, and refuses the same close one block earlier than the margin (property)", () => {
    let closes = 0;
    fc.assert(fc.property(arbRules, arbState, (r, s) => {
      const d = evaluate(r, s);
      if (d.kind !== "close") return;
      closes++;
      expect(withinRules(r, s, d)).toEqual({ ok: true });
      const early = { ...s, confirmFromBlock: s.block - OFFCHAIN_MARGIN_BLOCKS + 1 };
      if (early.confirmFromBlock >= 0) expect(withinRules(r, early, d)).toEqual({ ok: false, reason: "the close condition isn't confirmed yet" });
    }), { numRuns: 4000 });
    expect(closes).toBeGreaterThan(300);
  });
});
