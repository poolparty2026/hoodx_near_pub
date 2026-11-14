import { sha256 } from "@noble/hashes/sha2.js";
import { RulesError } from "./errors.ts";
import { checkState, CLOSE_REASONS, evaluate, MAX_POINT, MIN_POINT, type CloseReason, type Decision, type MarketState } from "./evaluate.ts";
import { hashRules, toHex } from "./hash.ts";
import { canonicalize, strictParse, type JsonValue } from "./json.ts";
import { readU128 } from "./read.ts";
import { isAccountId, type RulesV1 } from "./schema.ts";
import { isPairedOpen } from "./constants.ts";

/**
 * The decision record: the one text the agent publishes for every action it sends, and the one the
 * check page reads (INTERFACE section 5, EC-R31). It is canonical JSON (RFC 8785, as `canonicalize`),
 * so the exact bytes are fixed by their content, and `decision_hash` is the SHA-256 of those bytes.
 * Anyone holding the revealed rules can re-run `evaluate` on `state` and compare `decision`.
 *
 * ```
 * { "decision": <Decision>, "rules_hash": <64 lowercase hex>, "state": <state>, "strategy": <account id>, "version": 1 }
 * state = { "block", "closedBy", "confirmFromBlock", "fees": {"base","quote"}, "holdings": {"base","quote"},
 *           "nowS", "point", "position", "principal", "startedAtS", "valuationPoint" }
 * ```
 * Amounts (`principal`, `holdings`, `fees`) are decimal strings; everything else is a safe integer, `null`
 * or a string, exactly as `MarketState` has it. Pure: no clock, network or randomness (EC-R06).
 */
export const DECISION_RECORD_VERSION = 1;
const ZERO_HEAD = "0".repeat(64);

const amounts = (a: { readonly quote: bigint; readonly base: bigint }): JsonValue => ({ base: a.base.toString(), quote: a.quote.toString() });

/** The state as JSON: bigints as decimal strings. Throws `RulesError` STATE for an invalid state (EC-R06). */
export function stateJson(s: MarketState): JsonValue {
  checkState(s);
  return {
    block: s.block, closedBy: s.closedBy, confirmFromBlock: s.confirmFromBlock, fees: amounts(s.fees), holdings: amounts(s.holdings),
    nowS: s.nowS, point: s.point, position: s.position === null ? null : { left: s.position.left, right: s.position.right },
    principal: s.principal.toString(), startedAtS: s.startedAtS, valuationPoint: s.valuationPoint,
  };
}

/** The exact text to publish for a decision at a state under the rules. */
export function decisionRecordText(rules: RulesV1, state: MarketState, decision: Decision, strategy: string): string {
  const text = decisionRecordTextUnchecked(rules, state, decision, strategy);
  // The agent only ever publishes what the rules give for the state (EC-R31, security M-A): the same check the page makes.
  const want = evaluate(rules, state);
  if (canonicalize(want as unknown as JsonValue) !== canonicalize(decision as unknown as JsonValue)) bad("the decision is not what the rules give for the state");
  return text;
}

/**
 * The record text without the `evaluate` check. **Tests only** (to build a record that lies, which the page must
 * refuse); the agent never calls it. Everything else is checked: the decision's shape, the state, the strategy id,
 * and the text reads back as written.
 */
export function decisionRecordTextUnchecked(rules: RulesV1, state: MarketState, decision: Decision, strategy: string): string {
  if (typeof strategy !== "string" || !isAccountId(strategy)) bad("strategy must be a NEAR account id");
  const text = canonicalize({ decision: checkDecision(decision as unknown as JsonValue) as unknown as JsonValue, rules_hash: toHex(hashRules(rules)), state: stateJson(state), strategy, version: DECISION_RECORD_VERSION });
  // The writer reads its own output back: a record the agent publishes, after funds moved on its
  // hash, is always one the page can read (security audit M-1, round 3).
  const back = parseDecisionRecord(text);
  if (back.strategy !== strategy || back.rulesHash !== toHex(hashRules(rules))) bad("the record does not read back as written");
  return text;
}

/** `decision_hash`: SHA-256 of the record's UTF-8 bytes, 64 lowercase hex. */
export function decisionHash(recordText: string): string {
  return toHex(sha256(new TextEncoder().encode(recordText)));
}

