// Rebuilds the MarketState the rules judge on from public views read at one block, through both providers (EC-W08). It mirrors
// the agent's own sampling (apps/agent/src/chain.ts `sample`): the same views, the same holdings formula from @poolside/rules.
// Nothing is taken from the agent's record: the page compares the agent's claimed state with THIS state, never the other way.
//
// GUESS (to confirm with the backend's re-recording): the block timestamp is read through a recorded view
//   account "near", method "block", args {"block_id": N}, text {"header":{"height":N,"timestamp":"<ns as a string>"}}
// which is the RPC `block` result the agent already uses (apps/agent/src/real.ts), with the timestamp written as a string because
// nanosecond timestamps exceed 2^53. The recordings do not carry it yet.
import {
  feesEarned, marketHoldings, nsToS, positionPieces, readU128, readU64, strictParse, RulesError,
  type CloseReason, type JsonValue, type MarketState,
} from "@poolside/rules";
import { readBoth } from "./provider.ts";
import type { RunSource } from "./run.ts";

type Obj = { [k: string]: JsonValue };
const isObj = (v: JsonValue | undefined): v is Obj => v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);

/** One view through both providers at a block. `undefined` is a failed read or a disagreement: never a guess. */
export async function readAt(src: RunSource, account: string, method: string, args: JsonValue, block: number): Promise<JsonValue | undefined> {
  const r = await readBoth(src.a, src.b, { account, method, args, block });
  if (r.kind !== "agreed") return undefined;
  try { return strictParse(r.value); } catch { return undefined; }
}

function bad(m: string): never { throw new RulesError("STATE", `state: ${m}`); }
const u128 = (v: JsonValue | undefined, w: string): bigint => { try { return readU128(v as string); } catch { return bad(`${w} must be a u128 string`); } };
function need<T>(v: T | undefined, w: string): T { return v === undefined ? bad(`${w} could not be read from both providers`) : v; }

/** The block's timestamp in nanoseconds, from the recorded block header (see the GUESS above). */
export async function blockTimeNs(src: RunSource, block: number): Promise<bigint> {
  const h = need(await readAt(src, "near", "block", { block_id: block }, block), `block ${block} header`);
  const hd = isObj(h) && isObj(h.header) ? h.header : bad("a block header is {header:{height,timestamp}}");
  if (hd.height !== block || typeof hd.timestamp !== "string") bad("the block header is not for this block or has no string timestamp");
  try { return readU64(hd.timestamp); } catch { return bad("the block timestamp must be a u64 string"); }
}

export interface StateContext {
  /** The rules' pool id and quote token: the strategy's limits and config must be the same. */
  readonly pool: string;
  readonly quoteToken: string;
  readonly closedBy: CloseReason | null;
  readonly confirmFromBlock: number | null;
}

/** Throws RulesError("STATE") when a view can't be read or is not what it must be: the caller shows "can't check". */
export async function stateAtBlock(src: RunSource, ctx: StateContext, block: number): Promise<MarketState> {
  const sv = (m: string, a: JsonValue = {}) => readAt(src, src.account, m, a, block);
  const config = need(await readAt(src, src.account, "get_config", {}, src.head), "get_config");
  const limits = need(await readAt(src, src.account, "get_limits", {}, src.head), "get_limits");
  if (!isObj(config) || !isObj(limits) || typeof config.quote_token !== "string" || typeof config.dcl_contract !== "string" || typeof limits.pool !== "string") bad("config and limits are required");
  const quote = config.quote_token as string, dcl = config.dcl_contract as string, poolId = limits.pool as string;
  if (poolId !== ctx.pool || quote !== ctx.quoteToken) bad("the strategy's pool or quote token is not the rules'");
  const parts = poolId.split("|");
  if (parts.length !== 3) bad("pool id");
  const [tokenX, tokenY] = [parts[0]!, parts[1]!];
  const quoteIsX = tokenX === quote;
  if (!quoteIsX && tokenY !== quote) bad("the quote token is not in the pool");
  const baseToken = quoteIsX ? tokenY : tokenX;
  if (baseToken === quote) bad("the pool's two tokens must differ");

  const ts = await blockTimeNs(src, block);
  const startedV = need(await sv("get_started_at"), "get_started_at");
  if (typeof startedV !== "string") bad("the strategy has not started");
  const principal = u128(need(await sv("get_principal"), "get_principal"), "principal");
  const own = need(await sv("get_own_position"), "get_own_position");
  const fc = need(await sv("get_fees_collected"), "get_fees_collected");
  if (!isObj(fc)) bad("fees_collected must be an object");

  const pool = need(await readAt(src, dcl, "get_pool", { pool_id: poolId }, block), "get_pool");
  if (!isObj(pool) || pool.pool_id !== poolId || pool.token_x !== tokenX || pool.token_y !== tokenY || typeof pool.current_point !== "number" || !Number.isSafeInteger(pool.current_point)) bad("the pool is not the strategy's");
  const point = pool.current_point;

  const wallet = async (t: string) => u128(need(await readAt(src, t, "ft_balance_of", { account_id: src.account }, block), `ft_balance_of ${t}`), "balance");
  const assets = need(await readAt(src, dcl, "list_user_assets", { account_id: src.account }, block), "list_user_assets");
  if (!isObj(assets)) bad("assets must be an object");
  const internal = (t: string) => (assets[t] === undefined ? 0n : u128(assets[t], "internal balance"));
  const owed = async (t: string) => u128(need(await sv("get_platform_owed", { token: t }), `get_platform_owed ${t}`), "platform_owed");

  let positions = { quote: 0n, base: 0n };
  let unclaimed = { quote: 0n, base: 0n };
  let position: MarketState["position"] = null;
  if (own !== null) {
    if (typeof own !== "string") bad("own position must be a string or null");
    const l = need(await readAt(src, dcl, "get_liquidity", { lpt_id: own }, block), "get_liquidity");
    if (!isObj(l) || l.lpt_id !== own || l.pool_id !== poolId || l.owner_id !== src.account) bad("the own position is not this strategy's in this pool");
    const pr = need(await readAt(src, dcl, "predict_remove_liquidity", { lpt_id: own, amount: u128(l.amount, "position amount").toString() }, block), "predict_remove_liquidity");
    if (!Array.isArray(pr) || pr.length !== 2) bad("predict_remove_liquidity must be [x, y]");
    const pieces = positionPieces(quoteIsX, [u128(pr[0], "predict x"), u128(pr[1], "predict y")], [u128(l.unclaimed_fee_x, "unclaimed x"), u128(l.unclaimed_fee_y, "unclaimed y")]);
    positions = pieces.positions;
    unclaimed = pieces.unclaimedFees;
    if (typeof l.left_point !== "number" || typeof l.right_point !== "number") bad("position points");
    position = { left: l.left_point, right: l.right_point };
  }
  const holdings = marketHoldings(
    { wallet: await wallet(quote), internal: internal(quote), platformOwed: await owed(quote), positions: positions.quote },
    { wallet: await wallet(baseToken), internal: internal(baseToken), platformOwed: await owed(baseToken), positions: positions.base },
  );
  const fees = feesEarned({ quote: u128(fc.quote, "fees.quote"), base: u128(fc.base, "fees.base") }, unclaimed);
  return {
    nowS: nsToS(ts), startedAtS: nsToS(readU64(startedV)), point, valuationPoint: point, block,
    confirmFromBlock: ctx.confirmFromBlock, position, closedBy: ctx.closedBy, principal, holdings, fees,
  };
}
