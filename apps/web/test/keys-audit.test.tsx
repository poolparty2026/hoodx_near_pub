import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { encryptRules, hashRules, parseRules, toHex } from "@poolside/rules";
import { sealedBox } from "../src/lib/keys/deps.ts";
import { BUY_REFUSALS, NOT_FOR_SALE, buy, buyState, errorText, openAndVerify, pubkeyHex, runBuy, runRefund, type BuyerKeyPair, type Wallet } from "../src/lib/keys/flow.ts";
import { loadFollow, parseConfigForFollow, rpcView, TESTNET_RPCS, type ViewFn } from "../src/lib/keys/chain.ts";
import { GAS_BUY, GAS_REFUND, TESTNET_RPC, realAccount, testnetWallet, type ChainAccount } from "../src/lib/keys/wallet.ts";
import { parseKeyParams, parseKeySale, parseKeySales, ViewError } from "../src/lib/keys/views.ts";
import { isTestnetId } from "../src/lib/keys/ids.ts";
import { UnlockedView } from "../src/components/KeyPanel.tsx";
import { FollowLive } from "../src/components/FollowLive.tsx";
import { RECORDED_KEY_PARAMS } from "../src/lib/keys/fixtures.ts";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const RULES = parseRules(JSON.stringify({ version: 1, pool: `${USDC}|wrap.near|100`, quote_token: USDC, range: { width_bps: 800, centre: "mid" }, take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }));
const HASH = toHex(hashRules(RULES));
const STRAT = "strategy.fixture.testnet";
const P = RECORDED_KEY_PARAMS;
const KEYS_RS = readFileSync(fileURLToPath(new URL("../../../contracts/strategy/src/contract/keys.rs", import.meta.url)), "utf8");
const CONTRACT_RS = readFileSync(fileURLToPath(new URL("../../../contracts/strategy/src/contract.rs", import.meta.url)), "utf8");

// B1: the contract's own serde output, recorded from its unit-test build (see _provenance in the fixture).
const WIRE = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/contract-wire.json", import.meta.url)), "utf8"));
const REAL_PARAMS = WIRE.after_buy.get_key_params;
const REAL_SALE = WIRE.after_buy.get_key_sale;

