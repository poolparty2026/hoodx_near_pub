"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Hoody, type Mood } from "@/components/Hoody.tsx";
import { BANNER, REC, deliveredSale, escrowedSale, iso, near, prepareWorld, unlock, type World } from "@/lib/journey/model.ts";
import type { OpenResult } from "@/lib/keys/flow.ts";
import type { KeySale } from "@/lib/keys/views.ts";

const TITLES = [
  "The creator writes rules and commits their hash", "Fund and start", "A follower buys a viewing key", "The deliverer seals the key and delivers",
  "The follower opens the key", "The agent acts", "Close and reveal", "The check",
] as const;
const MOODS: Mood[] = ["shh", "happy", "hype", "wow", "wow", "happy", "sleepy", "happy"];

function RealSim({ real, sim }: { real: string; sim: string }) {
  return (
    <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
      <p className="rounded-lg bg-mint px-3 py-2 text-navy"><b>Real here:</b> {real}</p>
      <p className="rounded-lg bg-butter px-3 py-2 text-navy"><b>Simulated:</b> {sim}</p>
    </div>
  );
}
const Mono = ({ children }: { children: ReactNode }) => <code className="break-all rounded bg-surface-2 px-1 text-xs">{children}</code>;

/** The guided journey. Plain text only (EC-W04); the chain is replayed in memory, nothing is sent anywhere. */
export function Journey({ verdict }: { verdict: ReactNode }) {
  const [step, setStep] = useState(0);
  const [world, setWorld] = useState<World | null>(null);
  const [sale, setSale] = useState<KeySale | null>(null);
  const [result, setResult] = useState<OpenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { prepareWorld().then(setWorld, (e) => setError(e instanceof Error ? e.message : "Could not prepare the simulation.")); }, []);

  const done = [true, true, sale !== null, sale?.state === "Released", result?.kind === "unlocked", true, true, true][step]!;
  const run = (f: () => Promise<void>) => f().catch((e) => setError(e instanceof Error ? e.message : "That failed."));

  const body: ReactNode[] = [
    <>
      <p>The creator writes the rules and commits only their SHA-256 hash on the contract, with an encrypted copy. The rules stay private until close, or until a viewing key is bought. Positions on Rhea are public and the strategy wallet is visible there; public positions can leak part of the rules once a wallet is linked, so the rules are private only until they are revealed or a key is bought.</p>
      <p className="mt-2">Rules hash recorded on the sandbox contract: <Mono>{REC.rulesHash}</Mono></p>
      {world && <p className="mt-2">The recorded rules hash to exactly this value ({world.ciphertext.length} bytes of encrypted rules are held for the demo). The rules are not shown yet.</p>}
      <RealSim real="the hash of the recorded rules, compared with the recorded rules_hash, and the encryption of the rules." sim="the recording's own encrypted copy is a placeholder and its key was not kept, so the rules are encrypted again here with a fresh key." />
    </>,
    <>
      <p>The creator funds the strategy and starts it. Recorded values from the sandbox run: principal <Mono>{REC.principal}</Mono> (smallest units of the quote token), started at <Mono>{iso(REC.startedAtNs)}</Mono>.</p>
      <RealSim real="the principal and start time are values the sandbox contract returned." sim="the funding transactions themselves are not replayed; the recording holds contract views, not funding events. Sandbox accounts, no tokens." />
    </>,
    <>
      <p>A follower buys a viewing key. In the product they attach exactly the key price ({near(REC.keyPriceYocto)} in this recording); the contract holds it in escrow. The follower's browser first makes a key pair; the public half goes to the contract.</p>
      {sale ? (
        <p className="mt-2">Sale as the contract view returns it: state <b>{sale.state}</b>, price <Mono>{sale.price.toString()}</Mono> yoctoNEAR, buyer public key <Mono>{sale.buyerPubkey}</Mono>.</p>
      ) : (
        <button className="pill mt-3 bg-mint font-bold" disabled={!world} onClick={() => world && setSale(escrowedSale(world, BigInt(Date.now()) * 1_000_000n))}>Simulate buy</button>
      )}
      <p className="mt-2 text-sm">A viewing key shows the rules, and anyone who holds the key can copy them or pass them on.</p>
      <RealSim real="the key pair is made in this browser with the real sealed-box library, and the sale has the exact shape the contract returns." sim="the buy transaction: nothing is sent, no wallet, no chain read, not on testnet or mainnet." />
    </>,
    <>
      <p>The deliverer is one account that holds the rules key. It reads the buyer's public key from the contract's sale view (never from an event), seals the key to it and delivers it. The contract then pays the creator, once.</p>
      {sale?.state === "Released" ? (
        <p className="mt-2">Sale view now: state <b>Released</b>, sealed key (160 hex characters, 80 bytes): <Mono>{sale.sealedKey}</Mono></p>
      ) : (
        <button className="pill mt-3 bg-mint font-bold" disabled={!world || !sale} onClick={() => run(async () => { if (world && sale) setSale(await deliveredSale(world, sale)); })}>Simulate delivery</button>
      )}
      <p className="mt-2 text-sm">The deliverer is a single account the buyer has to trust: it can send a well-formed key that does not open the rules, and after delivery there is no refund. If no key arrives within the delivery window, the buyer can take the payment back.</p>
      <RealSim real="the sealing: the key is sealed to the buyer's public key with the real library." sim="the delivery transaction and the payout: replayed in memory, not sent." />
    </>,
    <>
      <p>The follower's browser opens the sealed key with the secret half of their key pair, decrypts the rules, and compares their hash with the recorded rules_hash.</p>
      {result === null && <button className="pill mt-3 bg-mint font-bold" disabled={!world || sale?.state !== "Released"} onClick={() => run(async () => { if (world && sale) setResult(await unlock(world, sale)); })}>Open the key</button>}
      {result?.kind === "unlocked" && (
        <>
          <p className="mt-2 font-bold">Hash check: the rules you decrypted match the recorded rules hash. This shows the rules are the ones committed; it is not proof that the agent followed them.</p>
          <pre className="card mt-2 overflow-x-auto p-3 text-xs whitespace-pre-wrap">{JSON.stringify(result.rules, null, 2)}</pre>
        </>
      )}
      {result?.kind === "failed" && <p role="alert" className="mt-2">Could not unlock: {result.reason.replaceAll("_", " ")}. Nothing was shown.</p>}
      <RealSim real="the whole step: sealed-box open, decryption and the hash comparison all run in this browser." sim="only the inputs: the sealed key comes from the replayed delivery above." />
    </>,
    <>
      <p>In the recording, the agent acted inside the limits the contract enforces (the agent is still being finished). Recorded actions from the sandbox run, in order:</p>
      <ol className="mt-2 space-y-1 text-sm">
        {REC.actions.map((a) => (
          <li key={a.index} className="card px-3 py-2">#{a.index} {a.kind}: {a.result}. Called at block {a.callBlock}, result at block {a.resultBlock}, observed point {a.observedPoint}, range {a.leftPoint} to {a.rightPoint}.</li>
        ))}
      </ol>
      <RealSim real="the actions are the sandbox contract's own records of a real agent process." sim="they are replayed from the recording; this page does not run an agent." />
    </>,
    <>
      <p>The run closes (recorded: <Mono>{iso(REC.closedAtNs)}</Mono>) and the rules are revealed on the contract so anyone can check them. The creator's rules are now public:</p>
      <pre className="card mt-2 overflow-x-auto p-3 text-xs whitespace-pre-wrap">{JSON.stringify(JSON.parse(REC.rulesText), null, 2)}</pre>
      <p className="mt-2 text-sm">Revealed rules text, as the contract returned it, hashes to <Mono>{REC.rulesHash}</Mono>.</p>
      <RealSim real="the revealed text is what the sandbox contract returned." sim="the reveal transaction is not replayed." />
    </>,
    <>
      <p>The check page reads the recorded run and says, row by row, whether it matches. This is the same check as <a className="underline" href="/check/scenario-good">/check/scenario-good</a>. Today it reads recordings and hand-made runs only.</p>
      <div className="mt-3">{verdict}</div>
      <RealSim real="the check itself: the same code and the same recording as the check page." sim="the recording is one sandbox node read twice, not two independent providers and not a mainnet strategy." />
    </>,
  ];

  return (
    <div>
      <p className="mt-3 rounded-lg bg-butter px-3 py-1.5 text-xs font-bold text-navy" data-testid="banner">{BANNER}</p>
      <p className="mt-2 text-sm"><a className="underline" href="/strategies/sandbox-run">Strategy details and a simulated join</a></p>
      <ol className="mt-4 flex flex-wrap gap-1 text-xs" aria-label="Steps">
        {TITLES.map((t, i) => (
          <li key={t} aria-current={i === step ? "step" : undefined} className={`pill px-2 py-0.5 ${i === step ? "bg-mint" : i < step ? "bg-lavender" : "bg-surface-2 text-ink"}`}>{i + 1}</li>
        ))}
      </ol>
      <section className="card mt-4 p-4" aria-labelledby="step-title">
        <div className="flex items-center gap-3">
          <Hoody mood={MOODS[step]!} size={56} />
          <div>
            <p className="text-xs font-bold uppercase tracking-wide text-muted">Step {step + 1} of {TITLES.length}</p>
            <h2 id="step-title" className="text-lg font-bold">{TITLES[step]}</h2>
          </div>
        </div>
        <div className="mt-3 text-sm">{body[step]}</div>
        {error !== null && <p role="alert" className="mt-2 text-sm">{error}</p>}
      </section>
      <div className="mt-3 flex justify-between">
        <button className="pill bg-surface-2 text-ink" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        <button className="pill bg-mint font-bold" disabled={step === TITLES.length - 1 || !done} onClick={() => setStep(step + 1)}>Next</button>
      </div>
    </div>
  );
}
