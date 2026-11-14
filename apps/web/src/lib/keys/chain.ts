// Live TESTNET reads of the strategy's views through two independent RPC providers; a value is used only if both
// return the same JSON (EC-W08). A failure or a disagreement is "can't read", never a guess.
import { JsonRpcProvider } from "near-api-js";
import { TESTNET_RPCS } from "./rpcs.ts";
import { parseKeyParams, parseKeySale, ViewError, type KeyParams, type KeySale } from "./views.ts";

export { TESTNET_RPCS };

export type ViewFn = (contract: string, method: string, args: Record<string, unknown>) => Promise<unknown>;

export const rpcView = (url: string): ViewFn => {
  const p = new JsonRpcProvider({ url });
  return (contractId, method, args) => p.callFunction({ contractId, method, args });
};

const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x);

export async function viewAgreed(a: ViewFn, b: ViewFn, contract: string, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  let x: unknown, y: unknown;
  try { [x, y] = await Promise.all([a(contract, method, args), b(contract, method, args)]); } catch { throw new ViewError(`${method}: a provider failed`); }
  if (canon(x) !== canon(y)) throw new ViewError(`${method}: the two providers disagree`);
  return x;
}

export interface FollowData { params: KeyParams; sale: KeySale | null; rulesHash: string; ciphertext: Uint8Array }

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Confirmed against contracts/strategy/src/contract.rs: ConfigArgs.rules_ciphertext is Base64VecU8, so get_config
 * gives a standard-alphabet base64 string with padding. Anything else, or a non-canonical string, is refused. */
export function parseConfigForFollow(cfg: unknown): { rulesHash: string; ciphertext: Uint8Array } {
  if (typeof cfg !== "object" || cfg === null) throw new ViewError("get_config: not an object");
  const c = cfg as Record<string, unknown>;
  if (typeof c.rules_hash !== "string" || !/^[0-9a-f]{64}$/.test(c.rules_hash)) throw new ViewError("get_config: rules_hash is not 64 lowercase hex");
  const ct = c.rules_ciphertext;
  if (typeof ct !== "string" || ct.length > 8000 || !B64.test(ct)) throw new ViewError("get_config: rules_ciphertext is not base64");
  const bin = atob(ct);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  if (bytes.length < 41 || bytes.length > 4096 + 41) throw new ViewError("get_config: rules_ciphertext is not 41 to 4137 bytes");
  if (btoa(bin) !== ct) throw new ViewError("get_config: rules_ciphertext is not canonical base64");
  return { rulesHash: c.rules_hash, ciphertext: bytes };
}

export async function loadFollow(a: ViewFn, b: ViewFn, strategy: string, account: string | null): Promise<FollowData> {
  const params = parseKeyParams(await viewAgreed(a, b, strategy, "get_key_params"));
  const sale = account === null ? null : parseKeySale(await viewAgreed(a, b, strategy, "get_key_sale", { buyer: account }));
  const cfg = parseConfigForFollow(await viewAgreed(a, b, strategy, "get_config"));
  return { params, sale, ...cfg };
}
