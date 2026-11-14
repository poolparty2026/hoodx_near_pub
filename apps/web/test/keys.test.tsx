import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { encryptRules, hashRules, parseRules, toHex } from "@poolside/rules";
import { parseKeyParams, parseKeySale, parseKeySales, ViewError } from "../src/lib/keys/views.ts";
import { MAX_KEY_PRICE_YOCTO, pairIsConsistent, buy, buyState, exportSecret, importSecret, fromHex, openAndVerify, pubkeyHex, type BuyerKeyPair, type SealedBox, type Wallet } from "../src/lib/keys/flow.ts";
import { UnlockedView, BuyStatus, DataBanner } from "../src/components/KeyPanel.tsx";
import FollowPage from "../src/app/follow/[strategy]/page.tsx";
import { sealedBox } from "../src/lib/keys/deps.ts";
import { RECORDED_KEY_PARAMS } from "../src/lib/keys/fixtures.ts";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const RULES = parseRules(JSON.stringify({ version: 1, pool: `${USDC}|wrap.near|100`, quote_token: USDC, range: { width_bps: 800, centre: "mid" }, take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }));
const HASH = toHex(hashRules(RULES));
const STRAT = "strategy.fixture.testnet";
const K = new Uint8Array(32).fill(0xab);
// TEST DOUBLE ONLY, not a crypto scheme: "sealing" prefixes the buyer pubkey so open() can tell right from wrong key.
const box: SealedBox = {
  generateKeyPair: async () => ({ publicKey: new Uint8Array(32).fill(9), secretKey: new Uint8Array(32).fill(1) }),
  seal: async (pk, msg) => new Uint8Array([...pk, ...msg, ...new Uint8Array(16)]),
  open: async (pk, _sk, ct) => { if (toHex(ct.subarray(0, 32)) !== toHex(pk)) throw new Error("x"); return ct.subarray(32, 64); },
};
const kp = await box.generateKeyPair();
const sealedHex = toHex(new Uint8Array([...kp.publicKey, ...K, ...new Uint8Array(16)]));
const sale = (o: Record<string, unknown> = {}) => ({ buyer: "alice.testnet", buyer_pubkey: toHex(kp.publicKey), state: "Released", bought_at_ns: "100", price: "5", sealed_key: sealedHex, ...o });
const ct = encryptRules(RULES, K, new Uint8Array(24).fill(3), STRAT);

describe("view parsers (T74: views only, strict)", () => {
  const params = { key_price: "1", key_delivery_window_ns: "2", max_key_sales: 5, sold: 0, deliverer: "d.testnet", escrow_total: "0", near_owed_total: "0" };
  it("reads get_key_params", () => expect(parseKeyParams(params).keyPrice).toBe(1n));
  it.each(["+5", "007", "", "1.0", "-1", "340282366920938463463374607431768211456"])("refuses u128 %j", (v) => expect(() => parseKeyParams({ ...params, key_price: v })).toThrow(ViewError));
  it("accepts u128 max, refuses max+1", () => {
    expect(parseKeyParams({ ...params, key_price: (2n ** 128n - 1n).toString() }).keyPrice).toBe(2n ** 128n - 1n);
    expect(() => parseKeyParams({ ...params, key_price: (2n ** 128n).toString() })).toThrow(ViewError);
  });
  it("sale: null is no sale; Released needs a 160-hex key, others must have none", () => {
    expect(parseKeySale(null)).toBeNull();
    expect(parseKeySale(sale())?.state).toBe("Released");
    expect(() => parseKeySale(sale({ sealed_key: null }))).toThrow(ViewError);
    expect(() => parseKeySale(sale({ state: "Escrowed" }))).toThrow(ViewError);
    expect(() => parseKeySale(sale({ sealed_key: sealedHex.slice(2) }))).toThrow(ViewError);
    expect(() => parseKeySale(sale({ sealed_key: sealedHex.toUpperCase() }))).toThrow(ViewError);
    expect(() => parseKeySale(sale({ buyer_pubkey: "ab" }))).toThrow(ViewError);
    expect(() => parseKeySale(sale({ state: "Weird" }))).toThrow(ViewError);
  });
  it("sales page: 50 ok, 51 refused", () => {
    expect(parseKeySales(Array(50).fill(sale()))).toHaveLength(50);
    expect(() => parseKeySales(Array(51).fill(sale()))).toThrow(ViewError);
  });
});

