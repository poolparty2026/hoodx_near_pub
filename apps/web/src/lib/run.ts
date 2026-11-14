// The check of one strategy run, from two providers (ARCHITECTURE section 8, EC-W08). Everything is read through
// `readBoth`: a view both providers don't give identically is "unverifiable", never matching. The judging is done by
// @poolside/rules and the per-item checks in checks.ts / missed.ts / account.ts; this file only reads and assembles.
//
// GUESS (unverified, to change at the interface freeze, docs/INTERFACE.md is a draft): the three `fixture:*` methods
// below are not contract views. They stand in for what the live layer will rebuild from archival chain reads
// (Rhea state at the observed block, the grid windows, the account snapshots). A recorded run supplies them; the live
// layer will not, and until it exists the page says it reads recorded runs only.
import {
  parseRules, canonicalize, closeCondition, verifyRecordTextOnly, verifyDecisionRecordAgainstChain, isMatching, type ChainedAction, type ChainVerdict, isPairedOpen, checkConfirmation, confirmGrid, OFFCHAIN_MARGIN_BLOCKS, chainHead, readU128, readU64, strictParse, nsToS, RulesError,
  type CloseReason, type JsonValue, type MarketState, type RulesV1,
} from "@poolside/rules";
import { checkAccountIntegrity, type AccountSnapshot, type SnapshotPair } from "./account.ts";
import { checkAction, checkDecisionRecord, checkRulesReveal, type Finding } from "./checks.ts";
import { checkMissedClose, type CloseRecord, type GridWindow, type MissedInput } from "./missed.ts";
import { readBoth, type Provider } from "./provider.ts";
import type { DecisionLookup } from "./records-host.ts";
import { readAt, stateAtBlock } from "./state.ts";
import { windowsFromViews } from "./windows.ts";
import { verdictOf } from "./verdict-map.ts";
import { parseActionRecord, type ActionRecord } from "./record.ts";
import type { Row } from "../components/Findings.tsx";

export interface RunSource {
  readonly a: Provider;
  readonly b: Provider;
  readonly account: string;
  /** What the page says about where the data came from (a recorded run, one node, ...). Plain text. */
  readonly label?: string;
  /** The final block every view is read at. */
  readonly head: number;
  /** The decision log: the exact published text for a decision hash, or null when it was not published. */
  /** True when the source has no way to supply decision texts at all (a recording without them): reads are "recording incomplete", not "not published". */
  readonly decisionTextsAbsent?: boolean;
  /** Account snapshots are read from `view_account` and `view_access_key_list` at each snapshot block (recorded RPC answers), not from `fixture:account`. */
  readonly accountViews?: boolean;
  /** Missed-close windows are built from views at each 20-block window start (src/lib/windows.ts), not from `fixture:window`. */
  readonly windowViews?: boolean;
  readonly decisionText: (hash: string) => DecisionLookup | Promise<DecisionLookup>;
  /** Account snapshot blocks in order: deploy, start, each action block, settlement, head. */
  readonly snapshotBlocks: readonly number[];
  /**
   * The block of the single creating transaction, established from chain data (account absent at the block before, the
   * creating transaction's shape; EC-W16, EC-W29). Absent means it could not be established: the account check can't be made.
   * `get_deploy_block` is only a hint and is not v1 (frozen INTERFACE), so it must never be used here.
   */
  readonly deployBlock?: number;
  /**
   * Where `deployBlock` came from. "chain": established from chain data (account absent the block before, the creating
   * transaction's shape). "fixture": a stand-in a recorded run supplies; refused unless `allowFixtureViews`, so a live source can't
   * reuse the first sample as its own baseline (audit N1). Absent is "not established".
   */
  readonly deployBlockEvidence?: "chain" | "fixture";
  /** The recovery key the deploy transaction added. */
  readonly recoveryKey: string;
  /** The pinned hash of the audited build. Absent means none is published yet: that check can't be made. */
  readonly pinnedCodeHash?: string;
  /** Where the pins came from, when they are not independent (a recording's own pins.json): added to the pin rows' passing text. */
  readonly pinsNote?: string;
  /** True only for recorded runs: the `fixture:*` views are not chain reads and a live source must never serve them (security M3). */
  readonly allowFixtureViews?: boolean;
  /** The network constants the strategy must use (EC-W14). Absent means none are pinned: that check can't be made. */
  readonly pinnedCounterparties?: { readonly dclContract: string; readonly quoteToken: string; readonly pool: string };
}

const MAX_RECORDS = 64; // INTERFACE: get_actions_len is at most 64

type Json = { [k: string]: JsonValue };
const isObj = (v: JsonValue | undefined): v is Json => v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);

async function readJson(src: RunSource, method: string, args: JsonValue, block = src.head): Promise<JsonValue | undefined> {
  if (method.startsWith("fixture:") && src.allowFixtureViews !== true) return undefined;
  const r = await readBoth(src.a, src.b, { account: src.account, method, args, block });
  if (r.kind !== "agreed") return undefined;
  try { return strictParse(r.value); } catch { return undefined; }
}
const unreadable = (title: string, what: string): Row => ({ title, verdict: "unverifiable", text: `Can't check: ${what} could not be read from both providers, or they disagree.` });

