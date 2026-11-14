import { MAX_GAS, type SentTransaction } from "@poolside/near";
import {
  closeCondition, confirmGrid, feesEarned, isPairedOpen, marketHoldings, nextConfirmRun, nsToS, OFFCHAIN_MARGIN_BLOCKS, parseDecisionRecord,
  hashRules, positionPieces, readU128, toHex, readU64, swapForRange, targetRange,
  type CloseReason, type ConfirmRun, type MarketState, type RulesV1,
} from "@poolside/rules";
import type { Chain, Observation } from "./loop.ts";

/**
 * The chain as the agent sees it, built from public reads only (ARCHITECTURE 7). Everything the
 * agent knows comes from views at one final block: the contract's state and records, DCL's pool and
 * position, the strategy's wallet and DCL's internal balances. The one thing it remembers between
 * rounds is the close confirmation run (`O1`), rebuilt on restart (a restart restarts the run).
 * Reads and the transaction sender are injected, so tests never reach a network.
 */
export interface ChainDeps {
  readonly rules: RulesV1;
  /** The strategy account and the Rhea DCL contract. */
  readonly strategy: string;
  readonly dcl: string;
  /** The latest final block's height and timestamp (ns). */
  head(): Promise<{ height: number; timestampNs: bigint }>;
  /** The timestamp (ns) of block `height`, for the grid heights between two observations. */
  blockTimeNs(height: number): Promise<bigint>;
  /** The agent's own published record for `hash` (its `records/<hash>.txt`), or null if it has none. */
  readRecord(hash: string): Promise<string | null>;
  /** A view read at exactly `blockId`, strictly parsed JSON. */
  view(account: string, method: string, args: unknown, blockId: number): Promise<unknown>;
  /** Signs with the agent's function-call key and sends; `gas` is at most 300 Tgas. */
  submit(method: string, args: Record<string, unknown>, gas: bigint): Promise<SentTransaction>;
}

