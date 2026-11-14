import { Journey } from "@/components/Journey.tsx";
import { Findings } from "@/components/Findings.tsx";
import { checkRunMemo } from "@/lib/run.ts";
import { loadScenario } from "@/lib/scenario.ts";
import { RulesError } from "@poolside/rules";

export const dynamic = "force-dynamic";

export default async function JourneyPage() {
  let verdict: React.ReactNode;
  try {
    const src = loadScenario("good");
    verdict = (<><p className="rounded-lg bg-butter px-3 py-1.5 text-xs font-bold text-navy">{src.label}</p><Findings rows={await checkRunMemo(src)} /></>);
  } catch (e) {
    if (!(e instanceof RulesError)) throw e;
    verdict = <p className="card p-4 text-sm text-muted">Unverifiable: the recording could not be read, so nothing was checked.</p>;
  }
  return (
    <section className="py-6">
      <h1 className="text-2xl font-bold">The whole process: a guided simulation</h1>
      <p className="mt-2 text-sm text-muted">Eight steps from a creator's rules to the check, on a recorded sandbox run. Each step says what is real here and what is replayed.</p>
      <Journey verdict={verdict} />
    </section>
  );
}
