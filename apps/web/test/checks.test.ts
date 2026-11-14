import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBytes, hashRules, parseRules, toHex, evaluate, type MarketState } from "@poolside/rules";
import { checkAction, checkDecisionRecord, checkRulesReveal } from "../src/lib/checks.ts";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const rulesObj = {
  version: 1, pool: `${USDC}|wrap.near|100`, quote_token: USDC, range: { width_bps: 800, centre: "mid" },
  take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432_000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};
const text = JSON.stringify(rulesObj);
const rules = parseRules(text);
const hash = toHex(hashRules(rules));
const state: MarketState = {
  nowS: 10_000, startedAtS: 1_000, point: -400, valuationPoint: -400, block: 50_000, confirmFromBlock: null, position: null,
  closedBy: null, principal: 250_000_000n, holdings: { quote: 250_000_000n, base: 0n }, fees: { quote: 0n, base: 0n },
};

describe("EC-W01 / EC-W09 rules reveal", () => {
  it("matches the commitment", () => {
    expect(checkRulesReveal(text, hash)).toEqual({ verdict: "matching", text: "The revealed rules match the commitment." });
  });
  it("a changed rule is not matching, with the exact text", () => {
    const tampered = JSON.stringify({ ...rulesObj, stop_loss_bps: 5000 });
    expect(checkRulesReveal(tampered, hash)).toEqual({ verdict: "not_matching", text: "The revealed rules do not match the commitment." });
  });
  it("a different centre is not matching", () => {
    expect(checkRulesReveal(JSON.stringify({ ...rulesObj, range: { width_bps: 800, centre: "up" } }), hash).verdict).toBe("not_matching");
  });
  it("different salt is not matching", () => {
    const t = JSON.stringify({ ...rulesObj, salt: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=" });
    expect(checkRulesReveal(t, hash).verdict).toBe("not_matching");
  });
  it("no reveal is unverifiable: not revealed, never matching", () => {
    expect(checkRulesReveal(null, hash)).toEqual({ verdict: "unverifiable", text: "Unverifiable: not revealed." });
  });
  it("text that is not valid rules is not matching", () => {
    expect(checkRulesReveal("not json", hash).verdict).toBe("not_matching");
    expect(checkRulesReveal("{}", hash).verdict).toBe("not_matching");
  });
  it("an unreadable on-chain hash is unverifiable", () => {
    expect(checkRulesReveal(text, "zz").verdict).toBe("unverifiable");
    expect(checkRulesReveal(text, hash.toUpperCase()).verdict).toBe("unverifiable");
  });
  it("the same rules in another key order still match (canonical form)", () => {
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(rulesObj).reverse()));
    expect(checkRulesReveal(reordered, hash).verdict).toBe("matching");
    expect(toHex(sha256(canonicalBytes(rules)))).toBe(hash);
  });
});

describe("EC-W05 decision record", () => {
  const rec = '{"kind":"hold"}';
  const h = toHex(sha256(new TextEncoder().encode(rec)));
  it("matches its hash", () => expect(checkDecisionRecord(rec, h).verdict).toBe("matching"));
  it("one changed byte is not matching", () => expect(checkDecisionRecord('{"kind":"hold" }', h).verdict).toBe("not_matching"));
  it("an unreadable or upper-case committed hash is unverifiable, not a mismatch", () => {
    expect(checkDecisionRecord(rec, "zz").verdict).toBe("unverifiable");
    expect(checkDecisionRecord(rec, h.toUpperCase()).verdict).toBe("unverifiable");
  });
  it("a one-bit flip of the committed hash is not matching", () => {
    const flipped = (h[0] === "0" ? "1" : "0") + h.slice(1);
    expect(checkDecisionRecord(rec, flipped)).toEqual({ verdict: "not_matching", text: "The decision record does not match its hash." });
  });
  it("an empty record is judged on its hash like any other", () => {
    expect(checkDecisionRecord("", h).verdict).toBe("not_matching");
  });
  it("a missing record is not matching", () => expect(checkDecisionRecord(null, h)).toEqual({ verdict: "not_matching", text: "The decision record is not published." }));
});

describe("EC-W18 actions", () => {
  const d = evaluate(rules, state);
  it("evaluate's own decision is matching", () => {
    expect(checkAction(rules, state, JSON.stringify(d), "contract").verdict).toBe("matching");
  });
  it("an open outside the target range is not matching, with the reason as text", () => {
    const f = checkAction(rules, state, '{"kind":"open","left":-5000,"right":5000}', "contract");
    expect(f.verdict).toBe("not_matching");
    expect(f.text.startsWith("The action is outside the rules: ")).toBe(true);
  });
  it("unreadable agent text is not matching", () => {
    expect(checkAction(rules, state, '{"kind":"open","left":-800,"right":1e2}', "agent")).toEqual({
      verdict: "not_matching", text: "The agent's committed text could not be read." });
  });
  it("unreadable contract text is unverifiable, never matching", () => {
    expect(checkAction(rules, state, '{"kind":"open","left":-800,"right":1e2}', "contract")).toEqual({
      verdict: "unverifiable", text: "Can't check this action: its record could not be read." });
  });
  it("an invalid rebuilt state is unverifiable, never a crash (rules-verifier M-1)", () => {
    const bad = { ...state, startedAtS: state.nowS + 1 };
    const cant = { verdict: "unverifiable", text: "Can't check this action: the state it was judged on could not be read." };
    expect(checkAction(rules, bad, JSON.stringify(d), "contract")).toEqual(cant);
    expect(checkAction(rules, { ...state, point: 10 ** 9 }, JSON.stringify(d), "agent")).toEqual(cant);
  });
  it("an error that is not a RulesError is not swallowed", () => {
    const boom = Object.defineProperty({ ...state }, "nowS", { get() { throw new TypeError("boom"); } });
    expect(() => checkAction(rules, boom as MarketState, JSON.stringify(d), "contract")).toThrow("boom");
  });
  it("HTML in a reason stays text (EC-W04): the finding is a string, never markup", () => {
    const f = checkAction(rules, state, '{"kind":"<img src=x onerror=alert(1)>"}', "contract");
    expect(typeof f.text).toBe("string");
  });
});
