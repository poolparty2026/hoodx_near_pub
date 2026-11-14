// Startup wiring, separate from main.ts so it can be tested: guard, key restriction, rules-key check,
// then polling. Nothing is sent and no poll starts until every check has passed.
import { parseSecretKey } from "@poolside/near";
import { fromHex } from "@poolside/seal";
import { checkKeyRestriction, makeChain } from "./chain.ts";
import { Deliverer, type Outcome } from "./deliverer.ts";
import { assertTestnetRpc } from "./guard.ts";

export interface RunDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  log: (m: string) => void;
  schedule: (fn: () => void, ms: number) => unknown;
}

function need(env: RunDeps["env"], name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

/** Runs all startup checks, then the first pass and the schedule. Returns the Deliverer and the pass function. */
export async function start(d: RunDeps): Promise<{ deliverer: Deliverer; pass: () => Promise<void> }> {
  const rpcUrl = need(d.env, "DELIVERER_RPC");
  assertTestnetRpc(rpcUrl);
  const accountId = need(d.env, "DELIVERER_ACCOUNT");
  const strategy = need(d.env, "STRATEGY");
  const secret = need(d.env, "DELIVERER_KEY");
  const rulesKey = fromHex(need(d.env, "RULES_KEY_HEX"));
  const pollMs = Number(d.env.DELIVERER_POLL_MS ?? 5000);
  if (!Number.isInteger(pollMs) || pollMs < 1000) throw new Error("DELIVERER: DELIVERER_POLL_MS must be an integer of at least 1000");
  const rpc = { rpcUrl, fetch: d.fetch };
  const restriction = await checkKeyRestriction(rpc, accountId, parseSecretKey(secret).publicKey, strategy);
  if (!restriction.ok) throw new Error(`DELIVERER: refusing to start, ${restriction.reason}`);
  const deliverer = new Deliverer({ chain: makeChain(rpc, strategy, accountId, secret), accountId, strategyId: strategy, rulesKey, log: d.log });
  await deliverer.verifyKey(); // refuse to start when the key doesn't open the on-chain rules (EC-K03)
  let running = false; // N2: passes never overlap
  async function pass(): Promise<void> {
    if (running) return;
    running = true;
    try {
      for (const o of (await deliverer.tick()) as Outcome[]) if (o.result !== "skipped") d.log(JSON.stringify(o));
    } catch (e) {
      d.log((e as Error).message);
    } finally {
      running = false;
    }
  }
  void pass();
  d.schedule(() => void pass(), pollMs);
  return { deliverer, pass };
}
