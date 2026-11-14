import { appendFileSync, readFileSync } from "node:fs";
import { parseSecretKey } from "@poolside/near";
import { parseRules } from "@poolside/rules";
import { createChain } from "./chain.ts";
import { localDeps } from "./localdeps.ts";
import { run, type LogEntry } from "./loop.ts";
import { realDeps } from "./real.ts";
import { listRecordFiles, readRecordFile, writeRecordFile } from "./records.ts";
import { checkDirs, isHttps, isLocalHttp, makePrivateDir, parseInterval, redact } from "./safety.ts";

/**
 * The agent's entry point: one long-running process that observes, decides with the shared rules, sends, and
 * publishes its records after the strategy leaves `Running` (INTERFACE section 5, THREAT_MODEL T78).
 * Everything comes from the environment; no key is in the repository. It stops by itself once it has
 * published everything held, and logs one JSON line per round (to stdout, and to LOG_FILE if set): the decision's kind, its
 * hash, what was sent and an error, **never the record text** (that shows where the hidden bounds lie) and never a key.
 *
 *   RPC_URL         JSON-RPC endpoint (https; http only for a local sandbox on 127.0.0.1)
 *   STRATEGY        the strategy account
 *   DCL             the Rhea DCL contract account (the strategy's `dcl_contract`)
 *   AGENT_ACCOUNT   the agent's account; AGENT_SECRET its function-call key, `ed25519:...`
 *   RULES_FILE      the rules JSON (the creator's; the agent holds them, the chain holds only their hash, which must match)
 *   HELD_DIR        private directory (mode 0700) where records are held while the strategy runs
 *   RECORDS_DIR     public directory records are published to once the strategy is Closing or Closed
 *   INTERVAL_S      whole seconds between rounds (default 60)
 */
const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`${k} is required`);
  return v;
};

const rpcUrl = env("RPC_URL");
const local = isLocalHttp(rpcUrl);
if (!local && !isHttps(rpcUrl)) throw new Error("RPC_URL must be https (or http to 127.0.0.1 or localhost for a sandbox)");
const rules = parseRules(readFileSync(env("RULES_FILE"), "utf8"));
const { seed, publicKey } = parseSecretKey(env("AGENT_SECRET"));
const common = { rules, strategy: env("STRATEGY"), dcl: env("DCL"), agent: env("AGENT_ACCOUNT"), seed };
const heldDir = env("HELD_DIR");
const recordsDir = env("RECORDS_DIR");
checkDirs(heldDir, recordsDir);
makePrivateDir(heldDir);
const intervalMs = parseInterval(env("INTERVAL_S", "60")) * 1000;
const deps = local
  ? localDeps({ ...common, rpcUrl, publicKey, heldDir })
  : realDeps({ ...common, rpc: { rpcUrl, fetch }, recordsDir: heldDir });
const chain = createChain(deps);
const logFile = process.env["LOG_FILE"];
let terminate = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { terminate = true; });
console.log(JSON.stringify({ started: true, strategy: common.strategy, dcl: common.dcl, agent: common.agent, rpc: new URL(rpcUrl).origin, network: local ? "local sandbox" : "remote" }));

await run(rules, chain, {
  log: (e: LogEntry) => {
    const line = JSON.stringify(redact(e), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    console.log(line);
    if (logFile) appendFileSync(logFile, line + "\n", { mode: 0o600 });
  },
  sleep: () => new Promise((r) => setTimeout(r, intervalMs)),
  stop: () => terminate,
  hold: (h, t) => writeRecordFile(heldDir, h, t, 0o600),
  listHeld: () => listRecordFiles(heldDir),
  readHeld: (h) => readRecordFile(heldDir, h),
  publish: (h, t) => writeRecordFile(recordsDir, h, t),
});
