import type { SentTransaction } from "@poolside/near";
import { withinRules, type Decision, type MarketState, type RulesV1 } from "@poolside/rules";
import { chainHead, verifyRecordTextOnly } from "@poolside/rules";
import { plan, record, type Progress } from "./decide.ts";

/** What the agent reads each round, rebuilt from public chain data by the chain adapter. */
export interface Observation {
  readonly state: MarketState;
  readonly progress: Progress;
  /** The observed block's height and DCL point, sent as `meta.observed`. */
  readonly observed: { readonly block: number; readonly point: number };
  /** The strategy's own position id (`get_own_position`), sent with a close. */
  readonly position?: string | null;
  /** The previous record's `chain_head` (`get_actions`' last record), null for the first (EC-R32). */
  readonly prevHead?: string | null;
  /** The close's first confirming observation `O1`, sent as `confirm_observed` (EC-R30). */
  readonly confirm?: { readonly block: number; readonly point: number } | null;
  /**
   * The previous Swap's published record, hash and range when this open pairs with it (INTERFACE s5): the
   * open is sent with that hash and that range, and its record is the swap's, not a new one.
   */
  readonly paired?: { readonly hash: string; readonly text: string; readonly left: number; readonly right: number } | null;
}

/** The chain as the agent sees it. Tests use a fake; the real adapter wraps packages/near. */
export interface Chain {
  /** The strategy account the records name (EC-R31). */
  readonly strategy: string;
  /** Whether the strategy has left `Running` (its rules can be revealed), so held records may be published (INTERFACE s5, THREAT_MODEL T78). */
  released?(): Promise<boolean>;
  observe(): Promise<Observation>;
  send(method: string, args: Record<string, unknown>): Promise<SentTransaction>;
}

/** One line of the decision log: what was seen, decided and sent. Never holds a key. */
export interface LogEntry {
  readonly block: number;
  readonly decision: Decision;
  readonly decisionHash: string;
  /** The exact decision record text whose SHA-256 is `decisionHash` (EC-R31); empty when none was made. */
  readonly record: string;
  readonly sent: { readonly method: string; readonly ok: boolean; readonly hash: string; readonly failure: string | null } | null;
  readonly error: string | null;
  /** Set when the agent has stopped for good: nothing it can send moves the run on (`plan` returned `stalled`). */
  readonly stalled?: string;
}

/**
 * One round: observe, decide with the shared rules, and send at most one transaction. Errors from the
 * chain are logged, never thrown, so one bad round cannot stop the loop; the next round decides afresh
 * from chain state, which is the only memory the agent has.
 */
export interface RoundHooks {
  /** Writes the record to the private held store; called BEFORE the action is sent. If it throws, nothing is sent. */
  readonly hold?: (hash: string, text: string) => void | Promise<void>;
  /** The gate on every send (default `withinRules`); injectable so a test can show a rejecting gate stops the send. */
  readonly gate?: typeof withinRules;
}

