import { NotChecked } from "./NotChecked.tsx";
import { Hoody } from "./Hoody.tsx";
import { VERDICT_MOOD, VERDICT_TEXT, worst, type Verdict } from "../lib/verdict.ts";

export interface Row { readonly title: string; readonly verdict: Verdict; readonly text: string }

// Fill with navy text (pastels are fills, never text on light; navy on pastel always).
export const FILL: Record<Verdict, string> = {
  matching: "bg-mint", could_not_act: "bg-butter", unverifiable: "bg-lavender", not_matching: "bg-pink",
};

/** The run's verdict, then one row per check. Every string is rendered by React as text (EC-W04, EC-W11). */
export function Findings({ rows }: { rows: readonly Row[] }) {
  const run = worst(rows.map((r) => r.verdict));
  return (
    <>
      <div className="card mt-6 flex items-center gap-4 p-4">
        <Hoody mood={VERDICT_MOOD[run]} size={72} />
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wide text-muted">Result</h2>
          <p className="mt-1 text-2xl font-bold">{VERDICT_TEXT[run]}</p>
        </div>
      </div>
      <ul className="mt-4 space-y-3">
        {rows.map((r) => (
          <li key={r.title} className="card p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-bold">{r.title}</h2>
              <span className={`pill text-sm ${FILL[r.verdict]}`}>{VERDICT_TEXT[r.verdict]}</span>
            </div>
            <p className="mt-2 break-words text-sm text-muted">{r.text}</p>
          </li>
        ))}
      </ul>
      <NotChecked />
    </>
  );
}
