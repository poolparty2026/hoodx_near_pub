// Evidence (not a contract test). The stub below is hand-built from INTERFACE section 9; it does not run the contract.
// D57-b: the whole follower path against a STUBBED chain shaped like INTERFACE section 9, with real libsodium.
// The local-sandbox version of this test replaces `Stub` with real RPC (rpcView(url), realAccount(id, key, url),
// testnetWallet(acc, "sandbox")). The UI never passes a chain other than testnet.
import { describe, expect, it } from "vitest";
import { encryptRules, hashRules, parseRules, toHex } from "@poolside/rules";
import { sealedBox } from "../src/lib/keys/deps.ts";
import { buy, buyState, openAndVerify, type Wallet } from "../src/lib/keys/flow.ts";
import { loadFollow, type ViewFn } from "../src/lib/keys/chain.ts";
import { testnetWallet, type ChainAccount } from "../src/lib/keys/wallet.ts";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const RULES = parseRules(JSON.stringify({ version: 1, pool: `${USDC}|wrap.near|100`, quote_token: USDC, range: { width_bps: 800, centre: "mid" }, take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }));
const STRAT = "strategy.sandbox";
const PRICE = 10n ** 23n;

class Stub {
  sale: Record<string, unknown> | null = null;
  readonly K = crypto.getRandomValues(new Uint8Array(32));
  readonly ct = encryptRules(RULES, this.K, crypto.getRandomValues(new Uint8Array(24)), STRAT);
  deposits: bigint[] = [];
  view: ViewFn = async (_c, m, args) => {
    if (m === "get_key_params") return { key_price: PRICE.toString(), key_delivery_window_ns: "600000000000", max_key_sales: 2, sold: this.sale ? 1 : 0, deliverer: "deliverer.sandbox", escrow_total: "0", near_owed_total: "0" };
    if (m === "get_key_sale") return args.buyer === "alice.sandbox" ? this.sale : null;
    if (m === "get_config") return { rules_hash: toHex(hashRules(RULES)), rules_ciphertext: btoa(String.fromCharCode(...this.ct)) };
    throw new Error("unexpected view " + m);
  };
  account = (chain: string): ChainAccount => ({
    accountId: "alice.sandbox", chainId: async () => chain,
    callFunction: async (a) => {
      if (a.methodName !== "buy_viewing_key") throw new Error("unexpected call");
      if (a.deposit !== PRICE) throw new Error("LIMIT: key price");
      this.deposits.push(a.deposit);
      this.sale = { buyer: "alice.sandbox", buyer_pubkey: (a.args as { buyer_pubkey: string }).buyer_pubkey, state: "Escrowed", bought_at_ns: "1000", price: PRICE.toString(), sealed_key: null };
    },
  });
  async deliver() { // what the deliverer does: read the pubkey from the VIEW, seal, store
    const pk = Uint8Array.from((this.sale!.buyer_pubkey as string).match(/../g)!, (h) => parseInt(h, 16));
    this.sale = { ...this.sale, state: "Released", sealed_key: toHex(await sealedBox.seal(pk, this.K)) };
  }
}

describe("Evidence (not a contract test): D57-b stubbed end to end (real libsodium)", () => {
  it("load -> buy exact price -> wait -> deliver -> unlock -> hash matches", async () => {
    const st = new Stub();
    let d = await loadFollow(st.view, st.view, STRAT, "alice.sandbox");
    expect(buyState(d.params, d.sale, 0n)).toEqual({ kind: "can_buy", deposit: PRICE });
    const wallet: Wallet = testnetWallet(st.account("sandbox"), "sandbox");
    const kp = await sealedBox.generateKeyPair(); // backed up first (M2)
    await buy({ wallet, strategy: STRAT, params: d.params, kp, sale: d.sale, nowNs: 0n });
    expect(st.deposits).toEqual([PRICE]);
    d = await loadFollow(st.view, st.view, STRAT, "alice.sandbox");
    expect(buyState(d.params, d.sale, 1001n).kind).toBe("waiting");
    await st.deliver();
    d = await loadFollow(st.view, st.view, STRAT, "alice.sandbox");
    expect(buyState(d.params, d.sale, 0n).kind).toBe("delivered");
    const r = await openAndVerify({ box: sealedBox, kp, sale: d.sale!, strategyId: STRAT, rulesHashHex: d.rulesHash, ciphertext: d.ciphertext });
    expect(r).toMatchObject({ kind: "unlocked", hashMatches: true });
  });
  it("the default guard still refuses a sandbox chain, so the UI cannot spend there", async () => {
    const st = new Stub();
    await expect(testnetWallet(st.account("sandbox")).buyViewingKey(STRAT, "ab".repeat(32), PRICE)).rejects.toThrow("only works on testnet");
    expect(st.deposits).toEqual([]);
  });
});