describe("buy state", () => {
  const p = RECORDED_KEY_PARAMS;
  const esc = parseKeySale(sale({ state: "Escrowed", sealed_key: null, bought_at_ns: "1000" }))!;
  it("limit: sold == max is sold out, one below can buy", () => {
    expect(buyState({ ...p, sold: p.maxKeySales }, null, 0n).kind).toBe("sold_out");
    expect(buyState({ ...p, sold: p.maxKeySales - 1 }, null, 0n)).toEqual({ kind: "can_buy", deposit: p.keyPrice });
    expect(buyState({ ...p, maxKeySales: 0 }, null, 0n).kind).toBe("sold_out");
  });
  it("refund opens exactly at bought_at + window, not one ns earlier", () => {
    const dl = 1000n + p.windowNs;
    expect(buyState(p, esc, dl - 1n).kind).toBe("waiting");
    expect(buyState(p, esc, dl).kind).toBe("can_refund");
  });
});

describe("open and verify", () => {
  const a = { box, kp, sale: parseKeySale(sale())!, strategyId: STRAT, rulesHashHex: HASH, ciphertext: ct };
  it("unlocks and the hash matches", async () => expect((await openAndVerify(a)).kind).toBe("unlocked"));
  it("wrong strategy, wrong hash, tampered ciphertext, wrong key all fail with nothing shown", async () => {
    expect(await openAndVerify({ ...a, strategyId: "other.testnet" })).toEqual({ kind: "failed", reason: "rules_do_not_match" });
    expect(await openAndVerify({ ...a, rulesHashHex: "0".repeat(64) })).toEqual({ kind: "failed", reason: "rules_do_not_match" });
    const bad = ct.slice(); bad[40] = (bad[40] ?? 0) ^ 1;
    expect((await openAndVerify({ ...a, ciphertext: bad })).kind).toBe("failed");
    const other: BuyerKeyPair = { publicKey: new Uint8Array(32).fill(8), secretKey: kp.secretKey };
    expect(await openAndVerify({ ...a, kp: other })).toEqual({ kind: "failed", reason: "wrong_pubkey" });
  });
  it("a sale that is not delivered does not open", async () => expect(await openAndVerify({ ...a, sale: parseKeySale(sale({ state: "Escrowed", sealed_key: null }))! })).toEqual({ kind: "failed", reason: "sale_not_delivered" }));
  it("refuses an all-zero buyer key", () => expect(() => pubkeyHex({ publicKey: new Uint8Array(32), secretKey: kp.secretKey })).toThrow());
  it("export and import round trip; junk is refused", () => {
    const back = importSecret(exportSecret(kp));
    expect(toHex(back.secretKey)).toBe(toHex(kp.secretKey));
    expect(toHex(back.publicKey)).toBe(toHex(kp.publicKey));
    expect(() => importSecret("hello")).toThrow("not a hoodx LP agent viewing key backup");
    expect(() => importSecret(`poolside-viewing-key-v1\n${"0".repeat(63)}\n${"0".repeat(64)}\n`)).toThrow();
  });
  it("fromHex round trips", () => expect(toHex(fromHex(sealedHex))).toBe(sealedHex));
});

