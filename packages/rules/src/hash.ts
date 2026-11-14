import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalize, strictParse, type JsonValue } from "./json.ts";
import { validateRules, type RulesV1 } from "./schema.ts";

/** Canonical UTF-8 bytes of validated rules: what gets hashed and encrypted. */
export function canonicalBytes(rules: RulesV1): Uint8Array {
  // Re-validate: a caller passing an unvalidated object must not get a commitment (L5).
  const valid = validateRules(rules as unknown as JsonValue);
  return new TextEncoder().encode(canonicalize(valid as unknown as JsonValue));
}

/** The on-chain commitment: sha256 of the canonical bytes. */
export function hashRules(rules: RulesV1): Uint8Array {
  return sha256(canonicalBytes(rules));
}

/** Parses, validates and canonicalises rules text in one step. */
export function parseRules(text: string): RulesV1 {
  return validateRules(strictParse(text));
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