/** Rebuilds a MarketState from the fixture JSON; amounts are decimal strings. Throws RulesError on anything off. */
export function parseState(v: JsonValue | undefined): MarketState {
  if (!isObj(v)) throw new RulesError("STATE", "state must be an object");
  const num = (x: JsonValue | undefined, n: string): number => {
    if (typeof x !== "number") throw new RulesError("STATE", `${n} must be a number`);
    return x;
  };
  const amounts = (x: JsonValue | undefined, n: string) => {
    if (!isObj(x) || typeof x.quote !== "string" || typeof x.base !== "string") throw new RulesError("STATE", `${n} must be {quote, base} strings`);
    return { quote: readU128(x.quote), base: readU128(x.base) };
  };
  const pos = v.position === null ? null : isObj(v.position) ? { left: num(v.position.left, "position.left"), right: num(v.position.right, "position.right") } : (() => { throw new RulesError("STATE", "position must be an object or null"); })();
  return {
    nowS: num(v.nowS, "nowS"), startedAtS: num(v.startedAtS, "startedAtS"), point: num(v.point, "point"),
    valuationPoint: num(v.valuationPoint, "valuationPoint"), block: num(v.block, "block"),
    confirmFromBlock: v.confirmFromBlock === null ? null : num(v.confirmFromBlock, "confirmFromBlock"),
    position: pos, closedBy: (v.closedBy ?? null) as MarketState["closedBy"],
    principal: typeof v.principal === "string" ? readU128(v.principal) : (() => { throw new RulesError("STATE", "principal must be a string"); })(),
    holdings: amounts(v.holdings, "holdings"), fees: amounts(v.fees, "fees"),
  };
}


/** Windows are read 16 at a time so a long run can't open thousands of requests at once. */
async function readWindows(src: RunSource, n: number): Promise<(JsonValue | undefined)[]> {
  const out: (JsonValue | undefined)[] = [];
  for (let i = 0; i < n; i += 16) {
    out.push(...(await Promise.all(Array.from({ length: Math.min(16, n - i) }, (_, k) => readJson(src, "fixture:window", { n: i + k })))));
  }
  return out;
}

async function readRecords(src: RunSource, len: number): Promise<{ records: ActionRecord[]; bad: Row[] }> {
  const records: ActionRecord[] = [];
  const bad: Row[] = [];
  for (let i = 0; i < len; i++) {
    const r = await readBoth(src.a, src.b, { account: src.account, method: "get_action", args: { index: String(i) }, block: src.head });
    const title = `Action ${i + 1}`;
    if (r.kind !== "agreed") { bad.push(unreadable(title, `record ${i}`)); continue; }
    try {
      const rec = parseActionRecord(r.value);
      if (rec.index !== BigInt(i)) throw new RulesError("STATE", "record: index does not match its position");
      records.push(rec);
    } catch (e) {
      if (!(e instanceof RulesError)) throw e;
      bad.push({ title, verdict: "unverifiable", text: "Can't check: the record could not be read." });
    }
  }
  return { records, bad };
}

const worse = (x: Finding, y: Finding): Finding => {
  const rank = { matching: 0, could_not_act: 1, unverifiable: 2, not_matching: 3 } as const;
  return rank[y.verdict] > rank[x.verdict] ? y : x;
};

const DETAIL_MAX = 60;
const short = (t: string): string => (t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX)}...` : t);

/** The decision in the record must be the call the contract recorded: same kind, same range (security H1). */
function decisionMatchesRecord(rec: ActionRecord, d: { readonly kind: string; readonly left?: number; readonly right?: number }): boolean {
  if (rec.kind === "ClosePosition") return d.kind === "close";
  // GUESS: an agent_swap is part of an open decision (v1 has four decisions: hold, open, close, done).
  if (rec.kind === "Open" || rec.kind === "Swap") return d.kind === "open" && d.left === rec.leftPoint && d.right === rec.rightPoint;
  return true;
}

/** Maps the chain-tie result to a finding with an exhaustive switch: "can't check" can never be shown as a pass. */
function chainFinding(v: Exclude<ChainVerdict, { status: "matching" }>): Finding {
  switch (v.status) {
    case "not_matching": return { verdict: verdictOf(v.status), text: `The decision record does not match the chain: ${v.reason}.` };
    case "cant_check": return { verdict: verdictOf(v.status), text: `Can't check this action against the chain: ${v.reason}.` };
    default: {
      const unreachable: never = v;
      void unreachable;
      return { verdict: "unverifiable", text: "Can't check this action: the chain check gave a result this page doesn't know." };
    }
  }
}

