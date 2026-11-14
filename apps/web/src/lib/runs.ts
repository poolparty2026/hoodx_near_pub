// The runs a visitor can open from the home page, with the verdict the page computes for each. Nothing here is a real strategy:
// "fixture-*" are made by hand, "scenario-*" are recordings of a local sandbox (one node, read twice).
import { RulesError } from "@poolside/rules";
import { buildFixture, type FixtureCase } from "./fixtures.ts";
import { checkRun, checkRunMemo } from "./run.ts";
import { loadScenario, type ScenarioCase } from "./scenario.ts";
import { worst, type Verdict } from "./verdict.ts";

export interface RunCard { readonly id: string; readonly title: string; readonly kind: "hand-made" | "sandbox recording"; readonly note: string }

export const RUN_CARDS: readonly RunCard[] = [
  { id: "fixture-good", title: "A run that matches", kind: "hand-made", note: "Every check this version makes passes on this hand-made data (see \"Not checked\" on the run)." },
  { id: "fixture-tampered-rules", title: "Rules changed after the commitment", kind: "hand-made", note: "The revealed rules do not hash to the commitment." },
  { id: "fixture-missed-close", title: "A close that was due and not sent", kind: "hand-made", note: "The page names the blocks." },
  { id: "scenario-good", title: "Sandbox good run", kind: "sandbox recording", note: "Made by a real agent against a local sandbox. Its actions, records and sampling check out; the creation block can't be established, so it reads Unverifiable." },
  { id: "scenario-bad-tampered-rules", title: "Sandbox run with tampered rules", kind: "sandbox recording", note: "The same run with the rules text changed after the commitment." },
  { id: "scenario-no-agent-close", title: "Sandbox run without an agent close", kind: "sandbox recording", note: "The agent never closed. The page's own sampling finds the time close due for about 15 minutes and never sent: a missed close." },
];

export interface CardVerdict { readonly verdict: Verdict; /** A recording that carries no decision texts: shown as "recording incomplete", not as an agent failure. */ readonly incomplete: boolean }

/** The verdict of one card. A recording that can't be read is Unverifiable, never a guess and never Matching. */
export async function cardVerdict(id: string): Promise<CardVerdict> {
  try {
    const src = id.startsWith("fixture-") ? buildFixture(id.slice("fixture-".length) as FixtureCase).source : loadScenario(id.slice("scenario-".length) as ScenarioCase);
    const rows = id.startsWith("scenario-") ? await checkRunMemo(src) : await checkRun(src);
    return { verdict: worst(rows.map((r) => r.verdict)), incomplete: src.decisionTextsAbsent === true && worst(rows.map((r) => r.verdict)) === "unverifiable" };
  } catch (e) {
    if (e instanceof RulesError) return { verdict: "unverifiable", incomplete: false };
    throw e;
  }
}
export const verdictFor = async (id: string): Promise<Verdict> => (await cardVerdict(id)).verdict;
