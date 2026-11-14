// Prints {rulesKeyHex, rulesHashHex, ciphertextB64} for the sandbox E2E (contracts/strategy-sandbox/tests/e2e.rs).
// The ciphertext is bound to the strategy id given as argv[2] (its AAD). Throwaway key, sandbox only.
//   node scripts/testnet/sandbox-prep.ts strategy-1.test.near
import { randomBytes } from "node:crypto";
import { encryptRules, hashRules, toHex } from "@poolside/rules";
import { rules } from "../../packages/rules/test/fixtures.ts";

const strategy = process.argv[2];
if (!strategy) throw new Error("usage: node scripts/testnet/sandbox-prep.ts <strategy id>");
const K = randomBytes(32);
const r = rules();
console.log(JSON.stringify({
  rulesKeyHex: K.toString("hex"),
  rulesHashHex: toHex(hashRules(r)),
  ciphertextB64: Buffer.from(encryptRules(r, K, randomBytes(24), strategy)).toString("base64"),
}));
