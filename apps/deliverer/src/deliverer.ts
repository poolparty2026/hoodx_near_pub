// Viewing-key deliverer (D57, INTERFACE section 9). Testnet and sandbox only; its account holds a
// function-call key limited to `deliver_key` and no funds worth taking.
//
// Design: stateless polling, not event-driven. Every tick reads the sale list from a view at a
// final block and acts only on that (T74, EC-K06: an event is text any contract can log, so the
// buyer and buyer_pubkey are never taken from one). A restart loses nothing: the next tick finds
// every `Escrowed` sale still inside its window. Refunds are the buyer's own `refund_key` call after
// the window, so the deliverer never sends one (INTERFACE: `refund_key` caller is the buyer).
import { sealKey, KEY_BYTES } from "@poolside/seal";
import { decryptRules } from "@poolside/rules";

export interface KeySale {
  buyer: string;
  buyer_pubkey: string;
  state: "Escrowed" | "Released" | "Refunded";
  bought_at_ns: string;
  price: string;
  sealed_key: string | null;
}

export interface KeyParams {
  key_delivery_window_ns: string;
  deliverer: string;
  sold: number;
}

export interface Chain {
  /** A view at final finality, parsed JSON. */
  view(method: string, args: unknown): Promise<unknown>;
  /** Timestamp of the latest final block, ns. The deadline is judged on chain time, never the host clock. */
  now(): Promise<bigint>;
  /** Signs and sends `deliver_key` (0 deposit) and resolves true only on a final success. */
  /**
   * `precheck` runs inside the send queue right before signing, on a fresh chain clock; a non-null
   * answer ("too close to deadline", "window closed") means the send is skipped (EC-K08).
   */
  deliverKey(buyer: string, sealedKey: string, precheck?: () => Promise<string | null>): Promise<{ ok: boolean; failure: string | null; skipped?: string }>;
}

export interface Options {
  chain: Chain;
  /** The rules decryption key K (32 bytes). Never logged. */
  rulesKey: Uint8Array;
  /** This deliverer's NEAR account; must equal the contract's configured `deliverer`. */
  accountId: string;
  /** The strategy account id: the associated data that binds the ciphertext to it. */
  strategyId: string;
  /** Skip a sale this close to its deadline: a delivery that lands late is refused and wastes gas. */
  marginNs?: bigint;
  log?: (msg: string) => void;
}

export type Outcome =
  | { buyer: string; result: "delivered" }
  | { buyer: string; result: "skipped"; reason: "window closed" | "too close to deadline" | "not escrowed" | "in flight" | "backing off" }
  | { buyer: string; result: "failed"; reason: string };

const HEX64 = /^[0-9a-f]{64}$/;
const U = /^(0|[1-9][0-9]*)$/;
export const MAX_PAGE = 50;
const U64_MAX = (1n << 64n) - 1n;

function fail(msg: string): never {
  throw new Error(`DELIVERER: ${msg}`);
}

export function parseSale(v: unknown): KeySale {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail("sale is not an object");
  const s = v as Record<string, unknown>;
  if (typeof s.buyer !== "string" || s.buyer.length === 0) fail("sale buyer");
  if (typeof s.buyer_pubkey !== "string" || !HEX64.test(s.buyer_pubkey)) fail("sale buyer_pubkey");
  if (s.state !== "Escrowed" && s.state !== "Released" && s.state !== "Refunded") fail("sale state");
  if (typeof s.bought_at_ns !== "string" || !U.test(s.bought_at_ns)) fail("sale bought_at_ns");
  if (typeof s.price !== "string" || !U.test(s.price)) fail("sale price");
  if (s.sealed_key !== null && typeof s.sealed_key !== "string") fail("sale sealed_key");
  return s as unknown as KeySale;
}