/** A backstop: a RulesError from hostile data in one row is that row's "can't check", never the whole run's. */
async function actionRowSafe(...args: Parameters<typeof actionRow>): Promise<Row> {
  const latch = args[5];
  latch.pending = null;
  try { return await actionRow(...args); } catch (e) {
    if (!(e instanceof RulesError)) throw e;
    const rec = args[2];
    return { title: `Action ${Number(rec.index) + 1}: ${rec.kind ?? "unknown kind"}, ${rec.result}`, verdict: "unverifiable", text: "Can't check this action: a value it depends on is out of range." };
  } finally {
    // The latch applies to LATER records only (this close's own state is judged before it), and whether or not this row passed.
    latch.closedBy ??= latch.pending;
    latch.pending = null;
  }
}

async function actionRow(src: RunSource, rules: RulesV1 | null, rec: ActionRecord, records: readonly ActionRecord[], published: boolean, latch: { closedBy: CloseReason | null; pending: CloseReason | null }): Promise<Row> {
  const title = `Action ${Number(rec.index) + 1}: ${rec.kind ?? "unknown kind"}, ${rec.result}${rec.detail !== null ? ` (${short(rec.detail)})` : ""}`;
  if (rec.kind === null) return { title, verdict: "unverifiable", text: "Can't check this action: the contract wrote a kind this page doesn't know." };
  if (rec.kind === "ExitRemove") {
    // An exit removal takes no decision (decision_hash is ""): it only takes the position out after close, so the rules don't judge it.
    return { title, verdict: rec.result === "ok" ? "matching" : "unverifiable", text: rec.result === "ok" ? "No decision record: an exit removal takes the position out after close and is not judged by the rules." : "Can't check this exit removal: the contract did not record it as done." };
  }
  if (rec.result === "unknown_result" || rec.result === "other" || rec.result === "pending") {
    return { title, verdict: "unverifiable", text: "Can't check this action: the contract has no final result for it that this page knows." };
  }
  // Nothing below can be judged without the revealed rules that match the commitment (EC-W09); this comes before any
  // "not published" reading so a run before the reveal is never a verdict against the agent.
  if (rules === null) return { title, verdict: "unverifiable", text: "Can't check: the rules were not revealed." };
  // A paired open (EC-W30) reuses its swap's exact record text, hash and range: the swap must have moved something, the open must
  // follow within the pairing window, only one open may use a swap, and its on-chain range must be the swap's. Its decision, range
  // and hash are judged against the SWAP's record, and its own observed only against the contract's checks.
  let swap: ActionRecord | undefined;
  if (rec.kind === "Open") {
    const same = records.filter((r) => r.kind === "Swap" && r.result === "ok" && r.decisionHash === rec.decisionHash && r.index < rec.index);
    const cand = same[same.length - 1];
    if (cand !== undefined) {
      let inWindow = false;
      try { inWindow = cand.resultTsNs !== null && isPairedOpen(cand.resultTsNs, rec.timestampNs); } catch (e) { if (!(e instanceof RulesError)) throw e; }
      if (cand.swapUsed === null || cand.swapUsed <= 0n || !inWindow) {
        return { title, verdict: "not_matching", text: "The open reuses a swap's decision outside the pairing rule: the swap moved nothing, or the open came too late." };
      }
      if (records.some((r) => r.kind === "Open" && r.index > cand.index && r.index < rec.index && r.decisionHash === cand.decisionHash)) {
        return { title, verdict: "not_matching", text: "A second open uses a swap that an earlier open already used." };
      }
      if (cand.leftPoint !== rec.leftPoint || cand.rightPoint !== rec.rightPoint) {
        return { title, verdict: "not_matching", text: "The paired open's on-chain range is not its swap's range." };
      }
      swap = cand;
    }
  }
  const basis = swap ?? rec;
  const looked = await src.decisionText(rec.decisionHash);
  // A failed read says nothing about whether the text was published: unverifiable, never "missing" and never matching.
  if (typeof looked === "object" && looked !== null) {
    return { title, verdict: "unverifiable", text: looked.reason === "recording"
      ? "Can't check: this recording has no file for this decision record. A recording is a single source and cannot show that a record was never published."
      : looked.reason === "hosts"
      ? "Can't check: the records host is not configured, or only one host is. One host cannot show that a record was never published."
      : "Can't check: the decision records could not be fetched." };
  }
  const text = looked;
  if (text === null && src.decisionTextsAbsent === true) return { title, verdict: "unverifiable", text: "Can't check: this recording has no decision texts (recording incomplete)." };
  // Records are published after the reveal (from Closing). Before that, "not published" is no verdict against the agent.
  if (text === null && !published) return { title, verdict: "unverifiable", text: "The decision record is not published yet: records are published after the reveal." };
  const hashed = checkDecisionRecord(text, rec.decisionHash);
  // The decision record is the whole input of the judging: without a hash match there is nothing to judge (EC-W05).
  if (hashed.verdict !== "matching" || text === null) return { title, ...hashed };
  // The shared check (packages/rules, EC-R31): the hash, a canonical valid record, its rules hash, and evaluate(rules, state) == decision.
  // A committed text that can't be read is the agent's fault: not matching (EC-W18 a); record faults stay unverifiable.
  const v = verifyRecordTextOnly(text, rec.decisionHash, rules, src.account);
  if (!v.ok) {
    // No matching on the library's reason wording: an unreadable committed text and every other refusal are the two classes the library
    // gives (EC-W18 a), and the library's own reason is shown as it is.
    const t = v.unreadable ? "The agent's committed text could not be read." : `The decision record is not valid: ${v.reason}.`;
    return { title, verdict: "not_matching", text: t };
  }
  const parsed = v.record;
  // The close latch (EC-W22, D47): the first Ok close, with the reason its readable, hash-verified decision gives, holds from then on,
  // whether or not this row goes on to fail (a failure is shown on this row only, never cascaded to every later row).
  if (rec.kind === "ClosePosition" && rec.result === "ok" && parsed.decision.kind === "close") latch.pending = parsed.decision.reason;
  if (!decisionMatchesRecord(rec, parsed.decision)) {
    return { title, verdict: "not_matching", text: "The decision record does not describe the call the contract recorded." };
  }
  // A refused or failed close recorded without confirm_observed: what the contract writes on a refusal is unverified, so it can't be
  // tied to the chain (D53: context only). Unverifiable, never a state mismatch.
  if (rec.kind === "ClosePosition" && rec.result !== "ok" && rec.confirmObserved === null) {
    return { title, verdict: "unverifiable", text: "The close was refused or failed and no confirmation was recorded with it, so it can't be checked against the chain; whether a required close was missed is judged by the missed-close check." };
  }
  // The state is rebuilt from public views at the observed block (src/lib/state.ts), never taken from the agent's record.
  let state: MarketState;
  try {
    state = await stateAtBlock(src, { pool: rules.pool, quoteToken: rules.quote_token, closedBy: latch.closedBy, confirmFromBlock: rec.kind === "ClosePosition" ? (rec.confirmObserved?.block ?? null) : null }, basis.observed.block);
  } catch (e) {
    if (!(e instanceof RulesError)) throw e;
    return { title, verdict: "unverifiable", text: "Can't check this action: the market state at its observed block could not be rebuilt from the chain's views." };
  }
  if (state.block !== basis.observed.block || state.point !== basis.observed.point) {
    return { title, verdict: "not_matching", text: "The market state does not match the observation the contract recorded." };
  }
  // The state the agent claims in its record is tied to the chain by the shared check (packages/rules, EC-R35): the record's block and
  // point must be an unpaired on-chain action's observation, an open's range the on-chain range, and every field the page rebuilt must
  // equal the record's. The page passes EVERY action carrying the hash (a refused or failed one only when it is the row being judged),
  // and pairing is derived inside. The one pass test is isMatching; the switch is exhaustive (a new status fails to compile).
  const resultOf = (r: ActionRecord): ChainedAction["result"] => (r.result === "ok" ? "ok" : r.result === "refused" || r.result === "swap_refused" ? "refused" : "failed");
  const toChained = (r: ActionRecord): ChainedAction => ({
    kind: r.kind as ChainedAction["kind"], observed: r.observed, left: r.kind === "ClosePosition" ? null : r.leftPoint, right: r.kind === "ClosePosition" ? null : r.rightPoint,
    timestampNs: r.timestampNs, resultTsNs: r.resultTsNs, index: Number(r.index), result: resultOf(r), swapUsed: r.swapUsed ?? 0n,
  });
  // A decision hash may be used by one unpaired action only (backend, 13 Nov: a refused or failed action that took the lock consumes its
  // hash in the contract, so an honest agent makes a new decision and a new hash after a refusal). EVERY recorded action carrying the
  // hash counts, whatever its result, except the one paired open after its Ok swap; a refused or failed swap never pairs.
  const everyone = records.filter((r) => r.decisionHash === rec.decisionHash && (r.kind === "Swap" || r.kind === "Open" || r.kind === "ClosePosition"));
  const okSwaps = everyone.filter((r) => r.kind === "Swap" && r.result === "ok" && r.resultTsNs !== null);
  const pairedWithOkSwap = (r: ActionRecord): boolean => r.kind === "Open" && okSwaps.some((s) => { try { return isPairedOpen(s.resultTsNs!, r.timestampNs); } catch { return false; } });
  if (everyone.filter((r) => !pairedWithOkSwap(r)).length > 1) {
    return { title, verdict: "not_matching", text: "A decision hash is used by more than one recorded action that is not a paired open." };
  }
  const cv = verifyDecisionRecordAgainstChain(text, rec.decisionHash, rules, src.account, everyone.map(toChained), {
    block: state.block, point: state.point,
    nowS: state.nowS, startedAtS: state.startedAtS, valuationPoint: state.valuationPoint, position: state.position, principal: state.principal,
    holdings: state.holdings, fees: state.fees, closedBy: state.closedBy, confirmFromBlock: state.confirmFromBlock,
  });
  if (!isMatching(cv)) {
    const f = chainFinding(cv);
    return { title, ...f };
  }
  // A close's recorded confirmation must be the observation the state was judged with (EC-W22).
  // (Only an Ok close: a refused one is context under D53 and the contract may record no confirm_observed on a refusal.)
  if (rec.kind === "ClosePosition" && rec.result === "ok" && (rec.confirmObserved === null || state.confirmFromBlock !== rec.confirmObserved.block)) {
    return { title, verdict: "not_matching", text: "The close's recorded confirmation does not match the observation it was judged with." };
  }
  // A close's confirmation (EC-W22): the page rebuilds the states at O1 (confirm_observed), at every grid height between O1 and O2 and
  // at O2 from views, and replays the confirmation with the shared checkConfirmation, as the agent does before it sends a close.
  if (rec.kind === "ClosePosition" && rec.result === "ok" && rec.confirmObserved !== null) {
    const verdict = await confirmationOk(src, rules, rec, state, latch.closedBy);
    if (verdict !== "ok") return { title, ...verdict };
  }
  const judged = worse(hashed, checkAction(rules, state, JSON.stringify(parsed.decision), "agent"));
  // The close latch (EC-W22, D47): the first Ok close, with the reason its verified decision gives, holds from then on.
  // The valuation point is the pool's spot point (Q15): disclosed on every passing row, not only in the general list.
  if (rec.result === "ok") return { title, ...judged, text: judged.verdict === "matching" ? `${judged.text} The valuation point is the pool's spot point; the page cannot check that value.` : judged.text };
  // Refused and failed calls: shown as context, never as an excuse. The page can't yet recompute a refusal from the record
  // (EC-W19), so a refused or failed call never ranks better than unverifiable; an out-of-rules one stays not matching.
  // EC-W13 / EC-W19 (b, c): a required action the contract refused or failed, with no later successful retry of the same kind,
  // is not matching (the page can't reproduce the refusal from a public limit). A later Ok of the same kind is a retry: the
  // refusal can't be reproduced, so the row can't be matching, but the agent did the action: unverifiable. Provider failure
  // and disagreement never get here (they are unverifiable above).
  const retried = records.some((r) => r.kind === rec.kind && r.result === "ok" && r.index > rec.index);
  // D53 and ARCHITECTURE section 8 win for closes: a close is judged by missedClose alone, so a refused close is context here and
  // missedClose (its own row) decides Not matching when the sampling shows it was required and not done.
  const asContext: Finding = judged.verdict !== "matching" ? judged
    : rec.kind === "ClosePosition" ? { verdict: "unverifiable", text: "The close was refused or failed; whether a required close was missed is judged by the missed-close check." }
    : retried ? { verdict: "unverifiable", text: "The call was refused and later retried successfully; the refusal can't be reproduced from a public limit." }
    : { verdict: "not_matching", text: "A required action was refused or failed and was not retried successfully; the refusal can't be reproduced from a public limit." };
  return { title, ...asContext, text: `${asContext.text} The contract recorded this call as ${rec.result.replaceAll("_", " ")}; that is shown here as context, never as an excuse.` };
}

