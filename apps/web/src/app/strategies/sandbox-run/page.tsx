import Link from "next/link";
import { Hoody } from "@/components/Hoody.tsx";
import { StrategyJoin } from "@/components/StrategyJoin.tsx";
import { REC, BANNER, iso, near } from "@/lib/journey/model.ts";
import { usdc } from "@/lib/journey/join.ts";

// The recorded sandbox strategy, as its contract returned it (apps/web/src/lib/journey/recorded.json, from fixtures/scenario/good).
export default function SandboxStrategyPage() {
  const L = REC.limits;
  const rows: [string, string][] = [
    ["Status in the recording", `${REC.runStatusFirst} from block 170, ${REC.runStatusLast} at ${iso(REC.closedAtNs)}`],
    ["Creator", REC.creator], ["Agent", REC.agent], ["Deliverer (one account the buyer has to trust)", REC.deliverer], ["Pool", REC.pool],
    ["Principal", `${usdc(BigInt(REC.principal))} (max ${usdc(BigInt(REC.maxPrincipal))})`], ["Started", iso(REC.startedAtNs)],
    ["Max slippage", `${L.max_slippage_bps} bps (swaps ${L.max_swap_slippage_bps} bps)`], ["Max observation drift", `${L.max_observation_drift_bps} bps, at most ${L.max_observation_age_blocks} blocks old`],
    ["Range width", `${L.min_range_width_bps} to ${L.max_range_width_bps} bps`], ["Actions", `at most ${L.max_actions_per_24h} per 24 hours, at least ${L.min_action_interval_s} s apart`],
    ["Rules hash", REC.rulesHash], ["Viewing key", `${near(REC.keyPriceYocto)}, up to ${REC.maxKeySales} sales`],
  ];
  return (
    <section className="py-6">
      <p className="text-xs font-bold uppercase tracking-wide text-muted">Strategy</p>
      <h1 className="text-2xl font-bold">The recorded sandbox strategy</h1>
      <p className="font-mono text-xs text-muted">{REC.strategyId}</p>
      <p className="mt-3 rounded-lg bg-butter px-3 py-1.5 text-xs font-bold text-navy">{BANNER}</p>
      <div className="card mt-4 flex items-center justify-between gap-3 p-4">
        <p className="text-sm text-muted">The rules are private until close or until a key is bought. Only their hash is public. Positions on Rhea are public and the strategy wallet is visible there; public positions can leak part of the rules once a wallet is linked.</p>
        <Hoody mood="shh" size={64} label="Rules hidden" />
      </div>
      <div className="card mt-3 p-4">
        <h2 className="font-bold">Details</h2>
        <dl className="mt-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-line py-2 text-sm last:border-0"><dt className="text-muted">{k}</dt><dd className="break-all text-right">{v}</dd></div>
          ))}
        </dl>
        <p className="mt-2 rounded-lg bg-mint px-3 py-2 text-sm text-navy"><b>Real here:</b> these details, as recorded from the sandbox contract (views at block {REC.lastBlock}). <b>Simulated:</b> the join and exit below, which are page state only.</p>
      </div>
      <StrategyJoin />
      <div className="mt-3 flex flex-wrap gap-2">
        <Link className="pill bg-mint px-4 py-1 font-bold" href="/journey">Buy a viewing key (simulated, step 3 of the journey)</Link>
        <Link className="pill bg-lavender px-4 py-1 font-bold" href="/check/scenario-good">Check this run</Link>
      </div>
    </section>
  );
}
