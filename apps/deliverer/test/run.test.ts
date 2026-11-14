import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { base58Encode } from "@poolside/near";
import { validateRules, encryptRules, hashRules } from "@poolside/rules";
import { start } from "../src/run.ts";

const STRAT = "s.testnet", ME = "d.testnet";
const K = new Uint8Array(32).fill(7);

function key() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32));
  const pub = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return "ed25519:" + base58Encode(new Uint8Array([...seed, ...pub]));
}
const R = validateRules({ version: 1, pool: `${"ab".repeat(32)}|wrap.near|100`, quote_token: "ab".repeat(32), range: { width_bps: 800, centre: "mid" },
  take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432_000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const CONFIG = (k: Uint8Array) => ({ rules_ciphertext: Buffer.from(encryptRules(R, k, new Uint8Array(24).fill(3), STRAT)).toString("base64"), rules_hash: hex(hashRules(R)) });

function rig(opts: { cfgKey?: Uint8Array; permission?: unknown } = {}) {
  const calls: string[] = [];
  const f = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body);
    let result: unknown;
    if (body.params?.request_type === "view_access_key") {
      calls.push("view_access_key");
      result = { permission: opts.permission ?? { FunctionCall: { receiver_id: STRAT, method_names: ["deliver_key"], allowance: "1" } } };
    } else if (body.params?.request_type === "call_function") {
      const m = body.params.method_name;
      calls.push(m);
      const val = m === "get_config" ? CONFIG(opts.cfgKey ?? K) : m === "get_key_params" ? { key_delivery_window_ns: "3600000000000", deliverer: ME, sold: 0 } : [];
      result = { result: [...Buffer.from(JSON.stringify(val))], block_height: 1, block_hash: base58Encode(new Uint8Array(32).fill(9)) };
    } else result = { header: { timestamp_nanosec: "1000" } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200 });
  }) as unknown as typeof fetch;
  const scheduled: number[] = [];
  const env = { DELIVERER_RPC: "https://rpc.testnet.near.org", DELIVERER_ACCOUNT: ME, STRATEGY: STRAT, DELIVERER_KEY: key(), RULES_KEY_HEX: hex(K), DELIVERER_POLL_MS: "1234" };
  return { calls, scheduled, env, deps: (e: Record<string, string | undefined> = env) => ({ env: e, fetch: f, log: () => undefined, schedule: (_fn: () => void, ms: number) => scheduled.push(ms) }) };
}

describe("start wiring", () => {
  it("refuses a mainnet RPC before any request", async () => {
    const r = rig();
    await expect(start(r.deps({ ...r.env, DELIVERER_RPC: "https://rpc.mainnet.near.org" }))).rejects.toThrow("DELIVERER: refusing a non-allowlisted RPC");
    expect(r.calls).toEqual([]);
  });
  it("refuses a full-access key before verifying rules or polling", async () => {
    const r = rig({ permission: "FullAccess" });
    await expect(start(r.deps())).rejects.toThrow("refusing to start, key is full access");
    expect(r.calls).toEqual(["view_access_key"]);
    expect(r.scheduled).toEqual([]);
  });
  it("refuses a wrong rules key before the first tick (no get_key_sales, nothing scheduled)", async () => {
    const r = rig({ cfgKey: new Uint8Array(32).fill(1) });
    await expect(start(r.deps())).rejects.toThrow("rules key does not open the on-chain rules");
    expect(r.calls).toEqual(["view_access_key", "get_config"]);
    expect(r.scheduled).toEqual([]);
  });
  it("on success: key check, then rules check, then the first tick, then the schedule", async () => {
    const r = rig();
    const { pass } = await start(r.deps());
    await pass();
    await new Promise((res) => setTimeout(res, 30)); // the first pass started by start() finishes
    expect(r.calls.slice(0, 3)).toEqual(["view_access_key", "get_config", "get_key_params"]);
    expect(r.calls).toContain("get_key_sales");
    expect(r.scheduled).toEqual([1234]);
  });
  it("a missing variable is named", async () => {
    const r = rig();
    await expect(start(r.deps({ ...r.env, STRATEGY: undefined }))).rejects.toThrow("missing STRATEGY");
  });
});

describe("poll interval", () => {
  for (const bad of ["abc", "999", "0", "-5", "1500.5"]) {
    it(`DELIVERER_POLL_MS=${bad} is refused`, async () => {
      const r = rig();
      await expect(start(r.deps({ ...r.env, DELIVERER_POLL_MS: bad }))).rejects.toThrow("DELIVERER_POLL_MS must be an integer of at least 1000");
      expect(r.calls).toEqual([]);
    });
  }
});
