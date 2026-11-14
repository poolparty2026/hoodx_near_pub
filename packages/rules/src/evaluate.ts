import { RulesError } from "./errors.ts";
import { MAX_POINT, MIN_POINT, baseToQuote } from "./price.ts";
import { parsePoolId, type RulesV1 } from "./schema.ts";
import { U128_MAX } from "./swap.ts";
import { CONFIRM_MAX_BLOCKS, DENSE_STEP_BLOCKS, MISSED_CLOSE_GRACE_S, OFFCHAIN_MARGIN_BLOCKS } from "./constants.ts";

export { MIN_POINT, MAX_POINT } from "./price.ts";

/** Token amounts in smallest units, split into the quote token and the other (base) token. */
export interface Amounts {
  readonly quote: bigint;
  readonly base: bigint;
}

/**
 * The state evaluate needs. Every field is rebuilt from public data by both
 * the agent and the check page (architecture section 4, "State inputs").
 * No clock, network or randomness is read here (EC-R06).
 */
export interface MarketState {
  /** Block timestamp (seconds, floored) of the observation or sample block. */
  readonly nowS: number;
  /** Block timestamp (seconds, floored) of the `start` transaction. */
  readonly startedAtS: number;
  /** DCL `current_point` at that block. Used for range decisions. */
  readonly point: number;
  /**
   * Point used to value holdings and fees for stop loss and take profit.
   * Shipped: the pool's spot `current_point` at that block (Q15 is provisional,
   * "no anchor"). A one-block spot move is not what guards a close: a close needs
   * two confirming observations (D53, `confirmFromBlock`).
   */
  readonly valuationPoint: number;
  /** Height of the observation or sample block (`O2` for a close). */
  readonly block: number;
  /**
   * Height of the first observation of the current unbroken run of observations at
   * which the same close condition held (`O1`), or null: the `fromBlock` of
   * `nextConfirmRun` (EC-R30). Ignored when no close condition holds.
   */
  readonly confirmFromBlock: number | null;
  /** The strategy's own position (from its action records), or null. Half-open [left, right). */
  readonly position: { readonly left: number; readonly right: number } | null;
  /** Set once the agent has recorded a close decision; latches the outcome (H2). */
  readonly closedBy: CloseReason | null;
  /** Quote-token smallest units deposited. */
  readonly principal: bigint;
  /** Everything the strategy holds: tokens, position amounts and Rhea internal balances. */
  readonly holdings: Amounts;
  /** Fees earned: collected plus unclaimed on the position. */
  readonly fees: Amounts;
}

export type CloseReason = "time" | "stop_loss" | "take_profit";
export const CLOSE_REASONS: readonly CloseReason[] = Object.freeze(["time", "stop_loss", "take_profit"]);

/**
 * Rule format v1 has no size choices: an open adds all the strategy holds (after the
 * swap step), and DCL takes what the range needs. v1 has no `rebalance` and no
 * `claim_fees` decision (D47); withinRules refuses both by name (EC-R29).
 */
export type Decision =
  | { readonly kind: "hold" }
  | { readonly kind: "open"; readonly left: number; readonly right: number }
  | { readonly kind: "close"; readonly reason: CloseReason }
  | { readonly kind: "done" };

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function bad(msg: string): never {
  throw new RulesError("STATE", msg);
}
function checkInt(n: unknown, name: string, lo: number, hi: number): void {
  // -0 is refused like canonicalize refuses it, so the envelope and the canonical form agree.
  if (typeof n !== "number" || !Number.isSafeInteger(n) || Object.is(n, -0) || n < lo || n > hi) bad(`${name} must be an integer between ${lo} and ${hi}`);
}
function checkAmounts(a: unknown, name: string): void {
  if (a === null || typeof a !== "object") bad(`${name} must be an object`);
  const o = a as Record<string, unknown>;
  for (const k of ["quote", "base"]) {
    if (typeof o[k] !== "bigint" || (o[k] as bigint) < 0n) bad(`${name}.${k} must be a non-negative bigint`);
    // Token amounts are u128 on NEAR; the Rust valuation needs U512 for the products (rules-verifier L-1).
    if ((o[k] as bigint) > U128_MAX) bad(`${name}.${k} must fit in u128`);
  }
}

