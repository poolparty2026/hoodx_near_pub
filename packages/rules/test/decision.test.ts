import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chainHead, checkDecision, verifyRecordTextOnly, decisionHash, decisionRecordText as writeChecked, parseDecisionRecord, stateJson } from "../src/decision.ts";
import { RulesError } from "../src/errors.ts";
import { evaluate, type Decision, type MarketState } from "../src/evaluate.ts";
import { hashRules, toHex } from "../src/hash.ts";
import { rules } from "./fixtures.ts";

const state = (o: Partial<MarketState> = {}): MarketState => ({
  nowS: 1000, startedAtS: 900, point: -8000, valuationPoint: -8000, block: 100, confirmFromBlock: null, position: null, closedBy: null,
  principal: 1_000_000n, holdings: { quote: 1_000_000n, base: 0n }, fees: { quote: 0n, base: 0n }, ...o,
});
const open: Decision = { kind: "open", left: -8400, right: -7600 }; // rules(): width 800 at point -8000
const STRAT = "strategy-1.near";
const decisionRecordText = (r: ReturnType<typeof rules>, st: MarketState, d: Decision, strategy = STRAT) => writeRecord(r, st, d, strategy);
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/** The reference record, written out by hand: keys sorted, no spaces, amounts as strings (EC-R31). */
const rulesHashHex = () => toHex(hashRules(rules()));
const REFERENCE = () =>
  '{"decision":{"kind":"open","left":-8400,"right":-7600},"rules_hash":"' + rulesHashHex() +
  '","state":{"block":100,"closedBy":null,"confirmFromBlock":null,"fees":{"base":"0","quote":"0"},"holdings":{"base":"0","quote":"1000000"},' +
  '"nowS":1000,"point":-8000,"position":null,"principal":"1000000","startedAtS":900,"valuationPoint":-8000},"strategy":"strategy-1.near","version":1}';

