// E2E for the viewing-key flow against a `Running` strategy (testnet or a sandbox RPC), D57.
// buy -> deliver (the real Deliverer class, using the deliver_key-only key) -> open -> hash match,
// or with --refund: buy, let the window pass without a deliverer, refund_key.
//   node scripts/testnet/e2e.ts [--refund [--no-wait]]
// Sandbox: the Rust harness (backend `running()`) writes .testnet/run.json with rpc = http://127.0.0.1:<port>,
// the account ids, the deliverer function-call key (deliver_key only), the buyer key, rulesKeyHex, rulesHashHex;
// then runs this script (for --refund it fast_forwards past the window first and passes --no-wait).
// Reads .testnet/run.json (written by setup.ts). Prints no keys.
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";
import { generateKeypair, open, toHex } from "@poolside/seal";
import { decryptRules, hashRules } from "@poolside/rules";
import { resolveGasSlack } from "./slack.ts";
import { Deliverer, type Chain } from "../../apps/deliverer/src/deliverer.ts";
import { assertTestnetRpc } from "../../apps/deliverer/src/guard.ts";

const run = JSON.parse(readFileSync(".testnet/run.json", "utf8")) as {
  rpc: string; names: Record<string, string>; rulesKeyHex: string; rulesHashHex: string; gasSlackYocto?: string | number; keys: Record<string, string>; gasSlack?: string;
};
assertTestnetRpc(run.rpc);
const refund = process.argv.includes("--refund");
const provider = new JsonRpcProvider({ url: run.rpc });
const S = run.names.strategy!;
const view = (method: string, args: Record<string, unknown> = {}) => provider.callFunction({ contractId: S, method, args }) as Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const assert = (c: unknown, m: string) => { if (!c) throw new Error(`E2E FAILED: ${m}`); };

assert((await view("get_status")) === "Running", "strategy must be Running before a key can be bought (fund + start first)");
const params = await view("get_key_params");
assert(params.deliverer === run.names.deliverer, "contract deliverer is the setup deliverer");

const buyer = new Account(run.names.buyer!, provider, run.keys.buyer as KeyPairString);
const kp = await generateKeypair();
await buyer.callFunction({ contractId: S, methodName: "buy_viewing_key", args: { buyer_pubkey: toHex(kp.pk) }, deposit: BigInt(params.key_price), gas: teraToGas("30") });
let sale = await view("get_key_sale", { buyer: run.names.buyer });
assert(sale?.state === "Escrowed" && sale.buyer_pubkey === toHex(kp.pk), "sale is Escrowed with our key");
const price = BigInt(params.key_price);
const gasSlack = resolveGasSlack(run, price); // refund_key's own gas; bounded below price/4 up front, before any buy or wait
const escrow0 = BigInt((await view("get_key_params")).escrow_total);
assert(escrow0 >= price, "escrow holds at least the price after the buy");
const creatorBefore = BigInt((await provider.viewAccount({ accountId: run.names.creator! })).amount);
const refuses = async (who: Account, method: string, args: Record<string, unknown>, re: RegExp, what: string) => {
  try { await who.callFunction({ contractId: S, methodName: method, args, gas: teraToGas("30"), deposit: 0n }); }
  catch (e) { assert(re.test((e as Error).message), `${what}: expected ${re}`); return; }
  assert(false, `${what}: must be refused`);
};
const fakeSealed = "ab".repeat(80);
await refuses(buyer, "refund_key", {}, /delivery window open/, "refund before the window");
await refuses(buyer, "deliver_key", { buyer: run.names.buyer, sealed_key: fakeSealed }, /deliverer only/, "deliver_key by a non-deliverer");
console.log("bought; escrow_total", escrow0.toString());