type Failed = { verdict: "not_matching" | "unverifiable"; text: string };
async function confirmationOk(src: RunSource, rules: RulesV1, rec: ActionRecord, o2: MarketState, closedBy: CloseReason | null): Promise<"ok" | Failed> {
  const c = rec.confirmObserved!;
  const cant: Failed = { verdict: "unverifiable", text: "Can't check this close: the states for its confirmation could not be rebuilt from the chain's views." };
  try {
    const at = (block: number) => stateAtBlock(src, { pool: rules.pool, quoteToken: rules.quote_token, closedBy, confirmFromBlock: null }, block);
    const o1 = await at(c.block);
    if (o1.point !== c.point) return { verdict: "not_matching", text: "The close's confirmation point is not the pool's point at the confirmation block." };
    const heights = rec.observed.block >= c.block ? confirmGrid(c.block, rec.observed.block) : [];
    const grid = await Promise.all(heights.map((h) => at(h)));
    const sw = await readAt(src, src.account, "get_settle_window", {}, rec.observed.block);
    if (sw === undefined || !isObj(sw)) return cant;
    const settledFrom = Math.max(Number(readU64(String(sw.settle_until_block))), Number(readU64(String(sw.last_payout_callback_block))) + OFFCHAIN_MARGIN_BLOCKS);
    const v = checkConfirmation(rules, { o1, o2: { ...o2, confirmFromBlock: null }, grid, settledFromBlock: Math.min(settledFrom, rec.observed.block) });
    return v.ok ? "ok" : { verdict: "not_matching", text: `The close's confirmation does not hold: ${v.reason}.` };
  } catch (e) {
    if (e instanceof RulesError) return cant;
    throw e;
  }
}

