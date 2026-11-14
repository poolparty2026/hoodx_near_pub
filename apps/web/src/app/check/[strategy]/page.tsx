import { SampleBanner } from "@/components/SampleBanner.tsx";
import { Findings } from "@/components/Findings.tsx";
import { VERDICT_MOOD, VERDICT_TEXT } from "@/lib/verdict.ts";
import { Hoody } from "@/components/Hoody.tsx";
import { buildFixture, parseFixtureId } from "@/lib/fixtures.ts";
import { checkRun, checkRunMemo } from "@/lib/run.ts";
import { loadScenario, parseScenarioId } from "@/lib/scenario.ts";
import { RulesError } from "@poolside/rules";

export const dynamic = "force-dynamic";

export default async function CheckPage({ params }: { params: Promise<{ strategy: string }> }) {
  const { strategy } = await params;
  const fixture = parseFixtureId(strategy);
  const scenario = parseScenarioId(strategy);
  let scenarioRows: Awaited<ReturnType<typeof checkRun>> | null = null;
  let scenarioLabel = "";
  if (scenario !== null) {
    try { const src = loadScenario(scenario); scenarioLabel = src.label ?? ""; scenarioRows = await checkRunMemo(src); }
    catch (e) { if (!(e instanceof RulesError)) throw e; }
  }
  return (
    <section className="py-6">
      <h1 className="text-2xl font-bold">Check a strategy</h1>
      {/* Rendered as plain text by React; never as HTML (EC-W04). */}
      <p className="mt-1 break-all text-muted">{strategy}</p>
      {scenario !== null ? (
        scenarioRows !== null ? (
          <>
            <p className="mt-3 rounded-lg bg-butter px-3 py-1.5 text-xs font-bold text-navy">{scenarioLabel}</p>
            <Findings rows={scenarioRows} />
          </>
        ) : (
          <p className="card mt-6 p-4 text-sm text-muted">Unverifiable: the recording for this run could not be read, so nothing was checked.</p>
        )
      ) : fixture === null ? (
        <div className="card mt-6 flex items-center gap-4 p-4">
          <Hoody mood={VERDICT_MOOD.unverifiable} size={72} label={VERDICT_TEXT.unverifiable} />
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-muted">Result</p>
            <p className="mt-1 text-2xl font-bold">{VERDICT_TEXT.unverifiable}</p>
            <p className="mt-2 text-sm text-muted">
              This page reads recorded runs only for now. Reading a live strategy from two RPC providers is not built yet, so nothing about this account has been checked.
            </p>
          </div>
        </div>
      ) : (
        <>
          <SampleBanner />
          <Findings rows={await checkRun(buildFixture(fixture).source)} />
        </>
      )}
    </section>
  );
}
