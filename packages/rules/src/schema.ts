import { RulesError } from "./errors.ts";
import type { JsonValue } from "./json.ts";

/** DCL fee tiers confirmed on mainnet (gate 3), mapped to point spacing. */
export const FEE_TIER_POINT_DELTA: Readonly<Record<number, number>> = Object.freeze({
  100: 1, 400: 8, 1000: 20, 2000: 40, 10000: 200,
});

/**
 * Rule format v1. Every number is an integer (EC-R09). v1 has no `rebalance` field
 * (D47): a rules object carrying one is refused as an unknown field, so revealed rules
 * never show a policy v1 can't carry out (EC-R29).
 */
export interface RulesV1 {
  readonly version: 1;
  readonly pool: string;
  readonly quote_token: string;
  readonly range: { readonly width_bps: number; readonly centre: "mid" };
  readonly take_profit_bps: number;
  readonly stop_loss_bps: number;
  readonly close_after_s: number;
  readonly salt: string;
}

/** Bounds the schema enforces. The contract's public limits may be narrower. */
export const BOUNDS = Object.freeze({
  width_bps: [50, 5000],
  take_profit_bps: [1, 10_000],
  stop_loss_bps: [1, 9_999],
  close_after_s: [3_600, 30 * 86_400],
} as const);

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function fail(path: string, msg: string): never {
  throw new RulesError("SCHEMA", `${path}: ${msg}`);
}
function obj(v: JsonValue | undefined, path: string, keys: readonly string[]): { [key: string]: JsonValue } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(path, "must be an object");
  const o = v as { [key: string]: JsonValue };
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${path}.${k}`, "unknown field");
  for (const k of keys) if (!(k in o)) fail(`${path}.${k}`, "missing field");
  return o;
}
function int(v: JsonValue | undefined, path: string, lo: number, hi: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) fail(path, "must be an integer");
  if (v < lo || v > hi) fail(path, `must be between ${lo} and ${hi}`);
  return v;
}
function str(v: JsonValue | undefined, path: string): string {
  if (typeof v !== "string") fail(path, "must be a string");
  return v;
}
function account(v: JsonValue | undefined, path: string): string {
  const s = str(v, path);
  if (s.length < 2 || s.length > 64 || !ACCOUNT_ID.test(s)) fail(path, "must be a NEAR account id");
  return s;
}

/** Splits and checks a DCL pool id: sorted token ids, then a known fee tier. */
export function parsePoolId(pool: string, path = "pool"): { tokenX: string; tokenY: string; fee: number; pointDelta: number } {
  const parts = pool.split("|");
  if (parts.length !== 3) fail(path, "must be token_x|token_y|fee");
  const [x, y, feeText] = parts as [string, string, string];
  account(x, `${path}.token_x`);
  account(y, `${path}.token_y`);
  if (!(x < y)) fail(path, "token ids must be sorted and distinct");
  if (!/^[1-9][0-9]*$/.test(feeText)) fail(path, "fee must be an integer");
  const fee = Number(feeText);
  const pointDelta = FEE_TIER_POINT_DELTA[fee];
  if (pointDelta === undefined) fail(path, "unknown fee tier");
  return { tokenX: x, tokenY: y, fee, pointDelta };
}

/** Decodes standard base64 strictly, refusing anything that doesn't round-trip. */
export function decodeBase64Strict(s: string): Uint8Array {
  if (typeof s !== "string" || s.length > 44) throw new RulesError("SCHEMA", "salt: must be at most 44 base64 characters");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new RulesError("SCHEMA", "salt: must be standard base64");
  const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  if (btoa(String.fromCharCode(...bytes)) !== s) throw new RulesError("SCHEMA", "salt: non-canonical base64");
  return bytes;
}

/** Validates a parsed value as RulesV1. Refuses unknown, missing or out-of-range fields (EC-R03, EC-R04). */
export function isAccountId(s: string): boolean {
  return typeof s === "string" && s.length >= 2 && s.length <= 64 && ACCOUNT_ID.test(s);
}

export function validateRules(v: JsonValue): RulesV1 {
  const o = obj(v, "rules", ["version", "pool", "quote_token", "range", "take_profit_bps", "stop_loss_bps", "close_after_s", "salt"]);
  if (o["version"] !== 1) fail("rules.version", "must be 1");
  const pool = str(o["pool"], "rules.pool");
  const { tokenX, tokenY } = parsePoolId(pool, "rules.pool");
  const quote = account(o["quote_token"], "rules.quote_token");
  if (quote !== tokenX && quote !== tokenY) fail("rules.quote_token", "must be one of the pool's tokens");
  const r = obj(o["range"], "rules.range", ["width_bps", "centre"]);
  const width = int(r["width_bps"], "rules.range.width_bps", ...BOUNDS.width_bps);
  if (r["centre"] !== "mid") fail("rules.range.centre", 'must be "mid"');
  const salt = str(o["salt"], "rules.salt");
  if (decodeBase64Strict(salt).length !== 32) fail("rules.salt", "must encode exactly 32 bytes");
  return Object.freeze({
    version: 1,
    pool,
    quote_token: quote,
    range: Object.freeze({ width_bps: width, centre: "mid" as const }),
    take_profit_bps: int(o["take_profit_bps"], "rules.take_profit_bps", ...BOUNDS.take_profit_bps),
    stop_loss_bps: int(o["stop_loss_bps"], "rules.stop_loss_bps", ...BOUNDS.stop_loss_bps),
    close_after_s: int(o["close_after_s"], "rules.close_after_s", ...BOUNDS.close_after_s),
    salt,
  });
}
