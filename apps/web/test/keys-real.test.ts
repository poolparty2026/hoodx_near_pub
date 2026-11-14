import { describe, expect, it } from "vitest";
import { encryptRules, hashRules, parseRules, toHex } from "@poolside/rules";
import { sealedBox } from "../src/lib/keys/deps.ts";
import { openAndVerify, pubkeyHex } from "../src/lib/keys/flow.ts";
import { parseKeySale } from "../src/lib/keys/views.ts";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const RULES = parseRules(JSON.stringify({ version: 1, pool: `${USDC}|wrap.near|100`, quote_token: USDC, range: { width_bps: 800, centre: "mid" }, take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }));
const HASH = toHex(hashRules(RULES));
const STRAT = "strategy.fixture.testnet";

describe("real libsodium seal, end to end (D57-a)", () => {
  it("buyer pair -> sealed key -> sale view -> unlock -> hash matches; a different buyer cannot open", async () => {
    const kp = await sealedBox.generateKeyPair();
    const K = crypto.getRandomValues(new Uint8Array(32));
    const ct = encryptRules(RULES, K, crypto.getRandomValues(new Uint8Array(24)), STRAT);
    const sealed = toHex(await sealedBox.seal(kp.publicKey, K));
    expect(sealed).toMatch(/^[0-9a-f]{160}$/);
    const sale = parseKeySale({ buyer: "a.testnet", buyer_pubkey: pubkeyHex(kp), state: "Released", bought_at_ns: "1", price: "1", sealed_key: sealed })!;
    const r = await openAndVerify({ box: sealedBox, kp, sale, strategyId: STRAT, rulesHashHex: HASH, ciphertext: ct });
    expect(r.kind).toBe("unlocked");
    const other = await sealedBox.generateKeyPair();
    const saleOther = parseKeySale({ buyer: "b.testnet", buyer_pubkey: pubkeyHex(other), state: "Released", bought_at_ns: "1", price: "1", sealed_key: sealed })!;
    expect(await openAndVerify({ box: sealedBox, kp: other, sale: saleOther, strategyId: STRAT, rulesHashHex: HASH, ciphertext: ct })).toEqual({ kind: "failed", reason: "does_not_open" });
  });
});