export function parseParams(v: unknown): KeyParams {
  if (v === null || typeof v !== "object") fail("key params");
  const p = v as Record<string, unknown>;
  if (typeof p.key_delivery_window_ns !== "string" || !U.test(p.key_delivery_window_ns)) fail("key_delivery_window_ns");
  if (typeof p.deliverer !== "string") fail("deliverer");
  if (typeof p.sold !== "number" || !Number.isInteger(p.sold) || p.sold < 0) fail("sold");
  return p as unknown as KeyParams;
}

export class Deliverer {
  private keyChecked = false;
  private inFlight = new Set<string>();
  /** Per-buyer backoff after a failed attempt, on chain time, so a persistent failure can't drain the key's gas allowance. */
  private backoff = new Map<string, { n: number; untilNs: bigint }>();
  private readonly margin: bigint;
  private readonly log: (m: string) => void;

  constructor(private readonly o: Options) {
    if (o.rulesKey.length !== KEY_BYTES) fail("rules key must be 32 bytes");
    this.margin = o.marginNs ?? 15_000_000_000n;
    if (typeof this.margin !== "bigint" || this.margin < 0n) fail("margin must be a non-negative bigint");
    this.log = o.log ?? (() => undefined);
  }

  /**
   * M1 (EC-K03): the key we hold must open the ciphertext committed on chain, or we would seal a wrong
   * key and the buyer's payment would go to the creator for nothing. Checked before any seal, once it
   * has passed (the config never changes).
   */
  async verifyKey(): Promise<void> {
    if (this.keyChecked) return;
    const cfg = (await this.o.chain.view("get_config", {})) as { rules_ciphertext?: unknown; rules_hash?: unknown } | null;
    if (cfg === null || typeof cfg !== "object" || typeof cfg.rules_ciphertext !== "string" || typeof cfg.rules_hash !== "string" || !HEX64.test(cfg.rules_hash)) {
      fail("config is unreadable");
    }
    try {
      decryptRules(Uint8Array.from(Buffer.from(cfg.rules_ciphertext, "base64")), this.o.rulesKey, this.o.strategyId, Uint8Array.from(Buffer.from(cfg.rules_hash, "hex")));
    } catch {
      fail("rules key does not open the on-chain rules");
    }
    this.keyChecked = true;
  }

  /** One pass over every sale. Never throws for one bad sale; a bad read of the params throws. */
  async tick(): Promise<Outcome[]> {
    const params = parseParams(await this.o.chain.view("get_key_params", {}));
    if (params.deliverer !== this.o.accountId) fail("this account is not the contract's deliverer");
    await this.verifyKey();
    const window = BigInt(params.key_delivery_window_ns);
    const out: Outcome[] = [];
    // The contract caps a page at 50 and max_key_sales at 50, so one page should hold every sale;
    // keep paging while a page is full anyway, so a 51st sale could never be missed.
    const raw: unknown[] = [];
    for (let from = 0; ; from += MAX_PAGE) {
      const page = await this.o.chain.view("get_key_sales", { from_index: from, limit: MAX_PAGE });
      if (!Array.isArray(page)) fail("sales is not a list");
      raw.push(...page);
      if (page.length < MAX_PAGE) break;
    }
    const work: Promise<Outcome>[] = [];
    const sales: KeySale[] = [];
    for (const item of raw) {
      let sale: KeySale;
      try {
        sale = parseSale(item);
      } catch (e) {
        out.push({ buyer: "?", result: "failed", reason: (e as Error).message });
        continue;
      }
      if (sale.state !== "Escrowed") continue; // Released or Refunded: nothing to do, idempotent
      // In parallel: one slow FINAL send must not starve the others before their deadlines.
      sales.push(sale);
    }
    // Earliest deadline first: the send queue is FIFO, so the sale closest to its deadline goes first.
    sales.sort((a, b) => (BigInt(a.bought_at_ns) < BigInt(b.bought_at_ns) ? -1 : BigInt(a.bought_at_ns) > BigInt(b.bought_at_ns) ? 1 : 0));
    for (const sale of sales) work.push(this.deliver(sale, window));
    out.push(...(await Promise.all(work)));
    return out;
  }