export function checkState(s: MarketState): void {
  if (s === null || typeof s !== "object") bad("state must be an object");
  checkInt(s.nowS, "nowS", 0, Number.MAX_SAFE_INTEGER);
  checkInt(s.startedAtS, "startedAtS", 0, s.nowS);
  checkInt(s.point, "point", MIN_POINT, MAX_POINT);
  checkInt(s.valuationPoint, "valuationPoint", MIN_POINT, MAX_POINT);
  checkInt(s.block, "block", 0, Number.MAX_SAFE_INTEGER);
  if (s.confirmFromBlock !== null) checkInt(s.confirmFromBlock, "confirmFromBlock", 0, s.block);
  if (s.position !== null) {
    if (typeof s.position !== "object") bad("position must be an object or null");
    checkInt(s.position.left, "position.left", MIN_POINT, MAX_POINT);
    checkInt(s.position.right, "position.right", MIN_POINT, MAX_POINT);
    if (s.position.left >= s.position.right) bad("position must have left < right");
  }
  if (s.closedBy !== null && !CLOSE_REASONS.includes(s.closedBy)) bad("closedBy must be a close reason or null");
  if (typeof s.principal !== "bigint" || s.principal < 0n) bad("principal must be a non-negative bigint");
  if (s.principal > U128_MAX) bad("principal must fit in u128");
  checkAmounts(s.holdings, "holdings");
  checkAmounts(s.fees, "fees");
}

// Floor and ceiling division toward -infinity and +infinity. Exact here (|a| is
// about 802,500 at most, b is a small point spacing). Rust's `/` truncates toward
// zero, so the Rust mirror must use `a.div_euclid(b)` for floor (b > 0) and an
// explicit ceiling, or ranges at negative points come out one spacing off
// (rules-verifier, re-audit of 6decefb). Shared vectors: test/vectors/target_range.json (EC-R23).
const floorDiv = (a: number, b: number): number => Math.floor(a / b);
// `+ 0` turns -0 into 0: Math.ceil(-0.75) is -0, which canonicalize refuses (rules-verifier M-1).
// targetRange normalises its result as well; either one alone is enough.
const ceilDiv = (a: number, b: number): number => Math.ceil(a / b) + 0;

/** Whether the quote token is the pool's token_x. */
export function quoteIsX(rules: RulesV1): boolean {
  return parsePoolId(rules.pool).tokenX === rules.quote_token;
}

/** Value of some amounts in quote units at `point`, rounded down. */
export function valueInQuote(rules: RulesV1, point: number, a: Amounts): bigint {
  checkAmounts(a, "amounts");
  return a.quote + baseToQuote(a.base, point, quoteIsX(rules));
}

/**
 * The target range around a centre point: half of width_bps (1 point ≈ 1 bp)
 * on each side, rounded outward to the pool's point spacing. Returns null if
 * no such range fits inside DCL's bounds while containing the centre (H1, L1).
 */
export function targetRange(rules: RulesV1, centre: number): { left: number; right: number } | null {
  const { pointDelta } = parsePoolId(rules.pool);
  const half = Math.floor(rules.range.width_bps / 2);
  const left = floorDiv(centre - half, pointDelta) * pointDelta;
  const right = ceilDiv(centre + half, pointDelta) * pointDelta;
  if (left < MIN_POINT || right > MAX_POINT || !(left <= centre && centre < right)) return null;
  return { left: left + 0, right: right + 0 };
}

/** The first close condition that holds, in a fixed order: time, stop loss, take profit. */
export function closeCondition(rules: RulesV1, s: MarketState): CloseReason | null {
  if (s.nowS - s.startedAtS >= rules.close_after_s) return "time";
  if (s.principal > 0n) {
    const value = valueInQuote(rules, s.valuationPoint, s.holdings);
    if (value * 10_000n <= s.principal * BigInt(10_000 - rules.stop_loss_bps)) return "stop_loss";
    const fees = valueInQuote(rules, s.valuationPoint, s.fees);
    if (fees * 10_000n >= s.principal * BigInt(rules.take_profit_bps)) return "take_profit";
  }
  return null;
}

/**
 * Whether the close condition is confirmed at this observation: it held from `O1`
 * (`confirmFromBlock`) to this block with OFFCHAIN_MARGIN_BLOCKS <= block - O1 <=
 * CONFIRM_MAX_BLOCKS, the same bounds the contract checks on `confirm_observed`
 * (principle 6, EC-R30). Every close needs it, time included, because the contract
 * can't see which condition fired.
 */
export function closeConfirmed(s: MarketState): boolean {
  if (s.confirmFromBlock === null) return false;
  const span = s.block - s.confirmFromBlock;
  return span >= OFFCHAIN_MARGIN_BLOCKS && span <= CONFIRM_MAX_BLOCKS;
}

