import {
  jsonArgs, nextNonceAndBlock, publicKeyOf, sendTransaction, signTransaction, viewCall,
  type AgentMethod, type RpcClient,
} from "@poolside/near";
import { strictParse } from "@poolside/rules";
import type { ChainDeps } from "./chain.ts";
import { readRecordFile } from "./records.ts";
import { isHttps } from "./safety.ts";

/**
 * The real reads and sender for `createChain`: JSON-RPC against the given node, the agent's
 * function-call key (a 32-byte seed the caller reads from its own secret store; this file never
 * reads the environment and never logs it). A transaction is a function call with no deposit to the
 * strategy and an agent method only (`checkTransaction`).
 */
export function realDeps(o: { rpc: RpcClient; rules: ChainDeps["rules"]; strategy: string; dcl: string; agent: string; seed: Uint8Array; recordsDir: string }): ChainDeps {
  const { rpc } = o;
  if (!isHttps(rpc.rpcUrl)) throw new Error("realDeps talks to an https node only");
  return {
    rules: o.rules, strategy: o.strategy, dcl: o.dcl,
    async head() {
      const res = await rpc.fetch(rpc.rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(rpc.timeoutMs ?? 10_000),
        body: JSON.stringify({ jsonrpc: "2.0", id: "poolside", method: "block", params: { finality: "final" } }),
      });
      if (!res.ok) throw new Error(`rpc block: HTTP ${res.status}`);
      const body = (await res.json()) as { result?: { header?: { height?: unknown; timestamp?: unknown } } };
      const hd = body.result?.header;
      if (typeof hd?.height !== "number" || (typeof hd.timestamp !== "number" && typeof hd.timestamp !== "string")) throw new Error("unreadable block header");
      return { height: hd.height, timestampNs: BigInt(hd.timestamp) };
    },
    async blockTimeNs(height) {
      const res = await rpc.fetch(rpc.rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(rpc.timeoutMs ?? 10_000),
        body: JSON.stringify({ jsonrpc: "2.0", id: "poolside", method: "block", params: { block_id: height } }),
      });
      if (!res.ok) throw new Error(`rpc block: HTTP ${res.status}`);
      const body = (await res.json()) as { result?: { header?: { height?: unknown; timestamp?: unknown } } };
      const hd = body.result?.header;
      if (hd?.height !== height || (typeof hd.timestamp !== "number" && typeof hd.timestamp !== "string")) throw new Error("unreadable block header");
      return BigInt(hd.timestamp);
    },
    async readRecord(hash) {
      return readRecordFile(o.recordsDir, hash);
    },
    async view(account, method, args, blockId) {
      const r = await viewCall(rpc, account, method, args, { blockId });
      return strictParse(r.text);
    },
    async submit(method, args, gas) {
      const pk = publicKeyOf(o.seed);
      const { nonce, blockHash } = await nextNonceAndBlock(rpc, o.agent, pk);
      const signed = signTransaction(
        { signerId: o.agent, publicKey: pk, nonce, receiverId: o.strategy, blockHash, action: { methodName: method as AgentMethod, args: jsonArgs(args), gas } },
        o.seed,
      );
      return sendTransaction(rpc, signed, o.agent);
    },
  };
}