describe("B1: the page parses what the contract really returns", () => {
  it("before any sale: get_key_params, get_key_sale (null) and get_config", () => {
    expect(parseKeyParams(WIRE.before_sale.get_key_params).sold).toBe(0);
    expect(parseKeySale(WIRE.before_sale.get_key_sale)).toBeNull();
    const cfg = parseConfigForFollow(WIRE.before_sale.get_config);
    expect(cfg.rulesHash).toBe(WIRE.before_sale.get_config.rules_hash);
    expect(cfg.ciphertext.length).toBeGreaterThanOrEqual(41);
  });
  it("after a buy: the Escrowed sale, the sales page and the counters", () => {
    const p = parseKeyParams(WIRE.after_buy.get_key_params);
    expect(p.sold).toBe(1);
    expect(p.escrowTotal).toBe(p.keyPrice);
    const sale = parseKeySale(WIRE.after_buy.get_key_sale)!;
    expect(sale).toMatchObject({ buyer: "bob.near", state: "Escrowed", sealedKey: null, price: p.keyPrice });
    expect(parseKeySales(WIRE.after_buy.get_key_sales)).toEqual([sale]);
    expect(buyState(p, sale, sale.boughtAtNs).kind).toBe("waiting");
  });
  it("Released and Refunded sales as the contract wasm returns them (sandbox dump)", () => {
    const rr = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/contract-wire-released-refunded.json", import.meta.url)), "utf8"));
    const released = parseKeySale(rr.get_key_sale_released)!;
    expect(released).toMatchObject({ state: "Released", price: parseKeyParams(rr.get_key_params_after_deliver).keyPrice });
    expect(released.sealedKey).toBe(rr.get_key_sale_released.sealed_key);
    expect(released.sealedKey).toMatch(/^[0-9a-f]{160}$/);
    expect(parseKeyParams(rr.get_key_params_after_deliver)).toMatchObject({ sold: 1, escrowTotal: 0n });
    const refunded = parseKeySale(rr.get_key_sale_refunded)!;
    expect(refunded).toMatchObject({ state: "Refunded", sealedKey: null });
    expect(parseKeyParams(rr.get_key_params_after_refund)).toMatchObject({ sold: 2, escrowTotal: 0n });
    expect(rr.get_key_params_after_deliver.escrow_total).toBe("0");
    expect(rr.get_key_params_after_refund.escrow_total).toBe("0");
    const p = parseKeyParams(rr.get_key_params_after_deliver);
    expect(buyState(p, released, released.boughtAtNs + 10n * p.windowNs).kind).toBe("delivered"); // never a refund after delivery
    expect(buyState(p, refunded, 0n).kind).toBe("refunded");
  });
  it("the Rust source still has the field names, variants and methods the page relies on", () => {
    for (const f of ["key_price: U128", "key_delivery_window_ns: U64", "max_key_sales: u32", "sold: u32", "deliverer: AccountId", "escrow_total: U128", "near_owed_total: U128", "buyer_pubkey: String", "bought_at_ns: U64", "sealed_key: Option<String>"]) expect(KEYS_RS).toContain(f);
    for (const v of ["Escrowed", "Released", "Refunded"]) expect(KEYS_RS).toContain(v);
    expect(CONTRACT_RS).toContain("rules_ciphertext: Base64VecU8");
    for (const m of ["buy_viewing_key", "refund_key", "get_key_params", "get_key_sale"]) expect(KEYS_RS).toContain(`pub fn ${m}`);
  });
});

describe("B2: EC-K tests", () => {
  const refusalsInRust = (r: string) => KEYS_RS.includes(`"${r}"`) || CONTRACT_RS.includes(`"${r}"`);
  it.each([...BUY_REFUSALS])("BUY_REFUSALS %s is a real contract refusal and reaches the screen verbatim", (r) => {
    expect(refusalsInRust(r)).toBe(true);
    expect(errorText(new Error(r))).toBe(r);
  });
  it("EC-K01: a key sealed to someone else's pair does not open: nothing shown", async () => {
    const buyer = await sealedBox.generateKeyPair(), other = await sealedBox.generateKeyPair();
    const K = crypto.getRandomValues(new Uint8Array(32));
    const sale = parseKeySale({ ...REAL_SALE, buyer_pubkey: pubkeyHex(buyer), state: "Released", sealed_key: toHex(await sealedBox.seal(other.publicKey, K)) })!;
    const ct = encryptRules(RULES, K, new Uint8Array(24).fill(1), STRAT);
    expect(await openAndVerify({ box: sealedBox, kp: buyer, sale, strategyId: STRAT, rulesHashHex: HASH, ciphertext: ct })).toEqual({ kind: "failed", reason: "does_not_open" });
  });
  it("EC-K03 and EC-K04: the deliverer seals a wrong key: failed check, stated trust shown, no rules", async () => {
    const buyer = await sealedBox.generateKeyPair();
    const K = crypto.getRandomValues(new Uint8Array(32)), wrong = crypto.getRandomValues(new Uint8Array(32));
    const sale = parseKeySale({ ...REAL_SALE, buyer_pubkey: pubkeyHex(buyer), state: "Released", sealed_key: toHex(await sealedBox.seal(buyer.publicKey, wrong)) })!;
    const ct = encryptRules(RULES, K, new Uint8Array(24).fill(1), STRAT);
    const r = await openAndVerify({ box: sealedBox, kp: buyer, sale, strategyId: STRAT, rulesHashHex: HASH, ciphertext: ct });
    expect(r).toEqual({ kind: "failed", reason: "rules_do_not_match" });
    const out = renderToStaticMarkup(<UnlockedView result={r} />);
    expect(out).toContain("Nothing was shown");
    expect(out).toContain("there is no refund after delivery");
    expect(out).not.toContain("<pre");
  });
});