/** The close condition due now, latched or live, without regard to confirmation: what a sample shows. */
export function closeDue(rules: RulesV1, s: MarketState): CloseReason | null {
  checkState(s);
  return s.closedBy ?? closeCondition(rules, s);
}

/** A running confirmation: the first observation `O1` of the current run, and the condition it confirms. */
export interface ConfirmRun {
  readonly fromBlock: number;
  readonly reason: CloseReason;
}

/**
 * The confirmation run after this observation, given the previous one (EC-R30). The
 * agent calls it at every observation, and checkConfirmation replays it for the page,
 * so both carry `O1` the same way:
 * - null when no close condition holds (a false reading restarts it);
 * - a new run at this block when none was running; when the earlier `O1` is below
 *   `settledFromBlock` (a later payout or lock made it unsettled, so the contract would
 *   refuse it); or when keeping it would put the span above CONFIRM_MAX_BLOCKS (it
 *   restarts at this, the latest true observation);
 * - otherwise the earlier run's `O1`, with `reason` the condition due now.
 * A run confirms that **some** close condition was due at every observation (D53, rules
 * re-audit security M-1): the contract can't see the reason, a change between stop loss
 * and take profit doesn't restart it, and the close's reason is the one due at `O2`.
 * The latched `closedBy` counts as holding, so a retry after a recorded close is
 * confirmed on the latch alone (EC-W22).
 * `settledFromBlock` is the latest of `quiet_since_block` and
 * `last_payout_callback_block + OFFCHAIN_MARGIN_BLOCKS` at this block; an observation
 * below it isn't one (principle 6) and is refused.
 */
export function nextConfirmRun(rules: RulesV1, s: MarketState, prev: ConfirmRun | null, settledFromBlock: number): ConfirmRun | null {
  checkState(s);
  checkInt(settledFromBlock, "settledFromBlock", 0, s.block);
  if (prev !== null) {
    if (typeof prev !== "object") bad("prev must be a confirmation run or null");
    checkInt(prev.fromBlock, "prev.fromBlock", 0, s.block);
    if (!CLOSE_REASONS.includes(prev.reason)) bad("prev.reason must be a close reason");
  }
  const reason = s.closedBy ?? closeCondition(rules, s);
  if (reason === null) return null;
  const restart = prev === null || prev.fromBlock < settledFromBlock || s.block - prev.fromBlock > CONFIRM_MAX_BLOCKS;
  return Object.freeze({ fromBlock: restart ? s.block : prev.fromBlock, reason });
}

export type ConfirmationVerdict = { readonly ok: true; readonly run: ConfirmRun } | { readonly ok: false; readonly reason: string };

/** What checkConfirmation judges: one close record and the states around it. */
export interface ConfirmationInput {
  /** The states at the close record's `confirm_observed.block` (O1) and `observed.block` (O2). `closedBy` in every state comes only from close records before this one. */
  readonly o1: MarketState;
  readonly o2: MarketState;
  /**
   * The states at exactly the heights `confirmGrid(O1, O2)`. Every height between O1 and
   * O2 is settled, so each is its own grid point (`gridPoint`). A height with no block
   * (NEAR may skip heights: none in 2,000 consecutive mainnet heights, 9 November 2026)
   * has the state after the latest block below it. The agent carries its confirmation
   * over the same grid states, so the agent and every page judge the same blocks.
   */
  readonly grid: readonly MarketState[];
  /** The latest of `quiet_since_block` and `last_payout_callback_block + OFFCHAIN_MARGIN_BLOCKS`, read at O2. */
  readonly settledFromBlock: number;
}

/**
 * Checks a close's confirmation (EC-W22): replays nextConfirmRun over O1, the grid states
 * in between and O2, and requires the run never to restart and the span to be within
 * bounds at O2. The agent (before it sends a close) and the page both use this one
 * function. Returns a verdict for every input it can read, refused closes included; throws
 * only on a malformed input.
 */
