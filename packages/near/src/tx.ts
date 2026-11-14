import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { isAccountId } from "@poolside/rules";
import { NearError } from "./errors.ts";
import type { RpcClient } from "./rpc.ts";

/**
 * Transactions for the agent (apps/agent), signed with a function-call access key that is limited to
 * the strategy contract's agent methods (ARCHITECTURE 5.9, EC-C142). Pure encoding and signing live
 * here and never touch the network; `sendTransaction` takes the RPC client as an argument.
 *
 * Safety by construction (CLAUDE.md hard rules): the only action this module can build is a
 * function call with **no deposit** to one configured receiver and a method from a fixed list, with
 * gas at most 300 Tgas. A key that controls funds is never handled here, only the agent's
 * function-call key, and nothing in this file reads it from the environment or logs it.
 *
 * NEAR's wire format: a Borsh `Transaction`, signed as ed25519 over the SHA-256 of its bytes, sent as
 * a Borsh `SignedTransaction` in base64. Proven against the sandbox by the agent's integration test;
 * the unit tests here check the encoding's structure and that signatures verify.
 */

/** The strategy contract's agent-callable methods (EC-C142). Anything else is refused here too. */
export const AGENT_METHODS = ["agent_swap", "agent_open", "agent_close_position", "exit_remove", "exit_withdraw", "resolve_stale"] as const;
export type AgentMethod = (typeof AGENT_METHODS)[number];
export const MAX_GAS = 300_000_000_000_000n;

export interface FunctionCall { readonly methodName: AgentMethod; readonly args: Uint8Array; readonly gas: bigint }
export interface Transaction {
  readonly signerId: string;
  readonly publicKey: Uint8Array; // 32 bytes, ed25519
  readonly nonce: bigint;
  readonly receiverId: string;
  readonly blockHash: Uint8Array; // 32 bytes
  readonly action: FunctionCall;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new NearError("TX", "not base58");
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.push(Number(n & 0xffn)); n >>= 8n; }
  let zeros = 0;
  for (const ch of s) { if (ch === "1") zeros++; else break; }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes.reverse()]);
}

export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = "";
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  let zeros = 0;
  for (const x of b) { if (x === 0) zeros++; else break; }
  return "1".repeat(zeros) + out;
}

/** An agent key as NEAR prints it: `ed25519:` + base58(seed || public key), 64 bytes. */
export function parseSecretKey(s: string): { seed: Uint8Array; publicKey: Uint8Array } {
  if (!s.startsWith("ed25519:")) throw new NearError("TX", "key must be ed25519");
  const raw = base58Decode(s.slice(8));
  if (raw.length !== 64) throw new NearError("TX", "key must be 64 bytes");
  const seed = raw.slice(0, 32);
  const publicKey = publicKeyOf(seed);
  if (!publicKey.every((v, i) => v === raw[32 + i])) throw new NearError("TX", "key's public half does not match its seed");
  return { seed, publicKey };
}

const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

function privateKeyObject(seed: Uint8Array) {
  return createPrivateKey({ key: Buffer.from([...PKCS8_PREFIX, ...seed]), format: "der", type: "pkcs8" });
}

export function publicKeyOf(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new NearError("TX", "seed must be 32 bytes");
  const der = createPublicKey(privateKeyObject(seed)).export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(der.length - 32));
}

/** `ed25519:<base58 public key>`, the form access-key lists and RPC use. */
export function publicKeyString(pk: Uint8Array): string {
  return "ed25519:" + base58Encode(pk);
}

