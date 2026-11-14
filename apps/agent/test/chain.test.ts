import { describe, expect, it } from "vitest";
import { chainHead, decisionHash, decisionRecordText, hashRules, toHex, validateRules, type MarketState, type RulesV1 } from "@poolside/rules";
import { decisionRecordTextUnchecked } from "@poolside/rules/testing";
import { createChain, round, type ChainDeps } from "../src/index.ts";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const POOL = `${USDC}|wrap.near|100`;
const rules = validateRules({
  version: 1, pool: POOL, quote_token: USDC, range: { width_bps: 1000, centre: "mid" },
  take_profit_bps: 500, stop_loss_bps: 1000, close_after_s: 86_400, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
} as never) as RulesV1;

const STRAT = "strategy-1.near";
const DCL = "dclv2.ref-labs.near";
const NS = 1_000_000_000n;
const START_S = 1_700_000_000;

interface World {
  height: number; nowS: number; status: string; swapsUsed: number; opened: boolean; own: string | null;
  actions: unknown[]; point: number; settleUntil: number; lastPayout: number;
  usdc: bigint; wnear: bigint; internal: Record<string, string>; need: [string, string]; records: Record<string, string>;
}
const world = (o: Partial<World> = {}): World => ({
  height: 1000, nowS: START_S + 100, status: "Running", swapsUsed: 0, opened: false, own: null, actions: [], point: -8000,
  settleUntil: 0, lastPayout: 0, usdc: 500_000_000n, wnear: 0n, internal: {}, need: ["1000000000000000000", "449000000000000000"], records: {}, ...o,
});

const reads = new Set<number>();
function deps(w: World, sent: { method: string; args: Record<string, unknown> }[] = []): ChainDeps {
  const table: Record<string, (a: Record<string, unknown>) => unknown> = {
    [`${STRAT}.get_status`]: () => w.status,
    [`${STRAT}.get_limits`]: () => ({ pool: POOL }),
    [`${STRAT}.get_config`]: () => ({ quote_token: USDC, rules_hash: toHex(hashRules(rules)) }),
    [`${STRAT}.get_started_at`]: () => String(BigInt(START_S) * NS),
    [`${STRAT}.get_principal`]: () => "500000000",
    [`${STRAT}.get_swaps_used`]: () => w.swapsUsed,
    [`${STRAT}.get_opened`]: () => w.opened,
    [`${STRAT}.get_own_position`]: () => w.own,
    [`${STRAT}.get_fees_collected`]: () => ({ quote: "0", base: "0" }),
    [`${STRAT}.get_settle_window`]: () => ({ settle_until_block: String(w.settleUntil), last_payout_callback_block: String(w.lastPayout), settle_window_class: "Agent" }),
    [`${STRAT}.get_actions_len`]: () => String(w.actions.length),
    [`${STRAT}.get_actions`]: (a) => w.actions.slice(Number(a["from"]), Number(a["from"]) + 20),
    [`${STRAT}.get_platform_owed`]: () => "0",
    [`${DCL}.get_pool`]: () => ({ pool_id: POOL, token_x: USDC, token_y: "wrap.near", state: "Running", current_point: w.point }),
    [`${DCL}.list_user_assets`]: () => w.internal,
    [`${DCL}.predict_add_liquidity`]: () => ({ need_x: w.need[0], need_y: w.need[1], liquidity_amount: "1" }),
    [`${DCL}.get_liquidity`]: () => ({ lpt_id: w.own, pool_id: POOL, owner_id: STRAT, amount: "1000", left_point: -8500, right_point: -7500, unclaimed_fee_x: "0", unclaimed_fee_y: "0" }),
    [`${DCL}.predict_remove_liquidity`]: () => ["250000000", "100"],
    [`${USDC}.ft_balance_of`]: () => w.usdc.toString(),
    ["wrap.near.ft_balance_of"]: () => w.wnear.toString(),
  };
  return {
    rules, strategy: STRAT, dcl: DCL,
    head: async () => ({ height: w.height, timestampNs: BigInt(w.nowS) * NS }),
    blockTimeNs: async (h) => BigInt(w.nowS - (w.height - h)) * NS,
    readRecord: async (hash) => w.records[hash] ?? null,
    view: async (account, method, args, blockId) => {
      expect(blockId).toBeLessThanOrEqual(w.height);
      reads.add(blockId);
      const f = table[`${account}.${method}`];
      if (f === undefined) throw new Error(`unexpected view ${account}.${method}`);
      return f(args as Record<string, unknown>);
    },
    submit: async (method, args, gas) => { expect(gas).toBe(300_000_000_000_000n); sent.push({ method, args }); return { ok: true, hash: "H", failure: null }; },
  };
}

