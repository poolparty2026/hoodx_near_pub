// Reads a recorded SANDBOX scenario (fixtures/scenario/<run>.sandbox-a.json and .sandbox-b.json, RecordedFile format, written by the
// backend's scenario harness) as a RunSource. These are recordings of the contract's views on one sandbox node, read twice: they are
// NOT two independent providers, and the page says so. They are read generically: whatever views were recorded are served; a view that
// was not recorded is a failed read, so its row is "Unverifiable" (never a guess).
// or account snapshots yet (to be re-recorded), so those rows say so.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RulesError } from "@poolside/rules";
import { parseRecordedFileLarge, recordedProvider } from "./provider.ts";
import { MAX_RECORD_BYTES, type DecisionLookup } from "./records-host.ts";
import type { RunSource } from "./run.ts";

export const SCENARIO_CASES = ["good", "bad-tampered-rules", "no-agent-close"] as const;
export type ScenarioCase = (typeof SCENARIO_CASES)[number];
export const SCENARIO_PREFIX = "scenario-";
export const parseScenarioId = (id: string): ScenarioCase | null => {
  const c = id.startsWith(SCENARIO_PREFIX) ? id.slice(SCENARIO_PREFIX.length) : "";
  return (SCENARIO_CASES as readonly string[]).includes(c) ? (c as ScenarioCase) : null;
};

export const SCENARIO_LABEL = "Recorded sandbox run on one node, read twice. Not two independent providers, not a mainnet strategy.";

/** The directory holding the recordings: the repository's fixtures/scenario. */
export function scenarioDir(): string {
  return process.env.SCENARIO_DIR ?? join(process.cwd(), "..", "..", "fixtures", "scenario");
}

/** Bounds on a recording (a local file, but still data): a larger one is refused, not parsed. */
export const MAX_RECORDING_BYTES = 64 * 1024 * 1024;
export const MAX_RECORDING_RESPONSES = 200_000;

/**
 * Throws RulesError when the files are missing or bad: a bad recording is never half-used, and nothing else escapes (a huge or odd
 * file is an "unreadable recording", never a crash of the page).
 */
export function loadScenario(c: ScenarioCase, dir: string = scenarioDir()): RunSource {
  try {
    return loadScenarioUnsafe(c, dir);
  } catch (e) {
    if (e instanceof RulesError) throw e;
    throw new RulesError("STATE", `fixture: ${c} could not be read as a recording`);
  }
}

const cache = new Map<string, RunSource>();

function loadScenarioUnsafe(c: ScenarioCase, dir: string): RunSource {
  // ONE copy per run is read, twice: the two recorded providers hold byte-identical responses (checked when they were made), so the
  // second file is not shipped. A run is parsed once per process and cached by path, size and modification time.
  const path = join(dir, `${c}.sandbox-a.json`);
  let st: ReturnType<typeof statSync>;
  try { st = statSync(path); } catch { throw new RulesError("STATE", `fixture: ${c} could not be read`); }
  if (st.size > MAX_RECORDING_BYTES) throw new RulesError("STATE", `fixture: ${c} is too large`);
  const key = `${path}|${st.size}|${st.mtimeMs}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { throw new RulesError("STATE", `fixture: ${c} could not be read`); }
  const file = parseRecordedFileLarge(text);
  if (file.responses.length > MAX_RECORDING_RESPONSES) throw new RulesError("STATE", `fixture: ${c} has too many responses`);
  const provider = recordedProvider(file);
  // The strategy account is the one that answers get_config; the head is the last block that has its status AND its records.
  let account = "";
  let head = -1;
  const blocks = new Set<number>();
  for (const r of file.responses) {
    if (r.method === "get_config") { if (account === "") account = r.account; if (r.block > head) head = r.block; }
    if (r.method === "view_account") blocks.add(r.block);
  }
  if (account === "") throw new RulesError("STATE", "fixture: no get_config was recorded");
  const recordsDir = join(dir, "records");
  const pins = readPins(dir);
  const src: RunSource = {
    a: provider, b: provider, account, head,
    label: SCENARIO_LABEL,
    decisionText: (hash) => readRecordFile(recordsDir, hash),
    // No records folder means the recording carries no decision texts at all: "recording incomplete", not an agent that published nothing.
    decisionTextsAbsent: !existsSync(recordsDir),
    snapshotBlocks: [...blocks].sort((x, y) => x - y), accountViews: true, windowViews: true,
    recoveryKey: "",
    pinsNote: " These are the sandbox constants from the recording (pins.json), not independently pinned.",
    ...(pins === null ? {} : { pinnedCodeHash: pins.codeHash, pinnedCounterparties: pins.counterparties }),
  };
  cache.set(key, src);
  return src;
}

/** pins.json (the sandbox's own constants, supplied beside the recording): accounts, pool and the strategy's code hash. */
function readPins(dir: string): { codeHash: string; counterparties: { dclContract: string; quoteToken: string; pool: string } } | null {
  try {
    const v = JSON.parse(readFileSync(join(dir, "pins.json"), "utf8")) as Record<string, unknown>;
    const s = (k: string) => (typeof v[k] === "string" && (v[k] as string) !== "" ? (v[k] as string) : null);
    const [dcl, quote, pool, code] = [s("dcl_contract"), s("quote_token"), s("pool"), s("strategy_code_hash")];
    return dcl && quote && pool && code ? { codeHash: code, counterparties: { dclContract: dcl, quoteToken: quote, pool } } : null;
  } catch { return null; }
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The decision texts of a recording, content-addressed: `<dir>/records/<decision_hash>.txt`, exactly the record text. A missing
 * file is "not published" (null); a file that can't be read, or is too large, is a failed read (unverifiable). The text is
 * accepted only if it hashes to the hash asked for, which the page checks, so this file's content is never trusted.
 */
export function readRecordFile(recordsDir: string, hash: string): DecisionLookup {
  if (!HEX64.test(hash)) return null; // never reaches the disk
  const path = join(recordsDir, `${hash}.txt`);
  try {
    if (statSync(path).size > MAX_RECORD_BYTES) return { failed: true };
    return readFileSync(path, "utf8");
  } catch (e) {
    // A recording is a single source: a missing file is "unverifiable" (Not matching needs the two-host rule); a body that hashes wrongly still is Not matching.
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { failed: true, reason: "recording" } : { failed: true };
  }
}
