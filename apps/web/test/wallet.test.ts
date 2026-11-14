import { describe, expect, it } from "vitest";
import { testnetWallet, type ChainAccount } from "../src/lib/keys/wallet.ts";

const fake = (chain: string | Error) => {
  const calls: unknown[] = [];
  const acc: ChainAccount = {
    accountId: "a.testnet",
    chainId: async () => { if (chain instanceof Error) throw chain; return chain; },
    callFunction: async (a) => { calls.push(a); },
  };
  return { acc, calls };
};

describe("testnet wallet", () => {
  it("buy: calls buy_viewing_key with the pubkey and exactly the deposit", async () => {
    const { acc, calls } = fake("testnet");
    await testnetWallet(acc).buyViewingKey("s.testnet", "ab".repeat(32), 123n);
    expect(calls).toMatchObject([{ contractId: "s.testnet", methodName: "buy_viewing_key", args: { buyer_pubkey: "ab".repeat(32) }, deposit: 123n }]);
  });
  it("refund: zero deposit", async () => {
    const { acc, calls } = fake("testnet");
    await testnetWallet(acc).refundKey("s.testnet");
    expect(calls).toMatchObject([{ methodName: "refund_key", deposit: 0n }]);
  });
  it.each(["mainnet", "", "localnet"])("refuses chain %j and sends nothing", async (c) => {
    const { acc, calls } = fake(c);
    await expect(testnetWallet(acc).buyViewingKey("s.testnet", "ab".repeat(32), 1n)).rejects.toThrow("This wallet only works on testnet. Nothing was sent.");
    expect(calls).toEqual([]);
  });
  it("refuses when the chain cannot be read", async () => {
    const { acc, calls } = fake(new Error("rpc down"));
    await expect(testnetWallet(acc).refundKey("s.testnet")).rejects.toThrow("only works on testnet");
    expect(calls).toEqual([]);
  });
  it("M3/M4: refuses accounts or strategies that are not .testnet names, sends nothing", async () => {
    const { acc, calls } = fake("testnet");
    await expect(testnetWallet(acc).buyViewingKey("strategy.near", "ab".repeat(32), 1n)).rejects.toThrow("only works on testnet");
    await expect(testnetWallet({ ...acc, accountId: "alice.near" }).buyViewingKey("s.testnet", "ab".repeat(32), 1n)).rejects.toThrow("only works on testnet");
    expect(calls).toEqual([]);
  });
});
