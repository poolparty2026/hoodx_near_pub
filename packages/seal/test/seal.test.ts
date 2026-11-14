import { describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers";
import {
  generateKeyPair,
  openKey,
  sealKey,
  SEALED_HEX_LEN,
  KEY_BYTES,
  toHex,
  fromHex,
} from "../src/index.ts";

const K = new Uint8Array(32).map((_, i) => i + 1);

describe("sealKey / openKey", () => {
  it("round-trips, output is 160 lowercase hex (80 bytes)", async () => {
    const kp = await generateKeyPair();
    expect(kp.publicKey).toMatch(/^[0-9a-f]{64}$/);
    const sealed = await sealKey(K, kp.publicKey);
    expect(sealed).toMatch(/^[0-9a-f]{160}$/);
    expect(sealed.length).toBe(SEALED_HEX_LEN);
    expect(await openKey(sealed, kp)).toEqual(K);
  });

  it("is randomised: two seals of the same key differ", async () => {
    const kp = await generateKeyPair();
    expect(await sealKey(K, kp.publicKey)).not.toBe(await sealKey(K, kp.publicKey));
  });

  it("EC-K01: wrong private key fails", async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const sealed = await sealKey(K, a.publicKey);
    await expect(openKey(sealed, b)).rejects.toThrow("SEAL: cannot open");
  });

  it("a private key that doesn't match the public key fails", async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    await expect(
      openKey(await sealKey(K, a.publicKey), { publicKey: a.publicKey, privateKey: b.privateKey }),
    ).rejects.toThrow("SEAL: cannot open");
  });

  it("tampered ciphertext fails at every byte", async () => {
    const kp = await generateKeyPair();
    const sealed = await sealKey(K, kp.publicKey);
    for (let i = 0; i < SEALED_HEX_LEN; i += 2) {
      const bytes = fromHex(sealed);
      bytes[i / 2] = bytes[i / 2]! ^ 1;
      await expect(openKey(toHex(bytes), kp)).rejects.toThrow("SEAL: cannot open");
    }
  });

  it("truncated and extended input is refused", async () => {
    const kp = await generateKeyPair();
    const sealed = await sealKey(K, kp.publicKey);
    await expect(openKey(sealed.slice(0, -2), kp)).rejects.toThrow("SEAL: sealed key must be 160 lowercase hex");
    await expect(openKey(sealed + "00", kp)).rejects.toThrow("SEAL: sealed key must be 160 lowercase hex");
    await expect(openKey("", kp)).rejects.toThrow("SEAL: sealed key must be 160 lowercase hex");
  });

  it("upper-case and non-hex sealed input is refused", async () => {
    const kp = await generateKeyPair();
    const sealed = await sealKey(K, kp.publicKey);
    await expect(openKey(sealed.toUpperCase().replace(/[0-9]/g, "A"), kp)).rejects.toThrow("SEAL: sealed key must be 160 lowercase hex");
    await expect(openKey("g".repeat(160), kp)).rejects.toThrow("SEAL: sealed key must be 160 lowercase hex");
  });

  it("refuses a key that is not 32 bytes", async () => {
    const kp = await generateKeyPair();
    await expect(sealKey(new Uint8Array(31), kp.publicKey)).rejects.toThrow("SEAL: key must be 32 bytes");
    await expect(sealKey(new Uint8Array(33), kp.publicKey)).rejects.toThrow("SEAL: key must be 32 bytes");
    expect(KEY_BYTES).toBe(32);
  });

  it("refuses bad buyer public keys (length, case, non-hex, all zero)", async () => {
    const msg = "SEAL: buyer key must be 64 lowercase hex and not all zero";
    await expect(sealKey(K, "ab".repeat(31))).rejects.toThrow(msg);
    await expect(sealKey(K, "ab".repeat(33))).rejects.toThrow(msg);
    await expect(sealKey(K, "AB".repeat(32))).rejects.toThrow(msg);
    await expect(sealKey(K, "zz".repeat(32))).rejects.toThrow(msg);
    await expect(sealKey(K, "00".repeat(32))).rejects.toThrow(msg);
  });

  it("refuses a malformed key pair on open", async () => {
    const kp = await generateKeyPair();
    const sealed = await sealKey(K, kp.publicKey);
    await expect(openKey(sealed, { publicKey: "00", privateKey: kp.privateKey })).rejects.toThrow("SEAL: bad key pair");
    await expect(openKey(sealed, { publicKey: kp.publicKey, privateKey: "00" })).rejects.toThrow("SEAL: bad key pair");
  });

  it("is libsodium crypto_box_seal compatible (browser/other side)", async () => {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const sealed = await sealKey(K, toHex(kp.publicKey));
    expect(sodium.crypto_box_seal_open(fromHex(sealed), kp.publicKey, kp.privateKey)).toEqual(K);
    const theirs = sodium.crypto_box_seal(K, kp.publicKey);
    expect(await openKey(toHex(theirs), { publicKey: toHex(kp.publicKey), privateKey: toHex(kp.privateKey) })).toEqual(K);
  });
});

describe("hex helpers", () => {
  it("rejects odd length and non-hex", () => {
    expect(() => fromHex("abc")).toThrow("SEAL: bad hex");
    expect(() => fromHex("zz")).toThrow("SEAL: bad hex");
    expect(toHex(fromHex("00ff10"))).toBe("00ff10");
  });
});

import { generateKeypair, seal, open } from "../src/index.ts";
describe("byte API", () => {
  it("round-trips and throws on wrong key, tamper, truncation", async () => {
    const a = await generateKeypair(), b = await generateKeypair();
    const ct = await seal(a.pk, K);
    expect(ct.length).toBe(80);
    expect(await open(a.pk, a.sk, ct)).toEqual(K);
    await expect(open(b.pk, b.sk, ct)).rejects.toThrow("SEAL: cannot open");
    const t = ct.slice(); t[40] = t[40]! ^ 1;
    await expect(open(a.pk, a.sk, t)).rejects.toThrow("SEAL: cannot open");
    await expect(open(a.pk, a.sk, ct.slice(0, 79))).rejects.toThrow("SEAL: cannot open");
    await expect(open(a.pk, a.sk, new Uint8Array(0))).rejects.toThrow("SEAL: cannot open");
  });
});

describe("fixed vector and unusable keys", () => {
  const V = { sk: "6465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80818283", pk: "7d9c24316539825c1896e57f28197746793ce60cbee3ad47da9d07b85fa55e2a", ct: "44a3a2ea67624753c930a0c58244b0cc56d0932c809a93b2acc54da385e5aa1e5f1ac897a90c64b5b1e08a2a15eacdb26172e5de247962c4d3f45e7b059c566b39c4007532b51dfca10ef00b047d851f" };
  it("opens a ciphertext made once by libsodium (guards against a library or format change)", async () => {
    expect(await openKey(V.ct, { publicKey: V.pk, privateKey: V.sk })).toEqual(K);
  });
  it("seal rejects an all-zero, short or low-order pubkey", async () => {
    await expect(seal(new Uint8Array(32), K)).rejects.toThrow("SEAL: buyer key must be 32 bytes and not all zero");
    await expect(seal(new Uint8Array(31).fill(1), K)).rejects.toThrow("SEAL: buyer key must be 32 bytes and not all zero");
    const low = new Uint8Array(32); low[0] = 1; // order-4 point: shared secret would be all zeros
    await expect(seal(low, K)).rejects.toThrow("SEAL: unusable buyer key");
    await expect(sealKey(K, "01" + "00".repeat(31))).rejects.toThrow("SEAL: unusable buyer key");
  });
});
