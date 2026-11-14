import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { RulesError } from "./errors.ts";
import { canonicalBytes, hashRules, parseRules } from "./hash.ts";
import { isAccountId, type RulesV1 } from "./schema.ts";

const FORMAT_VERSION = 1;

/**
 * Associated data binds a ciphertext to one format version, one strategy and
 * one commitment (EC-R10): version (1 byte) || rulesHash (32) || utf8(strategyId).
 * The fixed-length prefix makes the concatenation unambiguous, and the
 * strategy id must be a NEAR account id (ASCII only).
 */
function associatedData(strategyId: string, rulesHash: Uint8Array): Uint8Array {
  if (!(rulesHash instanceof Uint8Array) || rulesHash.length !== 32) throw new RulesError("CRYPTO", "rules hash must be 32 bytes");
  if (!isAccountId(strategyId)) throw new RulesError("CRYPTO", "strategy id must be a NEAR account id");
  const id = new TextEncoder().encode(strategyId);
  const ad = new Uint8Array(1 + 32 + id.length);
  ad[0] = FORMAT_VERSION;
  ad.set(rulesHash, 1);
  ad.set(id, 33);
  return ad;
}

/**
 * Encrypts rules. The caller MUST supply a fresh random 24-byte nonce from a
 * CSPRNG for every encryption and never reuse one with the same key; this
 * package stays free of randomness so it is deterministic to test.
 * Blob: version (1 byte) || nonce (24) || ciphertext with tag.
 */
export function encryptRules(rules: RulesV1, key: Uint8Array, nonce: Uint8Array, strategyId: string): Uint8Array {
  if (!(key instanceof Uint8Array) || !(nonce instanceof Uint8Array)) throw new RulesError("CRYPTO", "key and nonce must be Uint8Array");
  if (key.length !== 32) throw new RulesError("CRYPTO", "key must be 32 bytes");
  if (nonce.length !== 24) throw new RulesError("CRYPTO", "nonce must be 24 bytes");
  const ct = xchacha20poly1305(key, nonce, associatedData(strategyId, hashRules(rules))).encrypt(canonicalBytes(rules));
  const out = new Uint8Array(1 + 24 + ct.length);
  out[0] = FORMAT_VERSION;
  out.set(nonce, 1);
  out.set(ct, 25);
  return out;
}

/**
 * Decrypts and verifies rules against the on-chain commitment. Any tampering,
 * wrong key, wrong strategy or wrong hash fails with no partial data (EC-R05).
 */
export function decryptRules(blob: Uint8Array, key: Uint8Array, strategyId: string, rulesHash: Uint8Array): RulesV1 {
  if (!(blob instanceof Uint8Array) || !(key instanceof Uint8Array)) throw new RulesError("CRYPTO", "blob and key must be Uint8Array");
  if (key.length !== 32) throw new RulesError("CRYPTO", "key must be 32 bytes");
  if (blob.length < 1 + 24 + 16 || blob[0] !== FORMAT_VERSION) throw new RulesError("CRYPTO", "malformed ciphertext");
  const ad = associatedData(strategyId, rulesHash);
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(key, blob.subarray(1, 25), ad).decrypt(blob.subarray(25));
  } catch {
    throw new RulesError("CRYPTO", "decryption failed");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    throw new RulesError("CRYPTO", "decrypted data is not valid UTF-8");
  }
  const rules = parseRules(text);
  const h = hashRules(rules);
  if (h.length !== rulesHash.length || !h.every((b, i) => b === rulesHash[i])) throw new RulesError("HASH_MISMATCH", "decrypted rules don't match the commitment");
  return rules;
}
