import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateRules, type MarketState, type RulesV1 } from "@poolside/rules";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chainHead, decisionHash, decisionRecordText, parseDecisionRecord, verifyDecisionRecordAgainstChain } from "@poolside/rules";
import { listRecordFiles, plan, readRecordFile, record, round, run, writeRecordFile, type Chain, type LogEntry, type Observation } from "../src/index.ts";

const rules = validateRules({
  version: 1, pool: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|wrap.near|100",
  quote_token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  range: { width_bps: 1000, centre: "mid" }, take_profit_bps: 500, stop_loss_bps: 1000, close_after_s: 86_400, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
} as never) as RulesV1;

const state = (o: Partial<MarketState> = {}): MarketState => ({
  nowS: 1000, startedAtS: 1000, point: -8000, valuationPoint: -8000, block: 100, confirmFromBlock: null, position: null, closedBy: null,
  principal: 1_000_000n, holdings: { quote: 1_000_000n, base: 0n }, fees: { quote: 0n, base: 0n }, ...o,
});

describe("plan", () => {
  it("swaps first, then opens, then waits once opened", () => {
    expect(plan(rules, state(), { swapsUsed: 0, opened: false })).toMatchObject({ kind: "send", method: "agent_swap" });
    expect(plan(rules, state(), { swapsUsed: 1, opened: false })).toMatchObject({ kind: "send", method: "agent_open" });
    expect(plan(rules, state(), { swapsUsed: 1, opened: true }).kind).toBe("wait");
  });
  it("ROUND 6 liveness: a failed swap is retried while the cap allows it, and the agent never opens with unbalanced holdings", () => {
    const failed = { swapsUsed: 1, opened: false, swapFailed: true, swapNeeded: true };
    expect(plan(rules, state(), failed)).toMatchObject({ kind: "send", method: "agent_swap" });
    // The hour's back-off after the refusal still applies.
    expect(plan(rules, state(), { ...failed, recentRefusal: true }).kind).toBe("wait");
    // At the contract's cap (2) nothing can move the run on: the agent stops and the creator can close.
    expect(plan(rules, state(), { ...failed, swapsUsed: 2 })).toMatchObject({ kind: "stalled", reason: expect.stringContaining("swaps are used up") });
    // A failed swap whose range no longer needs one opens as usual.
    expect(plan(rules, state(), { ...failed, swapNeeded: false })).toMatchObject({ kind: "send", method: "agent_open" });
    // A successful swap opens, even though the holdings are never in the exact ratio.
    expect(plan(rules, state(), { swapsUsed: 1, opened: false, swapFailed: false, swapNeeded: true })).toMatchObject({ kind: "send", method: "agent_open" });
  });
  it("ROUND 6 liveness: after two refused or failed opens the agent stops instead of trying again every hour", () => {
    expect(plan(rules, state(), { swapsUsed: 1, opened: false, refusedOpens: 1 })).toMatchObject({ kind: "send", method: "agent_open" });
    expect(plan(rules, state(), { swapsUsed: 1, opened: false, refusedOpens: 2 })).toMatchObject({ kind: "stalled", reason: expect.stringContaining("refused or failed") });
    expect(plan(rules, state(), { swapsUsed: 1, opened: false, refusedOpens: 3 }).kind).toBe("stalled");
  });
  it("closes only when the shared evaluate says so, and holds otherwise", () => {
    const due = state({ nowS: 1000 + 86_400, position: { left: -8500, right: -7500 }, confirmFromBlock: 50, block: 100 });
    expect(plan(rules, due, { swapsUsed: 1, opened: true })).toMatchObject({ kind: "send", method: "agent_close_position" });
    expect(plan(rules, state({ position: { left: -8500, right: -7500 } }), { swapsUsed: 1, opened: true }).kind).toBe("wait");
  });
});

describe("record (EC-R31: the one shared helper)", () => {
  it("hashes the published text with the helper the page imports, and the page can read it back", () => {
    const d = { kind: "open", left: -8500, right: -7500 } as const;
    const r = record(rules, state(), d, STRAT);
    expect(r.hash).toBe(decisionHash(r.text));
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record(rules, state(), d, STRAT).hash).toBe(r.hash);
    expect(record(rules, state({ block: 101 }), d, STRAT).hash).not.toBe(r.hash);
    // The writer refuses a decision the rules don't give (a hold where they say open).
    expect(() => record(rules, state(), { kind: "hold" }, STRAT)).toThrow(/not what the rules give/);
    expect(parseDecisionRecord(r.text)).toMatchObject({ state: state(), decision: d });
  });
});

