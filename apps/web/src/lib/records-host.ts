// Reads the agent's published decision records from untrusted static hosts (lead decision of 12 November, final layout):
//   GET <base>/<decision_hash>.txt   body = the exact decisionRecordText (text/plain; charset=utf-8, no trailing newline)
// Content-addressed: no strategy folder, no index. The hashes come from the contract's records (get_action).
// The hosts are untrusted. A body is accepted only if SHA-256(body) equals the on-chain decision_hash.
// Per host: 404 = never published; a network error, timeout, 5xx or oversized body = failed (can't tell); a body whose
// hash differs = wrong body. Across hosts (any number): a verifying body wins; else any wrong body stands, so a wrong
// body can't dodge a 404 (the page then reports the hash mismatch, not matching), unless two wrong bodies disagree
// (unverifiable); else any failure makes it unverifiable; else every host said 404 and it is not published.
import { decisionHash } from "@poolside/rules";

/** A text, nothing published (404 on every host, or no host), or a read that failed and says nothing about publication. */
export type DecisionLookup = string | null | { readonly failed: true; readonly reason?: "hosts" | "fetch" | "recording" };

export const MAX_RECORD_BYTES = 16_384;
const HEX64 = /^[0-9a-f]{64}$/;
const FAILED = { failed: true, reason: "fetch" } as const;
const FAILED_HOSTS = { failed: true, reason: "hosts" } as const;

type Resp = { ok: boolean; status: number; text(): Promise<string>; body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null };
type FetchLike = (url: string, init?: { signal?: AbortSignal; redirect?: "error"; credentials?: "omit"; cache?: "no-store" }) => Promise<Resp>;

/** `base` must be an absolute http(s) URL without credentials; anything else is no host. */
export function recordUrl(base: string, hash: string): string | null {
  if (!HEX64.test(hash)) return null;
  let u: URL;
  try { u = new URL(base); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username !== "" || u.password !== "") return null; // no credentials in a URL
  return `${u.href.endsWith("/") ? u.href : `${u.href}/`}${hash}.txt`;
}

function validBase(s: string): boolean {
  try { const u = new URL(s); return (u.protocol === "https:" || u.protocol === "http:") && u.username === "" && u.password === ""; } catch { return false; }
}

/**
 * The hosts, from the RECORDS_BASE_URLS environment variable (comma-separated absolute http(s) URLs without credentials).
 * Unset or empty is no host: every record reads as not published. There is no default and no placeholder host (the final hostname
 * is a co-lead decision). `misconfigured` is true when something was set but none of it is usable: then a read is a failed read
 * (unverifiable), never "not published", so a typo can't read as an agent that published nothing.
 */
export function recordsConfig(env: Record<string, string | undefined> = process.env): { bases: string[]; misconfigured: boolean } {
  const entries = (env.RECORDS_BASE_URLS ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  const bases = entries.filter(validBase);
  return { bases, misconfigured: entries.length > 0 && bases.length === 0 };
}
export function recordsBases(env: Record<string, string | undefined> = process.env): string[] {
  return recordsConfig(env).bases;
}

/** The origins to allow in connect-src for browser reads of those hosts. */
export function recordsOrigins(env: Record<string, string | undefined> = process.env): string[] {
  return [...new Set(recordsBases(env).map((b) => new URL(b).origin))];
}

type One = { kind: "text"; text: string } | { kind: "missing" } | { kind: "failed" };

/** Reads the body with a byte cap that counts UTF-8 bytes and stops at the cap (never reads a whole oversized body). */
async function readCapped(r: Resp): Promise<string | null> {
  if (r.body) {
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value?.byteLength ?? 0;
      if (n > MAX_RECORD_BYTES) { await reader.cancel().catch(() => undefined); return null; }
      if (value) chunks.push(value);
    }
    const all = new Uint8Array(n);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(all);
  }
  const text = await r.text();
  return new TextEncoder().encode(text).byteLength > MAX_RECORD_BYTES ? null : text;
}

async function getOne(url: string, fetchFn: FetchLike, timeoutMs: number): Promise<One> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, { signal: ctl.signal, redirect: "error", credentials: "omit", cache: "no-store" });
    if (r.status === 404) return { kind: "missing" };
    if (!r.ok) return { kind: "failed" };
    const text = await readCapped(r);
    return text === null ? { kind: "failed" } : { kind: "text", text };
  } catch {
    return { kind: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

export interface HostOptions { readonly timeoutMs?: number; readonly misconfigured?: boolean; readonly budgetMs?: number; readonly now?: () => number }

/**
 * A lookup for RunSource.decisionText. A hash that is not 64 lowercase hex never reaches a host. Redirects are errors, requests
 * carry no credentials, and one run has a total time budget (default 30 s, started at the FIRST read, not at creation) so up to 64
 * records can't hold the page for minutes: after it, every read is a failed read.
 *
 * ONE HOST CANNOT CONVICT (lead decision of 13 November): a record counts as "not published" (not matching, EC-W05) only when at
 * least two configured hosts agree on it (all 404, or the same wrong body). With no host, one host, or hosts that disagree, a
 * record that did not verify is a failed read (unverifiable). A body that hashes to the recorded decision_hash is accepted from any
 * single host: a verifying body is proof by itself.
 */
export function hostLookup(bases: readonly string[], fetchFn: FetchLike, opts: HostOptions = {}): (hash: string) => Promise<DecisionLookup> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const now = opts.now ?? Date.now;
  let deadline: number | undefined;
  return async (hash) => {
    if (!HEX64.test(hash)) return null;
    if (opts.misconfigured === true) return FAILED_HOSTS;
    const urls = [...new Set(bases.map((b) => recordUrl(b, hash)).filter((u): u is string => u !== null))];
    if (urls.length === 0) return FAILED_HOSTS;
    deadline ??= now() + (opts.budgetMs ?? 30_000);
    if (now() > deadline) return FAILED;
    const got = await Promise.all(urls.map((u) => getOne(u, fetchFn, timeoutMs)));
    const texts = got.flatMap((g) => (g.kind === "text" ? [g.text] : []));
    const verified = texts.find((t) => decisionHash(t) === hash);
    if (verified !== undefined) return verified;
    if (urls.length < 2) return FAILED_HOSTS; // one host can't show a record was never published or that a body is the one served to everybody
    // Two or more hosts: they must agree to convict.
    if (texts.length === urls.length && new Set(texts).size === 1) return texts[0]!; // the same wrong body from every host: the page reports the hash mismatch
    if (got.every((g) => g.kind === "missing")) return null; // every host says it was never published
    return FAILED;
  };
}