describe("buy", () => {
  const wallet = (calls: unknown[][], fail?: string): Wallet => ({ accountId: "a.testnet", buyViewingKey: async (...x) => { calls.push(x); if (fail) throw new Error(fail); }, refundKey: async () => {} });
  it("attaches exactly key_price and sends the public key, never the secret", async () => {
    const calls: unknown[][] = [];
    const kp2 = await box.generateKeyPair();
    await buy({ wallet: wallet(calls), strategy: STRAT, params: RECORDED_KEY_PARAMS, kp: kp2, sale: null, nowNs: 0n });
    expect(calls).toEqual([[STRAT, toHex(kp2.publicKey), RECORDED_KEY_PARAMS.keyPrice]]);
    expect(JSON.stringify(calls, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(toHex(kp2.secretKey));
  });
  it("a refusal from the contract passes through unchanged", async () => {
    await expect(buy({ wallet: wallet([], "LIMIT: key price"), strategy: STRAT, params: RECORDED_KEY_PARAMS, kp, sale: null, nowNs: 0n })).rejects.toThrow("LIMIT: key price");
  });
  it("M4: price at 10 NEAR is allowed, one yocto more is refused and nothing is sent", async () => {
    const calls: unknown[][] = [];
    await buy({ wallet: wallet(calls), strategy: STRAT, params: { ...RECORDED_KEY_PARAMS, keyPrice: MAX_KEY_PRICE_YOCTO }, kp, sale: null, nowNs: 0n });
    expect(calls).toHaveLength(1);
    await expect(buy({ wallet: wallet(calls), strategy: STRAT, params: { ...RECORDED_KEY_PARAMS, keyPrice: MAX_KEY_PRICE_YOCTO + 1n }, kp, sale: null, nowNs: 0n })).rejects.toThrow("Nothing was sent");
    expect(calls).toHaveLength(1);
  });
  it("pairIsConsistent accepts a real pair, refuses a mismatched one", async () => {
    const real = await sealedBox.generateKeyPair(), other = await sealedBox.generateKeyPair();
    expect(await pairIsConsistent(sealedBox, real)).toBe(true);
    expect(await pairIsConsistent(sealedBox, { publicKey: real.publicKey, secretKey: other.secretKey })).toBe(false);
  });
});

describe("buy status text", () => {
  it("the waiting text says where the delivery has run and where it has not", () => {
    const out = renderToStaticMarkup(<BuyStatus state={{ kind: "waiting", deadlineNs: 1n }} />);
    expect(out).toContain("run end to end in a local sandbox, by script and not through this page, and has not been run on testnet");
    expect(out).not.toContain("not been run end to end");
    expect(out).toContain("you can ask for a refund");
  });
});

describe("screens", () => {
  it("EC-W04 and EC-W11: rules text with HTML is rendered as text", () => {
    const out = renderToStaticMarkup(<UnlockedView result={{ kind: "unlocked", rules: RULES, hashMatches: true }} rulesText={'<img src=x onerror=alert(1)>'} />);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
  it("a failed unlock shows no rules", () => {
    const out = renderToStaticMarkup(<UnlockedView result={{ kind: "failed", reason: "does_not_open" }} />);
    expect(out).toContain("Nothing was shown");
    expect(out).not.toContain("<pre");
  });
  it("the follow page says what data it shows and escapes the strategy name", async () => {
    const out = renderToStaticMarkup(await FollowPage({ params: Promise.resolve({ strategy: "<script>x</script>" }) }));
    expect(out).toContain("Testnet data.");
    expect(out).toContain("anyone who holds the key can copy them or pass them on");
    expect(out).toContain("The strategy wallet is visible on Rhea");
    expect(out).toContain("single account that you have to trust");
    expect(out).toContain("after delivery there is no refund");
    expect(out).not.toContain("<script>");
  });
  it("banners state their kind; no fee split number", () => {
    for (const k of ["sample", "recorded", "testnet"] as const) expect(renderToStaticMarkup(<DataBanner kind={k} />)).toMatch(/data\./i);
    expect(renderToStaticMarkup(<BuyStatus state={{ kind: "can_buy", deposit: 10n ** 24n }} />)).toContain("1 NEAR");
  });
});

import { FollowLive } from "../src/components/FollowLive.tsx";
describe("follow screen", () => {
  it("says testnet, no real tokens; the secret field only appears after a load; nothing is read before", () => {
    const out = renderToStaticMarkup(<FollowLive strategy={STRAT} />);
    expect(out).toContain("Testnet data.");
    expect(out).toContain("Testnet only, no real tokens");
    expect(out).not.toContain('type="password"');
    expect(out).not.toContain("Step 1");
    expect(out).toContain("disabled");
  });
});
