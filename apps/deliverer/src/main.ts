// Run: DELIVERER_RPC, STRATEGY, DELIVERER_ACCOUNT, DELIVERER_KEY (ed25519 function-call key, deliver_key
// only, testnet), RULES_KEY_HEX (32 bytes) in the environment. Testnet and sandbox only (D57).
import { start } from "./run.ts";

await start({
  env: process.env,
  fetch,
  log: (m) => console.log(new Date().toISOString(), m),
  schedule: (fn, ms) => setInterval(fn, ms),
});
