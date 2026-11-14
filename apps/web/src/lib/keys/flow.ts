// The follower's buy flow, browser side. Buyer private keys never leave this module's callers: nothing here
// logs, stores or sends one. The sealed-box scheme is NOT invented here: it is `crypto_box_seal` (X25519), and
// the implementation is injected through SealedBox (GUESS: the audited library is chosen by packages/seal).
import { decryptRules, hashRules, toHex, type RulesV1 } from "@poolside/rules";
import { HEX160, HEX64, type KeyParams, type KeySale } from "./views.ts";

export interface BuyerKeyPair { readonly publicKey: Uint8Array; readonly secretKey: Uint8Array }
export interface SealedBox {
  generateKeyPair(): Promise<BuyerKeyPair>;
  /** crypto_box_seal (used by the deliverer and tests; the page never seals). */
  seal(recipientPk: Uint8Array, msg: Uint8Array): Promise<Uint8Array>;
  /** crypto_box_seal_open. Throws if it does not open (D57-a). */
  open(recipientPk: Uint8Array, recipientSk: Uint8Array, ct: Uint8Array): Promise<Uint8Array>;
}

/** Wallet connection (GUESS: the real impl is wired later; testnet only). */
export interface Wallet {
  readonly accountId: string | null;
  /** Calls buy_viewing_key(buyer_pubkey) with exactly `deposit` yoctoNEAR attached. Resolves on success; rejects with the contract's refusal text. */
  buyViewingKey(strategy: string, buyerPubkeyHex: string, deposit: bigint): Promise<void>;
  refundKey(strategy: string): Promise<void>;
}

/** Client-side ceiling on the price we will pay (M4); the contract's own cap is lower, this is a second guard. */
export const MAX_KEY_PRICE_YOCTO = 10n * 10n ** 24n;
export const PRICE_TOO_HIGH = "The key price is above the 10 NEAR limit this page will pay. Nothing was sent.";

/** The buyer's pair is created and backed up BEFORE this runs (M2), so a lost reply never loses the secret. */
export const NOT_FOR_SALE = "A viewing key is not available to buy right now. Nothing was sent.";
export async function buy(a: { wallet: Wallet; strategy: string; params: KeyParams; kp: BuyerKeyPair; sale: KeySale | null; nowNs: bigint }): Promise<void> {
  if (buyState(a.params, a.sale, a.nowNs).kind !== "can_buy") throw new Error(NOT_FOR_SALE);
  if (a.params.keyPrice > MAX_KEY_PRICE_YOCTO) throw new Error(PRICE_TOO_HIGH);
  await a.wallet.buyViewingKey(a.strategy, pubkeyHex(a.kp), a.params.keyPrice);
}

/** A backup text whose secret does not open a key sealed to its public key is refused (a mismatched pair). */
export async function pairIsConsistent(box: SealedBox, kp: BuyerKeyPair): Promise<boolean> {
  try {
    const probe = new Uint8Array(32).fill(5);
    const back = await box.open(kp.publicKey, kp.secretKey, await box.seal(kp.publicKey, probe));
    return back.length === 32 && back.every((x) => x === 5);
  } catch { return false; }
}

/** Exact refusal texts of buy_viewing_key (INTERFACE section 9), shown as they are. */
export const BUY_REFUSALS = [
  "LIMIT: wrong status", "LIMIT: already revealed", "LIMIT: key price", "LIMIT: buyer key",
  "LIMIT: already bought", "LIMIT: key sales full", "LIMIT: balance for registration",
] as const;

export const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
export const hex = toHex;

export const pubkeyHex = (kp: BuyerKeyPair): string => {
  const h = toHex(kp.publicKey);
  if (!HEX64.test(h) || /^0+$/.test(h)) throw new Error("buyer key must be 32 bytes and not all zero");
  return h;
};

/** Backup text for the buyer's key pair. Only ever shown to, or downloaded by, the buyer. */
export const exportSecret = (kp: BuyerKeyPair): string => `poolside-viewing-key-v1\n${toHex(kp.secretKey)}\n${toHex(kp.publicKey)}\n`;
export function importSecret(text: string): BuyerKeyPair {
  const m = /^poolside-viewing-key-v1\n([0-9a-f]{64})\n([0-9a-f]{64})\n?$/.exec(text.replaceAll("\r", ""));
  if (!m) throw new Error("This is not a hoodx LP agent viewing key backup.");
  return { secretKey: fromHex(m[1]!), publicKey: fromHex(m[2]!) };
}

