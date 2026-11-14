// The journey simulation's real parts. The rules text and its hash come from the recorded sandbox run (recorded.json); everything
// cryptographic here is the real code: the hash, the encryption, the sealed box (libsodium) and the unlock. What is simulated is
// only the chain: the buy and the delivery are replayed in memory, not sent anywhere.
import { decryptRules, encryptRules, hashRules, parseRules, toHex, type RulesV1 } from "@poolside/rules";
import recorded from "./recorded.json";
import { sealedBox } from "@/lib/keys/deps.ts";
import { fromHex, openAndVerify, pubkeyHex, type BuyerKeyPair, type OpenResult } from "@/lib/keys/flow.ts";
import { parseKeySale, type KeySale } from "@/lib/keys/views.ts";

export const REC = recorded;
export const BANNER = "Simulation on recorded sandbox data. No live strategy, no real tokens.";

export interface World {
  readonly rules: RulesV1;
  readonly rulesHashHex: string;
  readonly ciphertext: Uint8Array; // the creator's encrypted rules, bound to the strategy id and the recorded hash
  readonly rulesKey: Uint8Array; // the creator's key K; in the product only the creator and, after delivery, the deliverer hold it
  readonly buyer: BuyerKeyPair;
}

/** Step 1: the creator commits. The recorded rules text must hash to the recorded on-chain rules_hash, or nothing starts. */
export async function prepareWorld(): Promise<World> {
  const rules = parseRules(REC.rulesText);
  const h = toHex(hashRules(rules));
  if (h !== REC.rulesHash) throw new Error("The recorded rules do not hash to the recorded rules_hash.");
  const rulesKey = crypto.getRandomValues(new Uint8Array(32));
  // GUESS-free but labelled on screen: the recording's own ciphertext is a placeholder and its key was not kept, so the rules are
  // encrypted again here with a fresh key, under the recorded strategy id and hash.
  const ciphertext = encryptRules(rules, rulesKey, crypto.getRandomValues(new Uint8Array(24)), REC.strategyId);
  return { rules, rulesHashHex: h, ciphertext, rulesKey, buyer: await sealedBox.generateKeyPair() };
}

/** Step 3: the sale as the contract's view returns it right after buy_viewing_key (shape recorded from the contract wasm). */
export function escrowedSale(w: World, nowNs: bigint): KeySale {
  return parseKeySale({ buyer: "follower.test.near", buyer_pubkey: pubkeyHex(w.buyer), state: "Escrowed", bought_at_ns: nowNs.toString(), price: REC.keyPriceYocto, sealed_key: null })!;
}

/** Step 4: the deliverer reads the buyer's key from the VIEW (never from an event), seals K to it and the contract records it. */
export async function deliveredSale(w: World, sale: KeySale): Promise<KeySale> {
  const sealed = toHex(await sealedBox.seal(fromHex(sale.buyerPubkey), w.rulesKey));
  return parseKeySale({ buyer: sale.buyer, buyer_pubkey: sale.buyerPubkey, state: "Released", bought_at_ns: sale.boughtAtNs.toString(), price: sale.price.toString(), sealed_key: sealed })!;
}

/** Step 5: the follower's browser opens the sealed key, decrypts the rules and compares the hash with the recorded rules_hash. */
export function unlock(w: World, sale: KeySale, kp: BuyerKeyPair = w.buyer): Promise<OpenResult> {
  return openAndVerify({ box: sealedBox, kp, sale, strategyId: REC.strategyId, rulesHashHex: REC.rulesHash, ciphertext: w.ciphertext });
}

export const near = (yocto: string): string => {
  const y = BigInt(yocto), whole = y / 10n ** 24n, frac = (y % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} NEAR`;
};
export const iso = (ns: string): string => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().replace(".000Z", "Z");
export { decryptRules };