  private async noteFailure(buyer: string): Promise<void> {
    let now = 0n;
    try { now = await this.o.chain.now(); } catch { /* keep 0: the next success of now() resets nothing harmful */ }
    const n = (this.backoff.get(buyer)?.n ?? 0) + 1;
    const delayNs = BigInt(Math.min(2 ** n * 5, 300)) * 1_000_000_000n; // 10 s, 20 s, ... capped at 5 min
    this.backoff.set(buyer, { n, untilNs: now + delayNs });
  }

  private async deliver(listed: KeySale, window: bigint): Promise<Outcome> {
    const buyer = listed.buyer;
    if (this.inFlight.has(buyer)) return { buyer, result: "skipped", reason: "in flight" };
    this.inFlight.add(buyer);
    try {
      // Re-read this sale on its own at a final block right before acting: the buyer and key
      // sealed to are the view's, never an event's (T74, EC-K06), and a sale that was released or
      // refunded since the list read is not touched (idempotent across restarts).
      const v = await this.o.chain.view("get_key_sale", { buyer });
      const s = v === null ? null : parseSale(v);
      if (s !== null && s.buyer !== buyer) return { buyer, result: "failed", reason: "sale buyer mismatch between list and single-sale view" };
      if (s === null || s.state !== "Escrowed") return { buyer, result: "skipped", reason: "not escrowed" };
      // Saturates at u64::MAX like the contract's saturating_add (window 0 closes at once, MAX never closes).
      const rawDeadline = BigInt(s.bought_at_ns) + window;
      const deadline = rawDeadline > U64_MAX ? U64_MAX : rawDeadline;
      const now = await this.o.chain.now();
      const bo = this.backoff.get(buyer);
      if (bo !== undefined && now < bo.untilNs) return { buyer, result: "skipped", reason: "backing off" };
      if (now >= deadline) return { buyer, result: "skipped", reason: "window closed" };
      if (now + this.margin >= deadline) return { buyer, result: "skipped", reason: "too close to deadline" };
      const sealed = await sealKey(this.o.rulesKey, s.buyer_pubkey);
      const precheck = async (): Promise<string | null> => {
        const n2 = await this.o.chain.now(); // EC-K08: a queued send is judged on the clock at its own turn
        if (n2 >= deadline) return "window closed";
        if (n2 + this.margin >= deadline) return "too close to deadline";
        return null;
      };
      const r = await this.o.chain.deliverKey(s.buyer, sealed, precheck);
      if (r.skipped !== undefined) return { buyer, result: "skipped", reason: r.skipped as "window closed" | "too close to deadline" };
      if (!r.ok) {
        // keys.rs: the sale is set Released before the payout is sent, so a failed payout receipt
        // (creator account missing) fails the transaction's receipts yet the key IS delivered.
        // Re-read the sale: Released with our key counts as delivered, never as a failure.
        const again = await this.o.chain.view("get_key_sale", { buyer });
        const a = again === null ? null : parseSale(again);
        if (a !== null && a.state === "Released" && a.sealed_key !== sealed) {
          this.log(`sale for ${buyer} is Released with a sealed key that is not ours`);
          return { buyer, result: "failed", reason: "released with a different sealed key" };
        }
        if (a !== null && a.state === "Released") {
          this.log(`delivered to ${buyer} (payout receipt failed: ${r.failure ?? "unknown"})`);
          return { buyer, result: "delivered" };
        }
        await this.noteFailure(buyer);
        this.log(`deliver_key failed for ${buyer}: ${r.failure ?? "unknown"}`);
        return { buyer, result: "failed", reason: r.failure ?? "unknown" };
      }
      this.backoff.delete(buyer);
      this.log(`delivered to ${buyer}`);
      return { buyer, result: "delivered" };
    } catch (e) {
      await this.noteFailure(buyer);
      return { buyer, result: "failed", reason: (e as Error).message };
    } finally {
      this.inFlight.delete(buyer);
    }
  }
}