export async function round(rules: RulesV1, chain: Chain, hooks: RoundHooks = {}): Promise<LogEntry> {
  const gate = hooks.gate ?? withinRules;
  let obs: Observation;
  try {
    obs = await chain.observe();
  } catch (e) {
    return { block: 0, decision: { kind: "hold" }, decisionHash: "", record: "", sent: null, error: message(e) };
  }
  let p: ReturnType<typeof plan>;
  try {
    p = plan(rules, obs.state, obs.progress);
  } catch (e) {
    // `evaluate` refuses an invalid state: log it and carry on with the next round (security M2).
    return { block: obs.observed.block, decision: { kind: "hold" }, decisionHash: "", record: "", sent: null, error: message(e) };
  }
  let rec: ReturnType<typeof record>;
  try {
    rec = record(rules, obs.state, p.decision, chain.strategy);
  } catch (e) {
    return { block: obs.observed.block, decision: p.decision, decisionHash: "", record: "", sent: null, error: message(e) };
  }
  // A paired open reuses its swap's exact record, hash and range (INTERFACE s5); only `observed` is fresh.
  const pair = p.kind === "send" && p.method === "agent_open" ? (obs.paired ?? null) : null;
  const hash = pair !== null ? pair.hash : rec.hash;
  const text = pair !== null ? pair.text : rec.text;
  const base = { block: obs.observed.block, decision: p.decision, decisionHash: hash, record: text };
  if (p.kind === "stalled") return { ...base, sent: null, error: `stalled: ${p.reason}`, stalled: p.reason };
  if (p.kind === "wait") return { ...base, sent: null, error: null };
  // EC-A01: never send what `withinRules` rejects, and never send an observation that isn't the state
  // that was decided on (the page replays `state` and the contract records `observed`).
  if (pair === null && (obs.observed.point !== obs.state.point || obs.observed.block !== obs.state.block)) {
    return { ...base, sent: null, error: "observed does not match the decided state" };
  }
  let verdict: ReturnType<typeof withinRules>;
  try {
    if (pair !== null) {
      // The paired open is the swap's own record: it must hash to the swap's on-chain hash, be this strategy's and these
      // rules', and give the rules' own decision for its state (`verifyRecordTextOnly`), and be the open being sent.
      const v = verifyRecordTextOnly(pair.text, pair.hash, rules, chain.strategy);
      if (!v.ok) verdict = { ok: false, reason: `the swap's record does not verify: ${v.reason}` };
      else {
        const d = v.record.decision;
        verdict = d.kind === "open" && d.left === pair.left && d.right === pair.right ? gate(rules, v.record.state, d) : { ok: false, reason: "the swap's record is not the open being sent" };
      }
    } else {
      verdict = gate(rules, obs.state, p.decision);
    }
  } catch (e) {
    return { ...base, sent: null, error: message(e) };
  }
  if (!verdict.ok) return { ...base, sent: null, error: `outside the rules: ${verdict.reason}` };
  const args: Record<string, unknown> = {
    meta: { observed: { block: String(obs.observed.block), point: obs.observed.point }, decision_hash: hash, chain_head: chainHead(obs.prevHead ?? null, hash) },
  };
  if (p.method !== "agent_close_position") {
    args["left_point"] = pair !== null ? pair.left : p.left;
    args["right_point"] = pair !== null ? pair.right : p.right;
  } else {
    // A close names its position and the observation that first confirmed it; without them the
    // contract would refuse it, so the round logs an error instead of sending.
    if (!obs.position || !obs.confirm) return { ...base, sent: null, error: "close without a position or a confirming observation" };
    args["position"] = obs.position;
    args["confirm_observed"] = { block: String(obs.confirm.block), point: obs.confirm.point };
  }
  // The record is written before the action is sent: a send whose response is lost must still leave its record.
  try {
    await hooks.hold?.(hash, text);
  } catch (e) {
    return { ...base, sent: null, error: `the record could not be held, nothing was sent: ${message(e)}` };
  }
  try {
    const r = await chain.send(p.method, args);
    return { ...base, sent: { method: p.method, ok: r.ok, hash: r.hash, failure: r.failure }, error: null };
  } catch (e) {
    return { ...base, sent: null, error: message(e) };
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : "unknown error";
}

/**
 * Runs rounds until `stop` says so, appending each entry to `log`. `sleep` is injected so tests don't wait.
 * Records are written to the private **held store** before each send (`hold`) and are **published** (`publish`,
 * `records/<hash>.txt`) only once the chain says the strategy has left `Running`: a record served during the run
 * would show where the hidden bounds lie (THREAT_MODEL T78). Everything held is published, including records a
 * restarted agent finds on disk (`listHeld`, `readHeld`). A failing `hold` stops that send, a failing `publish` or
 * `released` is logged and retried next round; neither stops the loop.
 */
export async function run(rules: RulesV1, chain: Chain, opts: {
  log: (e: LogEntry) => void; sleep: () => Promise<void>; stop: () => boolean;
  hold?: (hash: string, text: string) => void | Promise<void>;
  listHeld?: () => string[];
  readHeld?: (hash: string) => string | null;
  publish?: (hash: string, text: string) => void | Promise<void>;
  gate?: typeof withinRules;
}): Promise<void> {
  const published = new Set<string>();
  let stalled = false;
  /** Publishes every held record once; true when nothing is left unpublished. A failure is logged and retried. */
  const publishHeld = async (): Promise<boolean> => {
    if (!opts.publish || !opts.listHeld || !opts.readHeld) return true;
    let all = true;
    let hashes: string[] = [];
    try { hashes = opts.listHeld(); } catch (e) { all = false; opts.log({ block: 0, decision: { kind: "hold" }, decisionHash: "", record: "", sent: null, error: `could not list held records: ${message(e)}` }); }
    for (const h of hashes) {
      if (published.has(h)) continue;
      let t: string | null = null;
      try { t = opts.readHeld(h); } catch { t = null; }
      if (t === null) continue;
      try { await opts.publish(h, t); published.add(h); } catch (e) { all = false; opts.log({ block: 0, decision: { kind: "hold" }, decisionHash: h, record: "", sent: null, error: `publish failed: ${message(e)}` }); }
    }
    return all;
  };
  while (!opts.stop()) {
    // Checked BEFORE the round, so an agent restarted after the strategy left `Running` publishes what its
    // held store holds instead of observing a strategy that is no longer running (it never acts again then).
    let released = false;
    try { released = (await chain.released?.()) === true; } catch { released = false; }
    if (released) {
      if (await publishHeld()) return;
    } else if (!stalled) {
      const entry = await round(rules, chain, { ...(opts.hold ? { hold: opts.hold } : {}), ...(opts.gate ? { gate: opts.gate } : {}) });
      opts.log(entry);
      // A stalled run never becomes sendable again: wait for the release, publish, and stop.
      if (entry.stalled !== undefined) stalled = true;
    }
    await opts.sleep();
  }
}
