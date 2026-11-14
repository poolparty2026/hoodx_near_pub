import { mkdirSync, chmodSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { LogEntry } from "./loop.ts";

/**
 * What the entry point logs and checks at start. Kept apart from `main.ts` so tests can run it (THREAT_MODEL T78:
 * the decision record text shows where the hidden bounds lie, so it is never logged while the strategy runs).
 */

/** The log line for an entry: the hash, what was sent and an error, **never the record text or the decision kind**, and no error text that contains it. */
export function redact(e: LogEntry): Record<string, unknown> {
  const error = e.error !== null && e.record !== "" && e.error.includes(e.record) ? "[error text withheld: it contained the record]" : e.error;
  // No decision kind: a `hold` line would say where the hidden bounds are not (T78). The kind is public once sent (`sent.method`).
  return { block: e.block, decisionHash: e.decisionHash, sent: e.sent, error, ...(e.stalled !== undefined ? { stalled: true } : {}) };
}

/** `INTERVAL_S`: a positive whole number of seconds, at most a day. A NaN or 0 would make a busy loop. */
export function parseInterval(raw: string): number {
  if (!/^[1-9][0-9]{0,4}$/.test(raw)) throw new Error("INTERVAL_S must be a whole number of seconds from 1 to 86400");
  const n = Number(raw);
  if (n > 86_400) throw new Error("INTERVAL_S must be a whole number of seconds from 1 to 86400");
  return n;
}

/** Whether `url` is plain http to 127.0.0.1 or localhost (the sandbox): parsed, hostname compared, no userinfo. */
export function isLocalHttp(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.username === "" && u.password === "";
}

/** Whether `url` is https with no userinfo. */
export function isHttps(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === "https:" && u.username === "" && u.password === "";
}

/** The held and published directories must be different and neither inside the other. */
export function checkDirs(held: string, published: string): void {
  const a = resolve(held);
  const b = resolve(published);
  const inside = (x: string, y: string) => { const r = relative(y, x); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
  if (a === b || inside(a, b) || inside(b, a)) throw new Error("HELD_DIR and RECORDS_DIR must be different and neither inside the other");
}

/** Creates the private held store with mode 0700. */
export function makePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
