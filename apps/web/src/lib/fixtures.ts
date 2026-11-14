// RECORDED-RUN FIXTURES, made by hand. They are not recordings of a chain: the backend's scenario harness will
// write real ones, and this file changes to read that format (docs/MINIMAL_PLAN.md section 4). The page that uses
// them says so. The view names `fixture:*` are the GUESSED stand-ins described in run.ts.
import {
  CONFIRM_MAX_BLOCKS, DENSE_STEP_BLOCKS, OFFCHAIN_MARGIN_BLOCKS, confirmGrid, decisionHash, decisionRecordText, canonicalize, evaluate, hashRules, parseRules, stateJson, toHex, type Decision, type MarketState,
} from "@poolside/rules";
import type { RunSource } from "./run.ts";
import { recordedProvider, type RecordedFile } from "./provider.ts";
import type { JsonValue } from "@poolside/rules";

export const FIXTURE_CASES = ["wrong-pool", "refused-close", "retried-close", "paired-open", "out-of-rules", "good", "tampered-rules", "missed-close", "not-revealed", "code-changed", "tampered-decision", "providers-disagree"] as const;
export type FixtureCase = (typeof FIXTURE_CASES)[number];
export const FIXTURE_PREFIX = "fixture-";
export const fixtureId = (c: FixtureCase): string => `${FIXTURE_PREFIX}${c}`;
export const parseFixtureId = (id: string): FixtureCase | null => {
  const c = id.startsWith(FIXTURE_PREFIX) ? id.slice(FIXTURE_PREFIX.length) : "";
  return (FIXTURE_CASES as readonly string[]).includes(c) ? (c as FixtureCase) : null;
};

const ACCOUNT = "strategy.fixture.near";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const RULES_OBJ = {
  version: 1, pool: `${USDC}|wrap.near|100`, quote_token: USDC, range: { width_bps: 800, centre: "mid" },
  take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432_000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};
const RULES_TEXT = JSON.stringify(RULES_OBJ);
const RULES = parseRules(RULES_TEXT);
const HASH = toHex(hashRules(RULES));
const DCL = "dclv2.ref-labs.near";
const POOL = `${USDC}|wrap.near|100`;
const CODE = "a".repeat(44);
const REC_KEY = "ed25519:recovery";

const flat: MarketState = {
  nowS: 1_000_050, startedAtS: 900_000, point: -400, valuationPoint: -400, block: 50, confirmFromBlock: null, position: null,
  closedBy: null, principal: 250_000_000n, holdings: { quote: 250_000_000n, base: 0n }, fees: { quote: 0n, base: 0n },
};
const stopLoss = (b: number): MarketState => ({
  ...flat, nowS: 1_000_000 + b, startedAtS: 900_000, block: b, point: 0, valuationPoint: 0,
  position: { left: -400, right: 400 }, holdings: { quote: 1n, base: 0n },
});
const retryState = (): MarketState => ({ ...stopLoss(201), confirmFromBlock: 201 - OFFCHAIN_MARGIN_BLOCKS });
const closeState = (): MarketState => ({ ...stopLoss(200), confirmFromBlock: 200 - OFFCHAIN_MARGIN_BLOCKS });

function record(i: number, kind: string, state: MarketState, decision: string, resultBlock: number | null, result: JsonValue) {
  // Frozen shape (INTERFACE section 5): a close carries `remove` with its confirm_observed; an open carries `open`.
  const extra = kind === "ClosePosition"
    ? { open: null, remove: { position: "1", liquidity: "1", confirm_observed: { block: String(state.confirmFromBlock ?? 0), point: state.point } } }
    : { open: kind === "Open" ? { lpt_id: null } : null, remove: null };
  const d = (JSON.parse(decision) as { decision: { left?: number; right?: number } }).decision;
  return JSON.stringify({
    index: String(i), op_id: String(i + 1), kind, caller: "agent.fixture.near", left_point: d.left ?? -400, right_point: d.right ?? 400,
    observed: { block: String(state.block), point: state.point }, reference: null, decision_hash: decisionHash(decision), chain_head: null,
    call_block: String(state.block + 1), timestamp_ns: String((1_000_000 + state.block + 1) * 1_000_000_000),
    result_block: resultBlock === null ? null : String(resultBlock), result_ts_ns: resultBlock === null ? null : String((1_000_000 + resultBlock) * 1_000_000_000), result, round: null, swap: kind === "Swap" ? { token_in: USDC, amount_in: "1", min_out: "1", used: "1" } : null, ...extra,
  });
}