/** A recorded RPC `view_account` and `view_access_key_list` pair at a block: the code hash, and every key with its permission and nonce. */
async function readSnapshotViews(src: RunSource, block: number, p: Provider): Promise<SnapshotPair["a"]> {
  const [ra, rk] = await Promise.all(["view_account", "view_access_key_list"].map((method) => p.view({ account: src.account, method, args: {}, block })));
  if (!ra?.ok || !rk?.ok) return { ok: false };
  try {
    const a = strictParse(ra.value);
    const k = strictParse(rk.value);
    if (!isObj(a) || typeof a.code_hash !== "string" || a.block_height !== block || !isObj(k) || !Array.isArray(k.keys) || k.block_height !== block) return { ok: false };
    const keys = k.keys.map((x) => {
      if (!isObj(x) || typeof x.public_key !== "string" || !isObj(x.access_key) || typeof x.access_key.nonce !== "number" || !Number.isSafeInteger(x.access_key.nonce)) throw new RulesError("STATE", "key");
      const perm = x.access_key.permission;
      return { publicKey: x.public_key, permission: typeof perm === "string" ? perm : canonicalize(perm as JsonValue), nonce: BigInt(x.access_key.nonce) };
    });
    return { ok: true, value: { block, codeHash: a.code_hash, keys } };
  } catch { return { ok: false }; }
}