export function checkConfirmation(rules: RulesV1, i: ConfirmationInput): ConfirmationVerdict {
  const no = (r: string): ConfirmationVerdict => ({ ok: false, reason: r });
  if (i === null || typeof i !== "object") bad("confirmation input must be an object");
  checkState(i.o1);
  checkState(i.o2);
  checkInt(i.settledFromBlock, "settledFromBlock", 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(i.grid)) bad("grid must be an array");
  for (const s of i.grid) checkState(s);
  const o1 = i.o1.block, o2 = i.o2.block;
  if (o1 > o2) return no("O1 is after O2");
  // The endpoints first: a close whose O1 or O2 shows nothing due is "not matching" whatever the grid (re-audit security F1).
  for (const s of [i.o1, i.o2]) if ((s.closedBy ?? closeCondition(rules, s)) === null) return no(`no close condition holds at block ${s.block}`);
  const windows = confirmGrid(o1, o2);
  const grid = [...i.grid].sort((a, b) => a.block - b.block);
  if (grid.length !== windows.length || grid.some((s, k) => s.block !== windows[k])) bad("grid must hold the states at exactly confirmGrid(O1, O2)");
  const states = [i.o1, ...grid, i.o2];
  for (let k = 1; k < states.length; k++) if (states[k]!.nowS < states[k - 1]!.nowS) bad("state timestamps must not decrease");
  if (i.settledFromBlock > o2) return no("O2 is inside the payout margin");
  if (o1 < i.settledFromBlock) return no("O1 is before the settled block");
  if (o1 === o2) return no("the confirmation span is out of bounds");
  let run: ConfirmRun | null = null;
  for (const s of states) {
    run = nextConfirmRun(rules, s, run, i.settledFromBlock);
    if (run === null) return no(`no close condition holds at block ${s.block}`);
    if (run.fromBlock !== o1) return no(`the confirmation restarted at block ${s.block}`);
  }
  if (!closeConfirmed({ ...i.o2, confirmFromBlock: run!.fromBlock })) return no("the confirmation span is out of bounds");
  return { ok: true, run: run! };
}

/** One page sample (EC-W23): the state at a window's `gridPoint`, or at a close's O2. */
export interface Sample {
  readonly state: MarketState;
}

/**
 * The windows between a close's O1 and O2 (exclusive) that checkConfirmation requires a
 * state in: the start of each, every multiple of DENSE_STEP_BLOCKS strictly between them.
 * At most CONFIRM_MAX_BLOCKS / 20 for a span checkConfirmation can accept; none above it.
 */
export function confirmGrid(o1Block: number, o2Block: number): number[] {
  checkInt(o1Block, "o1Block", 0, Number.MAX_SAFE_INTEGER);
  checkInt(o2Block, "o2Block", o1Block, Number.MAX_SAFE_INTEGER);
  if (o2Block - o1Block > CONFIRM_MAX_BLOCKS) return [];
  const out: number[] = [];
  for (let b = (Math.floor(o1Block / DENSE_STEP_BLOCKS) + 1) * DENSE_STEP_BLOCKS; b < o2Block; b += DENSE_STEP_BLOCKS) out.push(b);
  return out;
}

/** What the page reads at one height of a window: whether the strategy is quiet there, and its settled-from block there. */
export interface HeightState {
  /** `is_quiet()` at that height: no lock held and no unresolved `unknown_add`. */
  readonly quiet: boolean;
  /** The latest of `quiet_since_block` and `last_payout_callback_block + OFFCHAIN_MARGIN_BLOCKS`, read at that height. */
  readonly settledFromBlock: number;
}

/**
 * The block a `DENSE_STEP_BLOCKS` window is sampled at, for the agent and the page alike
 * (EC-W21, EC-W27): the first height in the window at which the strategy is quiet and the
 * height is at or after the settled-from block read **at that same height**, else none
 * (the window gives no sample, a gap, which never ends a stretch). `heights[k]` is the
 * reading at `windowStart + k`, all `DENSE_STEP_BLOCKS` of them; a height with no block
 * takes the reading of the latest block below it. Reading each height, not the start
 * only, means a callback or a lock inside the window can't make the chosen height
 * unsettled (rules re-audit security L-1, test F2).
 */
/** The largest window start whose 20 heights are all safe integers. */
export const MAX_WINDOW_START = Math.floor((Number.MAX_SAFE_INTEGER - (DENSE_STEP_BLOCKS - 1)) / DENSE_STEP_BLOCKS) * DENSE_STEP_BLOCKS;

