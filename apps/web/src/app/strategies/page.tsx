import Link from "next/link";
import { Hoody } from "@/components/Hoody.tsx";
import { SampleBanner } from "@/components/SampleBanner.tsx";
import { SAMPLE_STRATEGIES } from "@/lib/strategies.ts";

export default function StrategiesPage() {
  return (
    <section className="py-6">
      <h1 className="text-2xl font-bold">Strategies</h1>
      <SampleBanner />
      <ul className="mt-2 space-y-3">
        {SAMPLE_STRATEGIES.map((s) => (
          <li key={s.id}>
            <Link href={`/strategies/${s.id}`} className="card mt-3 block p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-bold">{s.name}</h2>
                <span className={`pill text-xs ${s.status === "live" ? "bg-mint" : "bg-lavender"}`}>{s.status === "live" ? "Sample: running" : "Sample: closed"}</span>
              </div>
              <p className="mt-1 text-sm text-muted">{s.pool}</p>
              <div className="mt-3 flex items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-muted">Value</p>
                  <p className="text-xl font-bold">{s.value}</p>
                </div>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-muted">Public P&amp;L</p>
                  <p className="text-xl font-bold">{s.publicPnl}</p>
                </div>
                <div className="text-center">
                  <Hoody mood={s.rulesRevealed ? "wow" : "shh"} size={44} label={s.rulesRevealed ? "Rules revealed" : "Rules hidden"} />
                  <p className="text-[10px] font-bold uppercase tracking-wide text-muted">{s.rulesRevealed ? "Rules revealed" : "Rules hidden"}</p>
                </div>
              </div>
              <p className="mt-3 flex justify-between text-sm text-muted"><span>{s.endsText}</span><span>Viewing keys: sandbox-tested, not run on testnet or mainnet</span></p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
