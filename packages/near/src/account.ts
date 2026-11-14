import { isAccountId } from "@poolside/rules";
import { NearError } from "./errors.ts";
import type { BlockRef, RpcClient } from "./rpc.ts";

/**
 * Account snapshots from the chain, not the contract (INTERFACE section 3): the account's `code_hash`
 * and its access keys at a height, each key with its permission and nonce (EC-W07: the nonce alone is
 * not enough, the permission must be compared too). Read-only. The reply is read as strictly as a
 * view: an unknown shape is an error, never a clean snapshot.
 */
export type KeyPermission = "FullAccess" | { readonly receiverId: string; readonly methodNames: readonly string[]; readonly allowance: string | null };
export interface AccessKeyInfo { readonly publicKey: string; readonly nonce: bigint; readonly permission: KeyPermission }
export interface AccountSnapshot { readonly blockHeight: number; readonly blockHash: string; readonly codeHash: string; readonly keys: readonly AccessKeyInfo[] }

const MAX_BYTES = 1 << 20;

async function query(c: RpcClient, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!/^https:\/\//.test(c.rpcUrl)) throw new NearError("RPC", "rpcUrl must be https");
  const timeoutMs = c.timeoutMs ?? 10_000;
  const signal = AbortSignal.timeout(timeoutMs);
  let text: string;
  try {
    const res = await c.fetch(c.rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: "poolside", method: "query", params }),
    });
    if (res.redirected) throw new NearError("RPC", "redirect refused");
    if (!res.ok) throw new NearError("RPC", `HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    if (e instanceof NearError) throw e;
    throw new NearError("RPC", signal.aborted ? "timeout" : "network error");
  }
  if (text.length > MAX_BYTES) throw new NearError("RPC", "response too large");
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new NearError("RPC", "response is not JSON"); }
  const b = body as { error?: unknown; result?: unknown } | null;
  if (b === null || typeof b !== "object" || b.error !== undefined) throw new NearError("RPC", "error from the node");
  const r = b.result as Record<string, unknown> | null | undefined;
  if (r === null || r === undefined || typeof r !== "object" || Array.isArray(r) || r["error"] !== undefined) throw new NearError("RPC", "error from the node");
  return r;
}

const where = (at: BlockRef) => ("blockId" in at ? { block_id: at.blockId } : { finality: "final" });
const u64 = (v: unknown, what: string): bigint => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < 1n << 64n) return BigInt(v);
  throw new NearError("RPC", `${what} must be a u64`);
};

function permission(v: unknown): KeyPermission {
  if (v === "FullAccess") return "FullAccess";
  const fc = (v as { FunctionCall?: Record<string, unknown> } | null)?.FunctionCall;
  if (fc === undefined || typeof fc !== "object" || fc === null) throw new NearError("RPC", "unknown key permission");
  const receiver = fc["receiver_id"];
  const methods = fc["method_names"];
  const allowance = fc["allowance"];
  if (typeof receiver !== "string" || !isAccountId(receiver) || !Array.isArray(methods) || !methods.every((m) => typeof m === "string")) throw new NearError("RPC", "unreadable function-call permission");
  if (allowance !== null && typeof allowance !== "string") throw new NearError("RPC", "allowance must be a decimal string or null");
  return { receiverId: receiver, methodNames: methods as string[], allowance: allowance as string | null };
}

/** The account's code hash and every access key at `at` (a block height, so two providers can be compared). */
export async function accountSnapshot(c: RpcClient, account: string, at: BlockRef): Promise<AccountSnapshot> {
  if (!isAccountId(account)) throw new NearError("RPC", "account must be a NEAR account id");
  const acct = await query(c, { request_type: "view_account", ...where(at), account_id: account });
  const keys = await query(c, { request_type: "view_access_key_list", ...where(at), account_id: account });
  const codeHash = acct["code_hash"];
  if (typeof codeHash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(codeHash)) throw new NearError("RPC", "code_hash must be base58");
  const height = acct["block_height"];
  const hash = acct["block_hash"];
  if (typeof height !== "number" || !Number.isSafeInteger(height) || typeof hash !== "string") throw new NearError("RPC", "block reference missing");
  if ("blockId" in at && height !== at.blockId) throw new NearError("RPC", "block_height doesn't match the requested block");
  const list = keys["keys"];
  if (!Array.isArray(list)) throw new NearError("RPC", "keys must be an array");
  const out: AccessKeyInfo[] = list.map((k) => {
    const o = k as { public_key?: unknown; access_key?: { nonce?: unknown; permission?: unknown } };
    if (typeof o.public_key !== "string" || o.access_key === undefined) throw new NearError("RPC", "unreadable access key");
    return { publicKey: o.public_key, nonce: u64(o.access_key.nonce, "nonce"), permission: permission(o.access_key.permission) };
  });
  return { blockHeight: height, blockHash: hash, codeHash, keys: out };
}
