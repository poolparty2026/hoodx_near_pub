import Link from "next/link";
import { FILL } from "@/components/Findings.tsx";
import { Hoody } from "@/components/Hoody.tsx";
import { RUN_CARDS, cardVerdict } from "@/lib/runs.ts";
import { VERDICT_MOOD, VERDICT_TEXT } from "@/lib/verdict.ts";

export default async function Home() {
  const cards = await Promise.all(RUN_CARDS.map(async (c) => ({ ...c, ...(await cardVerdict(c.id)) })));
  return (
    <section className="py-8">
      <h1 className="text-3xl font-bold">hoodx on NEAR</h1>
      <p className="mt-3 text-lg">Commit an LP strategy's rules by hash, and check at close whether the agent kept to them.</p>
      <p className="mt-2 text-sm text-muted">Viewing keys: written for testnet and tested end to end in a local sandbox by script; not run on testnet or mainnet. What is built and shown here is the commitment and the check.</p>
      <p className="mt-3 text-sm text-muted">
        A creator commits to rules by hash. An agent is meant to manage one position inside limits the contract enforces (trading is still being finished). After close, the rules are meant to be revealed. The check page is built to compare each action with them from public data and say, action by action, whether it matches. Today it does that on hand-made runs and sandbox recordings only.
      </p>
      <p className="mt-3 rounded-lg bg-butter px-3 py-1.5 text-xs font-bold text-navy">
        In progress. Every run below is hand-made or recorded on a local sandbox. No strategy has run on mainnet, and nothing here is a live strategy.
      </p>
      <h2 className="mt-8 text-xl font-bold">Open a run and see the check</h2>
      <ul className="mt-3 space-y-3">
        {cards.map((c) => (
          <li key={c.id}>
            <Link href={`/check/${c.id}`} className="card flex items-center gap-4 p-4">
              <Hoody mood={c.incomplete ? "sleepy" : VERDICT_MOOD[c.verdict]} size={56} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-bold">{c.title}</h3>
                  <span className={`pill text-sm ${FILL[c.verdict]}`}>{c.incomplete ? "Recording incomplete" : VERDICT_TEXT[c.verdict]}</span>
                </div>
                <p className="mt-1 text-sm text-muted">{c.note}</p>
                <p className="mt-1 text-xs font-bold uppercase tracking-wide text-muted">{c.kind}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-6 text-sm text-muted">
        No wallet needed. <Link href="/strategies" className="underline">See the sample strategy screens</Link>.
      </p>
    </section>
  );
}