export function gridPoint(windowStart: number, heights: readonly HeightState[]): number | null {
  // The last window whose every height is a safe integer (test re-audit L-3).
  checkInt(windowStart, "windowStart", 0, MAX_WINDOW_START);
  if (windowStart % DENSE_STEP_BLOCKS !== 0) bad("windowStart must be a multiple of DENSE_STEP_BLOCKS");
  if (!Array.isArray(heights) || heights.length !== DENSE_STEP_BLOCKS) bad("heights must hold one reading per height of the window");
  // Every reading is checked before one is chosen, so bad page data anywhere in the window is refused (test L-5).
  for (const h of heights) {
    if (h === null || typeof h !== "object" || typeof h.quiet !== "boolean") bad("each height reading must be { quiet, settledFromBlock }");
    checkInt(h.settledFromBlock, "settledFromBlock", 0, Number.MAX_SAFE_INTEGER);
  }
  for (let k = 0; k < DENSE_STEP_BLOCKS; k++) if (heights[k]!.quiet && heights[k]!.settledFromBlock <= windowStart + k) return windowStart + k;
  return null;
}

/** One lock of the agent's trading calls (refused ones included), as the contract's interval and 24-hour count see it. */
export interface AgentLock {
  /** Block timestamp, seconds. */
  readonly ts: number;
  /** Whether it was `agent_close_position`; a close attempt never moves the missed-close anchor. */
  readonly close: boolean;
}

/** A successful close of the agent's (an `Ok` ClosePosition record): its `observed.block` and its result block. Refused and failed closes are not closes here. */
export interface LandedClose {
  readonly o2Block: number;
  readonly resultBlock: number;
}

/** The public limits and the agent's own record that missedClose needs. */
export interface MissedCloseLimits {
  readonly maxObservationAgeBlocks: number;
  readonly minActionIntervalS: number;
  readonly maxActionsPer24h: number;
  /** Every lock of the agent's trading calls, refused ones included, in time order. */
  readonly agentLocks: readonly AgentLock[];
  /** The agent's successful closes. */
  readonly closes: readonly LandedClose[];
  /**
   * The last height the page judged (the run's end, or the head while it runs) and its
   * timestamp. A stretch followed only by gaps up to here is measured to here, so locks or
   * payout windows that leave no samples can't cut it short (rules re-audit security M-1).
   */
  readonly endBlock: number;
  readonly endS: number;
  /**
   * Block heights with their timestamps, read from the chain by the page (any blocks, quiet
   * or not; they carry no state). When the agent could first act inside any gap of more
   * than one window (trailing or inside a stretch), the page includes the last block before
   * that moment and the first block at or after it, as consecutive entries at adjacent
   * heights; the allowance counts blocks from the second and seconds from the moment
   * itself, exactly (rules re-audit test M-1, security L-1). A height skipped between the two
   * is refused, so the verdict is "can't check" there (none skipped in 2,000 mainnet
   * heights, `docs/gates/3`). Cross-checked
   * against the samples and the end of the range: a block with two timestamps, or
   * timestamps that decrease with height, is refused (security L-2). Optional; refused as
   * missing only when such a gap needs it.
   */
  readonly clock?: readonly { readonly block: number; readonly nowS: number }[];
}

export type MissedCloseFinding = {
  /** `missed`: held past the allowance with no close; `late_close`: a close landed past it; `single`: one true sample alone, "can't check" for that condition. */
  readonly kind: "missed" | "late_close" | "single";
  readonly reason: CloseReason;
  readonly fromBlock: number;
  readonly toBlock: number;
};

/**
 * The check page's missed-close rule (D53, principle 6, EC-W23). A stretch is consecutive
 * grid samples at which some close condition is due (latched or live) and a position is held;
 * a change between conditions continues it, and its reason is the one due at its last
 * sample. **Nothing anyone sends ends a stretch** (D53): not a lock, a pause, a refused or
 * failed close, an action of the agent or a gap between samples; only a sample where no
 * condition is due or no position is held, or the agent's successful close, does. The
 * samples are the grid samples, at most one per `DENSE_STEP_BLOCKS` window, plus the state
 * at each close's O2; the agent's own observations are never samples, so it can't choose
 * which readings count (rules re-audit security F3), and it carries its confirmation over
 * the same grid. A stretch is judged from its anchor, the first sample at or after the
 * later of its start and the time the agent could first act: its last non-close lock at or
 * before the stretch's first sample plus `minActionIntervalS`, and the time the 24-hour
 * count frees a slot if it was full. In v1 a non-close lock (`agent_swap`, `agent_open`)
 * needs no position held, so it is always before a stretch; a close attempt never moves
 * the anchor, since a failed close is the agent's own (D53; re-audit security F1, test F3).
 * A stretch runs through gaps (windows with no sample): if the sample that ends it, or
 * `endBlock`, is more than one window after its last due sample, it is measured to that
 * sample or to `endBlock`; when the agent could first act inside any such gap, trailing
 * or inside the stretch, the allowance counts from the page's `clock` point there, so the agent's own locks can't empty the windows after a due
 * condition and leave a one-sample stretch (rules re-audit security M-1). Outsiders can
 * cause such gaps too; that counts against the agent (T71, disclosed). It is `missed` (or `late_close`, ended by a close whose O2 is in it) when it is
 * held past the anchor by more than CONFIRM_MAX_BLOCKS + maxObservationAgeBlocks blocks
 * and MISSED_CLOSE_GRACE_S seconds. The agent's own actions inside a stretch never move
 * the anchor. A stretch of one sample not covered by a close is `single`. Samples from a
 * close's O2 to its result block are covered by that close; the page samples each
 * close's O2 block (refused otherwise).
 */
