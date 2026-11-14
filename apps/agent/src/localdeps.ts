import { jsonArgs, nextNonceAndBlock, sendTransaction, signTransaction, type AgentMethod, type RpcClient } from "@poolside/near";
import { strictParse } from "@poolside/rules";
import type { ChainDeps } from "./chain.ts";
import { isLocalHttp } from "./safety.ts";
import { readRecordFile } from "./records.ts";

/**
 * Reads and sender for a LOCAL SANDBOX node on plain http (the scenario harness). It refuses any other host:
 * the real network goes through `realDeps`, which insists on https. The key is the sandbox account's.
 */
export function localDeps(o: { rpcUrl: string; rules: ChainDeps["rules"]; strategy: string; dcl: string; agent: string; seed: Uint8Array; publicKey: Uint8Array; heldDir: string }): ChainDeps {
  if (!isLocalHttp(o.rpcUrl)) throw new Error("localDeps talks to a local sandbox only");
  const rpc: RpcClient = { rpcUrl: o.rpcUrl, fetch };
  async function call(method: string, params: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(o.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000), body: JSON.stringify({ jsonrpc: "2.0", id: "s", method, params }) });
    if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
    if (body.error !== undefined || body.result === undefined) throw new Error(`rpc ${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }
  const header = async (params: unknown) => {
    const hd = ((await call("block", params)).header ?? {}) as { height?: number; timestamp?: number | string };
    if (typeof hd.height !== "number" || hd.timestamp === undefined) throw new Error("unreadable block header");
    return { height: hd.height, timestampNs: BigInt(hd.timestamp) };
  };
  return {
    rules: o.rules, strategy: o.strategy, dcl: o.dcl,
    head: () => header({ finality: "final" }),
    blockTimeNs: async (h) => (await header({ block_id: h })).timestampNs,
    readRecord: async (hash) => readRecordFile(o.heldDir, hash),
    async view(account, method, args, blockId) {
      const r = await call("query", { request_type: "call_function", block_id: blockId, account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
      if (!Array.isArray(r["result"])) throw new Error(`view ${account}.${method} failed`);
      return strictParse(Buffer.from(r["result"] as number[]).toString("utf8"));
    },
    async submit(method, args, gas) {
      const { nonce, blockHash } = await nextNonceAndBlock(rpc, o.agent, o.publicKey);
      const signed = signTransaction({ signerId: o.agent, publicKey: o.publicKey, nonce, receiverId: o.strategy, blockHash, action: { methodName: method as AgentMethod, args: jsonArgs(args), gas } }, o.seed);
      return sendTransaction(rpc, signed, o.agent);
    },
  };
}