describe("H1 (EC-W08): one dishonest provider cannot get a tampered value shown", () => {
  const honest: ViewFn = async (_c, m) => ({ get_key_params: REAL_PARAMS, get_key_sale: REAL_SALE, get_config: { rules_hash: HASH, rules_ciphertext: btoa(String.fromCharCode(...new Uint8Array(41).fill(1))) } } as Record<string, unknown>)[m];
  const tamper = (method: string, v: unknown): ViewFn => async (c, m, a) => (m === method ? v : honest(c, m, a));
  it.each([
    ["get_config", { rules_hash: HASH, rules_ciphertext: btoa(String.fromCharCode(...new Uint8Array(41).fill(2))) }],
    ["get_key_sale", { ...REAL_SALE, state: "Released", sealed_key: "cd".repeat(80) }],
    ["get_key_params", { ...REAL_PARAMS, key_price: "1" }],
  ])("%s differs between providers: refused", async (m, v) => {
    await expect(loadFollow(honest, tamper(m, v), STRAT, "alice.testnet")).rejects.toThrow("the two providers disagree");
    await expect(loadFollow(tamper(m, v), honest, STRAT, "alice.testnet")).rejects.toThrow("the two providers disagree");
  });
});

describe("H2: default endpoints", () => {
  it("are exactly these two testnet URLs, and the wallet uses the first", () => {
    expect([...TESTNET_RPCS]).toEqual(["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"]);
    expect(TESTNET_RPC).toBe(TESTNET_RPCS[0]);
  });
  it("realAccount and rpcView build without touching the network", () => {
    const acc = realAccount("a.testnet", "ed25519:3D4YudUQRE39Lc4JHghuB5WM8kbgDDa9Vc2ELGPjHHCqwPF4BPqkVMQwjzcSHgwFuYKMxUWLDEmoDZ1rhF1jdXe");
    expect(acc.accountId).toBe("a.testnet");
    expect(typeof rpcView(TESTNET_RPCS[0])).toBe("function");
  });
});

describe("H3: exact wallet call arguments", () => {
  const fake = () => { const calls: unknown[] = []; const acc: ChainAccount = { accountId: "a.testnet", chainId: async () => "testnet", callFunction: async (a) => { calls.push(a); } }; return { acc, calls }; };
  it("buy and refund send exactly these arguments", async () => {
    const { acc, calls } = fake();
    await testnetWallet(acc).buyViewingKey(STRAT, "ab".repeat(32), 5n);
    await testnetWallet(acc).refundKey(STRAT);
    expect(calls).toEqual([
      { contractId: STRAT, methodName: "buy_viewing_key", args: { buyer_pubkey: "ab".repeat(32) }, deposit: 5n, gas: GAS_BUY },
      { contractId: STRAT, methodName: "refund_key", args: {}, deposit: 0n, gas: GAS_REFUND },
    ]);
  });
});

describe("H4: buy() state guard", () => {
  const sent: unknown[][] = [];
  const wallet: Wallet = { accountId: "a.testnet", buyViewingKey: async (...x) => { sent.push(x); }, refundKey: async () => {} };
  const kp: BuyerKeyPair = { publicKey: new Uint8Array(32).fill(9), secretKey: new Uint8Array(32).fill(1) };
  it("sold out, an existing sale, and an all-zero key all send nothing", async () => {
    sent.length = 0;
    await expect(buy({ wallet, strategy: STRAT, params: { ...P, sold: P.maxKeySales }, kp, sale: null, nowNs: 0n })).rejects.toThrow(NOT_FOR_SALE);
    await expect(buy({ wallet, strategy: STRAT, params: P, kp, sale: parseKeySale(REAL_SALE), nowNs: 0n })).rejects.toThrow(NOT_FOR_SALE);
    await expect(buy({ wallet, strategy: STRAT, params: P, kp: { ...kp, publicKey: new Uint8Array(32) }, sale: null, nowNs: 0n })).rejects.toThrow("not all zero");
    expect(sent).toEqual([]);
  });
});

