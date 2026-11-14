import Link from "next/link";
import { Hoody, type Mood } from "@/components/Hoody.tsx";
import { SAMPLE_CASES } from "@/lib/sample.ts";

const MOODS: { mood: Mood; use: string }[] = [
  { mood: "happy", use: "Matching (sample)" },
  { mood: "wow", use: "Rules revealed after close (sample)" },
  { mood: "shh", use: "Hidden rules, unverifiable" },
  { mood: "hype", use: "Fees collected" },
  { mood: "sleepy", use: "Idle, could not act" },
  { mood: "cute-rekt", use: "Not matching, refusals" },
];

export default function SampleIndex() {
  return (
    <section className="py-6">
      <h1 className="text-2xl font-bold">Sample runs</h1>
      <p className="mt-1 text-sm text-muted">Hand-made data to show how the check page reads. Nothing here comes from a chain.</p>
      <ul className="mt-4 space-y-2">
        {SAMPLE_CASES.map((c) => (
          <li key={c}><Link className="card block p-3 font-bold" href={`/sample/${c}`}>{c}</Link></li>
        ))}
      </ul>
      <h2 className="mt-8 text-lg font-bold">Hoody's moods</h2>
      <ul className="mt-3 grid grid-cols-2 gap-3">
        {MOODS.map(({ mood, use }) => (
          <li key={mood} className="card flex flex-col items-center p-3 text-center">
            <Hoody mood={mood} size={88} label={mood} />
            <p className="mt-2 text-sm font-bold">{mood}</p>
            <p className="text-xs text-muted">{use}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
