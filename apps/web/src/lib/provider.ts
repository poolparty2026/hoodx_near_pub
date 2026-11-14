// The page reads the chain through two independent providers and trusts only what both give (EC-W08).
// A provider returns the raw JSON text of a view, so the page can read it with strictParse (EC-R25) and
// never JSON.parse. `recordedProvider` replays a fixture file for the recorded run (backend MINIMAL_PLAN,
// acceptance test); a live provider over RPC implements the same interface later.
// GUESS: the fixture file format below is mine; the backend's scenario harness will record to it, or this
// changes to match what it writes. Mark it unverified until a real recording exists.
import { canonicalize, strictParse, RulesError, type JsonValue } from "@poolside/rules";
import { agree, type Agreed, type Read } from "./providers.ts";

export interface ViewRequest {
  readonly account: string;
  readonly method: string;
  readonly args: JsonValue;
  /** The block the view is read at (archival). A height with no block is the provider's job (EC-W22). */
  readonly block: number;
}

export interface Provider {
  readonly name: string;
  view(req: ViewRequest): Promise<Read<string>>;
}

const keyOf = (r: ViewRequest): string => `${r.account}|${r.method}|${canonicalize(r.args)}|${r.block}`;

export interface RecordedFile {
  readonly provider: string;
  readonly run: string;
  readonly responses: readonly { readonly account: string; readonly method: string; readonly args: JsonValue; readonly block: number; readonly text: string }[];
}

function validateRecorded(v: JsonValue): RecordedFile {
  const bad = (m: string): never => { throw new RulesError("STATE", `fixture: ${m}`); };
  if (v === null || typeof v !== "object" || Array.isArray(v)) bad("must be an object");
  const o0 = v as Record<string, JsonValue>;
  if (typeof o0.provider !== "string" || typeof o0.run !== "string" || !Array.isArray(o0.responses)) bad("needs provider, run and responses");
  const seen = new Set<string>();
  for (const r of o0.responses as JsonValue[]) {
    const o = r as Record<string, JsonValue>;
    if (r === null || typeof r !== "object" || Array.isArray(r) || typeof o.account !== "string" || typeof o.method !== "string" ||
        typeof o.text !== "string" || typeof o.block !== "number" || !Number.isSafeInteger(o.block) || o.block < 0 || o.args === undefined) bad("a response is malformed");
    const k = keyOf({ account: o.account as string, method: o.method as string, args: o.args as JsonValue, block: o.block as number });
    if (seen.has(k)) bad(`duplicate response for ${k}`);
    seen.add(k);
  }
  return v as unknown as RecordedFile;
}

/**
 * Parses a fixture file with strictParse (duplicate keys, -0, fractions and the like are refused) and checks its shape.
 * Throws RulesError on a bad file: a bad fixture is never half-used. strictParse refuses text over MAX_JSON_LENGTH (4,096),
 * so this is for small files; recordings are read with `parseRecordedFileLarge`.
 */
export function parseRecordedFile(text: string): RecordedFile {
  return validateRecorded(strictParse(text));
}

/**
 * For recordings, which are far over MAX_JSON_LENGTH: the envelope is read with JSON.parse (a local file, not chain data) and
 * checked for the same shape and duplicate responses. Nothing inside is trusted by this: every response `text` is the raw view
 * text and is read later with strictParse, one record at a time (EC-R25).
 */
export function parseRecordedFileLarge(text: string): RecordedFile {
  let v: JsonValue;
  try { v = JSON.parse(text) as JsonValue; } catch { throw new RulesError("STATE", "fixture: not JSON"); }
  return validateRecorded(v);
}

/** Replays a recorded file. A request it has no response for is a failed read: "can't check", never a guess. */
export function recordedProvider(file: RecordedFile): Provider {
  const byKey = new Map(file.responses.map((r) => [keyOf(r), r.text] as const));
  return {
    name: file.provider,
    view: async (req) => {
      const text = byKey.get(keyOf(req));
      return text === undefined ? { ok: false } : { ok: true, value: text };
    },
  };
}

/** Two responses are the same answer if they parse to the same canonical JSON, whatever their spacing. */
function sameJson(x: string, y: string): boolean {
  try {
    return canonicalize(strictParse(x)) === canonicalize(strictParse(y));
  } catch {
    return false; // text that can't be read is never "the same"
  }
}

/** Asks both providers. Agreement gives the first provider's text; anything else is not a result (EC-W08). */
export async function readBoth(a: Provider, b: Provider, req: ViewRequest): Promise<Agreed<string>> {
  // One node read twice (a recording served to both slots): one read is the same as two.
  const [ra, rb] = a === b ? await a.view(req).then((r) => [r, r] as const) : await Promise.all([a.view(req), b.view(req)]);
  return agree(ra, rb, sameJson);
}
