import { describe, expect, it } from "vitest";
import { accountSnapshot, type RpcClient } from "../src/index.ts";

const HASH = "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q";
const client = (reply: (p: Record<string, unknown>) => unknown, status = 200): RpcClient => ({
  rpcUrl: "https://rpc.example",
  fetch: (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: Record<string, unknown> };
    return new Response(JSON.stringify(reply(body.params)), { status });
  }) as typeof fetch,
});
const good = (p: Record<string, unknown>): unknown =>
  p["request_type"] === "view_account"
    ? { result: { code_hash: HASH, block_height: 100, block_hash: HASH } }
    : { result: { keys: [
        { public_key: "ed25519:AAA", access_key: { nonce: 5, permission: "FullAccess" } },
        { public_key: "ed25519:BBB", access_key: { nonce: 0, permission: { FunctionCall: { receiver_id: "strategy-1.near", method_names: ["agent_swap"], allowance: "1000" } } } },
      ] } };

describe("accountSnapshot", () => {
  it("reads the code hash and every key's permission and nonce at one block", async () => {
    const seen: Record<string, unknown>[] = [];
    const s = await accountSnapshot(client((p) => { seen.push(p); return good(p); }), "strategy-1.near", { blockId: 100 });
    expect(s.codeHash).toBe(HASH);
    expect(s.keys).toEqual([
      { publicKey: "ed25519:AAA", nonce: 5n, permission: "FullAccess" },
      { publicKey: "ed25519:BBB", nonce: 0n, permission: { receiverId: "strategy-1.near", methodNames: ["agent_swap"], allowance: "1000" } },
    ]);
    expect(seen.map((p) => p["block_id"])).toEqual([100, 100]);
  });
  it("refuses what it cannot read: a bad account, hash, key list, permission, height, status or error", async () => {
    await expect(accountSnapshot(client(good), "Not An Account", { finality: "final" })).rejects.toThrow(/account/);
    await expect(accountSnapshot(client((p) => (p["request_type"] === "view_account" ? { result: { code_hash: "0OIl", block_height: 1, block_hash: "x" } } : good(p))), "a.near", { finality: "final" })).rejects.toThrow(/base58/);
    await expect(accountSnapshot(client(good), "a.near", { blockId: 99 })).rejects.toThrow(/doesn't match/);
    await expect(accountSnapshot(client((p) => (p["request_type"] === "view_access_key_list" ? { result: { keys: "no" } } : good(p))), "a.near", { blockId: 100 })).rejects.toThrow(/array/);
    await expect(accountSnapshot(client((p) => (p["request_type"] === "view_access_key_list" ? { result: { keys: [{ public_key: "k", access_key: { nonce: -1, permission: "FullAccess" } }] } } : good(p))), "a.near", { blockId: 100 })).rejects.toThrow(/u64/);
    await expect(accountSnapshot(client((p) => (p["request_type"] === "view_access_key_list" ? { result: { keys: [{ public_key: "k", access_key: { nonce: 1, permission: { Other: {} } } }] } } : good(p))), "a.near", { blockId: 100 })).rejects.toThrow(/permission/);
    await expect(accountSnapshot(client(good, 500), "a.near", { blockId: 100 })).rejects.toThrow(/HTTP 500/);
    await expect(accountSnapshot(client(() => ({ error: { code: -1 } })), "a.near", { blockId: 100 })).rejects.toThrow(/error from the node/);
    await expect(accountSnapshot({ ...client(good), rpcUrl: "http://insecure" }, "a.near", { blockId: 100 })).rejects.toThrow(/https/);
  });
});
