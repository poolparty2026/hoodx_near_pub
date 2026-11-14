import { isAccountId } from "@poolside/rules";
import { NearError } from "./errors.ts";

/** Where and how to send JSON-RPC requests. `fetch` is injected so tests never reach the network. */
export interface RpcClient {
  readonly rpcUrl: string;
  /** Must pass `init` through (at least `redirect` and `signal`); a reply that was redirected anyway is refused (EC-V11). */
  readonly fetch: typeof fetch;
  /** Deadline for the whole request, body included (EC-A03, EC-V08). Default 10 s. */
  readonly timeoutMs?: number;
}

/** Read at final finality, or at one block so several reads agree (EC-A03 "inconsistent reads"). */
export type BlockRef = { finality: "final" } | { blockId: number };

export interface ViewResult { blockHeight: number; blockHash: string; text: string }

export const DEFAULT_TIMEOUT_MS = 10_000;
/** A larger response, in bytes on the wire, is refused once the count passes it; Poolside's views are a few KiB (EC-V08). */
export const MAX_RESPONSE_BYTES = 1 << 20;

const TOO_LARGE = () => new NearError("RPC", "response too large");

/** Reads the body as bytes, cancelling the stream as soon as it passes the cap, so a hostile node can't fill memory. */
async function readCapped(res: Response): Promise<Uint8Array> {
  const len = res.headers.get("content-length");
  if (len !== null && /^[0-9]+$/.test(len) && Number(len) > MAX_RESPONSE_BYTES) throw TOO_LARGE();
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); throw TOO_LARGE(); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

function base64(s: string): string {
  // TextEncoder and btoa run in Node and in browsers alike; Buffer is Node-only (check page).
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * A read-only `call_function` view. Never signs, never sends a transaction
 * (CLAUDE.md: mainnet views are fine, transactions are scripts a person runs).
 * Every refusal, network failures and timeouts included, is a NearError.
 */
export async function viewCall(c: RpcClient, account: string, method: string, args: unknown, at: BlockRef = { finality: "final" }): Promise<ViewResult> {
  if (!/^https:\/\//.test(c.rpcUrl)) throw new NearError("RPC", "rpcUrl must be https");
  if (!isAccountId(account)) throw new NearError("RPC", "account must be a NEAR account id");
  if (!/^[a-z_][a-z0-9_]{0,63}$/.test(method)) throw new NearError("RPC", "method must be a plain method name");
  const timeoutMs = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new NearError("RPC", "timeoutMs must be an integer from 1 to 120000");
  if ("blockId" in at && (!Number.isSafeInteger(at.blockId) || at.blockId < 0)) throw new NearError("RPC", "blockId must be a non-negative safe integer");
  const where = "blockId" in at ? { block_id: at.blockId } : { finality: "final" };
  let argsJson: string;
  try { argsJson = JSON.stringify(args); } catch { throw new NearError("RPC", "args must be JSON"); }
  if (typeof argsJson !== "string") throw new NearError("RPC", "args must be JSON");
  const signal = AbortSignal.timeout(timeoutMs);
  let bytes: Uint8Array;
  try {
    const res = await c.fetch(c.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Never follow a redirect: it could lead off https or to another host (EC-V11).
      redirect: "error",
      signal,
      body: JSON.stringify({
        jsonrpc: "2.0", id: "poolside", method: "query",
        params: { request_type: "call_function", ...where, account_id: account, method_name: method, args_base64: base64(argsJson) },
      }),
    });
    // A wrapped fetch that drops `redirect: "error"` would follow a redirect and hand back the
    // final reply; refuse it here too, so EC-V11 doesn't depend on the caller's fetch.
    if (res.redirected) throw new NearError("RPC", "redirect refused");
    if (!res.ok) throw new NearError("RPC", `HTTP ${res.status}`);
    bytes = await readCapped(res);
  } catch (e) {
    if (e instanceof NearError) throw e;
    throw new NearError("RPC", signal.aborted ? "timeout" : "network error");
  }
  let body: unknown;
  // The envelope is read with JSON.parse (a duplicate key takes the last value); the payload inside
  // is read strictly by the caller. An RPC that lies in the envelope can already lie in the payload.
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new NearError("RPC", "response is not JSON"); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new NearError("RPC", "response is not an object");
  const b = body as { error?: unknown; result?: unknown };
  if (b.error !== undefined) throw new NearError("RPC", "error from the node");
  if (b.result === null || typeof b.result !== "object" || Array.isArray(b.result)) throw new NearError("RPC", "result is not an object");
  const r = b.result as { error?: unknown; block_height?: unknown; block_hash?: unknown; result?: unknown };
  if (r.error !== undefined) throw new NearError("RPC", "error from the contract");
  if (!Array.isArray(r.result) || !r.result.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) throw new NearError("RPC", "result must be an array of bytes");
  if (typeof r.block_height !== "number" || !Number.isSafeInteger(r.block_height) || r.block_height < 0) throw new NearError("RPC", "block_height must be a non-negative safe integer");
  if ("blockId" in at && r.block_height !== at.blockId) throw new NearError("RPC", "block_height doesn't match the requested block");
  if (typeof r.block_hash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.block_hash)) throw new NearError("RPC", "block_hash must be base58");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(r.result as number[])); } catch { throw new NearError("RPC", "result is not UTF-8"); }
  return { blockHeight: r.block_height, blockHash: r.block_hash, text };
}
