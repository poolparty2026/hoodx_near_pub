import { describe, expect, it } from "vitest";
import { loadFollow, parseConfigForFollow, viewAgreed, type ViewFn } from "../src/lib/keys/chain.ts";
import { ViewError } from "../src/lib/keys/views.ts";

const params = { key_price: "5", key_delivery_window_ns: "9", max_key_sales: 3, sold: 1, deliverer: "d.testnet", escrow_total: "0", near_owed_total: "0" };
const b64 = (n: number) => btoa(String.fromCharCode(...Array(n).fill(1)));
const cfg = (n = 41) => ({ rules_hash: "ab".repeat(32), rules_ciphertext: b64(n) });
const src = (over: Record<string, unknown> = {}): ViewFn => async (_c, m) => (m in over ? over[m] : ({ get_key_params: params, get_key_sale: null, get_config: cfg() } as Record<string, unknown>)[m]);

describe("live reads (EC-W08)", () => {
  it("loads when both providers agree, key order does not matter", async () => {
    const d = await loadFollow(src(), src({ get_key_params: Object.fromEntries(Object.entries(params).reverse()) }), "s.testnet", "a.testnet");
    expect(d.params.keyPrice).toBe(5n);
    expect(d.sale).toBeNull();
  });
  it("refuses when providers disagree or one fails", async () => {
    await expect(viewAgreed(src(), src({ get_key_params: { ...params, key_price: "6" } }), "s", "get_key_params")).rejects.toThrow("the two providers disagree");
    await expect(viewAgreed(src(), async () => { throw new Error("down"); }, "s", "get_key_params")).rejects.toThrow("a provider failed");
  });
  it("ciphertext (base64, Base64VecU8): 41 and 4137 bytes ok, 40 and 4138 refused, non-base64 refused", () => {
    expect(parseConfigForFollow(cfg(41)).ciphertext).toHaveLength(41);
    expect(parseConfigForFollow(cfg(4137)).ciphertext).toHaveLength(4137);
    expect(() => parseConfigForFollow(cfg(40))).toThrow(ViewError);
    expect(() => parseConfigForFollow(cfg(4138))).toThrow(ViewError);
    expect(() => parseConfigForFollow({ ...cfg(), rules_ciphertext: Array(41).fill(1) })).toThrow(ViewError);
    expect(() => parseConfigForFollow({ ...cfg(), rules_ciphertext: "!!!!" })).toThrow(ViewError);
    expect(() => parseConfigForFollow({ ...cfg(), rules_ciphertext: b64(41).replace(/E=$/, "F=") })).toThrow(ViewError);
    expect(() => parseConfigForFollow({ ...cfg(), rules_hash: "AB".repeat(32) })).toThrow(ViewError);
  });
});

describe("N1: get_key_sale is asked for exactly the given account", () => {
  it("passes {buyer: account} to the view, and does not ask at all with no account", async () => {
    const calls: [string, string, Record<string, unknown>][] = [];
    const rec: ViewFn = async (c, m, a) => { calls.push([c, m, a]); return src()(c, m, a); };
    await loadFollow(rec, rec, "s.testnet", "alice.testnet");
    expect(calls.filter((c) => c[1] === "get_key_sale").map((c) => c[2])).toEqual([{ buyer: "alice.testnet" }, { buyer: "alice.testnet" }]);
    calls.length = 0;
    await loadFollow(rec, rec, "s.testnet", null);
    expect(calls.some((c) => c[1] === "get_key_sale")).toBe(false);
  });
});