class Writer {
  private parts: Uint8Array[] = [];
  u8(v: number) { this.parts.push(Uint8Array.of(v)); }
  uint(v: bigint, bytes: number) {
    if (v < 0n || v >= 1n << BigInt(8 * bytes)) throw new NearError("TX", "integer out of range");
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) out[i] = Number((v >> BigInt(8 * i)) & 0xffn);
    this.parts.push(out);
  }
  bytes(b: Uint8Array) { this.parts.push(b); }
  vec(b: Uint8Array) { this.uint(BigInt(b.length), 4); this.bytes(b); }
  str(s: string) { this.vec(new TextEncoder().encode(s)); }
  done(): Uint8Array {
    const n = this.parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/** Refuses anything an agent key must never send: another method, a deposit (there is none), too much gas. */
export function checkTransaction(tx: Transaction): void {
  if (!isAccountId(tx.signerId) || !isAccountId(tx.receiverId)) throw new NearError("TX", "account ids must be valid");
  if (tx.publicKey.length !== 32 || tx.blockHash.length !== 32) throw new NearError("TX", "key and block hash must be 32 bytes");
  if (!(AGENT_METHODS as readonly string[]).includes(tx.action.methodName)) throw new NearError("TX", "method is not an agent method");
  if (tx.action.gas <= 0n || tx.action.gas > MAX_GAS) throw new NearError("TX", "gas must be 1 to 300 Tgas");
  if (tx.nonce < 0n) throw new NearError("TX", "nonce");
}

export function serializeTransaction(tx: Transaction): Uint8Array {
  checkTransaction(tx);
  const w = new Writer();
  w.str(tx.signerId);
  w.u8(0); // ED25519
  w.bytes(tx.publicKey);
  w.uint(tx.nonce, 8);
  w.str(tx.receiverId);
  w.bytes(tx.blockHash);
  w.uint(1n, 4); // one action
  w.u8(2); // FunctionCall
  w.str(tx.action.methodName);
  w.vec(tx.action.args);
  w.uint(tx.action.gas, 8);
  w.uint(0n, 16); // deposit: always zero
  return w.done();
}

/** The base64 `SignedTransaction` for `send_tx`, and its hash. */
export function signTransaction(tx: Transaction, seed: Uint8Array): { base64: string; hash: string } {
  const bytes = serializeTransaction(tx);
  const digest = createHash("sha256").update(bytes).digest();
  const signature = edSign(null, digest, privateKeyObject(seed));
  const w = new Writer();
  w.bytes(bytes);
  w.u8(0);
  w.bytes(new Uint8Array(signature));
  return { base64: Buffer.from(w.done()).toString("base64"), hash: base58Encode(new Uint8Array(digest)) };
}

/** JSON args for a method, as the contract's `#[near]` entry points read them. */
export function jsonArgs(args: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function rpc(c: RpcClient, method: string, params: unknown): Promise<unknown> {
  if (!/^https?:\/\//.test(c.rpcUrl)) throw new NearError("RPC", "rpcUrl must be http(s)");
  const res = await c.fetch(c.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "poolside", method, params }),
    redirect: "error",
    signal: AbortSignal.timeout(c.timeoutMs ?? 30_000),
  });
  // A non-200 reply, a redirect, or a body above the size cap is an error, never a result (security M4).
  if (res.redirected) throw new NearError("RPC", "redirect refused");
  if (!res.ok) throw new NearError("RPC", `HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_RPC_TEXT) throw new NearError("RPC", "response too large");
  let body: { result?: unknown; error?: unknown };
  try { body = JSON.parse(text) as { result?: unknown; error?: unknown }; } catch { throw new NearError("RPC", "response is not JSON"); }
  if (body === null || typeof body !== "object" || body.error !== undefined || body.result === undefined || body.result === null || typeof body.result !== "object") throw new NearError("RPC", "rpc error");
  return body.result;
}
const MAX_RPC_TEXT = 1 << 20;

/** The next nonce and the block hash to sign against: the access key's nonce + 1, and the latest final block. */
export async function nextNonceAndBlock(c: RpcClient, accountId: string, publicKey: Uint8Array): Promise<{ nonce: bigint; blockHash: Uint8Array }> {
  const key = (await rpc(c, "query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKeyString(publicKey) })) as { nonce?: unknown; block_hash?: unknown };
  if (typeof key.nonce !== "number" && typeof key.nonce !== "string") throw new NearError("RPC", "no nonce");
  if (typeof key.block_hash !== "string") throw new NearError("RPC", "no block hash");
  return { nonce: BigInt(key.nonce) + 1n, blockHash: base58Decode(key.block_hash) };
}

export interface SentTransaction { readonly ok: boolean; readonly hash: string; readonly failure: string | null }

/** Sends a signed transaction and waits for it to be final. `ok` is false when the transaction or any receipt failed. */
export async function sendTransaction(c: RpcClient, signed: { base64: string; hash: string }, senderId: string): Promise<SentTransaction> {
  const result = (await rpc(c, "send_tx", { signed_tx_base64: signed.base64, wait_until: "FINAL" })) as {
    status?: { SuccessValue?: unknown; Failure?: unknown };
    receipts_outcome?: { outcome?: { status?: { Failure?: unknown } } }[];
  };
  void senderId;
  // `ok` only with a readable final status: `SuccessValue` present and no failure anywhere. A reply
  // with neither (an empty result, an unknown shape) is not a success (security M4, test audit 2).
  const failure = result.status?.Failure ?? result.receipts_outcome?.map((r) => r.outcome?.status?.Failure).find((f) => f !== undefined);
  if (failure === undefined && result.status?.SuccessValue === undefined) {
    return { ok: false, hash: signed.hash, failure: "no readable status in the reply" };
  }
  return { ok: failure === undefined, hash: signed.hash, failure: failure === undefined ? null : JSON.stringify(failure) };
}
