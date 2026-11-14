import { createHash, createPublicKey, verify } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_METHODS, MAX_GAS, base58Decode, base58Encode, jsonArgs, nextNonceAndBlock, parseSecretKey, publicKeyOf, publicKeyString,
  sendTransaction, serializeTransaction, signTransaction, type RpcClient, type Transaction,
} from "../src/index.ts";

const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const pub = publicKeyOf(seed);
const base: Transaction = {
  signerId: "agent.test.near",
  publicKey: pub,
  nonce: 7n,
  receiverId: "strategy-1.test.near",
  blockHash: new Uint8Array(32).fill(9),
  action: { methodName: "agent_swap", args: jsonArgs({ left_point: 1, right_point: 2 }), gas: 280_000_000_000_000n },
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("base58", () => {
  it("matches a known vector and round-trips, with leading zeros", () => {
    expect(base58Encode(new TextEncoder().encode("hello world"))).toBe("StV1DL6CwTryKyV");
    expect(new TextDecoder().decode(base58Decode("StV1DL6CwTryKyV"))).toBe("hello world");
    expect(hex(base58Decode(base58Encode(Uint8Array.of(0, 0, 1, 2))))).toBe("00000102");
    expect(base58Encode(new Uint8Array(0))).toBe("");
    fc.assert(fc.property(fc.uint8Array({ maxLength: 64 }), (b) => hex(base58Decode(base58Encode(b))) === hex(b)));
  });
  it("refuses characters outside the alphabet", () => {
    for (const bad of ["0", "O", "I", "l", "+", " ", "é"]) expect(() => base58Decode("abc" + bad)).toThrow(/TX: not base58/);
  });
});

describe("keys", () => {
  it("derives the public key from the seed and parses NEAR's secret key format", () => {
    expect(pub.length).toBe(32);
    const s = "ed25519:" + base58Encode(Uint8Array.from([...seed, ...pub]));
    expect(parseSecretKey(s).seed).toEqual(seed);
    expect(hex(parseSecretKey(s).publicKey)).toBe(hex(pub));
    expect(publicKeyString(pub)).toBe("ed25519:" + base58Encode(pub));
  });
  it("refuses another curve, a short key and a mismatched public half", () => {
    const good = base58Encode(Uint8Array.from([...seed, ...pub]));
    expect(() => parseSecretKey("secp256k1:" + good)).toThrow(/ed25519/);
    expect(() => parseSecretKey("ed25519:" + base58Encode(seed))).toThrow(/64 bytes/);
    expect(() => parseSecretKey("ed25519:" + base58Encode(Uint8Array.from([...seed, ...new Uint8Array(32)])))).toThrow(/does not match/);
    expect(() => publicKeyOf(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe("serializeTransaction (Borsh)", () => {
  const bytes = serializeTransaction(base);
  it("lays the fields out in NEAR's order", () => {
    let o = 0;
    const u32 = () => { const v = Buffer.from(bytes).readUInt32LE(o); o += 4; return v; };
    expect(u32()).toBe("agent.test.near".length);
    expect(new TextDecoder().decode(bytes.subarray(o, (o += 15)))).toBe("agent.test.near");
    expect(bytes[o++]).toBe(0); // ed25519
    expect(hex(bytes.subarray(o, (o += 32)))).toBe(hex(pub));
    expect(Buffer.from(bytes).readBigUInt64LE(o)).toBe(7n); o += 8;
    expect(u32()).toBe("strategy-1.test.near".length);
    expect(new TextDecoder().decode(bytes.subarray(o, (o += 20)))).toBe("strategy-1.test.near");
    expect(hex(bytes.subarray(o, (o += 32)))).toBe("09".repeat(32));
    expect(u32()).toBe(1); // one action
    expect(bytes[o++]).toBe(2); // FunctionCall
    expect(u32()).toBe("agent_swap".length);
    expect(new TextDecoder().decode(bytes.subarray(o, (o += 10)))).toBe("agent_swap");
    const n = u32();
    expect(new TextDecoder().decode(bytes.subarray(o, (o += n)))).toBe('{"left_point":1,"right_point":2}');
    expect(Buffer.from(bytes).readBigUInt64LE(o)).toBe(280_000_000_000_000n); o += 8;
    expect(hex(bytes.subarray(o, (o += 16)))).toBe("00".repeat(16)); // no deposit, ever
    expect(o).toBe(bytes.length);
  });
  it("is deterministic and changes with every field", () => {
    expect(hex(serializeTransaction(base))).toBe(hex(bytes));
    for (const t of [{ ...base, nonce: 8n }, { ...base, receiverId: "strategy-2.test.near" }, { ...base, signerId: "agent2.test.near" }, { ...base, blockHash: new Uint8Array(32).fill(8) }]) {
      expect(hex(serializeTransaction(t))).not.toBe(hex(bytes));
    }
  });
});

describe("what an agent key may never send", () => {
  const bad = (t: Partial<Transaction> & { action?: unknown }) => () => serializeTransaction({ ...base, ...t } as Transaction);
  it("only agent methods, with gas of 1 to 300 Tgas, valid accounts and 32-byte keys and hashes", () => {
    for (const m of ["withdraw", "claim_creator", "new", "ft_transfer", "close", "start", "reveal", "", "agent_swap "]) {
      expect(bad({ action: { ...base.action, methodName: m as never } })).toThrow(/not an agent method/);
    }
    for (const m of AGENT_METHODS) expect(() => serializeTransaction({ ...base, action: { ...base.action, methodName: m } })).not.toThrow();
    expect(bad({ action: { ...base.action, gas: 0n } })).toThrow(/gas/);
    expect(bad({ action: { ...base.action, gas: MAX_GAS + 1n } })).toThrow(/gas/);
    expect(() => serializeTransaction({ ...base, action: { ...base.action, gas: MAX_GAS } })).not.toThrow();
    expect(bad({ receiverId: "Not A Valid Id" })).toThrow(/account ids/);
    expect(bad({ signerId: "" })).toThrow(/account ids/);
    expect(bad({ publicKey: new Uint8Array(31) })).toThrow(/32 bytes/);
    expect(bad({ blockHash: new Uint8Array(33) })).toThrow(/32 bytes/);
    expect(bad({ nonce: -1n })).toThrow(/nonce/);
    expect(bad({ nonce: 1n << 64n })).toThrow(/out of range/);
  });
});

describe("signTransaction", () => {
  it("signs the SHA-256 of the Borsh bytes with ed25519 and the signature verifies", () => {
    const { base64, hash } = signTransaction(base, seed);
    const raw = Buffer.from(base64, "base64");
    const txBytes = serializeTransaction(base);
    expect(hex(raw.subarray(0, txBytes.length))).toBe(hex(txBytes));
    expect(raw[txBytes.length]).toBe(0); // ed25519 signature
    const sig = raw.subarray(txBytes.length + 1);
    expect(sig.length).toBe(64);
    expect(raw.length).toBe(txBytes.length + 65);
    const digest = createHash("sha256").update(txBytes).digest();
    expect(hash).toBe(base58Encode(new Uint8Array(digest)));
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub)]);
    expect(verify(null, digest, createPublicKey({ key: spki, format: "der", type: "spki" }), sig)).toBe(true);
    // Another key, another message: does not verify.
    const other = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKeyOf(new Uint8Array(32).fill(5)))]), format: "der", type: "spki" });
    expect(verify(null, digest, other, sig)).toBe(false);
    expect(verify(null, Buffer.from(digest.map((b) => b ^ 1)), createPublicKey({ key: spki, format: "der", type: "spki" }), sig)).toBe(false);
  });
});