describe("H5: runBuy and runRefund clear the testnet key and re-read, whatever happens", () => {
  const kp: BuyerKeyPair = { publicKey: new Uint8Array(32).fill(9), secretKey: new Uint8Array(32).fill(1) };
  const mk = (fail?: string) => { const log: string[] = []; const wallet: Wallet = { accountId: "a.testnet", buyViewingKey: async () => { log.push("buy"); if (fail) throw new Error(fail); }, refundKey: async () => { log.push("refund"); if (fail) throw new Error(fail); } }; return { log, wallet }; };
  const base = (log: string[], wallet: Wallet, saved = true) => ({ wallet, strategy: STRAT, params: P, kp, sale: null, nowNs: 0n, saved, clearSecret: () => log.push("clear"), reload: async () => { log.push("reload"); } });
  it("success: buy, clear, reload", async () => { const { log, wallet } = mk(); await runBuy(base(log, wallet)); expect(log).toEqual(["buy", "clear", "reload"]); });
  it("failure: error passes through, key still cleared, views still re-read", async () => {
    const { log, wallet } = mk("LIMIT: key price");
    await expect(runBuy(base(log, wallet))).rejects.toThrow("LIMIT: key price");
    expect(log).toEqual(["buy", "clear", "reload"]);
  });
  it("not saved: nothing sent, and the testnet key is still cleared", async () => { const { log, wallet } = mk(); await expect(runBuy(base(log, wallet, false))).rejects.toThrow("Save your key pair first. Nothing was sent."); expect(log).toEqual(["clear", "reload"]); });
  it("refund: re-reads first; sends only when a refund is open; clears either way", async () => {
    const esc = parseKeySale(REAL_SALE)!;
    const deadline = esc.boughtAtNs + P.windowNs;
    for (const [now, sends] of [[deadline - 1n, false], [deadline, true]] as const) {
      const { log, wallet } = mk();
      const go = runRefund({ wallet, strategy: STRAT, nowNs: () => now, clearSecret: () => log.push("clear"), reload: async () => { log.push("reload"); return { params: P, sale: esc }; } });
      if (sends) await go; else await expect(go).rejects.toThrow("A refund is not available right now. Nothing was sent.");
      expect(log).toEqual(sends ? ["reload", "refund", "clear", "reload"] : ["reload", "clear", "reload"]);
    }
  });
  it("the page never prints a secret: no value attribute on the password field, no secret in the markup", () => {
    const out = renderToStaticMarkup(<FollowLive strategy={STRAT} />);
    expect(out).not.toMatch(/secret key[^<]*<input[^>]*value="[^"]+"/);
  });
});

describe("A2: ids and key shape", () => {
  it.each([["x..testnet", false], ["x.testnet", true], ["ab.testnet", true], ["a.b.testnet", true], [".ab.testnet", false], ["ab-.testnet", false], ["-ab.testnet", false], ["ab.testnet.near", false], ["testnet", false], ["a".repeat(56) + ".testnet", true], ["a".repeat(57) + ".testnet", false], ["AB.testnet", false]])("isTestnetId(%j) = %s", (id, ok) => { expect(isTestnetId(id as string)).toBe(ok); });
  it("errorText hides every redacted string and keeps the contract's text otherwise", () => {
    expect(errorText(new Error("LIMIT: key price"), ["secret"])).toBe("LIMIT: key price");
    expect(errorText(new Error("x secret y secret"), ["secret", ""])).toBe("x [hidden] y [hidden]");
  });
  it("a wallet refuses x..testnet as strategy", async () => {
    const calls: unknown[] = [];
    const acc: ChainAccount = { accountId: "a.testnet", chainId: async () => "testnet", callFunction: async (a) => { calls.push(a); } };
    await expect(testnetWallet(acc).buyViewingKey("x..testnet", "ab".repeat(32), 1n)).rejects.toThrow("only works on testnet");
    expect(calls).toEqual([]);
  });
});

