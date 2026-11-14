// TESTNET-ONLY wallet (D57). Signs with a throwaway testnet key the user pastes. The key is held in memory by the
// caller only: never persisted, logged or sent anywhere except as a transaction signature to the testnet RPC.
// Refuses any chain that is not "testnet", checked before every call (fail closed).
// NOTE (A4): near-api-js 7.5.3 exports only ".", "./tokens", "./nep413" and "./seed-phrase", so there is no narrower subpath
// for Account or JsonRpcProvider; the whole package is imported.
import { Account } from "near-api-js";
import type { Wallet } from "./flow.ts";
import { isTestnetId } from "./ids.ts";

import { TESTNET_RPC } from "./rpcs.ts";
export { TESTNET_RPC };
// 100 TGas is the attached ceiling, not the use. Measured in the local sandbox: buy_viewing_key about 2.2 TGas; refund_key about
// 2.8 TGas plus 2.1 TGas and a callback. Unused gas is refunded. Not measured on testnet.
export const GAS_BUY = 100_000_000_000_000n;
export const GAS_REFUND = 100_000_000_000_000n;

/** The slice of Account this wallet uses, so tests can inject a fake. */
export interface ChainAccount {
  readonly accountId: string;
  chainId(): Promise<string>;
  callFunction(a: { contractId: string; methodName: string; args?: Record<string, unknown>; deposit?: bigint; gas?: bigint }): Promise<unknown>;
}

/** `rpcUrl` is injectable so a test can point at a local sandbox; the UI always uses the default (testnet). */
export function realAccount(accountId: string, secretKey: string, rpcUrl: string = TESTNET_RPC): ChainAccount {
  const acc = new Account(accountId, rpcUrl, secretKey as `ed25519:${string}`);
  return {
    accountId,
    chainId: async () => await acc.provider.getNetworkId(),
    callFunction: (a) => acc.callFunction(a),
  };
}

const NOT_TESTNET = "This wallet only works on testnet. Nothing was sent.";

/** `allowedChain` defaults to "testnet" and is a parameter only so tests can run against a local sandbox (D57-b); the UI never passes it. */
export function testnetWallet(acc: ChainAccount, allowedChain: string = "testnet"): Wallet {
  const guarded = async (strategy: string, f: () => Promise<unknown>): Promise<void> => {
    if (allowedChain === "testnet" && !(isTestnetId(acc.accountId) && isTestnetId(strategy))) throw new Error(NOT_TESTNET);
    let chain: string;
    try { chain = await acc.chainId(); } catch { throw new Error(NOT_TESTNET); }
    if (chain !== allowedChain) throw new Error(NOT_TESTNET);
    await f();
  };
  return {
    accountId: acc.accountId,
    buyViewingKey: (strategy, buyerPubkeyHex, deposit) =>
      guarded(strategy, () => acc.callFunction({ contractId: strategy, methodName: "buy_viewing_key", args: { buyer_pubkey: buyerPubkeyHex }, deposit, gas: GAS_BUY })),
    refundKey: (strategy) => guarded(strategy, () => acc.callFunction({ contractId: strategy, methodName: "refund_key", args: {}, deposit: 0n, gas: GAS_REFUND })),
  };
}
