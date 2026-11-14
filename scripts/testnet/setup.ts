// Testnet setup for the viewing-key flow (D57). TESTNET ONLY, throwaway keys, no real funds.
// Creates accounts through the public testnet helper (10 NEAR each), deploys the strategy wasm,
// calls `new`, and gives the deliverer a function-call key limited to `deliver_key`.
// Keys are written to .testnet/ (gitignored, mode 0600) and never printed.
//
//   cargo: RUSTFLAGS='--cfg near' cargo build -p strategy --target wasm32-unknown-unknown --release
//   node scripts/testnet/setup.ts <wasm path>
//
// MARKED GUESSES: config values below copy the sandbox defaults (tests/common/mod.rs `args`) with the
// gate-6 testnet tokens; `new` may refuse some bound until run. Reaching `Running` (fund USDC, create
// the pool, `start`) is NOT done here: buy_viewing_key needs `Running`.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { encryptRules, hashRules, toHex } from "@poolside/rules";
import { assertTestnetRpc } from "../../apps/deliverer/src/guard.ts";
import { rules } from "../../packages/rules/test/fixtures.ts";

const RPC = process.env.TESTNET_RPC ?? "https://rpc.testnet.near.org";
assertTestnetRpc(RPC); // exact-host allowlist (D57)
const DIR = ".testnet";
const wasmPath = process.argv[2];
if (!wasmPath) throw new Error("usage: node scripts/testnet/setup.ts <strategy.wasm>");

async function helperCreate(id: string, kp: KeyPair): Promise<void> {
  const r = await fetch("https://helper.nearprotocol.com/account", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!r.ok) throw new Error(`helper refused ${id}: HTTP ${r.status}`);
}

const run = randomUUID().slice(0, 6);
const names = { strategy: `ps-s-${run}.testnet`, creator: `ps-c-${run}.testnet`, agent: `ps-a-${run}.testnet`,
  deliverer: `ps-d-${run}.testnet`, platform: `ps-p-${run}.testnet`, buyer: `ps-b-${run}.testnet` };
const keys = Object.fromEntries(Object.keys(names).map((k) => [k, KeyPair.fromRandom("ed25519")]));
mkdirSync(DIR, { recursive: true, mode: 0o700 });
for (const [role, id] of Object.entries(names)) await helperCreate(id, keys[role]!);

const provider = new JsonRpcProvider({ url: RPC });
const acct = (role: keyof typeof names) => new Account(names[role], provider, keys[role]!.toString() as KeyPairString);

// Deliverer: a separate function-call key, only `deliver_key` on the strategy.
const dFc = KeyPair.fromRandom("ed25519");
await acct("deliverer").addFunctionCallAccessKey({
  publicKey: dFc.getPublicKey().toString(), contractId: names.strategy, methodNames: ["deliver_key"], allowance: nearToYocto("1"),
});

// Rules + key K. K never leaves .testnet/.
const K = randomBytes(32);
const r = rules();
const hash = hashRules(r);
const blob = encryptRules(r, K, randomBytes(24), names.strategy);

const NS = 1_000_000_000n;
const now = BigInt(Date.now()) * 1_000_000n;
const DAY = 86_400n * NS;
const config = {
  creator: names.creator, agent: names.agent, deliverer: names.deliverer, platform_account: names.platform,
  quote_token: "usdc.fakes.testnet", dcl_contract: "dclv2.ref-dev.testnet", rules_hash: toHex(hash),
  rules_ciphertext: Buffer.from(blob).toString("base64"), platform_bps: 500, key_price: nearToYocto("0.1").toString(), max_key_sales: 20,
  key_delivery_window_ns: String(Number(process.env.WINDOW_S ?? 600) * 1e9), // contract minimum is 10 minutes
  start_deadline_ns: String(now + DAY), run_end_ns: String(now + 6n * DAY), exit_grace_ns: String(DAY),
  platform_claim_window_ns: String(2n * DAY), stale_after_blocks: "500", stale_cooldown_blocks: "600",
  dcl_storage: nearToYocto("2").toString(), attested: false,
};
const limits = {
  max_principal: "500000000", pool: "usdc.fakes.testnet|wrap.testnet|100", max_slippage_bps: 50, max_swap_slippage_bps: 60,
  max_swap_step_bps: 6000, max_observation_drift_bps: 30, max_observation_age_blocks: "20", min_range_width_bps: 1000,
  max_range_width_bps: 2000, min_action_interval_s: "600", max_actions_per_24h: 6,
  dust_threshold: [["usdc.fakes.testnet", "1000"], ["wrap.testnet", "1000000000000000000"]],
};

const s = acct("strategy");
await s.deployContract(readFileSync(wasmPath));
await s.callFunction({ contractId: names.strategy, methodName: "new", args: { config, limits }, gas: teraToGas("200"), deposit: 0n });

writeFileSync(`${DIR}/run.json`, JSON.stringify({
  rpc: RPC, names, rulesKeyHex: K.toString("hex"), rulesHashHex: toHex(hash),
  keys: { ...Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.toString()])), delivererFc: dFc.toString() },
}, null, 2), { mode: 0o600 });
chmodSync(`${DIR}/run.json`, 0o600);
console.log("setup done:", names, "(keys in .testnet/run.json, not printed)");