/**
 * The chain link: `chain_head = SHA-256("poolside-chain-v1\n" + prev + "\n" + decision_hash)` as 64 lowercase
 * hex, with `prev` the previous head or 64 zeros for the first record (EC-R32).
 */
export function chainHead(prev: string | null, hash: string): string {
  for (const h of prev === null ? [hash] : [prev, hash]) {
    if (!/^[0-9a-f]{64}$/.test(h)) throw new RulesError("STATE", "a chain head and a decision hash are 64 lowercase hex characters");
  }
  return toHex(sha256(new TextEncoder().encode(`poolside-chain-v1\n${prev ?? ZERO_HEAD}\n${hash}`)));
}

export interface ParsedDecisionRecord { readonly rulesHash: string; readonly strategy: string; readonly state: MarketState; readonly decision: Decision }

function bad(m: string): never {
  throw new RulesError("STATE", `decision record: ${m}`);
}
function obj(v: JsonValue | undefined, keys: string, what: string): Record<string, JsonValue> {
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) bad(`${what} must be an object`);
  if (Object.keys(v as object).sort().join(",") !== keys) bad(`${what} must have exactly the keys ${keys}`);
  return v as Record<string, JsonValue>;
}
function int(v: JsonValue | undefined, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || Object.is(v, -0)) bad(`${what} must be an integer`);
  return v as number;
}
function amt(v: JsonValue | undefined, what: string): bigint {
  try { return readU128(v as string); } catch { return bad(`${what} must be a decimal u128 string`); }
}

/**
 * The one validator for a decision: exactly the keys of its kind, points integers within the DCL
 * bounds with `left < right`, a close reason from the fixed list (EC-R33). Throws `RulesError` STATE.
 */
export function checkDecision(d: JsonValue | undefined): Decision {
  if (d === null || d === undefined || typeof d !== "object" || Array.isArray(d)) bad("decision must be an object");
  const kind = (d as Record<string, JsonValue>)["kind"];
  if (kind === "open") {
    const o = obj(d, "kind,left,right", "decision");
    const [left, right] = [int(o["left"], "left"), int(o["right"], "right")];
    for (const [k, v] of [["left", left], ["right", right]] as const) if (v < MIN_POINT || v > MAX_POINT) bad(`${k} must be within the point bounds`);
    if (left >= right) bad("left must be below right");
    return { kind: "open", left, right };
  }
  if (kind === "close") {
    const o = obj(d, "kind,reason", "decision");
    if (!CLOSE_REASONS.includes(o["reason"] as CloseReason)) bad("close reason must be time, stop_loss or take_profit");
    return { kind: "close", reason: o["reason"] as CloseReason };
  }
  if (kind === "hold" || kind === "done") {
    obj(d, "kind", "decision");
    return { kind };
  }
  return bad("decision kind must be hold, open, close or done");
}

export type RecordVerdict =
  | { readonly ok: true; readonly record: ParsedDecisionRecord }
  | { readonly ok: false; readonly unreadable: boolean; readonly reason: string };

/**
 * The page's whole check of one record (EC-R31): the SHA-256 of the text is `expectedHash` (the
 * hash on chain), the text is the canonical form of a valid record, `strategy` is this strategy, its `rules_hash` is the hash of
 * the revealed rules, and `evaluate(rules, state)` gives the recorded decision. `unreadable: true` is
 * "can't check" (text that can't be read); `unreadable: false` is "not matching".
 */
/** **Text only**: it ties nothing in the record's state to chain data, so `ok: true` is not a pass. The page uses `verifyDecisionRecordAgainstChain` and `isMatching`. */
export function verifyRecordTextOnly(text: string, expectedHash: string, rules: RulesV1, strategy: string): RecordVerdict {
  if (decisionHash(text) !== expectedHash) return { ok: false, unreadable: false, reason: "the record's hash is not the recorded decision_hash" };
  let record: ParsedDecisionRecord;
  try {
    record = parseDecisionRecord(text);
  } catch (e) {
    if (e instanceof RulesError) return { ok: false, unreadable: true, reason: e.message };
    throw e;
  }
  if (record.strategy !== strategy) return { ok: false, unreadable: false, reason: "the record is for another strategy" };
  if (record.rulesHash !== toHex(hashRules(rules))) return { ok: false, unreadable: false, reason: "the record is for other rules" };
  const want = evaluate(rules, record.state);
  if (canonicalize(want as unknown as JsonValue) !== canonicalize(record.decision as unknown as JsonValue)) {
    return { ok: false, unreadable: false, reason: "the recorded decision is not what the rules give for the recorded state" };
  }
  return { ok: true, record };
}