async function readSnapshot(src: RunSource, block: number, p: Provider): Promise<SnapshotPair["a"]> {
  if (src.accountViews === true) return readSnapshotViews(src, block, p);
  if (src.allowFixtureViews !== true) return { ok: false };
  const r = await p.view({ account: src.account, method: "fixture:account", args: { block }, block });
  if (!r.ok) return { ok: false };
  try {
    const v = strictParse(r.value);
    if (!isObj(v) || typeof v.codeHash !== "string" || !Array.isArray(v.keys) || typeof v.block !== "number") return { ok: false };
    const keys = v.keys.map((k) => {
      if (!isObj(k) || typeof k.publicKey !== "string" || typeof k.permission !== "string" || typeof k.nonce !== "string") throw new RulesError("STATE", "key");
      return { publicKey: k.publicKey, permission: k.permission, nonce: readU64(k.nonce) };
    });
    const snap: AccountSnapshot = { block: v.block, codeHash: v.codeHash, keys };
    return { ok: true, value: snap };
  } catch { return { ok: false }; }
}

/** The account row: snapshots at every snapshot block from both providers, compared (EC-W02, EC-W07). Exported for tests. */
export async function accountFindingFor(src: RunSource): Promise<{ finding: Finding; pairs: SnapshotPair[] }> {
  const pairs: SnapshotPair[] = [];
  for (const block of src.snapshotBlocks) pairs.push({ block, a: await readSnapshot(src, block, src.a), b: await readSnapshot(src, block, src.b) });
  const creationOk = src.deployBlock !== undefined && (src.deployBlockEvidence === "chain" || (src.deployBlockEvidence === "fixture" && src.allowFixtureViews === true));
  let accountFinding: Finding;
  if (pairs.length === 0) accountFinding = { verdict: "unverifiable", text: "Can't check the account: no snapshots were read." };
  else if (creationOk) accountFinding = checkAccountIntegrity(pairs, src.recoveryKey, src.deployBlock!);
  else {
    // The creation block is not established, so the first sample can't be the baseline of a pass. A change between samples is still a
    // definite finding; no change is only "nothing seen since the first sample".
    const fa = pairs[0]!.a.ok ? pairs[0]!.a.value.keys.find((k) => k.permission === "FullAccess") : undefined;
    const probe = fa === undefined ? undefined : checkAccountIntegrity(pairs, fa.publicKey, pairs[0]!.block);
    accountFinding = probe !== undefined && probe.verdict === "not_matching" ? probe
      : probe !== undefined && probe.verdict === "matching"
        ? { verdict: "unverifiable", text: "No change to the account's keys or code was seen between the first and the last sampled block, but the creation block was not established from chain data, so anything before the first sample is not seen." }
        : { verdict: "unverifiable", text: "Can't check the account: the creation block was not established from chain data." };
  }
  return { finding: accountFinding, pairs };
}

const memo = new WeakMap<RunSource, Promise<Row[]>>();
/** checkRun for a source that is itself cached (a recording parsed once per process): the rows are computed once, so the home page stays fast. */
export function checkRunMemo(src: RunSource): Promise<Row[]> {
  let p = memo.get(src);
  if (p === undefined) { p = checkRun(src); memo.set(src, p); }
  return p;
}

