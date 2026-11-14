import Link from "next/link";
import { notFound } from "next/navigation";
import { Hoody } from "@/components/Hoody.tsx";
import { SampleBanner } from "@/components/SampleBanner.tsx";
import { findStrategy } from "@/lib/strategies.ts";

export default async function StrategyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = findStrategy(id);
  if (s === undefined) notFound();
  return (
    <section className="py-6">
      <p className="text-xs font-bold uppercase tracking-wide text-muted">Strategy</p>
      <h1 className="text-2xl font-bold">{s.name}</h1>
      <p className="font-mono text-xs text-muted">{s.account}</p>
      <SampleBanner />

      <div className="card mt-4 flex items-center justify-between gap-3 p-4">
        <div>
          <span className={`pill text-xs ${s.status === "live" ? "bg-mint" : "bg-lavender"}`}>{s.status === "live" ? "Sample: running" : "Sample: closed"}</span>
          <p className="mt-2 text-sm text-muted">
            {s.rulesRevealed ? "In this sample the rules are revealed. The sample check below is hand-made data." : "Rules are private until close or until a key is bought. Viewing keys: written for testnet and tested end to end in a local sandbox by script; not run on testnet or mainnet."}
          </p>
        </div>
        <Hoody mood={s.rulesRevealed ? "wow" : "shh"} size={64} label={s.rulesRevealed ? "Rules revealed" : "Rules hidden"} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="card p-4"><p className="text-xs font-bold uppercase tracking-wide text-muted">Value</p><p className="text-xl font-bold">{s.value}</p></div>
        <div className="card p-4"><p className="text-xs font-bold uppercase tracking-wide text-muted">Public P&amp;L</p><p className="text-xl font-bold">{s.publicPnl}</p></div>
      </div>

      <div className="card mt-3 p-4">
        <h2 className="font-bold">Public limits</h2>
        <dl className="mt-2">
          {s.limits.map((l) => (
            <div key={l.label} className="flex justify-between border-b border-line py-2 text-sm last:border-0">
              <dt className="text-muted">{l.label}</dt><dd>{l.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="card mt-3 p-4">
        <h2 className="font-bold">Recent actions</h2>
        <ul className="mt-2">
          {s.actions.map((a) => (
            <li key={a.label + a.when} className="flex justify-between border-b border-line py-2 text-sm last:border-0">
              <span>{a.label}</span><span className="text-muted">{a.when}</span>
            </li>
          ))}
        </ul>
      </div>

      {s.rulesRevealed ? (
        <Link href="/sample/good" className="mt-4 block rounded-xl border-2 border-navy bg-mint p-3 text-center font-bold text-navy">See the sample check</Link>
      ) : (
        <>
          {/* One action per screen. The buy flow lives at /follow/[strategy]; sample strategies have no button. */}
          <p className="mt-4 rounded-xl border-2 border-line p-3 text-center text-sm text-muted">
            Viewing keys: written for testnet and tested end to end in a local sandbox by script; not run on testnet or mainnet.
          </p>
          <p className="mt-2 text-center text-xs text-muted">A key holder can copy the rules or pass them on, so a bought key would not keep them private.</p>
        </>
      )}
    </section>
  );
}