export function missedClose(rules: RulesV1, samples: readonly Sample[], limits: MissedCloseLimits): MissedCloseFinding[] {
  if (!Array.isArray(samples)) bad("samples must be an array");
  if (limits === null || typeof limits !== "object") bad("limits must be an object");
  checkInt(limits.maxObservationAgeBlocks, "maxObservationAgeBlocks", 0, Number.MAX_SAFE_INTEGER);
  checkInt(limits.minActionIntervalS, "minActionIntervalS", 0, Number.MAX_SAFE_INTEGER);
  checkInt(limits.maxActionsPer24h, "maxActionsPer24h", 1, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(limits.agentLocks) || !Array.isArray(limits.closes)) bad("agentLocks and closes must be arrays");
  const locks = limits.agentLocks;
  locks.forEach((l, k) => {
    if (l === null || typeof l !== "object" || typeof l.close !== "boolean") bad("each lock must be { ts, close }");
    checkInt(l.ts, "lock ts", 0, Number.MAX_SAFE_INTEGER);
    if (k > 0 && l.ts < locks[k - 1]!.ts) bad("agentLocks must be in time order");
    // The contract allows a lock only while fewer than maxActionsPer24h are in (t - 86,400, t].
    const m = limits.maxActionsPer24h;
    if (k >= m && l.ts - locks[k - m]!.ts < 86_400) bad("agentLocks has more locks in 24 hours than maxActionsPer24h allows");
  });
  checkInt(limits.endBlock, "endBlock", 0, Number.MAX_SAFE_INTEGER);
  checkInt(limits.endS, "endS", 0, Number.MAX_SAFE_INTEGER);
  const clock = limits.clock ?? [];
  if (!Array.isArray(clock)) bad("clock must be an array");
  clock.forEach((c, k) => {
    if (c === null || typeof c !== "object") bad("each clock point must be { block, nowS }");
    checkInt(c.block, "clock block", 0, Number.MAX_SAFE_INTEGER);
    checkInt(c.nowS, "clock nowS", 0, Number.MAX_SAFE_INTEGER);
    if (k > 0 && (c.block <= clock[k - 1]!.block || c.nowS < clock[k - 1]!.nowS)) bad("clock must be in strictly increasing block order with timestamps not decreasing");
  });
  for (const c of limits.closes) {
    if (c === null || typeof c !== "object") bad("each close must be an object");
    checkInt(c.o2Block, "o2Block", 0, Number.MAX_SAFE_INTEGER);
    checkInt(c.resultBlock, "resultBlock", c.o2Block, Number.MAX_SAFE_INTEGER);
  }
  // A close is judged at its O2, so the page samples that block too (rules-verifier L-3).
  const sampled = new Set(samples.map((x) => (x !== null && typeof x === "object" ? x.state?.block : undefined)));
  for (const c of limits.closes) if (!sampled.has(c.o2Block)) bad("a sample is needed at every close's O2 block");
  const out: MissedCloseFinding[] = [];
  // When the agent could first act, for a stretch whose first sample is at `startS`.
  const actFrom = (startS: number): number => {
    const opens = locks.filter((l) => !l.close && l.ts <= startS);
    let from = opens.length > 0 ? opens[opens.length - 1]!.ts + limits.minActionIntervalS : startS;
    const day = locks.filter((l) => l.ts <= startS && l.ts > startS - 86_400).map((l) => l.ts);
    if (day.length >= limits.maxActionsPer24h) from = Math.max(from, day[day.length - limits.maxActionsPer24h]! + 86_400);
    return Math.max(from, startS);
  };
  type Run = { all: MarketState[]; reason: CloseReason };
  const win = (b: number) => Math.floor(b / DENSE_STEP_BLOCKS);
  // `next` is what ended the stretch without a close: a sample, or the end of the judged range.
  const judge = (run: Run, closedAt: number | null, next: { block: number; nowS: number } | null = null): void => {
    const first = run.all[0]!;
    const lastDue = closedAt === null ? run.all[run.all.length - 1]! : run.all.find((s) => s.block === closedAt)!;
    const last = closedAt === null && next !== null && win(next.block) > win(lastDue.block) + 1 ? next : lastDue;
    const from = actFrom(first.nowS);
    // The anchor is the first sample at or after `from`, or the end point of a trailing gap. If it lies more than one
    // window after the latest stretch sample before `from`, `from` fell inside a gap (trailing or inside the stretch):
    // blocks count from the clock point the page read there, the first block at or after `from`, which must be the
    // height right after a clock entry before `from`, so it is exact; seconds count from `from` itself.
    let anchor: { block: number; nowS: number } | undefined = run.all.find((s) => s.nowS >= from && s.block <= last.block) ?? (last.nowS >= from && last !== lastDue ? last : undefined);
    const before = [...run.all].reverse().find((s) => s.nowS < from);
    if (anchor !== undefined && before !== undefined && win(anchor.block) > win(before.block) + 1) {
      const k = clock.findIndex((p) => p.nowS >= from && p.block > before.block && p.block <= anchor!.block);
      if (k === -1) bad("clock needs the first block at or after the time the agent could first act, inside a gap");
      // The pair must be adjacent heights, the first before the moment: then the second is exactly the first block at
      // or after it. A height skipped between them can't be shown to be empty, so it is refused too ("can't check").
      if (k === 0 || clock[k - 1]!.nowS >= from || clock[k - 1]!.block !== clock[k]!.block - 1) {
        bad("clock needs the last block before the time the agent could first act, just before the first at or after it");
      }
      anchor = clock[k]!;
    }
    const late = anchor !== undefined
      && last.block - anchor.block > CONFIRM_MAX_BLOCKS + limits.maxObservationAgeBlocks
      && last.nowS - from > MISSED_CLOSE_GRACE_S;
    const kind = late ? (closedAt !== null ? "late_close" : "missed") : run.all.length === 1 && closedAt === null ? "single" : null;
    if (kind !== null) out.push(Object.freeze({ kind, reason: run.reason, fromBlock: first.block, toBlock: last.block }));
  };
  let run: Run | null = null;
  let prev: MarketState | null = null;
  let lastWindow = -1;
  for (const x of samples) {
    if (x === null || typeof x !== "object") bad("each sample must be an object");
    const s = x.state;
    checkState(s);
    if (prev !== null && s.block <= prev.block) bad("samples must be in strictly increasing block order");
    if (prev !== null && s.nowS < prev.nowS) bad("sample timestamps must not decrease");
    // At most one grid sample per window; a close's O2 state is the one extra sample allowed.
    const isO2 = limits.closes.some((c) => c.o2Block === s.block);
    if (!isO2) {
      const w = Math.floor(s.block / DENSE_STEP_BLOCKS);
      if (w === lastWindow) bad("samples must be at most one per grid window, besides each close's O2");
      lastWindow = w;
    }
    prev = s;
    const covering = limits.closes.find((c) => s.block >= c.o2Block && s.block <= c.resultBlock);
    const due = s.closedBy ?? closeCondition(rules, s);
    const isTrue = due !== null && s.position !== null;
    if (run !== null && !isTrue) { judge(run, null, s); run = null; }
    if (!isTrue) continue;
    if (covering !== undefined) {
      // Covered by a successful close: the stretch it ends is judged up to that close's O2.
      if (run !== null) { run.all.push(s); judge(run, covering.o2Block); run = null; }
      continue;
    }
    if (run === null) run = { all: [s], reason: due! };
    else { run.all.push(s); run.reason = due!; }
  }
  if (prev !== null && (limits.endBlock < prev.block || limits.endS < prev.nowS)) bad("endBlock and endS must be at or after the last sample");
  // Every (block, timestamp) the page gave, in block order: one timestamp per block, never decreasing (security L-2).
  const pts: { block: number; nowS: number }[] = [...clock, { block: limits.endBlock, nowS: limits.endS }, ...samples.map((x) => ({ block: x.state.block, nowS: x.state.nowS }))];
  pts.sort((a, b) => a.block - b.block);
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!, b = pts[k]!;
    if ((a.block === b.block && a.nowS !== b.nowS) || b.nowS < a.nowS) bad("clock points, samples and the end of the range must agree: one timestamp per block, never decreasing");
  }
  if (run !== null) judge(run, null, { block: limits.endBlock, nowS: limits.endS });
  return out;
}