describe("the decision record (EC-R31)", () => {
  it("is the hand-written canonical text, and its hash is the SHA-256 of those bytes", () => {
    const text = decisionRecordText(rules(), state(), open);
    expect(text).toBe(REFERENCE());
    expect(decisionHash(text)).toBe(sha(text));
    expect(decisionHash(text)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("matches the independent vectors in test/vectors/decision-record.json (built outside this code, shared with the page)", () => {
    const v = JSON.parse(readFileSync(new URL("./vectors/decision-record.json", import.meta.url), "utf8")) as { rules_hash: string; reference_record: string; reference_hash: string; chain: { zero: string; first: string; second: string } };
    expect(rulesHashHex()).toBe(v.rules_hash);
    expect(decisionRecordText(rules(), state(), open)).toBe(v.reference_record);
    expect(decisionHash(v.reference_record)).toBe(v.reference_hash);
    expect(v.reference_hash).toBe("fdb62073fbbcc50da393c774935afaf87285824e77b2bdb599375c67198165cd");
    expect(chainHead(null, v.reference_hash)).toBe(v.chain.first);
    expect(chainHead(v.chain.first, v.reference_hash)).toBe(v.chain.second);
    expect(v.chain.first).toBe("66df1b934cd5768ce8daab3956193acfd2bd34527d55970aa151d86d39621508");
  });
  it("changes with every input: each state field, the decision and the rules", () => {
    const base = decisionHash(decisionRecordText(rules(), state(), open));
    const variants: [string, string][] = [
      ["nowS", decisionRecordText(rules(), state({ nowS: 1001 }), open)],
      ["startedAtS", decisionRecordText(rules(), state({ startedAtS: 901 }), open)],
      ["point", decisionRecordText(rules(), state({ point: -7999, valuationPoint: -8000 }), open)],
      ["valuationPoint", decisionRecordText(rules(), state({ valuationPoint: -7999 }), open)],
      ["block", decisionRecordText(rules(), state({ block: 101 }), open)],
      ["confirmFromBlock", decisionRecordText(rules(), state({ confirmFromBlock: 5 }), open)],
      ["position", decisionRecordText(rules(), state({ position: { left: -8500, right: -7500 } }), open)],
      ["closedBy", decisionRecordText(rules(), state({ closedBy: "time" }), open)],
      ["principal", decisionRecordText(rules(), state({ principal: 1_000_001n }), open)],
      ["holdings.quote", decisionRecordText(rules(), state({ holdings: { quote: 1_000_001n, base: 0n } }), open)],
      ["holdings.base", decisionRecordText(rules(), state({ holdings: { quote: 1_000_000n, base: 1n } }), open)],
      ["fees.quote", decisionRecordText(rules(), state({ fees: { quote: 1n, base: 0n } }), open)],
      ["fees.base", decisionRecordText(rules(), state({ fees: { quote: 0n, base: 1n } }), open)],
      ["decision", decisionRecordText(rules(), state(), { kind: "open", left: -8401, right: -7600 })],
      ["rules", decisionRecordText(rules({ stop_loss_bps: 900 }), state(), open)],
    ];
    const hashes = new Set([base]);
    for (const [name, text] of variants) {
      const h = decisionHash(text);
      expect(h, name).not.toBe(base);
      hashes.add(h);
    }
    expect(hashes.size).toBe(variants.length + 1);
  });
  it("does not depend on the order the state's keys were written in", () => {
    const s = state();
    const shuffled = Object.fromEntries(Object.entries(s).reverse()) as unknown as MarketState;
    expect(decisionRecordText(rules(), shuffled, open)).toBe(decisionRecordText(rules(), s, open));
  });
  it("refuses an invalid state (no record for a state `evaluate` would refuse)", () => {
    expect(() => decisionRecordText(rules(), state({ point: 900_000 }), open)).toThrow(/STATE/);
    expect(() => stateJson(state({ principal: -1n }))).toThrow(/STATE/);
  });
  it("reads back what it wrote, and `evaluate` on the read state gives the recorded decision", () => {
    for (const [st, d] of [
      [state(), evaluate(rules(), state())],
      [state({ position: { left: -8500, right: -7500 }, nowS: 900 + 432_000, confirmFromBlock: 50 }), { kind: "close", reason: "time" } as Decision],
      [state({ closedBy: "time" }), { kind: "done" } as Decision],
      [state({ position: { left: -8500, right: -7500 } }), { kind: "hold" } as Decision],
    ] as [MarketState, Decision][]) {
      const text = decisionRecordText(rules(), st, d);
      const p = parseDecisionRecord(text);
      expect(p.state).toEqual(st);
      expect(p.decision).toEqual(d);
      expect(p.rulesHash).toBe(rulesHashHex());
      expect(decisionRecordText(rules(), p.state, p.decision)).toBe(text);
    }
    expect(evaluate(rules(), parseDecisionRecord(decisionRecordText(rules(), state(), open)).state)).toEqual(open);
  });
  it("property: any valid state round-trips byte for byte and hashes the same", () => {
    const amt = fc.bigInt({ min: 0n, max: (1n << 128n) - 1n });
    fc.assert(fc.property(
      fc.record({ nowS: fc.integer({ min: 0, max: 2_000_000_000 }), point: fc.integer({ min: -800_000, max: 800_000 }), block: fc.integer({ min: 0, max: 2 ** 31 }), principal: amt, q: amt, b: amt }),
      (r) => {
        const st = state({ nowS: r.nowS, startedAtS: 0, point: r.point, valuationPoint: r.point, block: r.block, principal: r.principal, holdings: { quote: r.q, base: r.b } });
        const text = decisionRecordText(rules(), st, { kind: "hold" });
        const back = parseDecisionRecord(text);
        return decisionRecordText(rules(), back.state, back.decision) === text && decisionHash(text) === sha(text);
      },
    ), { numRuns: 200 });
  });
  it("refuses every vector in the shared refusal list, each with its own exact reason (RulesError STATE)", () => {
    const v = JSON.parse(readFileSync(new URL("./vectors/decision-record.json", import.meta.url), "utf8")) as { refuse: { name: string; text: string; message: string | null }[] };
    expect(v.refuse.length).toBeGreaterThanOrEqual(30);
    for (const c of v.refuse) {
      let err: unknown;
      try { parseDecisionRecord(c.text); } catch (e) { err = e; }
      expect(err, c.name).toBeInstanceOf(RulesError);
      expect((err as RulesError).code, c.name).toMatch(/^(STATE|JSON|NUMBER|DUPLICATE|SYNTAX|CANON)/);
      if (c.message !== null) expect((err as RulesError).message, c.name).toContain(c.message);
    }
    // A hold, done and close are read as well as an open.
    expect(parseDecisionRecord(decisionRecordText(rules(), state(), { kind: "hold" })).decision).toEqual({ kind: "hold" });
  });
  it("the writer refuses the decisions the reader refuses (EC-R33): an unknown kind, extra keys, a bad reason, left >= right, a point out of range", () => {
    const bad: [string, unknown, string][] = [
      ["unknown kind", { kind: "rebalance" }, "decision kind must be"],
      ["extra key on hold", { kind: "hold", x: 1 }, "exactly the keys"],
      ["extra key on open", { kind: "open", left: -8400, right: -7600, x: 1 }, "exactly the keys"],
      ["bad close reason", { kind: "close", reason: "panic" }, "close reason must be"],
      ["close with an extra key", { kind: "close", reason: "time", x: 1 }, "exactly the keys"],
      ["left equals right", { kind: "open", left: 5, right: 5 }, "left must be below right"],
      ["left above right", { kind: "open", left: 6, right: 5 }, "left must be below right"],
      ["left below the bound", { kind: "open", left: -800_001, right: 5 }, "left must be within the point bounds"],
      ["right above the bound", { kind: "open", left: 5, right: 800_001 }, "right must be within the point bounds"],
      ["a fraction", { kind: "open", left: 1.5, right: 5 }, "left must be an integer"],
      ["a string point", { kind: "open", left: "1", right: 5 }, "left must be an integer"],
      ["not an object", "hold", "decision must be an object"],
      ["null", null, "decision must be an object"],
    ];
    for (const [name, d, msg] of bad) {
      expect(() => decisionRecordText(rules(), state(), d as Decision), name).toThrow(msg);
      expect(() => checkDecision(d as never), name).toThrow(RulesError);
    }
    // The bounds themselves are allowed, and two adjacent points are a range.
    expect(checkDecision({ kind: "open", left: -800_000, right: 800_000 })).toEqual({ kind: "open", left: -800_000, right: 800_000 });
    expect(checkDecision({ kind: "open", left: 4, right: 5 })).toEqual({ kind: "open", left: 4, right: 5 });
  });
  it("holds at the numeric boundaries: u128 max, 0 and the largest safe integer, the point bounds, equal times", () => {
    const max = (1n << 128n) - 1n;
    const edge = state({ principal: max, holdings: { quote: max, base: 0n }, fees: { quote: 0n, base: max }, nowS: 900, startedAtS: 900, block: Number.MAX_SAFE_INTEGER, confirmFromBlock: Number.MAX_SAFE_INTEGER, point: 800_000, valuationPoint: -800_000 });
    const text = decisionRecordText(rules(), edge, { kind: "hold" });
    expect(parseDecisionRecord(text).state).toEqual(edge);
    expect(() => stateJson(state({ principal: max + 1n }))).toThrow(/STATE/);
    expect(() => stateJson(state({ block: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(/STATE/);
    expect(() => stateJson(state({ point: 800_001 }))).toThrow(/STATE/);
    expect(() => stateJson(state({ point: -800_001, valuationPoint: -800_001 }))).toThrow(/STATE/);
    expect(() => stateJson(state({ startedAtS: 1001, nowS: 1000 }))).toThrow(/STATE/);
    expect(() => stateJson(state({ confirmFromBlock: 101, block: 100 }))).toThrow(/STATE/);
  });
  it("swapping quote and base (holdings or fees) changes the hash", () => {
    const h = (st: MarketState) => decisionHash(decisionRecordText(rules(), st, { kind: "hold" }));
    expect(h(state({ holdings: { quote: 1n, base: 0n } }))).not.toBe(h(state({ holdings: { quote: 0n, base: 1n } })));
    expect(h(state({ fees: { quote: 1n, base: 0n } }))).not.toBe(h(state({ fees: { quote: 0n, base: 1n } })));
  });
  it("property: every decision kind, with a position, a latch and a confirmation, round-trips and evaluates the same", () => {
    const amt = fc.bigInt({ min: 0n, max: (1n << 128n) - 1n });
    const pointArb = fc.integer({ min: -799_000, max: 799_000 });
    fc.assert(fc.property(pointArb, fc.integer({ min: 1, max: 1000 }), amt, amt, fc.constantFrom("time", "stop_loss", "take_profit", null), fc.integer({ min: 0, max: 3 }), (p, w, q, b, latch, kind) => {
      const st = state({ point: p, valuationPoint: p, position: { left: p - w, right: p + w }, closedBy: latch, confirmFromBlock: latch === null ? null : 50, holdings: { quote: q, base: b }, fees: { quote: b, base: q } });
      const d: Decision = kind === 0 ? { kind: "hold" } : kind === 1 ? { kind: "done" } : kind === 2 ? { kind: "open", left: p - w, right: p + w } : { kind: "close", reason: latch ?? "time" };
      const text = decisionRecordText(rules(), st, d);
      const back = parseDecisionRecord(text);
      return JSON.stringify(back.decision) === JSON.stringify(d) && decisionRecordText(rules(), back.state, back.decision) === text;
    }), { numRuns: 300 });
  });
  it("property: a changed byte is refused or reads as another record with another hash, never the same hash", () => {
    const base = REFERENCE();
    const h0 = decisionHash(base);
    fc.assert(fc.property(fc.integer({ min: 0, max: base.length - 1 }), fc.integer({ min: 32, max: 126 }), (i, c) => {
      const t = base.slice(0, i) + String.fromCharCode(c) + base.slice(i + 1);
      if (t === base) return true;
      if (decisionHash(t) === h0) return false;
      try { parseDecisionRecord(t); } catch { /* refused */ }
      return true;
    }), { numRuns: 300 });
  });
});

describe("verifyRecordTextOnly: the page's whole check (EC-R31)", () => {
  const good = () => decisionRecordText(rules(), state(), open);
  it("accepts a record that hashes to the on-chain hash, is for these rules, and is what evaluate gives", () => {
    const v = verifyRecordTextOnly(good(), decisionHash(good()), rules(), STRAT);
    expect(v.ok).toBe(true);
  });
  it("is 'not matching' for a wrong hash, other rules, or a decision the rules don't give", () => {
    expect(verifyRecordTextOnly(good(), "00".repeat(32), rules(), STRAT)).toMatchObject({ ok: false, unreadable: false, reason: expect.stringContaining("hash") });
    const other = decisionRecordText(rules({ stop_loss_bps: 900 }), state(), open);
    expect(verifyRecordTextOnly(other, decisionHash(other), rules(), STRAT)).toMatchObject({ ok: false, unreadable: false, reason: expect.stringContaining("other rules") });
    // A hold where the rules say open: well-formed, hashes right, wrong decision.
    const lie = decisionRecordText(rules(), state(), { kind: "hold" });
    expect(verifyRecordTextOnly(lie, decisionHash(lie), rules(), STRAT)).toMatchObject({ ok: false, unreadable: false, reason: expect.stringContaining("not what the rules give") });
    // An open at another range.
    const range = decisionRecordText(rules(), state(), { kind: "open", left: -8401, right: -7600 });
    expect(verifyRecordTextOnly(range, decisionHash(range), rules(), STRAT).ok).toBe(false);
  });
  it("is 'not matching' for a record written for another strategy (L-1), and the writer refuses a bad strategy id", () => {
    const other = decisionRecordText(rules(), state(), open, "strategy-2.near");
    expect(verifyRecordTextOnly(other, decisionHash(other), rules(), STRAT)).toMatchObject({ ok: false, unreadable: false, reason: expect.stringContaining("another strategy") });
    for (const bad of ["", "Not An Account", "a".repeat(70) + ".near"]) expect(() => decisionRecordText(rules(), state(), open, bad)).toThrow(/strategy must be a NEAR account id/);
    expect(parseDecisionRecord(good()).strategy).toBe(STRAT);
  });
  it("the vector file's reference record is byte for byte the writer's output (no trailing newline, UTF-8)", () => {
    const raw = readFileSync(new URL("./vectors/decision-record.json", import.meta.url), "utf8");
    const v = JSON.parse(raw) as { reference_record: string };
    expect(new TextEncoder().encode(v.reference_record)).toEqual(new TextEncoder().encode(good()));
    expect(v.reference_record.endsWith("\n")).toBe(false);
  });
  it("is 'can't check' (unreadable) for text that isn't a record, even when its hash matches", () => {
    for (const t of [good() + "\n", "x", "[]", good().replace('"version":1', '"version":2')]) {
      expect(verifyRecordTextOnly(t, decisionHash(t), rules(), STRAT)).toMatchObject({ ok: false, unreadable: true });
    }
  });
});

describe("the checked writer (EC-R31, audit M-A)", () => {
  it("writes only what evaluate gives for the state, and refuses every other decision", () => {
    const held = state({ position: { left: -8400, right: -7600 } });
    expect(writeChecked(rules(), state(), open, STRAT)).toBe(decisionRecordText(rules(), state(), open));
    expect(() => writeChecked(rules(), state(), { kind: "hold" }, STRAT)).toThrow(/not what the rules give/);
    expect(() => writeChecked(rules(), state(), { kind: "open", left: -8401, right: -7600 }, STRAT)).toThrow(/not what the rules give/);
    expect(() => writeChecked(rules(), held, open, STRAT)).toThrow(/not what the rules give/);
    expect(() => writeChecked(rules(), state(), { kind: "close", reason: "time" }, STRAT)).toThrow(/not what the rules give/);
    expect(writeChecked(rules(), held, { kind: "hold" }, STRAT)).toContain('"kind":"hold"');
    // A due but unconfirmed close is a hold, and the writer refuses to publish the close.
    const due = state({ position: { left: -8400, right: -7600 }, nowS: 900 + 432_000, confirmFromBlock: null });
    expect(() => writeChecked(rules(), due, { kind: "close", reason: "time" }, STRAT)).toThrow(/not what the rules give/);
    expect(writeChecked(rules(), { ...due, confirmFromBlock: 50 }, { kind: "close", reason: "time" }, STRAT)).toContain('"reason":"time"');
  });
});

describe("the chain link (EC-R32)", () => {
  const h1 = "11".repeat(32);
  const h2 = "22".repeat(32);
  it("is SHA-256 of the documented text, the first record starting from 64 zeros", () => {
    expect(chainHead(null, h1)).toBe(sha(`poolside-chain-v1\n${"0".repeat(64)}\n${h1}`));
    expect(chainHead(h1, h2)).toBe(sha(`poolside-chain-v1\n${h1}\n${h2}`));
    expect(chainHead(null, h1)).toBe(chainHead("0".repeat(64), h1));
  });
  it("depends on the order and on the previous head", () => {
    expect(chainHead(h1, h2)).not.toBe(chainHead(h2, h1));
    expect(chainHead(null, h2)).not.toBe(chainHead(h1, h2));
  });
  it("a changed earlier hash changes every later head", () => {
    const a = chainHead(chainHead(chainHead(null, h1), h2), h1);
    const b = chainHead(chainHead(chainHead(null, h2), h2), h1);
    expect(a).not.toBe(b);
    expect(chainHead(h1, h2)).not.toBe(chainHead(h1, h1));
  });
  it("refuses a bad second argument with a good first one (not only a bad previous head)", () => {
    expect(() => chainHead(h1, "x")).toThrow(/64 lowercase hex/);
    expect(() => chainHead(h1, h2 + "\n")).toThrow(/64 lowercase hex/);
  });
  it("refuses anything but 64 lowercase hex", () => {
    for (const bad of ["", "AB".repeat(32), "1".repeat(63), "1".repeat(65), "g".repeat(64)]) {
      expect(() => chainHead(bad, h1)).toThrow(/64 lowercase hex/);
      expect(() => chainHead(null, bad)).toThrow(/64 lowercase hex/);
    }
  });
});

// EC-R35: the record is tied to chain data (audit round 5).
import { decisionRecordTextUnchecked as writeRecord } from "../src/testing.ts";
import { isMatching, verifyDecisionRecordAgainstChain, type ChainedAction, type RebuiltState } from "../src/decision.ts";

describe("verifyDecisionRecordAgainstChain (EC-R35)", () => {
  const st = state({ position: null });
  const text = () => decisionRecordText(rules(), st, open);
  const T = 1_700_000_000n * 1_000_000_000n;
  const swap = (o: Partial<ChainedAction> = {}): ChainedAction => ({ kind: "Swap", observed: { block: st.block, point: st.point }, left: -8400, right: -7600, timestampNs: T, resultTsNs: T + 5_000_000_000n, index: 0, result: "ok", swapUsed: 1000n, ...o });
  // An open carrying the swap's hash 600 s after the swap's result: paired by the rules' own window.
  const pairedOpen = (o: Partial<ChainedAction> = {}): ChainedAction => ({ kind: "Open", observed: { block: 5000, point: 123 }, left: -8400, right: -7600, timestampNs: T + 605_000_000_000n, resultTsNs: null, index: 1, result: "ok", swapUsed: 0n, ...o });
  const rebuilt = (o: Partial<RebuiltState> = {}): RebuiltState => ({
    block: st.block, point: st.point, nowS: st.nowS, startedAtS: st.startedAtS, valuationPoint: st.valuationPoint, position: st.position, principal: st.principal, holdings: st.holdings, fees: st.fees, closedBy: st.closedBy, confirmFromBlock: st.confirmFromBlock, ...o,
  });
  const run = (acts: ChainedAction[], rb: RebuiltState, t = text()) => verifyDecisionRecordAgainstChain(t, decisionHash(t), rules(), STRAT, acts, rb);

  it("matches only when every part of the state is what the chain shows and the action agrees", () => {
    expect(isMatching(run([swap()], rebuilt()))).toBe(true);
  });
  it("a self-consistent record with a state the chain does not show is not matching: block, point, holdings, principal, fees, nowS, position, latch, confirmFromBlock, valuationPoint", () => {
    expect(run([swap({ observed: { block: st.block + 1, point: st.point } })], rebuilt())).toMatchObject({ status: "not_matching", reason: expect.stringContaining("observed block and point") });
    expect(run([swap({ observed: { block: st.block, point: st.point + 1 } })], rebuilt()).status).toBe("not_matching");
    for (const [name, o] of [
      ["block", { block: st.block + 1 }],
      ["point", { point: st.point + 1 }],
      ["holdings", { holdings: { quote: st.holdings.quote + 1n, base: 0n } }],
      ["principal", { principal: st.principal + 1n }],
      ["fees", { fees: { quote: 1n, base: 0n } }],
      ["nowS", { nowS: st.nowS + 1 }],
      ["startedAtS", { startedAtS: st.startedAtS - 1 }],
      ["position", { position: { left: -8400, right: -7600 } }],
      ["closedBy", { closedBy: "time" as const }],
      ["confirmFromBlock", { confirmFromBlock: 5 }],
      ["valuationPoint", { valuationPoint: st.valuationPoint + 1 }],
    ] as [string, RebuiltState][]) {
      expect(run([swap()], rebuilt(o)), name).toMatchObject({ status: "not_matching", reason: expect.stringContaining(name) });
    }
  });
  it("a rebuilt field that cannot sit in a valid state with the record's others conflicts: not matching", () => {
    expect(run([swap()], rebuilt({ startedAtS: st.nowS + 1 })).status).toBe("not_matching");
    expect(run([swap()], rebuilt({ confirmFromBlock: st.block + 1 })).status).toBe("not_matching");
  });
  it("an open range on chain that is not the record's is not matching (swap and open)", () => {
    expect(run([swap({ left: -8401 })], rebuilt())).toMatchObject({ status: "not_matching", reason: expect.stringContaining("range") });
    expect(run([swap({ right: -7599 })], rebuilt()).status).toBe("not_matching");
    expect(run([swap(), pairedOpen({ right: -7601 })], rebuilt()).status).toBe("not_matching");
  });
  it("a paired open (a swap in the list, within the pair window) is judged at the swap's observation: its own observed is not compared", () => {
    expect(isMatching(run([swap(), pairedOpen()], rebuilt()))).toBe(true);
    // At the window (3,600 s after the swap's result) the open is not paired: it is judged at its own observation.
    const late = pairedOpen({ timestampNs: T + 5_000_000_000n + 3_600_000_000_000n });
    expect(run([swap(), late], rebuilt()).status).toBe("not_matching");
    // One nanosecond inside the window it is still paired.
    expect(isMatching(run([swap(), pairedOpen({ timestampNs: T + 5_000_000_000n + 3_600_000_000_000n - 1n })], rebuilt()))).toBe(true);
    // An open before the swap's result is not paired either.
    expect(run([swap(), pairedOpen({ timestampNs: T })], rebuilt()).status).toBe("not_matching");
  });
  it("HIGH-1: only a paired open, or no swap in the list, ties the record to nothing: can't check, never matching", () => {
    // The invented record's block and point match no chain observation: only an "open" that claims to be paired.
    // Without a swap in the list nothing makes it paired, so it is judged at its own observation (which the record doesn't match).
    expect(run([pairedOpen()], rebuilt())).toMatchObject({ status: "not_matching" });
    // With the swap in the list but the swap itself not tying the record (it carries another observation), nothing ties it.
    expect(run([swap({ observed: { block: 1, point: 1 } }), pairedOpen()], rebuilt()).status).toBe("not_matching");
    expect(run([{ ...swap({ resultTsNs: null }), kind: "Open", observed: { block: 999, point: 5 } }], rebuilt()).status).toBe("not_matching");
    // Two opens both paired with the one swap is not allowed.
    expect(run([swap(), pairedOpen(), pairedOpen({ timestampNs: T + 700_000_000_000n })], rebuilt()).status).toBe("not_matching");
  });
  it("ROUND 6: block and point are required rebuilt fields (the pool's current_point at observed.block); an agent-asserted point is not enough", () => {
    const { point: _p, ...noPoint } = rebuilt();
    expect(run([swap()], noPoint)).toMatchObject({ status: "cant_check", reason: expect.stringContaining("point") });
    const { block: _b, ...noBlock } = rebuilt();
    expect(run([swap()], noBlock)).toMatchObject({ status: "cant_check", reason: expect.stringContaining("block") });
    // The agent records P' and sends P' as observed.point, but the pool was at the real point.
    expect(run([swap()], rebuilt({ point: st.point + 5 }))).toMatchObject({ status: "not_matching", reason: expect.stringContaining("point") });
  });
  it("ROUND 6: only an ok Swap that swapped something can be paired with; a refused, failed or no-op swap cannot", () => {
    // The open is judged at its own observation (not the record's) when its swap is not a real one.
    for (const bad of [{ result: "refused" as const }, { result: "failed" as const }, { swapUsed: 0n }]) {
      expect(run([swap(bad), pairedOpen()], rebuilt()).status, JSON.stringify(bad, (_k, v) => (typeof v === "bigint" ? String(v) : v))).toBe("not_matching");
    }
    // The swap must come first in the contract's order.
    expect(run([swap({ index: 2 }), pairedOpen()], rebuilt()).status).toBe("not_matching");
  });
  it("ROUND 6: unreadable chain input is 'can't check', never a throw or a quiet 'not matching'", () => {
    expect(run([swap(), pairedOpen({ timestampNs: 2n ** 70n })], rebuilt()).status).toBe("cant_check");
    expect(run([swap(), undefined as never], rebuilt()).status).toBe("cant_check");
    // eslint-disable-next-line no-sparse-arrays
    expect(run([, swap()] as never, rebuilt()).status).toBe("cant_check");
    expect(run([swap()], rebuilt({ closedBy: "oops" as never })).status).toBe("cant_check");
    expect(run([swap({ result: "weird" as never })], rebuilt()).status).toBe("cant_check");
  });
  it("ROUND 6: the same hash on actions that are not a swap and its one paired open: every unpaired action must tie to the record", () => {
    expect(run([swap(), swap({ index: 1, observed: { block: 1, point: 1 } })], rebuilt()).status).toBe("not_matching");
    expect(isMatching(run([swap({ result: "refused" }), swap({ index: 1 })], rebuilt()))).toBe(true);
  });
  it("ROUND 6 property: never matching unless every field ties", () => {
    const fields: [string, RebuiltState][] = [
      ["block", { block: st.block + 1 }], ["point", { point: st.point + 1 }], ["nowS", { nowS: st.nowS + 1 }], ["valuationPoint", { valuationPoint: st.valuationPoint + 1 }],
      ["principal", { principal: st.principal + 1n }], ["holdings", { holdings: { quote: st.holdings.quote + 1n, base: 0n } }],
    ];
    fc.assert(fc.property(fc.subarray(fields, { minLength: 1 }), (changes) => {
      const rb = Object.assign({}, rebuilt(), ...changes.map(([, o]) => o)) as RebuiltState;
      return !isMatching(run([swap()], rb));
    }));
  });
  it("an action kind must match the decision: a swap under a hold, a close under an open; an unknown kind is not matching", () => {
    const hold = decisionRecordText(rules(), st, { kind: "hold" });
    expect(run([swap()], rebuilt(), hold).status).toBe("not_matching");
    expect(run([{ kind: "ClosePosition", observed: { block: st.block, point: st.point }, left: null, right: null, timestampNs: T, resultTsNs: null, index: 0, result: "ok", swapUsed: 0n }], rebuilt()).status).toBe("not_matching");
    expect(run([{ ...swap(), kind: "Rebalance" as never }], rebuilt()).status).toBe("not_matching");
  });
  it("is 'can't check' for a field the page could not rebuild, an unreadable record, no action, and malformed input (never a throw)", () => {
    const { valuationPoint: _v, ...noVal } = rebuilt();
    expect(run([swap()], noVal)).toMatchObject({ status: "cant_check", reason: expect.stringContaining("valuationPoint") });
    expect(run([swap()], {})).toMatchObject({ status: "cant_check" });
    expect(run([], rebuilt()).status).toBe("cant_check");
    expect(run([swap()], rebuilt(), "x").status).toBe("cant_check");
    expect(run([swap()], rebuilt({ holdings: { quote: -1n, base: 0n } })).status).toBe("not_matching");
    expect(run([swap()], null as never).status).toBe("cant_check");
    expect(run([{ left: 1 } as never], rebuilt()).status).toBe("cant_check");
    expect(run([swap()], rebuilt({ holdings: "x" as never })).status).toBe("cant_check");
    expect(run(null as never, rebuilt()).status).toBe("cant_check");
  });
  it("a hold or done record has no action carrying its hash: always can't check", () => {
    const held = state({ position: { left: -8400, right: -7600 } });
    const hold = decisionRecordText(rules(), held, { kind: "hold" });
    expect(verifyDecisionRecordAgainstChain(hold, decisionHash(hold), rules(), STRAT, [], { ...rebuilt(), position: held.position }).status).toBe("cant_check");
  });
  it("only isMatching() reads as a pass: can't check and not matching are both truthy objects", () => {
    const cant = run([], rebuilt());
    expect(Boolean(cant)).toBe(true);
    expect(isMatching(cant)).toBe(false);
    const check = (v: ReturnType<typeof run>): string => {
      switch (v.status) {
        case "matching": return "m";
        case "not_matching": return "n";
        case "cant_check": return "c";
        default: { const _never: never = v; return _never; }
      }
    };
    expect(check(cant)).toBe("c");
  });
  it("keeps every check of verifyRecordTextOnly: another strategy, another rules hash, a lying decision, a wrong hash", () => {
    const other = decisionRecordText(rules(), st, open, "strategy-2.near");
    expect(verifyDecisionRecordAgainstChain(other, decisionHash(other), rules(), STRAT, [swap()], rebuilt()).status).toBe("not_matching");
    const lie = decisionRecordText(rules(), st, { kind: "hold" });
    expect(verifyDecisionRecordAgainstChain(lie, decisionHash(lie), rules(), STRAT, [swap()], rebuilt()).status).toBe("not_matching");
    expect(verifyDecisionRecordAgainstChain(text(), "00".repeat(32), rules(), STRAT, [swap()], rebuilt()).status).toBe("not_matching");
  });
});

describe("the unchecked record writer is for tests only (ROUND 6)", () => {
  it("no app source imports it, and the package index does not export it", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
      if (n === "node_modules" || n === "test" || n === ".next") return [];
      const f = join(d, n);
      return statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx|mjs)$/.test(f) ? [f] : [];
    });
    const apps = join(import.meta.dirname, "../../../apps");
    for (const f of walk(apps)) expect(readFileSync(f, "utf8"), f).not.toMatch(/decisionRecordTextUnchecked|@poolside\/rules\/testing/);
    expect(readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8")).not.toMatch(/Unchecked/);
  });
});
