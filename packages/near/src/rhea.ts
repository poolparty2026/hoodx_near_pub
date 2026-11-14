import { FEE_TIER_POINT_DELTA, isAccountId, parsePoolId, readU128, RulesError, strictParse } from "@poolside/rules";
import { NearError } from "./errors.ts";
import { viewCall, type BlockRef, type RpcClient } from "./rpc.ts";

/** Rhea DCL on mainnet (gate 3, rhea-dcl skill). */
export const DCL_MAINNET = "dclv2.ref-labs.near";
const MAX_POINT = 800_000;

/** The fields of `get_pool` Poolside uses. Shapes confirmed on mainnet, block 223429540 (gate 3). */
export interface Pool {
  poolId: string; tokenX: string; tokenY: string;
  fee: number; pointDelta: number; currentPoint: number;
  /** Only "Running" is confirmed on mainnet (gate 3). "Paused" and "Locked" are a guess at the
   * other DCL states, not yet checked against the source; callers act only on "Running". */
  state: "Running" | "Paused" | "Locked";
  liquidity: bigint; liquidityX: bigint; totalX: bigint; totalY: bigint;
}

/** `predict_add_liquidity`: what an add of the given amounts would take, and the liquidity it gives. */
export interface Predict { needX: bigint; needY: bigint; liquidity: bigint }

function object(text: string): Record<string, unknown> {
  let v: unknown;
  // The bytes pass through an RPC we don't trust (T15), so they are read as strictly as an action:
  // duplicate keys, fractions, exponents and -0 are refused, and so is anything over 4096 characters
  // (get_pool is about 850). Such a response is unreadable, never a clean observation (EC-V04).
  try { v = strictParse(text); } catch (e) {
    throw new NearError("RHEA", `response is unreadable (${(e as RulesError).code})`);
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new NearError("RHEA", "response must be an object");
  return v as Record<string, unknown>;
}
function u128(o: Record<string, unknown>, k: string): bigint {
  try { return readU128(o[k] as string); } catch { throw new NearError("RHEA", `${k} must be a decimal u128 string`); }
}
function point(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || Math.abs(v) > MAX_POINT) throw new NearError("RHEA", `${k} must be an integer within ±800000`);
  return v;
}
function account(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || !isAccountId(v)) throw new NearError("RHEA", `${k} must be a NEAR account id`);
  return v;
}

/** The tiers Poolside accepts; higher tiers that Rhea also lists are refused on purpose. */
const FEE_TIERS = Object.keys(FEE_TIER_POINT_DELTA).join(", ");

export function parsePool(text: string): Pool {
  const o = object(text);
  const fee = o["fee"];
  const delta = (FEE_TIER_POINT_DELTA as Record<number, number>)[fee as number];
  if (typeof fee !== "number" || delta === undefined) throw new NearError("RHEA", `fee must be one of ${FEE_TIERS}`);
  if (o["point_delta"] !== delta) throw new NearError("RHEA", `point_delta doesn't match fee ${fee}`);
  const tokenX = account(o, "token_x"), tokenY = account(o, "token_y");
  if (o["pool_id"] !== `${tokenX}|${tokenY}|${fee}`) throw new NearError("RHEA", "pool_id doesn't match token_x, token_y and fee");
  const state = o["state"];
  if (state !== "Running" && state !== "Paused" && state !== "Locked") throw new NearError("RHEA", "state must be Running, Paused or Locked");
  return {
    poolId: o["pool_id"] as string, tokenX, tokenY, fee, pointDelta: delta, currentPoint: point(o, "current_point"), state,
    liquidity: u128(o, "liquidity"), liquidityX: u128(o, "liquidity_x"), totalX: u128(o, "total_x"), totalY: u128(o, "total_y"),
  };
}

export function parsePredict(text: string): Predict {
  const o = object(text);
  return { needX: u128(o, "need_x"), needY: u128(o, "need_y"), liquidity: u128(o, "liquidity_amount") };
}

function requestPoolId(poolId: string): void {
  try { parsePoolId(poolId); } catch { throw new NearError("RHEA", "poolId must be token_x|token_y|fee with a known tier"); }
}

export async function getPool(c: RpcClient, poolId: string, at?: BlockRef): Promise<{ blockHeight: number; blockHash: string; pool: Pool }> {
  requestPoolId(poolId);
  const r = await viewCall(c, DCL_MAINNET, "get_pool", { pool_id: poolId }, at);
  const pool = parsePool(r.text);
  // A faulty or hostile RPC could answer with another valid pool (EC-V05).
  if (pool.poolId !== poolId) throw new NearError("RHEA", "pool_id doesn't match the request");
  return { blockHeight: r.blockHeight, blockHash: r.blockHash, pool };
}

export async function predictAddLiquidity(
  c: RpcClient, poolId: string, left: number, right: number, amountX: bigint, amountY: bigint, at?: BlockRef,
): Promise<{ blockHeight: number; blockHash: string; predict: Predict }> {
  requestPoolId(poolId);
  const ok = (p: number) => Number.isSafeInteger(p) && Math.abs(p) <= MAX_POINT;
  if (!ok(left) || !ok(right) || left >= right) throw new NearError("RHEA", "need left_point < right_point, both integers within ±800000");
  const U128_MAX = (1n << 128n) - 1n;
  if (amountX < 0n || amountY < 0n || amountX > U128_MAX || amountY > U128_MAX) throw new NearError("RHEA", "amounts must be u128");
  const r = await viewCall(c, DCL_MAINNET, "predict_add_liquidity", {
    pool_id: poolId, left_point: left, right_point: right, amount_x: amountX.toString(), amount_y: amountY.toString(),
  }, at);
  return { blockHeight: r.blockHeight, blockHash: r.blockHash, predict: parsePredict(r.text) };
}