if (!refund) {
  const deliverer = new Account(run.names.deliverer!, provider, run.keys.delivererFc as KeyPairString);
  const chain: Chain = {
    now: async () => BigInt((await provider.viewBlock({ finality: "final" })).header.timestamp_nanosec),
    view: (m, a) => provider.callFunction({ contractId: S, method: m, args: a as Record<string, unknown> }) as Promise<unknown>,
    async deliverKey(b, sealed) {
      try {
        await deliverer.callFunction({ contractId: S, methodName: "deliver_key", args: { buyer: b, sealed_key: sealed }, gas: teraToGas("50"), deposit: 0n });
        return { ok: true, failure: null };
      } catch (e) { return { ok: false, failure: (e as Error).message.slice(0, 300) }; }
    },
  };
  const d = new Deliverer({ chain, accountId: run.names.deliverer!, strategyId: S, rulesKey: Buffer.from(run.rulesKeyHex, "hex"), log: console.log });
  console.log(await d.tick());
  sale = await view("get_key_sale", { buyer: run.names.buyer });
  assert(sale.state === "Released" && /^[0-9a-f]{160}$/.test(sale.sealed_key), "sale Released with a sealed key");
  const K = await open(kp.pk, kp.sk, Buffer.from(sale.sealed_key, "hex"));
  const cfg = await view("get_config");
  const rules = decryptRules(Buffer.from(cfg.rules_ciphertext, "base64"), K, S, Buffer.from(run.rulesHashHex, "hex"));
  assert(toHex(hashRules(rules)) === run.rulesHashHex, "decrypted rules hash to the on-chain commitment");
  const p2 = await view("get_key_params");
  assert(BigInt(p2.escrow_total) === escrow0 - price, "escrow fell by exactly the price");
  const creatorAfter = BigInt((await provider.viewAccount({ accountId: run.names.creator! })).amount);
  assert(creatorAfter - creatorBefore === price, "creator received exactly the price, once");
  assert(BigInt(p2.near_owed_total) === 0n, "nothing held in near_owed");
  try { await deliverer.callFunction({ contractId: S, methodName: "deliver_key", args: { buyer: run.names.buyer, sealed_key: sale.sealed_key }, gas: teraToGas("50"), deposit: 0n }); assert(false, "a second delivery must be refused"); }
  catch (e) { assert(/not escrowed/.test((e as Error).message), "second delivery refused with LIMIT: not escrowed"); }
  console.log("OK: delivered, opened, hash matches");
} else {
  const wait = Number(params.key_delivery_window_ns) / 1e6 + 5000;
  if (process.argv.includes("--no-wait")) {
    // Sandbox: the harness fast_forwards past the window while we poll the chain's own clock.
    console.log("--no-wait: polling block time until the harness has advanced past the window");
    const deadline = BigInt(sale.bought_at_ns) + BigInt(params.key_delivery_window_ns);
    for (;;) {
      const b = await provider.viewBlock({ finality: "final" });
      if (BigInt(b.header.timestamp_nanosec) >= deadline) break;
      await sleep(1000);
    }
  }
  else {
    console.log(`waiting ${Math.round(wait / 1000)} s for the window to pass`);
    await sleep(wait);
  }
  const dl = new Account(run.names.deliverer!, provider, run.keys.delivererFc as KeyPairString);
  await refuses(dl, "deliver_key", { buyer: run.names.buyer, sealed_key: fakeSealed }, /delivery window closed/, "deliver after the window");
  const before = BigInt((await provider.viewAccount({ accountId: run.names.buyer! })).amount);
  await buyer.callFunction({ contractId: S, methodName: "refund_key", args: {}, gas: teraToGas("30"), deposit: 0n });
  sale = await view("get_key_sale", { buyer: run.names.buyer });
  assert(sale.state === "Refunded", "sale Refunded");
  const after = BigInt((await provider.viewAccount({ accountId: run.names.buyer! })).amount);
  assert(after > before + price - gasSlack && after <= before + price, "buyer got exactly the price back, less at most the call's gas");
  assert(BigInt((await view("get_key_params")).escrow_total) === escrow0 - price, "escrow fell by exactly the price");
  try { await buyer.callFunction({ contractId: S, methodName: "refund_key", args: {}, gas: teraToGas("30"), deposit: 0n }); assert(false, "a second refund must be refused"); }
  catch (e) { assert(/not escrowed/.test((e as Error).message), "second refund refused with LIMIT: not escrowed"); }
  console.log("OK: refunded");
}