/** Runs every check this version makes. Never throws for bad data: bad data is a row. */
export async function checkRun(src: RunSource): Promise<Row[]> {
  const rows: Row[] = [];
  const status = await readJson(src, "get_status", {});
  const config = await readJson(src, "get_config", {});
  const limits = await readJson(src, "get_limits", {});
  if (typeof status !== "string" || !isObj(config) || typeof config.rules_hash !== "string") {
    return [unreadable("The strategy", "its status and configuration")];
  }
  rows.push({ title: "The strategy's status", verdict: status === "Closed" ? "matching" : "unverifiable",
    text: status === "Closed" ? "The strategy is closed and settled." : `The strategy is ${status === "Running" || status === "Open" || status === "Closing" || status === "Cancelled" ? status.toLowerCase() : "in a state this page doesn't know"}, so the rules are not revealed yet and the rule checks are locked.` });

  // Rules and the commitment (EC-W01, EC-W09). `get_revealed` is the exact text `reveal` hashed (INTERFACE, proposed).
  const revealedV = await readJson(src, "get_revealed", {});
  const revealed = typeof revealedV === "string" ? revealedV : null;
  if (revealedV === undefined) rows.push(unreadable("Rules match the commitment", "the revealed rules"));
  else rows.push({ title: "Rules match the commitment", ...checkRulesReveal(revealed, config.rules_hash) });
  let rules: RulesV1 | null = null;
  if (revealed !== null) { try { rules = parseRules(revealed); } catch (e) { if (!(e instanceof RulesError)) throw e; } }
  if (rules !== null && checkRulesReveal(revealed, config.rules_hash).verdict !== "matching") rules = null; // judge only rules that match

  // An unreadable or oversized log skips only the checks that need the records; the account and pin checks still run.
  let logOk = true;
  let records: ActionRecord[] = [];
  const lenV = await readJson(src, "get_actions_len", {});
  let len = -1;
  if (typeof lenV === "string") { try { len = Number(readU64(lenV)); } catch { len = -1; } }
  if (len < 0) { logOk = false; rows.push(unreadable("The action log", "the number of records")); }
  else if (len > MAX_RECORDS) { logOk = false; rows.push({ title: "The action log", verdict: "unverifiable", text: "Can't check: the contract reports more records than it can hold." }); }
  else {
    const read = await readRecords(src, len);
    records = read.records;
    rows.push(...read.bad);
    const latch: { closedBy: CloseReason | null; pending: CloseReason | null } = { closedBy: null, pending: null };
    for (const rec of records) rows.push(await actionRowSafe(src, rules, rec, records, status === "Closing" || status === "Closed", latch));
  }

  // The decision chain (GUESS: a record's chain_head is the head after it, chainHead(previous head, its decision hash)).
  // Only judged when records carry heads; the v1 agent may leave them null, which the page lists as not checked.
  if (logOk) {
    const chained = records.filter((r) => r.kind !== "ExitRemove" && r.chainHead !== null);
    if (chained.length > 0) rows.push({ title: "The decision log chain matches the heads on chain", ...checkChain(records) });
  }

  // Nothing skipped: a due close is judged by missedClose alone (D53, EC-W23).
  if (!logOk) rows.push({ title: "No close missed at the sampled blocks", verdict: "unverifiable", text: "Can't check for a missed close: the action log could not be read." });
  else if (rules === null) rows.push({ title: "No close missed at the sampled blocks", verdict: "unverifiable", text: "Can't check: the rules were not revealed, or do not match the commitment." });
  else if (records.some((r) => r.kind === "ClosePosition" && (r.result === "pending" || (r.result === "ok" && r.resultBlock === null)))) {
    // A close still in flight, or an Ok close without its result block, can't be placed: never a false "missed" (audit, missed-close inputs).
    rows.push({ title: "No close missed at the sampled blocks", verdict: "unverifiable", text: "Can't check for a missed close: a close is still pending, or has no result block." });
  }
  else if (!isObj(limits) || typeof limits.max_observation_age_blocks !== "string" || typeof limits.min_action_interval_s !== "string" || typeof limits.max_actions_per_24h !== "number") {
    rows.push(unreadable("No close missed at the sampled blocks", "the public limits"));
  } else {
    try {
      let windows: GridWindow[];
      let endBlock = src.head;
      let endS: number;
      if (src.windowViews === true) {
        // Windows from views at each 20-block window start (src/lib/windows.ts); the run ends where the position was last held.
        const w = await windowsFromViews(src, rules, records);
        if (w === undefined) throw new RulesError("STATE", "windows");
        windows = w.windows; endBlock = w.endBlock; endS = w.endS;
      } else {
        // One window per read: strictParse refuses text over MAX_JSON_LENGTH (4,096), so a whole list can't be one view.
        const nV = await readJson(src, "fixture:window_count", {});
        const wv: (JsonValue | undefined)[] | undefined = typeof nV === "number" && Number.isSafeInteger(nV) && nV >= 0 && nV <= 4096
          ? await readWindows(src, nV) : undefined;
        const endV = await readJson(src, "get_closed_at", {});
        if (wv === undefined || typeof endV !== "string") throw new RulesError("STATE", "windows");
        // A window that could not be read from both providers is "unreadable", never a gap (EC-W28).
        windows = wv.map((x) => (x === undefined ? "unreadable" : x === "gap" ? "gap" : parseState(x)));
        endS = nsToS(readU64(endV));
      }
      const closes: CloseRecord[] = records.filter((r) => r.kind === "ClosePosition" && r.resultBlock !== null)
        .map((r) => ({ result: r.result === "ok" ? "Ok" : r.result, o2Block: r.observed.block, resultBlock: r.resultBlock! }));
      const locks = records.filter((r) => r.kind !== "ExitRemove").map((r) => ({ ts: nsToS(r.timestampNs), close: r.kind === "ClosePosition" }));
      const input: MissedInput = {
        rules, windows, closeRecords: closes, end: { block: endBlock, nowS: endS },
        limits: { maxObservationAgeBlocks: Number(readU64(limits.max_observation_age_blocks)), minActionIntervalS: Number(readU64(limits.min_action_interval_s)), maxActionsPer24h: limits.max_actions_per_24h, agentLocks: locks },
      };
      let missed = checkMissedClose(input);
      // A close still due at the end of the sampled range, with no close landed, that the run ended before the allowance ran out:
      // the rules call that "not late yet", which must not read as "no close was missed".
      const lastState = [...windows].reverse().find((x): x is MarketState => typeof x !== "string");
      if (missed.verdict === "matching" && lastState !== undefined && lastState.position !== null && !closes.some((c) => c.result === "Ok" && c.resultBlock >= lastState.block)) {
        try {
          if ((lastState.closedBy ?? closeCondition(rules, lastState)) !== null) {
            missed = { verdict: "unverifiable", text: "A close was due at the last sampled block and none landed before the run ended, but the run ended before the allowance for a late close ran out, so the page cannot call it missed." };
          }
        } catch (e) { if (!(e instanceof RulesError)) throw e; }
      }
      rows.push({ title: "No close missed at the sampled blocks", ...missed });
    } catch (e) {
      if (!(e instanceof RulesError)) throw e;
      rows.push(unreadable("No close missed at the sampled blocks", "the sampled windows"));
    }
  }

  // No outside interference with the account (EC-W02, EC-W07), and the code is the pinned audited build (EC-W15).
  const { finding: accountFinding, pairs } = await accountFindingFor(src);
  rows.push({ title: "No change to the account's keys or code at the sampled blocks", ...accountFinding });
  const first = pairs[0] === undefined ? undefined : (pairs[0].a.ok && pairs[0].b.ok && pairs[0].a.value.codeHash === pairs[0].b.value.codeHash ? pairs[0].a.value.codeHash : undefined);
  rows.push({ title: "The code hash equals the pinned hash",
    ...(src.pinnedCodeHash === undefined ? { verdict: "unverifiable" as const, text: "Can't check: no audited build hash is pinned yet." }
      : first === undefined ? { verdict: "unverifiable" as const, text: "Can't check: the code hash could not be read from both providers." }
      : first === src.pinnedCodeHash ? { verdict: "matching" as const, text: `The deployed code hash equals the pinned hash.${src.pinsNote ?? ""}` }
      : { verdict: "not_matching" as const, text: "The deployed code hash differs from the pinned hash." }) });
  // Pinned counterparties (EC-W14): dcl_contract, quote_token and the pool must be the network constants.
  const pins = src.pinnedCounterparties;
  rows.push({ title: "The strategy uses the pinned counterparties",
    ...(pins === undefined ? { verdict: "unverifiable" as const, text: "Can't check: no network constants are pinned yet." }
      : !isObj(limits) || typeof config.dcl_contract !== "string" || typeof config.quote_token !== "string" || typeof limits.pool !== "string"
        ? { verdict: "unverifiable" as const, text: "Can't check: the strategy's counterparties could not be read." }
      : config.dcl_contract === pins.dclContract && config.quote_token === pins.quoteToken && limits.pool === pins.pool
        ? { verdict: "matching" as const, text: `The DCL contract, quote token and pool equal the pinned constants.${src.pinsNote ?? ""}` }
      : { verdict: "not_matching" as const, text: "The DCL contract, quote token or pool differs from the pinned constants." }) });
  return rows;
}