describe("medium: parser limits", () => {
  it("u32 max ok, max+1 refused; sold may not exceed max_key_sales is the contract's job, not the parser's", () => {
    expect(parseKeyParams({ ...REAL_PARAMS, max_key_sales: 4294967295 }).maxKeySales).toBe(4294967295);
    expect(() => parseKeyParams({ ...REAL_PARAMS, max_key_sales: 4294967296 })).toThrow(ViewError);
    expect(parseKeyParams({ ...REAL_PARAMS, key_delivery_window_ns: (2n ** 64n - 1n).toString() }).windowNs).toBe(2n ** 64n - 1n);
    expect(() => parseKeyParams({ ...REAL_PARAMS, key_delivery_window_ns: (2n ** 64n).toString() })).toThrow(ViewError);
  });
  it("account id: 64 characters ok, 65 refused", () => {
    expect(parseKeySale({ ...REAL_SALE, buyer: "a".repeat(64) })?.buyer).toHaveLength(64);
    expect(() => parseKeySale({ ...REAL_SALE, buyer: "a".repeat(65) })).toThrow(ViewError);
  });
  it("ciphertext base64: URL-safe, whitespace and empty are refused", () => {
    const ok = btoa(String.fromCharCode(...new Uint8Array(41).fill(250)));
    const cfg = (c: string) => ({ rules_hash: HASH, rules_ciphertext: c });
    expect(parseConfigForFollow(cfg(ok)).ciphertext).toHaveLength(41);
    expect(() => parseConfigForFollow(cfg(ok.replaceAll("+", "-").replaceAll("/", "_")))).toThrow(ViewError);
    expect(() => parseConfigForFollow(cfg(ok + "\n"))).toThrow(ViewError);
    expect(() => parseConfigForFollow(cfg(""))).toThrow(ViewError);
  });
  it("a sealed key of the wrong length is refused by the parser, and a box that returns a short key does not open", async () => {
    const buyer = await sealedBox.generateKeyPair();
    const short = toHex(await sealedBox.seal(buyer.publicKey, new Uint8Array(16)));
    expect(() => parseKeySale({ ...REAL_SALE, buyer_pubkey: pubkeyHex(buyer), state: "Released", sealed_key: short })).toThrow(ViewError);
    const sale = parseKeySale({ ...REAL_SALE, buyer_pubkey: pubkeyHex(buyer), state: "Released", sealed_key: "cd".repeat(80) })!;
    const shortBox = { ...sealedBox, open: async () => new Uint8Array(16) };
    expect(await openAndVerify({ box: shortBox, kp: buyer, sale, strategyId: STRAT, rulesHashHex: HASH, ciphertext: new Uint8Array(41) })).toEqual({ kind: "failed", reason: "does_not_open" });
  });
});

import { rpcOrigins, TESTNET_RPC_2 } from "../src/lib/keys/rpcs.ts";
describe("lows: price 0 and the RPC constants", () => {
  it("a free key (price 0) is bought with a deposit of exactly 0, never more", async () => {
    const sent: unknown[][] = [];
    const wallet: Wallet = { accountId: "a.testnet", buyViewingKey: async (...x) => { sent.push(x); }, refundKey: async () => {} };
    const kp = await sealedBox.generateKeyPair();
    await buy({ wallet, strategy: STRAT, params: { ...P, keyPrice: 0n }, kp, sale: null, nowNs: 0n });
    expect(sent).toEqual([[STRAT, toHex(kp.publicKey), 0n]]);
  });
  it("rpcOrigins gives the origin of each testnet endpoint and nothing else", () => {
    expect(rpcOrigins()).toEqual(["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"]);
    expect(TESTNET_RPC_2).toBe("https://test.rpc.fastnear.com");
  });
});
