// SAMPLE DATA ONLY. Hand-made runs to exercise the check page before the chain views exist.
// They are never read from a chain and the page that shows them says so.
import { DENSE_STEP_BLOCKS, CONFIRM_MAX_BLOCKS, decisionHash, decisionRecordText, evaluate, hashRules, parseRules, toHex, type MarketState } from "@poolside/rules";
import { checkAction, checkDecisionRecord, checkRulesReveal, type Finding } from "./checks.ts";
import { checkMissedClose, type GridWindow } from "./missed.ts";
import type { Row } from "../components/Findings.tsx";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const RULES_OBJ = {
  version: 1, pool: `${USDC}|wrap.near|100`, quote_token: USDC, range: { width_bps: 800, centre: "mid" },
  take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432_000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};
const RULES_TEXT = JSON.stringify(RULES_OBJ);
const RULES = parseRules(RULES_TEXT);
const HASH = toHex(hashRules(RULES));
const LIMITS = { maxObservationAgeBlocks: 10, minActionIntervalS: 300, maxActionsPer24h: 6, agentLocks: [] };

const flat: MarketState = {
  nowS: 10_000, startedAtS: 1_000, point: -400, valuationPoint: -400, block: 50_000, confirmFromBlock: null, position: null,
  closedBy: null, principal: 250_000_000n, holdings: { quote: 250_000_000n, base: 0n }, fees: { quote: 0n, base: 0n },
};
const stopLoss = (b: number): MarketState => ({
  ...flat, nowS: 1_000_000 + b, startedAtS: 900_000 + b, block: b, point: 0, valuationPoint: 0,
  position: { left: -400, right: 400 }, holdings: { quote: 1n, base: 0n },
});
const heldFor = (to: number): GridWindow[] => {
  const w: GridWindow[] = [];
  for (let b = 0; b <= to; b += DENSE_STEP_BLOCKS) w.push(stopLoss(b));
  return w;
};

export const SAMPLE_CASES = ["good", "tampered-rules", "missed-close", "not-revealed"] as const;
export type SampleCase = (typeof SAMPLE_CASES)[number];

export function sampleRows(c: SampleCase): Row[] {
  // One record feeds both checks: the text the agent committed to by hash is the action that is judged.
  const decision = evaluate(RULES, flat);
  const record = decisionRecordText(RULES, flat, decision, "strategy.sample.near");
  const recordHash = decisionHash(record);
  const revealed = c === "tampered-rules" ? JSON.stringify({ ...RULES_OBJ, stop_loss_bps: 5000 }) : c === "not-revealed" ? null : RULES_TEXT;
  const allowance = CONFIRM_MAX_BLOCKS + LIMITS.maxObservationAgeBlocks;
  const to = c === "missed-close" ? allowance + 40 : 200;
  const closes = c === "missed-close" ? [] : [{ result: "Ok" as const, o2Block: 200, resultBlock: 202 }];
  const end = c === "missed-close" ? to : 202;
  // Without the revealed rules, nothing that depends on them can be checked (EC-W09).
  const needsRules = (f: Finding): Finding =>
    revealed === null ? { verdict: "unverifiable", text: "Can't check: the rules were not revealed." } : f;
  return [
    { title: "Rules match the commitment", ...checkRulesReveal(revealed, HASH) },
    { title: "Decision record matches its hash", ...checkDecisionRecord(record, recordHash) },
    { title: "Action 1 is within the rules", ...needsRules(checkAction(RULES, flat, JSON.stringify(decision), "agent")) },
    { title: "No close missed at the sampled blocks", ...needsRules(checkMissedClose({
      rules: RULES, windows: heldFor(to), limits: LIMITS, closeRecords: closes, end: { block: end, nowS: 1_000_000 + end } })) },
  ];
}