/** A record that lies (its decision is not what the rules give), built by hand so no app code imports the test-only builder. */
function lyingRecordText(rules: typeof RULES, state: MarketState, decision: Decision, strategy: string): string {
  return canonicalize({ decision: decision as unknown as JsonValue, rules_hash: toHex(hashRules(rules)), state: stateJson(state), strategy, version: 1 });
}
const BASE_TOKEN = "wrap.near";
const LPT = `${POOL}#1`;
type Put = (account: string, method: string, args: JsonValue, v: JsonValue, block: number) => unknown;
/** The recorded views a state at its block is made of: the inverse of src/lib/state.ts, so a round trip is testable. */
function viewsFor(st: MarketState, put: Put): void {
  const b = st.block;
  const at = (account: string, method: string, args: JsonValue, v: JsonValue) => put(account, method, args, v, b);
  at("near", "block", { block_id: b }, { header: { height: b, timestamp: String(st.nowS * 1_000_000_000) } });
  at(ACCOUNT, "get_started_at", {}, String(st.startedAtS * 1_000_000_000));
  at(ACCOUNT, "get_principal", {}, String(st.principal));
  at(ACCOUNT, "get_own_position", {}, st.position === null ? null : LPT);
  at(ACCOUNT, "get_fees_collected", {}, { quote: String(st.fees.quote), base: String(st.fees.base) });
  at(DCL, "get_pool", { pool_id: POOL }, { pool_id: POOL, token_x: USDC, token_y: BASE_TOKEN, current_point: st.point });
  at(DCL, "list_user_assets", { account_id: ACCOUNT }, {});
  const inPosition = st.position !== null;
  at(USDC, "ft_balance_of", { account_id: ACCOUNT }, String(inPosition ? 0n : st.holdings.quote));
  at(BASE_TOKEN, "ft_balance_of", { account_id: ACCOUNT }, String(inPosition ? 0n : st.holdings.base));
  at(ACCOUNT, "get_platform_owed", { token: USDC }, "0");
  at(ACCOUNT, "get_platform_owed", { token: BASE_TOKEN }, "0");
  if (st.position !== null) {
    at(DCL, "get_liquidity", { lpt_id: LPT }, { lpt_id: LPT, owner_id: ACCOUNT, pool_id: POOL, left_point: st.position.left, right_point: st.position.right, amount: "1", unclaimed_fee_x: "0", unclaimed_fee_y: "0" });
    at(DCL, "predict_remove_liquidity", { lpt_id: LPT, amount: "1" }, [String(st.holdings.quote), String(st.holdings.base)]);
  }
}

export interface Fixture { readonly source: RunSource; readonly files: readonly [RecordedFile, RecordedFile]; readonly log: ReadonlyMap<string, string> }