describe("the RPC calls", () => {
  const client = (reply: (body: { method: string; params: unknown }) => unknown): RpcClient => ({
    rpcUrl: "http://127.0.0.1:3030",
    fetch: (async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
      return new Response(JSON.stringify(reply(body)), { status: 200 });
    }) as typeof fetch,
  });
  it("reads the next nonce and block hash from the access key at final finality", async () => {
    const hash = base58Encode(new Uint8Array(32).fill(3));
    let seen: { method: string; params: Record<string, unknown> } | undefined;
    const c = client((b) => { seen = b as typeof seen; return { result: { nonce: 41, block_hash: hash } }; });
    const r = await nextNonceAndBlock(c, "agent.test.near", pub);
    expect(r.nonce).toBe(42n);
    expect(hex(r.blockHash)).toBe("03".repeat(32));
    expect(seen).toMatchObject({ method: "query", params: { request_type: "view_access_key", finality: "final", account_id: "agent.test.near", public_key: publicKeyString(pub) } });
  });
  it("refuses a reply without a nonce or a hash, and an RPC error", async () => {
    await expect(nextNonceAndBlock(client(() => ({ result: { block_hash: "x" } })), "agent.test.near", pub)).rejects.toThrow(/no nonce/);
    await expect(nextNonceAndBlock(client(() => ({ result: { nonce: 1 } })), "agent.test.near", pub)).rejects.toThrow(/no block hash/);
    await expect(nextNonceAndBlock(client(() => ({ error: { code: -1 } })), "agent.test.near", pub)).rejects.toThrow(/rpc error/);
  });
  it("sends the signed bytes and waits for FINAL; any failure in the transaction or a receipt is not ok", async () => {
    const signed = signTransaction(base, seed);
    let seen: { method: string; params: Record<string, unknown> } | undefined;
    const okC = client((b) => { seen = b as typeof seen; return { result: { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] } }; });
    const r = await sendTransaction(okC, signed, "agent.test.near");
    expect(r).toEqual({ ok: true, hash: signed.hash, failure: null });
    expect(seen).toMatchObject({ method: "send_tx", params: { signed_tx_base64: signed.base64, wait_until: "FINAL" } });
    const txFail = await sendTransaction(client(() => ({ result: { status: { Failure: { ActionError: "x" } } } })), signed, "agent.test.near");
    expect(txFail.ok).toBe(false);
    const receiptFail = await sendTransaction(client(() => ({ result: { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }, { outcome: { status: { Failure: { ActionError: "LIMIT: gas" } } } }] } })), signed, "agent.test.near");
    expect(receiptFail.ok).toBe(false);
    expect(receiptFail.failure).toContain("LIMIT: gas");
  });
  // EC-A03 (security M4, test audit 2 and 3): a reply that isn't a readable final status is never a success.
  it("an empty or unreadable send_tx result is not ok, whatever its HTTP status", async () => {
    const signed = signTransaction(base, seed);
    for (const result of [{}, { status: {} }, { status: { Unknown: 1 } }, { receipts_outcome: [] }]) {
      const r = await sendTransaction(client(() => ({ result })), signed, "agent.test.near");
      expect(r.ok, JSON.stringify(result)).toBe(false);
      expect(r.failure).toMatch(/no readable status/);
    }
    const mk = (res: () => Response): RpcClient => ({ rpcUrl: "https://rpc.example", fetch: (async () => res()) as typeof fetch });
    await expect(sendTransaction(mk(() => new Response("{}", { status: 503 })), signed, "agent.test.near")).rejects.toThrow(/HTTP 503/);
    await expect(sendTransaction(mk(() => new Response("not json", { status: 200 })), signed, "agent.test.near")).rejects.toThrow(/not JSON/);
    await expect(sendTransaction(mk(() => new Response("x".repeat((1 << 20) + 1), { status: 200 })), signed, "agent.test.near")).rejects.toThrow(/too large/);
    await expect(sendTransaction(mk(() => new Response(JSON.stringify({ result: null }), { status: 200 })), signed, "agent.test.near")).rejects.toThrow(/rpc error/);
  });
  it("refuses a non-http URL", async () => {
    const c = { ...client(() => ({ result: {} })), rpcUrl: "file:///etc/passwd" };
    await expect(nextNonceAndBlock(c, "agent.test.near", pub)).rejects.toThrow(/http/);
  });
});

describe("jsonArgs", () => {
  it("encodes bigint as a decimal string, as the contract's U64 and U128 expect", () => {
    expect(new TextDecoder().decode(jsonArgs({ a: 1n << 70n, b: [1, "x"], c: null }))).toBe('{"a":"1180591620717411303424","b":[1,"x"],"c":null}');
  });
});