const STRAT = "strategy-1.near";
function fake(obs: Observation | Error, sent: unknown[] = [], fail = false): Chain {
  return {
    strategy: STRAT,
    observe: async () => { if (obs instanceof Error) throw obs; return obs; },
    send: async (method, args) => { sent.push({ method, args }); if (fail) throw new Error("rpc down"); return { ok: true, hash: "H", failure: null }; },
  };
}
const obs = (o: Partial<MarketState> = {}, progress: Observation["progress"] = { swapsUsed: 0, opened: false }, extra: Partial<Observation> = {}): Observation => ({ state: state(o), progress, observed: { block: 100, point: -8000 }, ...extra });

describe("round", () => {
  it("sends one agent_swap with meta and the planned range, never a deposit field", async () => {
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    const e = await round(rules, fake(obs(), sent));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("agent_swap");
    expect(sent[0]?.args).toMatchObject({ left_point: -8500, right_point: -7500, meta: { observed: { block: "100", point: -8000 }, chain_head: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(e.sent).toMatchObject({ method: "agent_swap", ok: true });
    const meta = sent[0]?.args["meta"] as { decision_hash: string; chain_head: string };
    expect(e.decisionHash).toBe(meta.decision_hash);
    // The log line carries the exact text the hash is of, and the first chain head starts from zeros (EC-R32).
    expect(decisionHash(e.record)).toBe(e.decisionHash);
    expect(meta.chain_head).toBe(chainHead(null, e.decisionHash));
  });
  it("sends a close without points", async () => {
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    await round(rules, fake(obs({ nowS: 1000 + 86_400, position: { left: -8500, right: -7500 }, confirmFromBlock: 50 }, { swapsUsed: 1, opened: true }, { position: "p#1", confirm: { block: 50, point: -8000 } }), sent));
    expect(sent[0]?.method).toBe("agent_close_position");
    expect(sent[0]?.args).not.toHaveProperty("left_point");
    expect(sent[0]?.args).toMatchObject({ position: "p#1", confirm_observed: { block: "50", point: -8000 } });
  });
  it("links the chain head to the previous record's head (EC-R32)", async () => {
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    const prev = "ab".repeat(32);
    const e = await round(rules, fake(obs({}, { swapsUsed: 0, opened: false }, { prevHead: prev }), sent));
    expect((sent[0]?.args["meta"] as { chain_head: string }).chain_head).toBe(chainHead(prev, e.decisionHash));
  });
  it("does not send a close that lacks its position or confirming observation", async () => {
    const sent: unknown[] = [];
    const e = await round(rules, fake(obs({ nowS: 1000 + 86_400, position: { left: -8500, right: -7500 }, confirmFromBlock: 50 }, { swapsUsed: 1, opened: true }), sent));
    expect(sent).toHaveLength(0);
    expect(e.error).toMatch(/close without/);
  });
  it("sends nothing when it waits, and logs errors instead of throwing", async () => {
    const sent: unknown[] = [];
    expect((await round(rules, fake(obs({}, { swapsUsed: 1, opened: true }), sent))).sent).toBeNull();
    expect(sent).toHaveLength(0);
    expect((await round(rules, fake(new Error("boom")))).error).toBe("boom");
    expect((await round(rules, fake(obs(), [], true))).error).toBe("rpc down");
    const odd = await round(rules, { strategy: STRAT, observe: async () => { throw "x"; }, send: async () => { throw "x"; } });
    expect(odd.error).toBe("unknown error");
  });
});

describe("run", () => {
  it("ROUND 6: a stalled round is logged with its reason and the loop sends nothing more", async () => {
    const log: LogEntry[] = [];
    let n = 0;
    const chain = fake(obs({}, { swapsUsed: 2, opened: false, swapFailed: true, swapNeeded: true }));
    const sends: string[] = [];
    await run(rules, { ...chain, send: async (m) => { sends.push(m); return { ok: true, hash: "h", failure: null } as never; } }, { log: (e) => log.push(e), sleep: async () => undefined, stop: () => n++ >= 4 });
    expect(log[0]?.stalled).toMatch(/swaps are used up/);
    expect(log.length).toBe(1);
    expect(sends).toEqual([]);
  });
  it("logs every round and stops when told", async () => {
    const log: unknown[] = [];
    let n = 0;
    await run(rules, fake(obs({}, { swapsUsed: 1, opened: true })), { log: (e) => log.push(e), sleep: async () => { n++; }, stop: () => n >= 3 });
    expect(log).toHaveLength(3);
  });
});

describe("the gate on every send (EC-A01)", () => {
  it("sends nothing the rules reject, when observed is not the decided state, or when decide throws", async () => {
    const sent: unknown[] = [];
    // observed.point differs from state.point: nothing is sent.
    const mismatch = await round(rules, fake({ ...obs(), observed: { block: 100, point: -7999 } }, sent));
    expect(sent).toHaveLength(0);
    expect(mismatch.error).toMatch(/does not match/);
    // An invalid state makes `evaluate` throw: logged, never thrown out of the loop.
    const bad = await round(rules, fake(obs({ point: 9_999_999 }), sent));
    expect(sent).toHaveLength(0);
    expect(bad.error).not.toBeNull();
  });
  it("a recent refusal holds every trade but keeps `hold` and `done` as they are", async () => {
    const sent: unknown[] = [];
    const e = await round(rules, fake(obs({}, { swapsUsed: 0, opened: false, recentRefusal: true }), sent));
    expect(sent).toHaveLength(0);
    expect(e.decision.kind).toBe("open");
    expect(e.sent).toBeNull();
  });
});

describe("the gates on every send (EC-A01) and the record store (T78)", () => {
  it("sends nothing when the gate rejects, and the record is not held for a send that didn't happen", async () => {
    const sent: unknown[] = [];
    const held: string[] = [];
    const e = await round(rules, fake(obs(), sent), { hold: (h) => { held.push(h); }, gate: () => ({ ok: false, reason: "stubbed" }) });
    expect(sent).toHaveLength(0);
    expect(held).toEqual([]);
    expect(e.error).toBe("outside the rules: stubbed");
    // The default gate (`withinRules`) lets the same round through.
    const ok = await round(rules, fake(obs(), sent), { hold: (h) => { held.push(h); } });
    expect(ok.sent).toMatchObject({ ok: true });
  });
  it("sends nothing when observed.block (not only the point) is not the decided state's block", async () => {
    const sent: unknown[] = [];
    const e = await round(rules, fake({ ...obs(), observed: { block: 101, point: -8000 } }, sent));
    expect(sent).toHaveLength(0);
    expect(e.error).toMatch(/does not match/);
  });
  it("writes the record to the held store BEFORE sending, and sends nothing if it cannot be held", async () => {
    const order: string[] = [];
    const chain: Chain = { ...fake(obs()), send: async () => { order.push("send"); return { ok: true, hash: "H", failure: null }; } };
    await round(rules, chain, { hold: () => { order.push("hold"); } });
    expect(order).toEqual(["hold", "send"]);
    const sent: unknown[] = [];
    const e = await round(rules, fake(obs(), sent), { hold: () => { throw new Error("disk full"); } });
    expect(sent).toHaveLength(0);
    expect(e.error).toMatch(/could not be held, nothing was sent: disk full/);
  });
  it("a send that throws after the record was held still leaves the record (a lost response keeps its file)", async () => {
    const held: string[] = [];
    const e = await round(rules, fake(obs(), [], true), { hold: (h) => { held.push(h); } });
    expect(e.error).toBe("rpc down");
    expect(held).toHaveLength(1);
  });
  it("a paired open is verified: the swap's record must hash to the swap's hash, name this strategy and these rules", async () => {
    const swapState = state({ nowS: 1050, block: 90 });
    const text = decisionRecordText(rules, swapState, { kind: "open", left: -8500, right: -7500 }, STRAT);
    const good = { hash: decisionHash(text), text, left: -8500, right: -7500 };
    const send = async (paired: { hash: string; text: string; left: number; right: number }, strategy = STRAT) => {
      const sent: { method: string; args: Record<string, unknown> }[] = [];
      const chain: Chain = { ...fake(obs({}, { swapsUsed: 1, opened: false }, { paired, prevHead: "ab".repeat(32) }), sent as unknown[]), strategy };
      const e = await round(rules, chain);
      return { sent, e };
    };
    const ok = await send(good);
    expect(ok.sent[0]?.method).toBe("agent_open");
    expect((ok.sent[0]?.args["meta"] as { decision_hash: string }).decision_hash).toBe(good.hash);
    for (const [name, bad, strategy] of [
      ["hash is not the text's", { ...good, hash: "00".repeat(32) }, STRAT],
      ["another strategy", good, "strategy-2.near"],
      ["a range that is not the record's", { ...good, left: -8501 }, STRAT],
      ["a text that isn't a record", { ...good, text: "x", hash: decisionHash("x") }, STRAT],
    ] as const) {
      const r = await send(bad, strategy);
      expect(r.sent, name).toHaveLength(0);
      expect(r.e.error, name).not.toBeNull();
    }
  });
  it("EC-R31: what the agent writes is what the page's check reads back: its record text verifies against the chain facts", async () => {
    const sent: { method: string; args: Record<string, unknown> }[] = [];
    const o = obs();
    const e = await round(rules, fake(o, sent as unknown[]));
    const meta = sent[0]?.args["meta"] as { decision_hash: string };
    const left = sent[0]?.args["left_point"] as number;
    const right = sent[0]?.args["right_point"] as number;
    const v = verifyDecisionRecordAgainstChain(e.record, meta.decision_hash, rules, STRAT,
      [{ kind: "Swap", observed: { block: o.observed.block, point: o.observed.point }, left, right, timestampNs: 1n, resultTsNs: null, index: 0, result: "ok", swapUsed: 1n }],
      { block: o.state.block, point: o.state.point, nowS: o.state.nowS, startedAtS: o.state.startedAtS, valuationPoint: o.state.valuationPoint, position: o.state.position, principal: o.state.principal, holdings: o.state.holdings, fees: o.state.fees, closedBy: o.state.closedBy, confirmFromBlock: o.state.confirmFromBlock });
    expect(v.status).toBe("matching");
    // The same bytes through writeRecordFile: the file is the text, and reads back verified.
    const dir = mkdtempSync(join(tmpdir(), "held-"));
    writeRecordFile(dir, meta.decision_hash, e.record);
    expect(readRecordFile(dir, meta.decision_hash)).toBe(e.record);
  });
});

describe("run: records are published only after the strategy leaves Running, from the held store, and survive a restart", () => {
  const store = () => {
    const dir = mkdtempSync(join(tmpdir(), "run-"));
    return { held: join(dir, "held"), pub: join(dir, "pub") };
  };
  const opts = (d: { held: string; pub: string }, stopAfter: number, log: LogEntry[] = []) => {
    let n = 0;
    return {
      log: (e: LogEntry) => { log.push(e); }, sleep: async () => undefined, stop: () => n++ >= stopAfter,
      hold: (h: string, t: string) => writeRecordFile(d.held, h, t), listHeld: () => listRecordFiles(d.held), readHeld: (h: string) => readRecordFile(d.held, h),
      publish: (h: string, t: string) => writeRecordFile(d.pub, h, t),
    };
  };
  it("publishes nothing while running, then the held records once released", async () => {
    const d = store();
    let released = false;
    const chain: Chain = { ...fake(obs()), released: async () => released };
    await run(rules, chain, opts(d, 2));
    expect(listRecordFiles(d.held).length).toBeGreaterThanOrEqual(1);
    expect(listRecordFiles(d.pub)).toEqual([]);
    released = true;
    await run(rules, { ...fake(obs({}, { swapsUsed: 1, opened: true })), released: async () => true }, opts(d, 1));
    expect(listRecordFiles(d.pub).sort()).toEqual(listRecordFiles(d.held).sort());
  });
  it("a restarted agent publishes what the first process held, though its own memory is empty", async () => {
    const d = store();
    await run(rules, { ...fake(obs()), released: async () => false }, opts(d, 1));
    const held = listRecordFiles(d.held);
    expect(held.length).toBe(1);
    // A new process: nothing in memory, the chain now says Closing, and it only waits.
    await run(rules, { ...fake(obs({}, { swapsUsed: 1, opened: true })), released: async () => true }, opts(d, 1));
    expect(listRecordFiles(d.pub)).toEqual(held);
  });
  it("a failing publish or released() is logged and never stops the loop", async () => {
    const d = store();
    const log: LogEntry[] = [];
    await run(rules, { ...fake(obs()), released: async () => false }, opts(d, 1));
    expect(listRecordFiles(d.held).length).toBe(1);
    await run(rules, { ...fake(obs()), released: async () => true }, { ...opts(d, 2, log), publish: () => { throw new Error("read-only"); } });
    expect(log.some((e) => /publish failed: read-only/.test(e.error ?? ""))).toBe(true);
    const log2: LogEntry[] = [];
    await run(rules, { ...fake(obs()), released: async () => { throw new Error("rpc"); } }, opts(d, 2, log2));
    expect(log2.length).toBe(2);
    expect(listRecordFiles(d.pub)).toEqual([]);
  });
  it("HIGH-2: a restart after the strategy left Running publishes everything held and returns by itself, without observing", async () => {
    const d = store();
    await run(rules, { ...fake(obs()), released: async () => false }, opts(d, 1));
    const held = listRecordFiles(d.held);
    let observed = 0;
    const chain: Chain = { ...fake(obs()), released: async () => true, observe: async () => { observed++; throw new Error("the strategy is not running"); } };
    // `stop` never says stop: the loop must end on its own once everything is published.
    await run(rules, chain, { ...opts(d, 1_000_000), stop: () => false });
    expect(listRecordFiles(d.pub)).toEqual(held);
    expect(observed).toBe(0);
  });
  it("HIGH-2: a record that does not hash to its file name is not published", async () => {
    const d = store();
    await run(rules, { ...fake(obs()), released: async () => false }, opts(d, 1));
    const [h] = listRecordFiles(d.held);
    writeFileSync(join(d.held, `${"0".repeat(64)}.txt`), "tampered");
    await run(rules, { ...fake(obs()), released: async () => true }, { ...opts(d, 1_000_000), stop: () => false });
    expect(listRecordFiles(d.pub)).toEqual([h]);
  });
});