/**
 * Reads a published record. The text must be the canonical form of what it says (so the hash of
 * the bytes read is the hash of the record), the version 1, the rules hash 64 lowercase hex and the
 * state valid. Anything else throws `RulesError` STATE and is "can't check" on the page, never a
 * guess (EC-R25, EC-R31).
 */
export function parseDecisionRecord(text: string): ParsedDecisionRecord {
  const v = obj(strictParse(text), "decision,rules_hash,state,strategy,version", "record");
  const strategy = v["strategy"];
  if (typeof strategy !== "string" || !isAccountId(strategy)) bad("strategy must be a NEAR account id");
  if (v["version"] !== DECISION_RECORD_VERSION) bad("version must be 1");
  const rulesHash = v["rules_hash"];
  if (typeof rulesHash !== "string" || !/^[0-9a-f]{64}$/.test(rulesHash)) bad("rules_hash must be 64 lowercase hex");
  const s = obj(v["state"], "block,closedBy,confirmFromBlock,fees,holdings,nowS,point,position,principal,startedAtS,valuationPoint", "state");
  const pos = s["position"] === null ? null : obj(s["position"], "left,right", "position");
  const closedBy = s["closedBy"];
  if (closedBy !== null && !CLOSE_REASONS.includes(closedBy as CloseReason)) bad("closedBy must be a close reason or null");
  const fees = obj(s["fees"], "base,quote", "fees");
  const holdings = obj(s["holdings"], "base,quote", "holdings");
  const state: MarketState = {
    nowS: int(s["nowS"], "nowS"), startedAtS: int(s["startedAtS"], "startedAtS"), point: int(s["point"], "point"),
    valuationPoint: int(s["valuationPoint"], "valuationPoint"), block: int(s["block"], "block"),
    confirmFromBlock: s["confirmFromBlock"] === null ? null : int(s["confirmFromBlock"], "confirmFromBlock"),
    position: pos === null ? null : { left: int(pos["left"], "position.left"), right: int(pos["right"], "position.right") },
    closedBy: closedBy as CloseReason | null, principal: amt(s["principal"], "principal"),
    holdings: { quote: amt(holdings["quote"], "holdings.quote"), base: amt(holdings["base"], "holdings.base") },
    fees: { quote: amt(fees["quote"], "fees.quote"), base: amt(fees["base"], "fees.base") },
  };
  checkState(state);
  const decision = checkDecision(v["decision"]);
  if (canonicalize(v) !== text) bad("the text is not the canonical form of its content");
  return { rulesHash, strategy: strategy as string, state, decision };
}

/**
 * One on-chain action that carries a decision hash, as the page read it from the contract's `ActionRecord`
 * (INTERFACE section 5). The page passes **every** action that carries the hash; whether an `Open` is paired
 * is derived here, never passed in.
 */
export interface ChainedAction {
  /** The action's `kind`: a Swap or Open carries an `open` decision, a ClosePosition a `close` decision. */
  readonly kind: "Swap" | "Open" | "ClosePosition";
  /** `meta.observed` of the action as the contract recorded it. */
  readonly observed: { readonly block: number; readonly point: number };
  /** The action's own `left_point` and `right_point` (a close has none to compare: null). */
  readonly left: number | null;
  readonly right: number | null;
  /** The record's `timestamp_ns` (the block time of the call that took the lock). */
  readonly timestampNs: bigint;
  /** The record's `result_ts_ns` (when its result was recorded), or null. A Swap's is the start of the pair window. */
  readonly resultTsNs: bigint | null;
  /** The action's position in the contract's `get_actions` order (a paired open has a higher index than its swap). */
  readonly index: number;
  /** The record's result: only an `ok` Swap that used some of its allowance can be the swap an Open pairs with. */
  readonly result: "ok" | "refused" | "failed";
  /** What the Swap actually swapped (the record's `swap_used`), 0 for a no-op; ignored for other kinds. */
  readonly swapUsed: bigint;
}