/**
 * Each trading record's chain_head must be chainHead(the previous trading record's chain_head, its decision hash); the first
 * follows from null. The hashes come from the contract's own records, so no index is needed. GUESS: a record's chain_head is
 * the head after it. A record without a head among records that have them can't be chained: unverifiable.
 */
function checkChain(records: readonly ActionRecord[]): Finding {
  let prev: string | null = null;
  let known = true; // whether `prev` is the head before this record (null is the start, a known value)
  let unlinked = false;
  let lastIndex = -1n;
  for (const r of records) {
    // A record that could not be read leaves a hole in the indexes: the head before the next record is unknown (can't check, never a mismatch).
    if (r.index !== lastIndex + 1n) { known = false; unlinked = true; }
    lastIndex = r.index;
    if (r.kind === "ExitRemove") continue; // no decision, so no link
    if (r.chainHead === null) { unlinked = true; known = false; continue; }
    if (!known) { unlinked = true; prev = r.chainHead; known = true; continue; } // this link can't be checked; resync
    if (r.chainHead !== chainHead(prev, r.decisionHash)) {
      return { verdict: "not_matching", text: `Action ${Number(r.index) + 1}'s chain head does not follow from the previous head and its decision.` };
    }
    prev = r.chainHead;
  }
  return unlinked
    ? { verdict: "unverifiable", text: "Can't check the decision chain: some actions record no head, or could not be read." }
    : { verdict: "matching", text: "Each action's chain head follows from the one before and its decision." };
}