/** The probe `predict_add_liquidity` is asked about: large in both tokens so `need` carries the range's ratio (contract `PROBE_X`, `PROBE_Y`). */
const PROBE_X = "1000000000000000000";
const PROBE_Y = "1000000000000000000000000000000000000";
type Obj = Record<string, unknown>;
function obj(v: unknown, what: string): Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be an object`);
  return v as Obj;
}
const u128 = (v: unknown, what: string): bigint => {
  try { return readU128(v as string); } catch { throw new Error(`${what} must be a u128 string`); }
};
const u64 = (v: unknown, what: string): bigint => {
  try { return readU64(v as string); } catch { throw new Error(`${what} must be a u64 string`); }
};
function int(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error(`${what} must be an integer`);
  return v;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function createChain(deps: ChainDeps): Chain {
  let run: { readonly run: ConfirmRun; readonly point: number } | null = null;
  // The close reason of a recorded close, by decision hash: read once from the agent's own record.
  const reasons = new Map<string, CloseReason>();

  /** Everything `evaluate` needs at block `at` (timestamp `tsNs`), read through views at that block. */
  async function sample(at: number, tsNs: bigint) {
    const sv = (m: string, a: unknown = {}) => deps.view(deps.strategy, m, a, at);
    const dv = (m: string, a: unknown) => deps.view(deps.dcl, m, a, at);
    if ((await sv("get_status")) !== "Running") throw new Error("the strategy is not running");
    const limits = obj(await sv("get_limits"), "limits");
    const config = obj(await sv("get_config"), "config");
    // The rules file the agent holds must be the ones the strategy was created with (else every decision is on the wrong rules).
    if (config["rules_hash"] !== toHex(hashRules(deps.rules))) throw new Error("the rules file is not the strategy's (rules_hash differs)");
    const poolId = limits["pool"];
    const quote = config["quote_token"];
    if (typeof poolId !== "string" || typeof quote !== "string") throw new Error("limits.pool and config.quote_token are required");
    const [tokenX, tokenY, tier, extra] = poolId.split("|");
    if (tokenX === undefined || tokenY === undefined || tier === undefined || extra !== undefined) throw new Error("pool id");
    const quoteIsX = tokenX === quote;
    if (!quoteIsX && tokenY !== quote) throw new Error("the quote token is not in the pool");
    if (quote === (quoteIsX ? tokenY : tokenX)) throw new Error("the pool's two tokens must differ");
    const baseToken = quoteIsX ? tokenY : tokenX;
    if (poolId !== deps.rules.pool || quote !== deps.rules.quote_token) throw new Error("the strategy's pool or quote token is not the rules'");

    const startedNs = await sv("get_started_at");
    if (startedNs === null) throw new Error("the strategy has not started");
    const principal = u128(await sv("get_principal"), "principal");
    const own = await sv("get_own_position");
    const ownPosition = typeof own === "string" ? own : null;
    const fc = obj(await sv("get_fees_collected"), "fees_collected");

    const pool = obj(await dv("get_pool", { pool_id: poolId }), "pool");
    if (pool["state"] !== "Running" || pool["pool_id"] !== poolId || pool["token_x"] !== tokenX || pool["token_y"] !== tokenY) throw new Error("the pool is not the strategy's or not running");
    const point = int(pool["current_point"], "current_point");

    const strat = deps.strategy;
    const wallet = async (token: string) => u128(await deps.view(token, "ft_balance_of", { account_id: strat }, at), "balance");
    const internalAssets = obj(await dv("list_user_assets", { account_id: strat }), "assets");
    const internal = (t: string) => (internalAssets[t] === undefined ? 0n : u128(internalAssets[t], "internal balance"));
    const owed = async (t: string) => u128(await sv("get_platform_owed", { token: t }), "platform_owed");
    let positions = { quote: 0n, base: 0n };
    let unclaimed = { quote: 0n, base: 0n };
    let position: MarketState["position"] = null;
    if (ownPosition !== null) {
      const l = obj(await dv("get_liquidity", { lpt_id: ownPosition }), "position");
      if (l["lpt_id"] !== ownPosition || l["pool_id"] !== poolId || l["owner_id"] !== strat) throw new Error("the own position is not this strategy's in this pool");
      const pr = await dv("predict_remove_liquidity", { lpt_id: ownPosition, amount: u128(l["amount"], "position amount").toString() });
      if (!Array.isArray(pr) || pr.length !== 2) throw new Error("predict_remove_liquidity must be [x, y]");
      const pieces = positionPieces(quoteIsX, [u128(pr[0], "predict x"), u128(pr[1], "predict y")], [u128(l["unclaimed_fee_x"], "unclaimed x"), u128(l["unclaimed_fee_y"], "unclaimed y")]);
      positions = pieces.positions;
      unclaimed = pieces.unclaimedFees;
      position = { left: int(l["left_point"], "left_point"), right: int(l["right_point"], "right_point") };
    }
    const holdings = marketHoldings(
      { wallet: await wallet(quote), internal: internal(quote), platformOwed: await owed(quote), positions: positions.quote },
      { wallet: await wallet(baseToken), internal: internal(baseToken), platformOwed: await owed(baseToken), positions: positions.base },
    );
    const fees = feesEarned({ quote: u128(fc["quote"], "fees.quote"), base: u128(fc["base"], "fees.base") }, unclaimed);
    const state: MarketState = {
      nowS: nsToS(tsNs), startedAtS: nsToS(u64(startedNs, "started_at")), point, valuationPoint: point, block: at,
      confirmFromBlock: null, position, closedBy: null, principal, holdings, fees,
    };
    return { state, quoteIsX, poolId, ownPosition, point, holdings };
  }

  async function observe(): Promise<Observation> {
    const h = await deps.head();
    const at = h.height;
    const sv = (m: string, a: unknown = {}) => deps.view(deps.strategy, m, a, at);
    const s = await sample(at, h.timestampNs);
    const swapsUsed = int(await sv("get_swaps_used"), "swaps_used");
    const opened = (await sv("get_opened")) === true;
    const settle = obj(await sv("get_settle_window"), "settle_window");
    const settledFrom = Math.max(
      Number(u64(settle["settle_until_block"], "settle_until_block")),
      Number(u64(settle["last_payout_callback_block"], "last_payout_callback_block")) + OFFCHAIN_MARGIN_BLOCKS,
    );

    // The records: the close latch (from the agent's own record of a recorded close), the last record's
    // chain head (a record without a readable head fails closed), a paired open, and a recent refusal.
    const len = Number(u64(await sv("get_actions_len"), "actions_len"));
    let closedBy: CloseReason | null = null;
    let pairedHash: string | null = null;
    let paired: Observation["paired"] = null;
    let recentRefusal = false;
    let refusedOpens = 0;
    let swapFailed = false;
    let prevHead: string | null = null;
    for (let from = 0; from < len; from += 20) {
      const page = await sv("get_actions", { from: String(from), limit: 20 });
      if (!Array.isArray(page)) throw new Error("actions must be an array");
      for (const r of page) {
        const rec = obj(r, "action");
        {
          const res = rec["result"];
          const bad = res !== null && typeof res === "object" && ("Refused" in (res as Obj) || "Failed" in (res as Obj));
          if (rec["kind"] === "Open" && bad) refusedOpens++;
          if (rec["kind"] === "Swap") swapFailed = bad;
        }
        if (rec["kind"] === "ClosePosition" && rec["result"] === "Ok") {
          const hash = rec["decision_hash"];
          if (typeof hash !== "string" || !HEX64.test(hash)) throw new Error("a recorded close has no readable decision_hash");
          let reason = reasons.get(hash);
          if (reason === undefined) {
            const text = await deps.readRecord(hash);
            if (text === null) throw new Error("the record of a recorded close is not available: the close latch is unknown");
            const d = parseDecisionRecord(text).decision;
            if (d.kind !== "close") throw new Error("the record of a recorded close does not hold a close decision");
            reason = d.reason;
            reasons.set(hash, reason);
          }
          closedBy ??= reason;
        }
      }
      if (from + 20 >= len && page.length > 0) {
        const last = obj(page[page.length - 1], "action");
        // Every action record carries its chain head; one that doesn't makes the chain unknowable: fail closed.
        const head = last["chain_head"];
        if (typeof head !== "string" || !HEX64.test(head)) throw new Error("the last action record has no readable chain_head: not restarting the chain");
        prevHead = head;
        const res = last["result"];
        const refusedOrFailed = res !== null && typeof res === "object" && ("Refused" in (res as Obj) || "Failed" in (res as Obj));
        // Back off after a refused or failed swap or open only (a due close is never held back by this).
        if ((last["kind"] === "Swap" || last["kind"] === "Open") && refusedOrFailed && typeof last["timestamp_ns"] === "string" && h.timestampNs - u64(last["timestamp_ns"], "timestamp_ns") < 3600n * 1_000_000_000n) recentRefusal = true;
        const swap = last["swap"];
        if (last["kind"] === "Swap" && last["result"] === "Ok" && swap !== null && typeof swap === "object" && u128((swap as Obj)["used"], "used") > 0n && typeof last["result_ts_ns"] === "string" && typeof last["decision_hash"] === "string") {
          if (isPairedOpen(u64(last["result_ts_ns"], "result_ts_ns"), h.timestampNs)) {
            // A paired open reuses the swap's exact record, hash and range; without the record it is an ordinary open.
            const text = await deps.readRecord(last["decision_hash"]);
            if (text !== null) {
              pairedHash = last["decision_hash"];
              paired = { hash: last["decision_hash"], text, left: int(last["left_point"], "left_point"), right: int(last["right_point"], "right_point") };
            }
          }
        }
      }
    }

    const base: MarketState = { ...s.state, closedBy };
    // The confirmation run: carried from round to round, restarted by a false reading or by a payout
    // inside the contract's margin; and replayed at the grid heights between O1 and now, as the page does.
    let next = nextConfirmRun(deps.rules, base, run?.run ?? null, Math.min(settledFrom, at));
    if (next !== null && next.fromBlock < at) {
      for (const g of confirmGrid(next.fromBlock, at)) {
        const gs = await sample(g, await deps.blockTimeNs(g));
        if ((closedBy ?? closeCondition(deps.rules, gs.state)) === null) { next = { fromBlock: at, reason: next.reason }; break; }
      }
    }
    run = next === null ? null : { run: next, point: run !== null && run.run.fromBlock === next.fromBlock ? run.point : s.point };
    const state: MarketState = { ...base, confirmFromBlock: next?.fromBlock ?? null };
    // Whether an open needs a swap first: the shared `swapForRange` over the holdings and DCL's
    // `need` for the target range at this point (D27), the same sum the contract makes.
    let swapNeeded: boolean | undefined;
    const range = s.ownPosition === null && !opened ? targetRange(deps.rules, s.point) : null;
    if (range !== null) {
      const need = obj(await deps.view(deps.dcl, "predict_add_liquidity", { pool_id: s.poolId, left_point: range.left, right_point: range.right, amount_x: PROBE_X, amount_y: PROBE_Y }, at), "predict");
      const [nx, ny] = [u128(need["need_x"], "need_x"), u128(need["need_y"], "need_y")];
      if (nx > 0n || ny > 0n) {
        const [hx, hy] = s.quoteIsX ? [s.holdings.quote, s.holdings.base] : [s.holdings.base, s.holdings.quote];
        swapNeeded = swapForRange({ x: hx, y: hy }, { x: nx, y: ny }, s.point) !== null;
      }
    }
    return {
      state, progress: { swapsUsed, opened, pairedHash, refusedOpens, swapFailed, ...(swapNeeded === undefined ? {} : { swapNeeded }), recentRefusal }, observed: { block: at, point: s.point },
      position: s.ownPosition, prevHead, paired, confirm: run === null ? null : { block: run.run.fromBlock, point: run.point },
    };
  }

  return {
    strategy: deps.strategy,
    released: async () => {
      const h = await deps.head();
      const status = await deps.view(deps.strategy, "get_status", {}, h.height);
      return status === "Closing" || status === "Closed";
    },
    observe,
    send: (method, args) => deps.submit(method, args, MAX_GAS),
  };
}