/** The deterministic decision for this state. A close waits for its confirmation (EC-R30). */
export function evaluate(rules: RulesV1, s: MarketState): Decision {
  checkState(s);
  const reason = s.closedBy ?? closeCondition(rules, s);
  if (reason !== null) {
    if (s.position === null) return { kind: "done" };
    return closeConfirmed(s) ? { kind: "close", reason } : { kind: "hold" };
  }
  if (s.position === null) {
    const range = targetRange(rules, s.point);
    return range ? { kind: "open", ...range } : { kind: "hold" };
  }
  return { kind: "hold" };
}

/** Validates an action's shape at runtime: it may come from a model (M1, EC-A02). */
function parseAction(a: unknown): Decision | string {
  if (a === null || typeof a !== "object" || Array.isArray(a)) return "action must be an object";
  const o = a as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  switch (o["kind"]) {
    case "rebalance":
      return "rebalance is not available in v1";
    case "claim_fees":
      return "claim_fees is not available in v1";
    case "hold": case "done":
      return keys === "kind" ? (o as Decision) : "unexpected fields";
    case "close":
      if (keys !== "kind,reason") return "unexpected fields";
      return CLOSE_REASONS.includes(o["reason"] as CloseReason) ? (o as Decision) : "unknown close reason";
    case "open":
      if (keys !== "kind,left,right") return "unexpected fields";
      for (const k of ["left", "right"]) {
        const v = o[k];
        if (typeof v !== "number" || !Number.isSafeInteger(v) || Object.is(v, -0) || v < MIN_POINT || v > MAX_POINT) return `${k} must be an integer point`;
      }
      return o as Decision;
    default:
      return "unknown action";
  }
}

