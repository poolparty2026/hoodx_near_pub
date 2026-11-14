"use client";
import { useState } from "react";
import { REC, BANNER } from "@/lib/journey/model.ts";
import { MAX_JOIN_TEXT, exit, initialJoin, join, parseAmount, pct, shareBps, usdc, type JoinState } from "@/lib/journey/join.ts";

/** Simulated join and exit, kept in page state only. Nothing is sent: there is no wallet and no transaction. */
export function StrategyJoin() {
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<JoinState>(initialJoin);
  const [returned, setReturned] = useState<bigint | null>(null);
  const parsed = parseAmount(text);
  const principal = BigInt(REC.principal);
  return (
    <div className="card mt-3 p-4" aria-labelledby="join-title">
      <h2 id="join-title" className="font-bold">Join this strategy (simulated)</h2>
      <p className="mt-1 rounded-lg bg-butter px-3 py-1.5 text-xs font-bold text-navy">{BANNER}</p>
      {state.position === null ? (
        <>
          <label className="mt-3 block text-sm">Amount in USDC (the simulation accepts up to {MAX_JOIN_TEXT}, the strategy's recorded maximum principal; at most 2 decimals)
            <input className="card mt-1 w-full p-1" inputMode="decimal" value={text} onChange={(e) => { setText(e.target.value); setConfirming(false); }} autoComplete="off" />
          </label>
          {text.trim() !== "" && !parsed.ok && <p role="alert" className="mt-1 text-sm">{parsed.error}</p>}
          {!confirming && <button className="pill mt-3 bg-mint font-bold" disabled={!parsed.ok} onClick={() => setConfirming(true)}>Review join</button>}
          {confirming && parsed.ok && (
            <div className="mt-3 text-sm" data-testid="confirm">
              <h3 className="font-bold">Confirm: exact figures</h3>
              <dl className="mt-1">
                <div className="flex justify-between border-b border-line py-1"><dt className="text-muted">Your amount</dt><dd>{usdc(parsed.units)}</dd></div>
                <div className="flex justify-between border-b border-line py-1"><dt className="text-muted">Recorded principal</dt><dd>{usdc(principal)}</dd></div>
                <div className="flex justify-between border-b border-line py-1"><dt className="text-muted">Your share if you had joined (simulated)</dt><dd>{pct(shareBps(parsed.units, principal))} ({usdc(parsed.units)} / {usdc(principal + parsed.units)})</dd></div>
              </dl>
              <p className="mt-2">The public limits that bind the agent: max {REC.limits.max_slippage_bps} bps slippage, observation drift at most {REC.limits.max_observation_drift_bps} bps, range width {REC.limits.min_range_width_bps} to {REC.limits.max_range_width_bps} bps, at most {REC.limits.max_actions_per_24h} actions per 24 hours, at least {REC.limits.min_action_interval_s} s between actions.</p>
              <p className="mt-2">This screen shows no fee figure and no result of any strategy. Positions on Rhea are public and the strategy wallet is visible there.</p>
              <button className="pill mt-3 bg-mint font-bold" onClick={() => { setState(join(state, parsed.units)); setConfirming(false); setReturned(null); }}>Simulate join</button>
            </div>
          )}
          {returned !== null && <p className="mt-3 text-sm" data-testid="returned">Simulated exit: {usdc(returned)} returned, exactly the amount put in. The simulation does not model the results of any strategy.</p>}
        </>
      ) : (
        <div className="mt-3 text-sm" data-testid="position">
          <h3 className="font-bold">Your simulated position</h3>
          <dl className="mt-1">
            <div className="flex justify-between border-b border-line py-1"><dt className="text-muted">Amount</dt><dd>{usdc(state.position.amount)}</dd></div>
            <div className="flex justify-between border-b border-line py-1"><dt className="text-muted">Share of the pool</dt><dd>{pct(state.position.shareBps)}</dd></div>
            <div className="flex justify-between border-b border-line py-1"><dt className="text-muted">Status</dt><dd>Simulated, running</dd></div>
          </dl>
          <p className="mt-2">Kept in this page only: it is lost when you reload.</p>
          <button className="pill mt-3 bg-lavender font-bold" onClick={() => { const r = exit(state); setState(r.state); setReturned(r.returned); setText(""); }}>Simulate exit</button>
        </div>
      )}
      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <p className="rounded-lg bg-mint px-3 py-2 text-navy"><b>Real here:</b> the strategy details above, as recorded from the sandbox contract, and the share arithmetic.</p>
        <p className="rounded-lg bg-butter px-3 py-2 text-navy"><b>Simulated:</b> the join and the exit. No transaction is sent and there is no wallet. The contract in this version is funded by the creator alone; joining does not exist in it.</p>
      </div>
    </div>
  );
}