/**
 * The fields of the record's state that the page rebuilds from chain data at `observed.block`. A field left
 * out cannot be rebuilt and makes the verdict "can't check", never "matching". `valuationPoint` is the spot
 * point in the agent (Q15, "no anchor"): the page rebuilds it from the pool at that block. The page must also
 * rebuild `block` and `point` (the pool's `current_point` read **at** `observed.block`: without them the record's point
 * is only what the agent asserted) and `confirmFromBlock` (the first observation of the confirmation run); the pool
 * point at `confirmFromBlock` is not compared here and stays unverified unless the page reads it itself.
 */
export type RebuiltState = Partial<Omit<MarketState, "confirmFromBlock">> & { readonly confirmFromBlock?: number | null };

export type ChainVerdict =
  | { readonly status: "matching"; readonly record: ParsedDecisionRecord }
  | { readonly status: "not_matching"; readonly reason: string }
  | { readonly status: "cant_check"; readonly reason: string };

/** The only way to read a verdict as a pass: a caller cannot treat "can't check" (a truthy object) as one. */
export function isMatching(v: ChainVerdict): v is Extract<ChainVerdict, { status: "matching" }> {
  return v.status === "matching";
}

const REBUILD_FIELDS = ["block", "point", "nowS", "startedAtS", "valuationPoint", "position", "principal", "holdings", "fees", "closedBy", "confirmFromBlock"] as const;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isAmounts = (v: unknown): boolean => v !== null && typeof v === "object" && typeof (v as { quote?: unknown }).quote === "bigint" && typeof (v as { base?: unknown }).base === "bigint";
const rebuiltFieldOk: Record<(typeof REBUILD_FIELDS)[number], (v: unknown) => boolean> = {
  block: isInt, point: isInt, nowS: isInt, startedAtS: isInt, valuationPoint: isInt, principal: (v) => typeof v === "bigint",
  holdings: isAmounts, fees: isAmounts,
  position: (v) => v === null || (typeof v === "object" && isInt((v as { left?: unknown }).left) && isInt((v as { right?: unknown }).right)),
  closedBy: (v) => v === null || CLOSE_REASONS.includes(v as CloseReason), confirmFromBlock: (v) => v === null || isInt(v),
};

function actionShapeOk(a: unknown): a is ChainedAction {
  if (a === null || typeof a !== "object") return false;
  const o = a as Record<string, unknown>;
  const obs = o["observed"] as { block?: unknown; point?: unknown } | null | undefined;
  return obs !== null && obs !== undefined && typeof obs === "object" && isInt(obs.block) && isInt(obs.point)
    && (o["left"] === null || isInt(o["left"])) && (o["right"] === null || isInt(o["right"]))
    && typeof o["timestampNs"] === "bigint" && (o["resultTsNs"] === null || typeof o["resultTsNs"] === "bigint")
    && isInt(o["index"]) && (o["result"] === "ok" || o["result"] === "refused" || o["result"] === "failed") && typeof o["swapUsed"] === "bigint";
}

/**
 * The page's whole check of a record against the chain (INTERFACE section 5, EC-R35): everything
 * `verifyRecordTextOnly` checks, and every part of `record.state` that is tied to chain data:
 *
 * - at least one **unpaired** action carrying the hash (a Swap, an Open that is not paired, or a close) has an
 *   on-chain `meta.observed` equal to the record's `state.block` and `state.point`; every unpaired action must;
 *   otherwise the record is tied to nothing and the verdict is "can't check";
 * - an `Open` is **paired** only if a `Swap` in `actions` carries the hash and the Open's `timestampNs` is within
 *   `PAIR_WINDOW_S` of that Swap's `resultTsNs` (`isPairedOpen`); a paired open is judged at the swap's
 *   observation, so its own `observed` is not compared, and at most one is allowed;
 * - an `open` decision's `left` and `right` equal the on-chain range of every Swap and Open carrying it;
 * - a Swap or Open carries an `open` decision and a close a `close` decision; an unknown kind is not matching;
 * - every rebuilt field equals the record's; a field not passed is "can't check", a conflicting one is "not
 *   matching".
 *
 * A mismatch is "not matching"; anything unreadable or untied is "can't check". `hold` and `done` records have
 * no on-chain action carrying their hash, so they are always "can't check" (they are context, not actions).
 * Malformed input never throws: it is "can't check".
 */
