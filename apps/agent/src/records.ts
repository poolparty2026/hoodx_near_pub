import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decisionHash } from "@poolside/rules";

/**
 * The agent's records (INTERFACE section 5): one file per decision, `<dir>/<decision_hash>.txt`, exactly the
 * record text, UTF-8, no trailing newline. Two directories use this layout: a **private held store** the agent
 * writes before it sends an action and reads back (the swap's record for a paired open, the close record for the
 * latch), and the **public records directory** it publishes to only once the strategy is Closing or Closed
 * (THREAT_MODEL T78). A file is immutable and always verified: a write is atomic (temp file then rename), the same
 * text again is a no-op, different text under a hash is refused, and a read returns the text only if it hashes to
 * the file's name.
 */
const HEX64 = /^[0-9a-f]{64}$/;

export function writeRecordFile(dir: string, hash: string, text: string, mode = 0o644): void {
  if (!HEX64.test(hash)) throw new Error("a record file is named by a 64 lowercase hex hash");
  if (decisionHash(text) !== hash) throw new Error("the record text does not hash to its name");
  mkdirSync(dir, { recursive: true, mode: mode === 0o600 ? 0o700 : 0o755 });
  const file = join(dir, `${hash}.txt`);
  const existing = readRecordFile(dir, hash);
  if (existing !== null) {
    if (existing !== text) throw new Error("a record file is immutable");
    return;
  }
  const tmp = join(dir, `.${hash}.${process.pid}.tmp`);
  writeFileSync(tmp, text, { encoding: "utf8", flag: "w", mode });
  renameSync(tmp, file);
}

/** The text of `<dir>/<hash>.txt`, or null if there is none **or it does not hash to its name**. */
export function readRecordFile(dir: string, hash: string): string | null {
  if (!HEX64.test(hash)) return null;
  let text: string;
  try { text = readFileSync(join(dir, `${hash}.txt`), "utf8"); } catch { return null; }
  return decisionHash(text) === hash ? text : null;
}

/** The hashes of the verified records in `dir` (a file that doesn't hash to its name is not listed). */
export function listRecordFiles(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => n.endsWith(".txt") && HEX64.test(n.slice(0, -4)) && readRecordFile(dir, n.slice(0, -4)) !== null).map((n) => n.slice(0, -4));
}
