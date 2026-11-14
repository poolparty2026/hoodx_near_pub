import { describe, expect, it } from "vitest";
import { hashRules, parseRules, toHex } from "@poolside/rules";
import { REC, deliveredSale, escrowedSale, iso, near, prepareWorld, unlock } from "../src/lib/journey/model.ts";
import { sealedBox } from "../src/lib/keys/deps.ts";

describe("journey: the real parts (hash, sealed box, unlock)", () => {
  it("the recorded rules hash to the recorded on-chain rules_hash", () => {
    expect(toHex(hashRules(parseRules(REC.rulesText)))).toBe(REC.rulesHash);
    expect(REC.rulesHash).toBe("5305d16d4187d171527a0b45215ecbf9f78b602de4e0c05081aff899115950ef");
  });
  it("buy -> deliver -> unlock: the rules appear for real and match the hash", async () => {
    const w = await prepareWorld();
    const escrowed = escrowedSale(w, 1_000n);
    expect(escrowed).toMatchObject({ state: "Escrowed", sealedKey: null, price: BigInt(REC.keyPriceYocto) });
    expect((await unlock(w, escrowed)).kind).toBe("failed"); // before delivery there is nothing to open
    const released = await deliveredSale(w, escrowed);
    expect(released.state).toBe("Released");
    expect(released.sealedKey).toMatch(/^[0-9a-f]{160}$/);
    const r = await unlock(w, released);
    expect(r).toMatchObject({ kind: "unlocked", hashMatches: true });
    if (r.kind === "unlocked") expect(toHex(hashRules(r.rules))).toBe(REC.rulesHash);
  });
  it("a different follower's key pair cannot open the delivered key; a tampered ciphertext shows nothing", async () => {
    const w = await prepareWorld();
    const released = await deliveredSale(w, escrowedSale(w, 1n));
    const other = await sealedBox.generateKeyPair();
    expect((await unlock(w, released, other)).kind).toBe("failed");
    const bad = w.ciphertext.slice(); bad[40] = (bad[40] ?? 0) ^ 1;
    expect(await unlock({ ...w, ciphertext: bad }, released)).toEqual({ kind: "failed", reason: "rules_do_not_match" });
  });
  it("formats the recorded price and times", () => {
    expect(near(REC.keyPriceYocto)).toBe("0.1 NEAR");
    expect(iso("1794617497017860165")).toMatch(/^2026-11-1\dT/);
  });
});