export function buildFixture(c: FixtureCase): Fixture {
  const missed = c === "missed-close";
  const long = missed || c === "refused-close";
  const head = long ? CONFIRM_MAX_BLOCKS + 10 + 40 + 2 : c === "retried-close" ? 203 : 202;
  const windowsTo = long ? head - 2 : 200;
  // out-of-rules: the agent opens a range the rules don't give. Record and decision text agree with each other and with the hash,
  // so only the rules judgement (checkAction) can catch it.
  const openText = c === "out-of-rules" ? lyingRecordText(RULES, flat, { kind: "open", left: -1600, right: -800 }, ACCOUNT) : decisionRecordText(RULES, flat, evaluate(RULES, flat) as Decision, ACCOUNT);
  const closeText = decisionRecordText(RULES, closeState(), evaluate(RULES, closeState()) as Decision, ACCOUNT);
  const decisions = new Map<string, string>([[decisionHash(openText), openText], [decisionHash(closeText), closeText]]);
  const records = [record(0, c === "paired-open" ? "Swap" : "Open", flat, openText, 52, "Ok")];
  // A paired open reuses its swap's exact record text and hash; its own observed is a later block (judged only by the contract).
  if (c === "paired-open") records.push(record(1, "Open", { ...flat, block: 55, nowS: flat.nowS + 5 }, openText, 56, "Ok"));
  if (c === "refused-close") records.push(record(1, "ClosePosition", closeState(), closeText, 202, { Refused: "drift" }));
  else if (c === "retried-close") {
    // An honest retry after a refusal is a NEW decision at a new observation (block 201), so a new record and hash.
    const retryText = decisionRecordText(RULES, retryState(), evaluate(RULES, retryState()) as Decision, ACCOUNT);
    decisions.set(decisionHash(retryText), retryText);
    records.push(record(1, "ClosePosition", closeState(), closeText, 201, { Refused: "drift" }));
    records.push(record(2, "ClosePosition", retryState(), retryText, 203, "Ok"));
  } else if (c === "paired-open") records.push(record(2, "ClosePosition", closeState(), closeText, 202, "Ok"));
  else if (!missed) records.push(record(1, "ClosePosition", closeState(), closeText, 202, "Ok"));
  const windows: JsonValue[] = [];
  for (let b = 0; b <= windowsTo; b += DENSE_STEP_BLOCKS) windows.push(stateJson(stopLoss(b)));
  const revealed = c === "tampered-rules" ? JSON.stringify({ ...RULES_OBJ, stop_loss_bps: 5000 }) : c === "not-revealed" ? null : RULES_TEXT;
  const blocks = [10, 100, head];
  const snap = (block: number, code: string): JsonValue => ({
    block, codeHash: code, keys: [
      { publicKey: REC_KEY, permission: "FullAccess", nonce: "5" },
      { publicKey: "ed25519:agent", permission: "FunctionCall:agent_swap", nonce: String(block) },
    ],
  });
  const responses = (disagree: boolean): RecordedFile["responses"] => {
    const r: { account: string; method: string; args: JsonValue; block: number; text: string }[] = [];
    const add = (method: string, args: JsonValue, v: JsonValue | string, block = head) =>
      r.push({ account: ACCOUNT, method, args, block, text: typeof v === "string" && method === "get_action" ? v : JSON.stringify(v) });
    add("get_status", {}, disagree ? "Running" : "Closed");
    add("get_config", {}, { rules_hash: HASH, agent: "agent.fixture.near", dcl_contract: DCL, quote_token: USDC });
    add("get_limits", {}, { max_observation_age_blocks: "10", min_action_interval_s: "300", max_actions_per_24h: 6, pool: c === "wrong-pool" ? `${USDC}|evil.near|100` : POOL });
    add("get_revealed", {}, revealed);
    add("get_actions_len", {}, String(records.length));
    records.forEach((t, i) => add("get_action", { index: String(i) }, t));
    add("get_started_at", {}, String(900_000 * 1_000_000_000));
    add("get_closed_at", {}, String((1_000_000 + head) * 1_000_000_000));
    // The views the page rebuilds a state from, at each observed block (src/lib/state.ts), made from the states above.
    const states = [flat, closeState()];
    // the close's confirmation: O1 and the grid heights between O1 and O2 (a stop loss held throughout), and the settle window at O2
    for (const b of [200 - OFFCHAIN_MARGIN_BLOCKS, ...confirmGrid(200 - OFFCHAIN_MARGIN_BLOCKS, 200)]) states.push(stopLoss(b));
    add("get_settle_window", {}, { last_payout_callback_block: "0", settle_window_class: "Outsider", settle_until_block: "0" }, 200);
    if (c === "paired-open") states.push({ ...flat, block: 55, nowS: flat.nowS + 5 });
    if (c === "retried-close" || c === "refused-close") states.push(closeState());
    if (c === "retried-close") {
      for (const b of [201 - OFFCHAIN_MARGIN_BLOCKS, ...confirmGrid(201 - OFFCHAIN_MARGIN_BLOCKS, 201)]) states.push(stopLoss(b));
      states.push(retryState());
      add("get_settle_window", {}, { last_payout_callback_block: "0", settle_window_class: "Outsider", settle_until_block: "0" }, 201);
    }
    for (const st of new Map(states.map((x) => [x.block, x] as const)).values()) viewsFor(st, (account, method, args, v, block) => r.push({ account, method, args, block, text: JSON.stringify(v) }));
    add("fixture:window_count", {}, windows.length);
    windows.forEach((w, n) => add("fixture:window", { n }, w));
    for (const b of blocks) add("fixture:account", { block: b }, snap(b, c === "code-changed" && b === head ? "b".repeat(44) : CODE), b);
    return r;
  };
  const files = [
    { provider: "fixture-a", run: c, responses: responses(false) },
    { provider: "fixture-b", run: c, responses: responses(c === "providers-disagree") },
  ] as const;
  const log = new Map(decisions);
  if (c === "tampered-decision") log.set(decisionHash(openText), openText.replace("-", "+"));
  return {
    files, log,
    source: {
      a: recordedProvider(files[0]), b: recordedProvider(files[1]), account: ACCOUNT, head,
      decisionText: (h) => log.get(h) ?? null, snapshotBlocks: blocks, recoveryKey: REC_KEY, allowFixtureViews: true, deployBlock: blocks[0]!, deployBlockEvidence: "fixture", pinnedCodeHash: CODE, pinnedCounterparties: { dclContract: DCL, quoteToken: USDC, pool: POOL },
    },
  };
}

/** A source made only of the views a set of states is rebuilt from (src/lib/state.ts), for round-trip tests of the rebuild. */
export function stateViewsSource(states: readonly MarketState[], head = 1000, dropFromB: (method: string) => boolean = () => false, extra: (put: (account: string, method: string, args: JsonValue, v: JsonValue, block: number) => unknown) => void = () => undefined): RunSource {
  const r: { account: string; method: string; args: JsonValue; block: number; text: string }[] = [];
  const put = (account: string, method: string, args: JsonValue, v: JsonValue, block: number) => r.push({ account, method, args, block, text: JSON.stringify(v) });
  put(ACCOUNT, "get_config", {}, { rules_hash: HASH, dcl_contract: DCL, quote_token: USDC }, head);
  put(ACCOUNT, "get_limits", {}, { pool: POOL }, head);
  for (const st of states) viewsFor(st, put);
  extra(put);
  const file: RecordedFile = { provider: "state-views", run: "state-views", responses: r };
  const fileB: RecordedFile = { ...file, provider: "state-views-b", responses: r.filter((x) => !dropFromB(x.method)) };
  return { a: recordedProvider(file), b: recordedProvider(fileB), account: ACCOUNT, head, decisionText: () => null, snapshotBlocks: [], recoveryKey: "" };
}
export const STATE_CONTEXT: { pool: string; quoteToken: string } = { pool: POOL, quoteToken: USDC };
export const FIXTURE_STATES = { flat, close: closeState };
