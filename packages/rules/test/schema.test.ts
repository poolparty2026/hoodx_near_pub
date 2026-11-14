import { describe, expect, it } from "vitest";
import { validateRules, parsePoolId, decodeBase64Strict } from "../src/schema.ts";
import { RulesError } from "../src/errors.ts";
import { rawRules, POOL_100, USDC, WNEAR } from "./fixtures.ts";
import { strictParse } from "../src/json.ts";
import { readFileSync } from "node:fs";

const msg = (f: () => unknown): string => {
  try { f(); } catch (e) { expect(e).toBeInstanceOf(RulesError); return (e as Error).message; }
  return "NO_ERROR";
};

describe("validateRules (EC-R03, EC-R04, EC-R09)", () => {
  it("accepts the reference rules and freezes them", () => {
    const r = validateRules(rawRules());
    expect(r.pool).toBe(POOL_100);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.range)).toBe(true);
  });
  it("refuses an unknown field", () => {
    expect(msg(() => validateRules({ ...rawRules(), extra: 1 }))).toContain("rules.extra: unknown field");
  });
  it.each(["version", "pool", "quote_token", "range", "take_profit_bps", "stop_loss_bps", "close_after_s", "salt"])(
    "refuses a missing %s", (k) => {
      const r = rawRules(); delete r[k];
      expect(msg(() => validateRules(r))).toContain(`rules.${k}: missing field`);
    });
  it("refuses a v2 rebalance field as an unknown field, with the exact message (EC-R29)", () => {
    const v2 = { ...rawRules(), rebalance: { trigger: "out_of_range", edge_bps: 0, min_interval_s: 3600 } };
    expect(() => validateRules(v2)).toThrow("SCHEMA: rules.rebalance: unknown field");
    expect(msg(() => validateRules(v2))).toBe("SCHEMA: rules.rebalance: unknown field");
    expect(Object.keys(validateRules(rawRules())).sort()).toEqual(["close_after_s", "pool", "quote_token", "range", "salt", "stop_loss_bps", "take_profit_bps", "version"]);
  });
  it("accepts the documented v1 example of ARCHITECTURE section 4 exactly as written, comments removed (EC-R29)", () => {
    const doc = readFileSync(new URL("../../../docs/ARCHITECTURE.md", import.meta.url), "utf8");
    const sec4 = doc.slice(doc.indexOf("## 4. The rule format"));
    const block = /```jsonc\n([\s\S]*?)\n```/.exec(sec4)![1]!;
    // Comments are "  // ..." to the end of a line; none of the strings contains "//".
    const json = block.split("\n").map((l) => l.replace(/\s+\/\/.*$/, "")).join("\n");
    const r = validateRules(strictParse(json));
    expect(r.pool).toBe("usdc.example.near|wrap.near|2000");
    expect("rebalance" in r).toBe(false);
    expect(block).not.toContain('"rebalance"');
  });
  it("refuses a wrong version", () => {
    expect(msg(() => validateRules(rawRules({ version: 2 })))).toContain("rules.version");
  });
  it("refuses non-objects", () => {
    expect(msg(() => validateRules([] as never))).toContain("must be an object");
    expect(msg(() => validateRules(null))).toContain("must be an object");
  });
  it.each([
    ["width_bps at 49", { range: { width_bps: 49, centre: "mid" } }, "width_bps"],
    ["width_bps at 5001", { range: { width_bps: 5001, centre: "mid" } }, "width_bps"],
    ["centre other than mid", { range: { width_bps: 800, centre: "low" } }, "centre"],
    ["take_profit_bps at 0", { take_profit_bps: 0 }, "take_profit_bps"],
    ["stop_loss_bps at 10000", { stop_loss_bps: 10_000 }, "stop_loss_bps"],
    ["close_after_s at 3599", { close_after_s: 3599 }, "close_after_s"],
    ["close_after_s over 30 days", { close_after_s: 30 * 86_400 + 1 }, "close_after_s"],
    ["a string number", { take_profit_bps: "300" }, "take_profit_bps"],
  ])("refuses %s", (_name, over, field) => {
    expect(msg(() => validateRules(rawRules(over as never)))).toContain(field as string);
  });
  it("accepts every bound exactly", () => {
    expect(() => validateRules(rawRules({ range: { width_bps: 50, centre: "mid" }, take_profit_bps: 1, stop_loss_bps: 9999, close_after_s: 3600 }))).not.toThrow();
    expect(() => validateRules(rawRules({ range: { width_bps: 5000, centre: "mid" }, take_profit_bps: 10_000, stop_loss_bps: 1, close_after_s: 30 * 86_400 }))).not.toThrow();
  });
  it("refuses a quote token outside the pool", () => {
    expect(msg(() => validateRules(rawRules({ quote_token: "usdt.tether-token.near" })))).toContain("quote_token");
  });
  it.each([
    ["unsorted tokens", `${WNEAR}|${USDC}|100`],
    ["same token twice", `${USDC}|${USDC}|100`],
    ["unknown fee tier", `${USDC}|${WNEAR}|300`],
    ["fee with leading zero", `${USDC}|${WNEAR}|0100`],
    ["two parts", `${USDC}|${WNEAR}`],
    ["invalid account", `UPPER.near|${WNEAR}|100`],
  ])("refuses a pool id with %s", (_n, pool) => {
    expect(msg(() => validateRules(rawRules({ pool })))).toContain("pool");
  });
  it("maps fee tiers to point spacing", () => {
    expect(parsePoolId(POOL_100).pointDelta).toBe(1);
    expect(parsePoolId(`${USDC}|${WNEAR}|2000`).pointDelta).toBe(40);
  });
  it.each([
    ["missing salt length", "AAAA"],
    ["31 bytes", "A".repeat(40) + "AA=="],
    ["non-base64", "!".repeat(44)],
    ["url-safe alphabet", "_".repeat(43) + "="],
    ["non-canonical padding bits", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB="],
  ])("refuses a salt with %s (EC-R04)", (_n, salt) => {
    expect(msg(() => validateRules(rawRules({ salt })))).toContain("salt");
  });
  it("decodes canonical base64 exactly", () => {
    expect(decodeBase64Strict("AQID")).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("schema limits at limit + 1 and type checks (EC-R03, EC-R04, EC-R09)", () => {
  it.each([
    ["take_profit_bps 10001", { take_profit_bps: 10_001 }, "rules.take_profit_bps: must be between 1 and 10000"],
    ["stop_loss_bps 0", { stop_loss_bps: 0 }, "rules.stop_loss_bps: must be between 1 and 9999"],
    ["width_bps 5001", { range: { width_bps: 5001, centre: "mid" } }, "rules.range.width_bps: must be between 50 and 5000"],
    ["close_after_s 3599", { close_after_s: 3599 }, "rules.close_after_s: must be between 3600 and 2592000"],
    ["width_bps 800.5 passed directly", { range: { width_bps: 800.5, centre: "mid" } }, "rules.range.width_bps: must be an integer"],
    ["pool not a string", { pool: 5 }, "rules.pool: must be a string"],
  ])("refuses %s with the exact message", (_n, over, message) => {
    expect(() => validateRules(rawRules(over as never))).toThrow(`SCHEMA: ${message}`);
  });
  it("refuses a salt of 33 bytes and an over-long salt string", () => {
    const b33 = btoa(String.fromCharCode(...new Uint8Array(33)));
    expect(() => validateRules(rawRules({ salt: b33 }))).toThrow("SCHEMA: rules.salt: must encode exactly 32 bytes");
    expect(() => validateRules(rawRules({ salt: "A".repeat(100_000) }))).toThrow("SCHEMA: salt: must be at most 44 base64 characters");
  });
  it("accepts wrap.near (token_y) as the quote token", () => {
    expect(validateRules(rawRules({ quote_token: WNEAR })).quote_token).toBe(WNEAR);
  });
});
