// Real chain access for the deliverer: final-block views and a `deliver_key` signer.
// The only transaction this file can build is `deliver_key` with 0 deposit to the strategy account.
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import {
  base58Encode, jsonArgs, nextNonceAndBlock, parseSecretKey, sendTransaction, viewCall,
  type RpcClient,
} from "@poolside/near";
import type { Chain } from "./deliverer.ts";

// 50 Tgas. Measured in the sandbox on the real wasm (lead, 26bdfec): deliver 2.8 + 2.1 Tgas, buy 2.2, so 50 is ample.
export const DELIVER_GAS = 50_000_000_000_000n;

const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

class W {
  private p: Uint8Array[] = [];
  u8(v: number) { this.p.push(Uint8Array.of(v)); }
  uint(v: bigint, n: number) {
    const o = new Uint8Array(n);
    for (let i = 0; i < n; i++) o[i] = Number((v >> BigInt(8 * i)) & 0xffn);
    this.p.push(o);
  }
  bytes(b: Uint8Array) { this.p.push(b); }
  vec(b: Uint8Array) { this.uint(BigInt(b.length), 4); this.bytes(b); }
  str(s: string) { this.vec(new TextEncoder().encode(s)); }
  done() { return Buffer.concat(this.p); }
}

export interface DeliverTx {
  signerId: string; seed: Uint8Array; publicKey: Uint8Array; nonce: bigint;
  receiverId: string; blockHash: Uint8Array; args: Uint8Array; gas: bigint;
}

/** Borsh SignedTransaction (base64) for one `deliver_key` call, deposit zero. */
export function signDeliverKey(t: DeliverTx): { base64: string; hash: string } {
  const w = new W();
  w.str(t.signerId); w.u8(0); w.bytes(t.publicKey); w.uint(t.nonce, 8);
  w.str(t.receiverId); w.bytes(t.blockHash); w.uint(1n, 4);
  w.u8(2); w.str("deliver_key"); w.vec(t.args); w.uint(t.gas, 8); w.uint(0n, 16);
  const bytes = w.done();
  const digest = createHash("sha256").update(bytes).digest();
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, t.seed]), format: "der", type: "pkcs8" });
  const sig = edSign(null, digest, key);
  const s = new W();
  s.bytes(bytes); s.u8(0); s.bytes(sig);
  return { base64: s.done().toString("base64"), hash: base58Encode(new Uint8Array(digest)) };
}

export interface KeyRestriction { ok: boolean; reason: string }

/** The deliverer's key must be a function-call key to the strategy with exactly `deliver_key` (least privilege). */
export async function checkKeyRestriction(rpc: RpcClient, accountId: string, publicKey: Uint8Array, strategy: string): Promise<KeyRestriction> {
  const res = await rpc.fetch(rpc.rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(rpc.timeoutMs ?? 10_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: "k", method: "query", params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: "ed25519:" + base58Encode(publicKey) } }),
  });
  const body = (await res.json()) as { result?: { permission?: unknown } };
  const perm = body.result?.permission as { FunctionCall?: { receiver_id?: unknown; method_names?: unknown } } | string | undefined;
  if (perm === undefined) return { ok: false, reason: "key not found on the account" };
  if (typeof perm === "string") return { ok: false, reason: "key is full access" };
  const fc = perm.FunctionCall;
  if (fc === undefined) return { ok: false, reason: "key permission unreadable" };
  if (fc.receiver_id !== strategy) return { ok: false, reason: "key receiver is not the strategy" };
  const m = fc.method_names;
  if (!Array.isArray(m) || m.length !== 1 || m[0] !== "deliver_key") return { ok: false, reason: "key methods are not exactly [deliver_key]" };
  return { ok: true, reason: "" };
}

async function blockTimestampNs(rpc: RpcClient): Promise<bigint> {
  const res = await rpc.fetch(rpc.rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(rpc.timeoutMs ?? 10_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: "b", method: "block", params: { finality: "final" } }),
  });
  const body = (await res.json()) as { result?: { header?: { timestamp_nanosec?: unknown } } };
  const ts = body.result?.header?.timestamp_nanosec;
  if (typeof ts !== "string" || !/^[0-9]+$/.test(ts)) throw new Error("DELIVERER: block timestamp unreadable");
  return BigInt(ts);
}

export function makeChain(rpc: RpcClient, strategy: string, accountId: string, secretKey: string): Chain {
  const { seed, publicKey } = parseSecretKey(secretKey);
  let sendQueue: Promise<void> = Promise.resolve();
  async function send(buyer: string, sealedKey: string): Promise<{ ok: boolean; failure: string | null }> {
    const { nonce, blockHash } = await nextNonceAndBlock(rpc, accountId, publicKey);
    const signed = signDeliverKey({
      signerId: accountId, seed, publicKey, nonce, receiverId: strategy, blockHash,
      args: jsonArgs({ buyer, sealed_key: sealedKey }), gas: DELIVER_GAS,
    });
    const r = await sendTransaction(rpc, signed, accountId);
    return { ok: r.ok, failure: r.failure };
  }
  return {
    now: () => blockTimestampNs(rpc),
    async view(method, args) {
      const r = await viewCall(rpc, strategy, method, args, { finality: "final" });
      return JSON.parse(r.text) as unknown;
    },
    async deliverKey(buyer, sealedKey, precheck) {
      // N1: one key, one nonce stream. Sends are serialised, each waiting for FINAL, and the nonce is
      // re-read from the chain after the previous send landed, so concurrent sales can't sign the same
      // (or an out-of-order) nonce, and a failed send needs no local state to recover.
      const turn = sendQueue.then(async () => {
        const skipped = precheck === undefined ? null : await precheck();
        if (skipped !== null) return { ok: false, failure: null, skipped };
        return send(buyer, sealedKey);
      });
      sendQueue = turn.then(() => undefined, () => undefined);
      return turn;
    },
  };
}