/**
 * Whether an action is inside the rules' envelope (EC-R07). `rebalance` and
 * `claim_fees` are refused in v1 (EC-R29). A due close can't be answered with any
 * other action, except that while it waits for its confirmation `hold` is the only
 * answer (EC-R30); the close reason must match; a new range must be exactly
 * targetRange(observed point) (EC-R22), with no tolerance of any kind.
 */
export function withinRules(rules: RulesV1, s: MarketState, action: unknown): Verdict {
  checkState(s);
  const no = (r: string): Verdict => ({ ok: false, reason: r });
  const parsed = parseAction(action);
  if (typeof parsed === "string") return no(parsed);
  const due = s.closedBy ?? closeCondition(rules, s);
  if (due !== null) {
    if (s.position === null) return parsed.kind === "done" || parsed.kind === "hold" ? { ok: true } : no("a close condition holds");
    const confirmed = closeConfirmed(s);
    if (parsed.kind !== "close") return parsed.kind === "hold" && !confirmed ? { ok: true } : no("a close condition holds");
    if (parsed.reason !== due) return no("close reason doesn't match the condition that holds");
    if (confirmed) return { ok: true };
    return s.confirmFromBlock !== null && s.block - s.confirmFromBlock > CONFIRM_MAX_BLOCKS
      ? no("the confirmation span is above CONFIRM_MAX_BLOCKS")
      : no("the close condition isn't confirmed yet");
  }
  switch (parsed.kind) {
    case "hold":
      return { ok: true };
    case "close":
      return no("no close condition holds");
    case "done":
      return no("the strategy isn't done");
    case "open": {
      if (s.position !== null) return no("a position is already open");
      if (!(parsed.left <= s.point && s.point < parsed.right)) return no("range must contain the current point");
      // Exactly the target range at the observed point (D28: the agent sends the points
      // it computed from its observation). An earlier tolerance of one point spacing let
      // ranges sit off-centre in ways the contract's centring rule refuses (security
      // re-audit of d473dcd, L-1), and served no purpose once actions are judged at the
      // observed point.
      const t0 = targetRange(rules, s.point);
      if (t0 === null || parsed.left !== t0.left || parsed.right !== t0.right) return no("range isn't the rules' target range at the observed point");
      return { ok: true };
    }
  }
}

/**
 * The action the rules require at this observation, or null when nothing is required
 * (EC-R08). A close waiting for its confirmation requires nothing yet, so this alone
 * can't find a missed close at sparse samples: the check page uses missedClose.
 */
export function requiredAction(rules: RulesV1, s: MarketState): Decision | null {
  const d = evaluate(rules, s);
  return d.kind === "hold" || d.kind === "done" ? null : d;
}