/** What the buy button may do for this account right now, from the views (never from events). */
export type BuyState =
  | { kind: "can_buy"; deposit: bigint }
  | { kind: "sold_out" }
  | { kind: "waiting"; deadlineNs: bigint }
  | { kind: "can_refund" }
  | { kind: "refunded" }
  | { kind: "delivered" };

export function buyState(p: KeyParams, sale: KeySale | null, nowNs: bigint): BuyState {
  if (sale === null) return p.sold >= p.maxKeySales ? { kind: "sold_out" } : { kind: "can_buy", deposit: p.keyPrice };
  if (sale.state === "Released") return { kind: "delivered" };
  if (sale.state === "Refunded") return { kind: "refunded" };
  const deadline = sale.boughtAtNs + p.windowNs;
  return nowNs < deadline ? { kind: "waiting", deadlineNs: deadline } : { kind: "can_refund" };
}

export type OpenResult =
  | { kind: "unlocked"; rules: RulesV1; hashMatches: true }
  | { kind: "failed"; reason: "sale_not_delivered" | "wrong_pubkey" | "bad_sealed_key" | "does_not_open" | "rules_do_not_match" };

/** Opens the sealed key, decrypts the rules and checks them against the on-chain rules_hash. */
export async function openAndVerify(a: {
  box: SealedBox; kp: BuyerKeyPair; sale: KeySale; strategyId: string; rulesHashHex: string; ciphertext: Uint8Array;
}): Promise<OpenResult> {
  const { sale } = a;
  if (sale.state !== "Released" || sale.sealedKey === null) return { kind: "failed", reason: "sale_not_delivered" };
  if (pubkeyHex(a.kp) !== sale.buyerPubkey) return { kind: "failed", reason: "wrong_pubkey" };
  if (!HEX160.test(sale.sealedKey)) return { kind: "failed", reason: "bad_sealed_key" };
  let key: Uint8Array | null;
  try { key = await a.box.open(a.kp.publicKey, a.kp.secretKey, fromHex(sale.sealedKey)); } catch { key = null; }
  if (key === null || key.length !== 32) return { kind: "failed", reason: "does_not_open" };
  try {
    const rules = decryptRules(a.ciphertext, key, a.strategyId, fromHex(a.rulesHashHex));
    // decryptRules already compares; compare again so this screen never relies on one check alone.
    return toHex(hashRules(rules)) === a.rulesHashHex ? { kind: "unlocked", rules, hashMatches: true } : { kind: "failed", reason: "rules_do_not_match" };
  } catch {
    return { kind: "failed", reason: "rules_do_not_match" };
  }
}

/** A failure is shown as the contract (or wallet) said it, never reworded (INTERFACE section 1). */
export const errorText = (e: unknown, redact: readonly string[] = []): string => {
  let t = e instanceof Error && e.message !== "" ? e.message : "That failed.";
  for (const r of redact) if (r !== "") t = t.split(r).join("[hidden]"); // a pasted key is never echoed back
  return t;
};

/** The buy step, with the testnet key cleared and the views re-read whatever happens (M2, M3). */
export async function runBuy(a: { wallet: Wallet; strategy: string; params: KeyParams; kp: BuyerKeyPair; sale: KeySale | null; nowNs: bigint; saved: boolean; clearSecret: () => void; reload: () => Promise<unknown> }): Promise<void> {
  try {
    if (!a.saved) throw new Error("Save your key pair first. Nothing was sent.");
    await buy(a);
  } finally {
    a.clearSecret();
    try { await a.reload(); } catch { /* the buy error, if any, is the one shown */ }
  }
}

/** The refund step: re-read first, send only if a refund is open, and clear the testnet key whatever happens. */
export async function runRefund(a: { wallet: Wallet; strategy: string; nowNs: () => bigint; clearSecret: () => void; reload: () => Promise<{ params: KeyParams; sale: KeySale | null }> }): Promise<void> {
  try {
    const fresh = await a.reload();
    if (buyState(fresh.params, fresh.sale, a.nowNs()).kind !== "can_refund") throw new Error("A refund is not available right now. Nothing was sent.");
    await a.wallet.refundKey(a.strategy);
  } finally {
    a.clearSecret();
    try { await a.reload(); } catch { /* keep the first error */ }
  }
}
