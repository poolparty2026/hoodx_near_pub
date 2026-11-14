import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBytes, hashRules, parseRules, toHex } from "../src/hash.ts";
import { canonicalize } from "../src/json.ts";
import { rawRules, rules } from "./fixtures.ts";

/** Canonical text of the reference rules, written out by hand (EC-R02). */
const REFERENCE_CANONICAL =
  '{"close_after_s":432000,"pool":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|wrap.near|100",' +
  '"quote_token":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","range":{"centre":"mid","width_bps":800},' +
  '"salt":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",' +
  '"stop_loss_bps":1000,"take_profit_bps":300,"version":1}';

describe("hashing (EC-R02)", () => {
  it("refuses to hash an unvalidated object (L5)", () => {
    expect(() => hashRules({ ...rawRules(), extra: 1 } as never)).toThrow("SCHEMA: rules.extra: unknown field");
  });
  it("uses a correct sha256 (FIPS 180-2 'abc' vector)", () => {
    expect(toHex(sha256(new TextEncoder().encode("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("produces the hand-written canonical text for the reference rules", () => {
    expect(new TextDecoder().decode(canonicalBytes(rules()))).toBe(REFERENCE_CANONICAL);
  });
  it("matches the pinned hex vector shared with the Rust tests and check page", () => {
    expect(toHex(hashRules(rules()))).toBe("5e5a263d268c580bcf8214750f62c706434b83aace8c13422c44194542dd76ba");
  });
  it("matches an independent sha256 of the canonical text", () => {
    const expected = createHash("sha256").update(REFERENCE_CANONICAL, "utf8").digest("hex");
    expect(toHex(hashRules(rules()))).toBe(expected);
  });
  it("is the same for any key order or whitespace in the source text", () => {
    const shuffled = JSON.stringify(Object.fromEntries(Object.entries(rawRules()).reverse()), null, 3);
    expect(toHex(hashRules(parseRules(shuffled)))).toBe(toHex(hashRules(rules())));
  });
  it("changes when any field changes", () => {
    expect(toHex(hashRules(rules({ stop_loss_bps: 1001 })))).not.toBe(toHex(hashRules(rules())));
    expect(toHex(hashRules(rules({ salt: "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" })))).not.toBe(toHex(hashRules(rules())));
  });
  it("canonicalises validated rules with the generic canonicaliser", () => {
    expect(canonicalize(rules() as never)).toBe(REFERENCE_CANONICAL);
  });
});