describe("createChain", () => {
  it("builds the state from views at one block and sends the swap first", async () => {
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    const chain = createChain(deps(world(), sent));
    const o = await chain.observe();
    expect(o.state).toMatchObject({ block: 1000, point: -8000, valuationPoint: -8000, nowS: START_S + 100, startedAtS: START_S, position: null, closedBy: null, confirmFromBlock: null, principal: 500_000_000n });
    expect(o.state.holdings).toEqual({ quote: 500_000_000n, base: 0n });
    expect(o.progress).toEqual({ swapsUsed: 0, opened: false, pairedHash: null, refusedOpens: 0, swapFailed: false, swapNeeded: true, recentRefusal: false });
    const e = await round(rules, chain);
    expect(e.sent).toMatchObject({ method: "agent_swap", ok: true });
    expect(sent[0]?.args).toMatchObject({ left_point: -8500, right_point: -7500, meta: { observed: { block: "1000", point: -8000 } } });
  });

  it("a paired open reuses the swap's record, hash and range, with its own chain head; after the pair window it is an ordinary open", async () => {
    const swapState: MarketState = { nowS: START_S + 50, startedAtS: START_S, point: -8000, valuationPoint: -8000, block: 900, confirmFromBlock: null, position: null, closedBy: null, principal: 500_000_000n, holdings: { quote: 500_000_000n, base: 0n }, fees: { quote: 0n, base: 0n } };
    const text = decisionRecordText(rules, swapState, { kind: "open", left: -8500, right: -7500 }, STRAT);
    const hash = decisionHash(text);
    const swapHead = "cd".repeat(32);
    const swap = { kind: "Swap", result: "Ok", swap: { used: "250000000" }, decision_hash: hash, chain_head: swapHead, left_point: -8500, right_point: -7500, result_ts_ns: String(BigInt(START_S + 50) * NS) };
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    const w = world({ swapsUsed: 1, actions: [swap], usdc: 250_000_000n, wnear: 10n ** 24n, records: { [hash]: text } });
    const e = await round(rules, createChain(deps(w, sent)));
    expect(sent[0]?.method).toBe("agent_open");
    expect(sent[0]?.args).toMatchObject({ left_point: -8500, right_point: -7500, meta: { decision_hash: hash, chain_head: chainHead(swapHead, hash), observed: { block: "1000", point: -8000 } } });
    expect(e.decisionHash).toBe(hash);
    expect(e.record).toBe(text);
    expect(decisionHash(e.record)).toBe(hash);
    // Without the swap's record (it can't be paired) the open is an ordinary one with its own record and hash.
    const noRecord = world({ swapsUsed: 1, actions: [swap], usdc: 250_000_000n, wnear: 10n ** 24n });
    const sent2: { method: string; args: Record<string, unknown> }[] = [];
    await round(rules, createChain(deps(noRecord, sent2)));
    expect((sent2[0]?.args["meta"] as { decision_hash: string }).decision_hash).not.toBe(hash);
    // 3,600 s after the swap's result the pair has lapsed.
    const late = world({ swapsUsed: 1, actions: [swap], nowS: START_S + 50 + 3600, records: { [hash]: text } });
    const sent3: { method: string; args: Record<string, unknown> }[] = [];
    await round(rules, createChain(deps(late, sent3)));
    expect((sent3[0]?.args["meta"] as { decision_hash: string }).decision_hash).not.toBe(hash);
  });

  it("holds an open position, then confirms a time close over two observations and sends it with the position", async () => {
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    const w = world({ swapsUsed: 1, opened: true, own: `${POOL}#7`, nowS: START_S + 86_400 + 10, height: 5000, usdc: 0n });
    const chain = createChain(deps(w, sent));
    // First observation: the close is due but not yet confirmed (no earlier observation).
    const first = await round(rules, chain);
    expect(first.decision).toMatchObject({ kind: "hold" });
    expect(sent).toHaveLength(0);
    // 40 blocks later (the payout margin) the same condition still holds: the close goes out.
    w.height = 5040; w.nowS += 40;
    const second = await round(rules, chain);
    expect(second.decision).toMatchObject({ kind: "close", reason: "time" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("agent_close_position");
    expect(sent[0]?.args).toMatchObject({ position: `${POOL}#7`, confirm_observed: { block: "5000", point: -8000 }, meta: { observed: { block: "5040", point: -8000 } } });
    expect(sent[0]?.args["left_point"]).toBeUndefined();
  });

  it("a confirmation inside the contract's payout margin restarts the run", async () => {
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    const w = world({ swapsUsed: 1, opened: true, own: `${POOL}#7`, nowS: START_S + 86_500, height: 5000, usdc: 0n });
    const chain = createChain(deps(w, sent));
    await round(rules, chain);
    // An own payout lands at block 5030: the earlier observation (5000) is no longer settled.
    w.height = 5040; w.lastPayout = 5030;
    const e = await round(rules, chain);
    expect(e.decision).toMatchObject({ kind: "hold" });
    expect(sent).toHaveLength(0);
  });

  it("audit M1: refused or failed opens and swaps are counted from get_actions, and two refused opens stall the round", async () => {
    const act = (kind: string, result: unknown, i: number) => ({ kind, result, timestamp_ns: String(BigInt(START_S + i) * NS), decision_hash: String(i).padStart(64, "0"), chain_head: "ab".repeat(32) });
    const prog = async (actions: unknown[]) => (await createChain(deps(world({ swapsUsed: 1, actions: actions as never }))).observe()).progress;
    expect(await prog([act("Swap", "Ok", 1), act("Open", { Refused: "x" }, 2)])).toMatchObject({ refusedOpens: 1, swapFailed: false });
    expect(await prog([act("Swap", { Failed: "swap" }, 1)])).toMatchObject({ refusedOpens: 0, swapFailed: true });
    expect(await prog([act("Swap", { Refused: "x" }, 1), act("Swap", "Ok", 2)])).toMatchObject({ swapFailed: false });
    expect(await prog([act("Swap", "Pending", 1)])).toMatchObject({ swapFailed: false, refusedOpens: 0 });
    expect(await prog([act("Open", { Failed: "add" }, 1), act("Open", { Refused: "y" }, 2)])).toMatchObject({ refusedOpens: 2 });
    const e = await round(rules, createChain(deps(world({ swapsUsed: 1, actions: [act("Swap", "Ok", 1), act("Open", { Refused: "x" }, 2), act("Open", { Failed: "add" }, 3)] as never }))));
    expect(e.stalled).toMatch(/refused or failed/);
  });
  it("MEDIUM: rules whose hash is not the strategy's rules_hash are never acted on", async () => {
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    const d = deps(world(), sent);
    const bad: ChainDeps = { ...d, view: async (a, m, x, b) => (m === "get_config" ? { quote_token: USDC, rules_hash: "00".repeat(32) } : d.view(a, m, x, b)) };
    const log = await round(rules, createChain(bad));
    expect(log.error).toMatch(/rules_hash differs/);
    expect(sent).toEqual([]);
  });
  it("logs an error, never throws, when the strategy is not running or a read is unreadable", async () => {
    for (const mutate of [
      (w: World) => { w.status = "Closing"; },
      (w: World) => { w.internal = { [USDC]: "01" }; },
      (w: World) => { w.usdc = -1n; },
    ]) {
      const w = world();
      mutate(w);
      const e = await round(rules, createChain(deps(w)));
      expect(e.error).not.toBeNull();
      expect(e.sent).toBeNull();
    }
  });

  it("values holdings with the position's predicted amounts and clamps what the platform is owed", async () => {
    const w = world({ swapsUsed: 1, opened: true, own: `${POOL}#7`, usdc: 5n });
    const o = await createChain(deps(w)).observe();
    // 5 spendable + 250,000,000 from the position (x is the quote token); 100 base from the position.
    expect(o.state.holdings).toEqual({ quote: 250_000_005n, base: 100n });
    expect(o.state.position).toEqual({ left: -8500, right: -7500 });
    expect(o.position).toBe(`${POOL}#7`);
  });

  it("skips the swap when the holdings already have the range's ratio (nothing for swapForRange to do), and swaps otherwise", async () => {
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    const inRatio = world({ usdc: 250_000_000n, wnear: 10n ** 24n, need: ["250000000", "1000000000000000000000000"] });
    const o = await createChain(deps(inRatio)).observe();
    expect(o.progress.swapNeeded).toBe(false);
    await round(rules, createChain(deps(inRatio, sent)));
    expect(sent[0]?.method).toBe("agent_open");
    expect((await createChain(deps(world())).observe()).progress.swapNeeded).toBe(true);
  });

  it("sends nothing while the last trading record was refused less than an hour ago (EC-A01 family, security M3)", async () => {
    const refused = { kind: "Swap", result: { Refused: "no_swap_needed" }, chain_head: "ab".repeat(32), timestamp_ns: String(BigInt(START_S + 90) * NS) };
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    const e = await round(rules, createChain(deps(world({ actions: [refused] }), sent)));
    expect(sent).toHaveLength(0);
    expect(e.error).toBeNull();
    // An hour later it may try again.
    const later = world({ actions: [refused], nowS: START_S + 90 + 3600 });
    await round(rules, createChain(deps(later, sent)));
    expect(sent).toHaveLength(1);
  });

  it("fails closed when the last action record has no readable chain head (never restarts the chain from zeros)", async () => {
    for (const head of [undefined, null, "AB".repeat(32), "short"]) {
      const rec = { kind: "Swap", result: { Refused: "drift" }, timestamp_ns: "1", ...(head === undefined ? {} : { chain_head: head }) };
      const e = await round(rules, createChain(deps(world({ actions: [rec] }))));
      expect(e.error).toMatch(/chain_head/);
      expect(e.sent).toBeNull();
    }
  });

  it("a refused or failed CLOSE does not hold back the next close (backoff is for swaps and opens only)", async () => {
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    const refusedClose = { kind: "ClosePosition", result: { Refused: "own_position_gone" }, chain_head: "ab".repeat(32), timestamp_ns: String(BigInt(START_S + 86_400) * NS) };
    const w = world({ swapsUsed: 1, opened: true, own: `${POOL}#7`, nowS: START_S + 86_410, height: 5000, usdc: 0n, actions: [refusedClose] });
    const chain = createChain(deps(w, sent));
    await round(rules, chain);
    w.height = 5040; w.nowS += 40;
    await round(rules, chain);
    expect(sent[0]?.method).toBe("agent_close_position");
  });

  it("reads the close latch from the agent's own record of a recorded close, and fails closed without it", async () => {
    const closeState: MarketState = { nowS: START_S + 86_400, startedAtS: START_S, point: -8000, valuationPoint: -8000, block: 900, confirmFromBlock: 800, position: { left: -8500, right: -7500 }, closedBy: null, principal: 500_000_000n, holdings: { quote: 250_000_000n, base: 100n }, fees: { quote: 0n, base: 0n } };
    const text = decisionRecordText(rules, closeState, { kind: "close", reason: "time" }, STRAT);
    const hash = decisionHash(text);
    const closed = { kind: "ClosePosition", result: "Ok", decision_hash: hash, chain_head: "ab".repeat(32), timestamp_ns: "1" };
    const w = world({ swapsUsed: 1, opened: true, actions: [closed], records: { [hash]: text } });
    expect((await createChain(deps(w)).observe()).state.closedBy).toBe("time");
    const missing = world({ swapsUsed: 1, opened: true, actions: [closed] });
    await expect(createChain(deps(missing)).observe()).rejects.toThrow(/latch is unknown/);
    // A record that holds another decision is not a close latch.
    const hold = decisionRecordTextUnchecked(rules, closeState, { kind: "hold" }, STRAT);
    const w3 = world({ swapsUsed: 1, opened: true, actions: [{ ...closed, decision_hash: decisionHash(hold) }], records: { [decisionHash(hold)]: hold } });
    await expect(createChain(deps(w3)).observe()).rejects.toThrow(/does not hold a close decision/);
  });

  it("replays the confirmation at the grid heights between O1 and now: a dip at a grid height restarts the run (EC-R30, EC-W23)", async () => {
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    // The time bound passes at block 5000 but the read at block 5020 (a grid height) is before it: no close at 5040.
    const w = world({ swapsUsed: 1, opened: true, own: `${POOL}#7`, nowS: START_S + 86_400, height: 5000, usdc: 0n });
    const chain = createChain(deps(w, sent));
    await round(rules, chain);
    w.height = 5040; w.nowS += 40;
    // blockTimeNs(5020) = nowS - 20 is still above the bound, so the close goes out...
    await round(rules, chain);
    expect(sent).toHaveLength(1);
    // ...but if the strategy's clock at the grid height were before the bound, the run restarts and nothing is sent.
    const sent2: { method: string; args: Record<string, unknown> }[] = [];
    const w2 = world({ swapsUsed: 1, opened: true, own: `${POOL}#7`, nowS: START_S + 86_400, height: 5000, usdc: 250_000_000n }); // holdings 500 USDC: no stop loss, only the time bound
    const d2 = deps(w2, sent2);
    const chain2 = createChain({ ...d2, blockTimeNs: async (h) => BigInt(START_S + 86_399 - (w2.height - h) * 0) * NS });
    await round(rules, chain2);
    w2.height = 5040; w2.nowS += 40;
    const e2 = await round(rules, chain2);
    expect(sent2).toHaveLength(0);
    expect(e2.decision.kind).toBe("hold");
  });

  it("refuses a pool or position that is not the strategy's, and subtracts what the platform is owed from the wallet", async () => {
    const owedWorld = world({ swapsUsed: 1, opened: true });
    const o = await createChain({ ...deps(owedWorld), view: async (a, m, g, b) => (m === "get_platform_owed" ? "100000000" : deps(owedWorld).view(a, m, g, b)) }).observe();
    expect(o.state.holdings.quote).toBe(400_000_000n); // 500 USDC wallet less 100 owed
    const badPool = async (patch: Record<string, unknown>) => createChain({ ...deps(world()), view: async (a, m, g, b) => (m === "get_pool" ? { pool_id: POOL, token_x: USDC, token_y: "wrap.near", state: "Running", current_point: -8000, ...patch } : deps(world()).view(a, m, g, b)) }).observe();
    await expect(badPool({ state: "Paused" })).rejects.toThrow(/pool/);
    await expect(badPool({ token_y: "other.near" })).rejects.toThrow(/pool/);
    await expect(badPool({ pool_id: "x|y|100" })).rejects.toThrow(/pool/);
    const wrongOwner = world({ swapsUsed: 1, opened: true, own: `${POOL}#7` });
    const dv = deps(wrongOwner);
    await expect(createChain({ ...dv, view: async (a, m, g, b) => (m === "get_liquidity" ? { lpt_id: `${POOL}#7`, pool_id: POOL, owner_id: "someone.near", amount: "1", left_point: 1, right_point: 2, unclaimed_fee_x: "0", unclaimed_fee_y: "0" } : dv.view(a, m, g, b)) }).observe()).rejects.toThrow(/not this strategy's/);
  });

  it("maps the position's fees and amounts to quote and base by the pool's token order", async () => {
    const w = world({ swapsUsed: 1, opened: true, own: `${POOL}#7`, usdc: 5n });
    const d = deps(w);
    const o = await createChain({ ...d, view: async (a, m, g, b) => (m === "get_liquidity" ? { lpt_id: `${POOL}#7`, pool_id: POOL, owner_id: STRAT, amount: "1000", left_point: -8500, right_point: -7500, unclaimed_fee_x: "7", unclaimed_fee_y: "9" } : d.view(a, m, g, b)) }).observe();
    expect(o.state.fees).toEqual({ quote: 7n, base: 9n }); // x is the quote token in this pool
  });

  it("released() is true only in Closing and Closed", async () => {
    for (const [status, want] of [["Running", false], ["Closing", true], ["Closed", true], ["Open", false]] as const) {
      const w = world({ status });
      expect(await createChain(deps(w)).released?.()).toBe(want);
    }
  });
});
