// Strict readers for the viewing-key views (docs/INTERFACE.md section 9 on contract/viewing-keys).
// Values come from VIEWS, never from events (T74). Anything that is not exactly the documented shape is
// refused, so a bad provider reply is "can't read", never a half-trusted value.
import { ViewError, readU128, readU64 } from "./numbers.ts";
export { ViewError };

export type KeySaleState = "Escrowed" | "Released" | "Refunded";
export interface KeyParams {
  readonly keyPrice: bigint; readonly windowNs: bigint; readonly maxKeySales: number; readonly sold: number;
  readonly deliverer: string; readonly escrowTotal: bigint; readonly nearOwedTotal: bigint;
}
export interface KeySale {
  readonly buyer: string; readonly buyerPubkey: string; readonly state: KeySaleState; readonly boughtAtNs: bigint;
  readonly price: bigint; readonly sealedKey: string | null;
}

export const HEX64 = /^[0-9a-f]{64}$/;
export const HEX160 = /^[0-9a-f]{160}$/;

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ViewError(`${what}: not an object`);
  return v as Record<string, unknown>;
};
const u32 = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 0xffff_ffff) throw new ViewError(`${what}: not a u32`);
  return v;
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) throw new ViewError(`${what}: not an account id`);
  return v;
};

export function parseKeyParams(v: unknown): KeyParams {
  const o = obj(v, "get_key_params");
  return {
    keyPrice: readU128(o.key_price, "key_price"), windowNs: readU64(o.key_delivery_window_ns, "key_delivery_window_ns"),
    maxKeySales: u32(o.max_key_sales, "max_key_sales"), sold: u32(o.sold, "sold"), deliverer: str(o.deliverer, "deliverer"),
    escrowTotal: readU128(o.escrow_total, "escrow_total"), nearOwedTotal: readU128(o.near_owed_total, "near_owed_total"),
  };
}

export function parseKeySale(v: unknown): KeySale | null {
  if (v === null) return null;
  const o = obj(v, "KeySale");
  const state = o.state;
  if (state !== "Escrowed" && state !== "Released" && state !== "Refunded") throw new ViewError("KeySale: unknown state");
  const pk = o.buyer_pubkey;
  if (typeof pk !== "string" || !HEX64.test(pk)) throw new ViewError("KeySale: buyer_pubkey is not 64 lowercase hex");
  const sk = o.sealed_key;
  if (sk !== null && (typeof sk !== "string" || !HEX160.test(sk))) throw new ViewError("KeySale: sealed_key is not 160 lowercase hex");
  if (state === "Released" && sk === null) throw new ViewError("KeySale: Released without a sealed key");
  if (state !== "Released" && sk !== null) throw new ViewError("KeySale: sealed key on a sale that is not Released");
  return { buyer: str(o.buyer, "buyer"), buyerPubkey: pk, state, boughtAtNs: readU64(o.bought_at_ns, "bought_at_ns"), price: readU128(o.price, "price"), sealedKey: sk };
}

export function parseKeySales(v: unknown): KeySale[] {
  if (!Array.isArray(v) || v.length > 50) throw new ViewError("get_key_sales: not a list of at most 50");
  return v.map((x) => {
    const s = parseKeySale(x);
    if (s === null) throw new ViewError("get_key_sales: null entry");
    return s;
  });
}

/** Deadline of the delivery window; after it the buyer may call refund_key (INTERFACE section 9). */
export const deliveryDeadlineNs = (s: KeySale, p: KeyParams): bigint => s.boughtAtNs + p.windowNs;