export function verifyDecisionRecordAgainstChain(text: string, expectedHash: string, rules: RulesV1, strategy: string, actions: readonly (ChainedAction | undefined)[], rebuilt: RebuiltState): ChainVerdict {
  const base = verifyRecordTextOnly(text, expectedHash, rules, strategy);
  if (!base.ok) return base.unreadable ? { status: "cant_check", reason: base.reason } : { status: "not_matching", reason: base.reason };
  const rec = base.record;
  if (!Array.isArray(actions) || actions.length === 0) return { status: "cant_check", reason: "no on-chain action carries this decision hash" };
  actions = Array.from(actions); // a hole becomes undefined, which is not a readable action
  if (rebuilt === null || typeof rebuilt !== "object") return { status: "cant_check", reason: "the rebuilt state is missing" };
  if (!actions.every(actionShapeOk)) return { status: "cant_check", reason: "an on-chain action is not readable" };
  for (const a of actions as readonly ChainedAction[]) if (a.kind !== "Swap" && a.kind !== "Open" && a.kind !== "ClosePosition") return { status: "not_matching", reason: "an action of an unknown kind carries this decision hash" };
  const checked = actions as readonly ChainedAction[];
  // Only an `ok` Swap that swapped something, earlier in the list, can be the swap an Open pairs with (INTERFACE s5).
  const swaps = checked.filter((a) => a.kind === "Swap" && a.result === "ok" && a.swapUsed > 0n && a.resultTsNs !== null);
  const pairedSet = new Set<ChainedAction>();
  try {
    for (const a of checked) {
      if (a.kind === "Open" && swaps.some((s) => s.index < a.index && isPairedOpen(s.resultTsNs as bigint, a.timestampNs))) pairedSet.add(a);
    }
  } catch (e) {
    return { status: "cant_check", reason: `the pair window could not be computed: ${e instanceof Error ? e.message : "error"}` };
  }
  const paired = (a: ChainedAction): boolean => pairedSet.has(a);
  if (pairedSet.size > 1) return { status: "not_matching", reason: "more than one open is paired with the swap" };
  let judged = 0;
  for (const a of checked) {
    const wantsOpen = a.kind !== "ClosePosition";
    if (wantsOpen !== (rec.decision.kind === "open") || (!wantsOpen && rec.decision.kind !== "close")) {
      return { status: "not_matching", reason: `a ${a.kind} action carries a ${rec.decision.kind} decision` };
    }
    if (rec.decision.kind === "open" && (a.left !== rec.decision.left || a.right !== rec.decision.right)) {
      return { status: "not_matching", reason: "the action's on-chain range is not the record's open range" };
    }
    if (paired(a)) continue;
    if (a.observed.block !== rec.state.block || a.observed.point !== rec.state.point) {
      return { status: "not_matching", reason: "the record's block and point are not the action's on-chain observed block and point" };
    }
    judged++;
  }
  if (judged === 0) return { status: "cant_check", reason: "no unpaired action ties this record to an on-chain observation" };
  const missing: string[] = [];
  const mineJson = stateJson(rec.state) as Record<string, JsonValue>;
  for (const f of REBUILD_FIELDS) {
    const got = (rebuilt as Record<string, unknown>)[f];
    if (got === undefined) { missing.push(f); continue; }
    if (!rebuiltFieldOk[f](got)) return { status: "cant_check", reason: `the chain's ${f} could not be read as a state field` };
    let theirs: string;
    try {
      theirs = canonicalize((stateJson({ ...rec.state, [f]: got } as MarketState) as Record<string, JsonValue>)[f] as JsonValue);
    } catch (e) {
      // A rebuilt value that cannot sit in a valid state with the record's other fields conflicts with it.
      if (e instanceof RulesError) return { status: "not_matching", reason: `the chain's ${f} conflicts with the record's state` };
      throw e;
    }
    if (canonicalize(mineJson[f] as JsonValue) !== theirs) return { status: "not_matching", reason: `the record's ${f} is not what the chain shows at its block` };
  }
  if (missing.length > 0) return { status: "cant_check", reason: `not rebuilt from chain data: ${missing.join(", ")}` };
  return { status: "matching", record: rec };
}
