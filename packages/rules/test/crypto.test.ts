import { describe, expect, it } from "vitest";
import { decryptRules, encryptRules } from "../src/crypto.ts";
import { hashRules } from "../src/hash.ts";
import { RulesError } from "../src/errors.ts";
import { rules } from "./fixtures.ts";

const KEY = new Uint8Array(32).fill(7);
const NONCE = new Uint8Array(24).fill(9);
const ID = "s-1.poolside.near";

const code = (f: () => unknown): string => {
  try { f(); } catch (e) { return (e as RulesError).code; }
  return "NO_ERROR";
};

describe("encryptRules and decryptRules (EC-R05, EC-R10)", () => {
  const r = rules();
  const h = hashRules(r);
  const blob = encryptRules(r, KEY, NONCE, ID);

  it("round-trips and verifies the commitment", () => {
    expect(decryptRules(blob, KEY, ID, h)).toEqual(r);
  });
  it("is deterministic for a given nonce and has the documented layout", () => {
    expect(encryptRules(r, KEY, NONCE, ID)).toEqual(blob);
    expect(blob[0]).toBe(1);
    expect(blob.subarray(1, 25)).toEqual(NONCE);
  });
  it("fails with the wrong key", () => {
    expect(code(() => decryptRules(blob, new Uint8Array(32).fill(8), ID, h))).toBe("CRYPTO");
  });
  it("fails when any byte of the ciphertext or tag is changed", () => {
    for (const i of [25, 40, blob.length - 1]) {
      const t = blob.slice(); t[i] = (t[i] as number) ^ 1;
      expect(() => decryptRules(t, KEY, ID, h)).toThrow("CRYPTO: decryption failed");
    }
  });
  it("fails when the nonce is changed", () => {
    const t = blob.slice(); t[5] = (t[5] as number) ^ 1;
    expect(code(() => decryptRules(t, KEY, ID, h))).toBe("CRYPTO");
  });
  it("fails for another strategy id (EC-R10)", () => {
    expect(code(() => decryptRules(blob, KEY, "s-2.poolside.near", h))).toBe("CRYPTO");
  });
  it("fails for another commitment (EC-R10)", () => {
    const other = hashRules(rules({ stop_loss_bps: 999 }));
    expect(code(() => decryptRules(blob, KEY, ID, other))).toBe("CRYPTO");
  });
  it("refuses malformed blobs, versions and sizes", () => {
    expect(code(() => decryptRules(blob.subarray(0, 40), KEY, ID, h))).toBe("CRYPTO");
    const v = blob.slice(); v[0] = 2;
    expect(code(() => decryptRules(v, KEY, ID, h))).toBe("CRYPTO");
    expect(code(() => encryptRules(r, new Uint8Array(31), NONCE, ID))).toBe("CRYPTO");
    expect(code(() => encryptRules(r, KEY, new Uint8Array(12), ID))).toBe("CRYPTO");
    expect(code(() => decryptRules(blob, new Uint8Array(16), ID, h))).toBe("CRYPTO");
    expect(code(() => decryptRules(blob, KEY, ID, new Uint8Array(31)))).toBe("CRYPTO");
  });
  it("never returns partial data on failure", () => {
    let out: unknown = "unset";
    try { out = decryptRules(blob.slice(0, -1), KEY, ID, h); } catch { /* expected */ }
    expect(out).toBe("unset");
  });
});

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { canonicalBytes } from "../src/hash.ts";

/** Builds a blob exactly as the library does, but lets a test choose the plaintext. */
function forge(plain: Uint8Array, key: Uint8Array, nonce: Uint8Array, id: string, hash: Uint8Array): Uint8Array {
  const idBytes = new TextEncoder().encode(id);
  const ad = new Uint8Array(1 + 32 + idBytes.length);
  ad[0] = 1; ad.set(hash, 1); ad.set(idBytes, 33);
  const ct = xchacha20poly1305(key, nonce, ad).encrypt(plain);
  const out = new Uint8Array(25 + ct.length); out[0] = 1; out.set(nonce, 1); out.set(ct, 25);
  return out;
}

describe("input types (L5)", () => {
  it("refuses non-Uint8Array keys, nonces and blobs with a RulesError", () => {
    expect(() => encryptRules(rules(), "k".repeat(32) as never, NONCE, ID)).toThrow("CRYPTO: key and nonce must be Uint8Array");
    expect(() => encryptRules(rules(), KEY, Array(24).fill(0) as never, ID)).toThrow("CRYPTO: key and nonce must be Uint8Array");
    expect(() => decryptRules(Array(60).fill(1) as never, KEY, ID, hashRules(rules()))).toThrow("CRYPTO: blob and key must be Uint8Array");
  });
});

describe("commitment and plaintext checks (EC-R05, EC-R12)", () => {
  const committed = rules();
  const h = hashRules(committed);
  it("refuses validly encrypted rules that don't match the committed hash (EC-R12)", () => {
    const other = canonicalBytes(rules({ stop_loss_bps: 999 }));
    const blob = forge(other, KEY, NONCE, ID, h);
    expect(() => decryptRules(blob, KEY, ID, h)).toThrow("HASH_MISMATCH: decrypted rules don't match the commitment");
  });
  it("refuses a valid ciphertext whose plaintext isn't UTF-8, with a RulesError", () => {
    const blob = forge(new Uint8Array([0xff, 0xfe, 0xfd]), KEY, NONCE, ID, h);
    expect(() => decryptRules(blob, KEY, ID, h)).toThrow("CRYPTO: decrypted data is not valid UTF-8");
  });
  it("refuses an empty plaintext and the exact minimum-length blob", () => {
    const empty = forge(new Uint8Array(0), KEY, NONCE, ID, h);
    expect(empty.length).toBe(41);
    expect(() => decryptRules(empty, KEY, ID, h)).toThrow("JSON_SYNTAX");
    expect(() => decryptRules(empty.subarray(0, 40), KEY, ID, h)).toThrow("CRYPTO: malformed ciphertext");
  });
  it("gives distinct messages for each refusal", () => {
    expect(() => decryptRules(blob(), new Uint8Array(32).fill(8), ID, h)).toThrow("CRYPTO: decryption failed");
    expect(() => decryptRules(blob(), KEY, ID, new Uint8Array(31))).toThrow("CRYPTO: rules hash must be 32 bytes");
    expect(() => decryptRules(blob(), new Uint8Array(16), ID, h)).toThrow("CRYPTO: key must be 32 bytes");
    expect(() => encryptRules(committed, KEY, new Uint8Array(12), ID)).toThrow("CRYPTO: nonce must be 24 bytes");
  });
  it("refuses a strategy id that isn't a NEAR account id", () => {
    for (const bad of ["", "S-1.near", "\uD800", "�", "a".repeat(65)]) {
      expect(() => encryptRules(committed, KEY, NONCE, bad)).toThrow("CRYPTO: strategy id must be a NEAR account id");
    }
  });
  it("binds the format version into the associated data", () => {
    const idBytes = new TextEncoder().encode(ID);
    const ad = new Uint8Array(1 + 32 + idBytes.length); ad[0] = 2; ad.set(h, 1); ad.set(idBytes, 33);
    const ct = xchacha20poly1305(KEY, NONCE, ad).encrypt(canonicalBytes(committed));
    const b = new Uint8Array(25 + ct.length); b[0] = 1; b.set(NONCE, 1); b.set(ct, 25);
    expect(() => decryptRules(b, KEY, ID, h)).toThrow("CRYPTO: decryption failed");
  });
  function blob(): Uint8Array { return encryptRules(committed, KEY, NONCE, ID); }
});
