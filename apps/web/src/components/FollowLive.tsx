"use client";
import { useEffect, useState } from "react";
import { DataBanner, BuyStatus, UnlockedView } from "@/components/KeyPanel.tsx";
import { isTestnetId, looksLikeSecretKey } from "@/lib/keys/ids.ts";
import { runBuy, runRefund, errorText, buyState, exportSecret, importSecret, openAndVerify, pairIsConsistent, type BuyerKeyPair, type OpenResult } from "@/lib/keys/flow.ts";
import { sealedBox } from "@/lib/keys/deps.ts";
import { loadFollow, rpcView, TESTNET_RPCS, type FollowData } from "@/lib/keys/chain.ts";
import { realAccount, testnetWallet } from "@/lib/keys/wallet.ts";

export const ONLY_TESTNET = "Use a testnet account (the name ends in .testnet) and a testnet strategy. Nothing was sent.";
export { isTestnetId };
export const BAD_KEY = "That does not look like a testnet secret key (ed25519: followed by letters and digits). Nothing was sent.";

/** Testnet follow flow. The testnet key and the buyer's key pair live only in this component's state: never logged,
 * stored or sent anywhere except the testnet signature. Rules are shown as plain text (EC-W04, EC-W11).
 * The key pair is created and backed up BEFORE paying (M2): the page will not pay until the buyer confirms the backup. */
export function FollowLive({ strategy }: { strategy: string }) {
  const [account, setAccount] = useState("");
  const [secret, setSecret] = useState("");
  const [backup, setBackup] = useState("");
  const [saved, setSaved] = useState(false);
  const [data, setData] = useState<FollowData | null>(null);
  const [kp, setKp] = useState<BuyerKeyPair | null>(null);
  const [result, setResult] = useState<OpenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Warn before the tab closes while an unsaved or unused pair exists.
  useEffect(() => {
    if (kp === null) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [kp]);

  const run = async (f: () => Promise<void>) => { setBusy(true); setError(null); try { await f(); } catch (e) { setError(errorText(e, [secret.trim(), secret])); } finally { setBusy(false); } };
  const views = () => [rpcView(TESTNET_RPCS[0]), rpcView(TESTNET_RPCS[1])] as const;
  const reload = async (): Promise<FollowData> => {
    const [a, b] = views();
    try { const d = await loadFollow(a, b, strategy, account.trim()); setData(d); return d; }
    catch (e) { setData(null); throw e; } // never act on a view we could not refresh (a stale "can buy" would allow a second pay click)
  };
  const load = () => run(async () => { if (!isTestnetId(account.trim()) || !isTestnetId(strategy)) throw new Error(ONLY_TESTNET); await reload(); });

  const makePair = () => run(async () => { setKp(await sealedBox.generateKeyPair()); setSaved(false); });
  const doBuy = () => run(async () => {
    if (!data || !kp) return;
    try {
      if (!looksLikeSecretKey(secret.trim())) throw new Error(BAD_KEY);
      const wallet = testnetWallet(realAccount(account.trim(), secret.trim()));
      await runBuy({ wallet, strategy, params: data.params, kp, sale: data.sale, nowNs: BigInt(Date.now()) * 1_000_000n, saved, clearSecret: () => setSecret(""), reload });
    } finally {
      setSecret(""); // whatever threw, including a malformed key or a failed wallet set-up, the pasted key is cleared
    }
  });
  const doRefund = () => run(async () => {
    try {
      if (!looksLikeSecretKey(secret.trim())) throw new Error(BAD_KEY);
      const wallet = testnetWallet(realAccount(account.trim(), secret.trim()));
      await runRefund({ wallet, strategy, nowNs: () => BigInt(Date.now()) * 1_000_000n, clearSecret: () => setSecret(""), reload });
    } finally {
      setSecret("");
    }
  });
  const unlock = () => run(async () => {
    if (!data?.sale) return;
    const pair = kp ?? importSecret(backup);
    if (!(await pairIsConsistent(sealedBox, pair))) throw new Error("This backup's secret key and public key do not belong together. Nothing was shown.");
    setResult(await openAndVerify({ box: sealedBox, kp: pair, sale: data.sale, strategyId: strategy, rulesHashHex: data.rulesHash, ciphertext: data.ciphertext }));
    setKp(null); setBackup(""); // the buyer's pair is dropped from state once the rules are shown
  });

  const state = data ? buyState(data.params, data.sale, BigInt(Date.now()) * 1_000_000n) : null;
  return (
    <div className="space-y-3">
      <DataBanner kind="testnet" />
      <p className="text-sm font-bold">Testnet only, no real tokens. Use a throwaway testnet account. Nothing is read from the chain until you press Load.</p>
      <label className="block text-sm">Testnet account <input className="card w-full p-1" value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="off" spellCheck={false} /></label>
      <button className="pill bg-lavender font-bold" disabled={busy || account.trim() === ""} onClick={load}>Load from testnet</button>
      {state && <div className="card p-4"><BuyStatus state={state} /></div>}

      {state?.kind === "can_buy" && (
        <div className="space-y-2 text-sm">
          {kp === null ? (
            <button className="pill bg-lavender font-bold" disabled={busy} onClick={makePair}>Step 1: create my key pair</button>
          ) : (
            <>
              <p className="font-bold">Step 1: save your key pair now. It is held only on this page and is lost if you close or reload it. If you lose it, the rules cannot be unlocked even after you pay.</p>
              <textarea readOnly className="card w-full p-2 text-xs" value={exportSecret(kp)} rows={4} onFocus={(e) => e.currentTarget.select()} />
              <button className="pill bg-lavender font-bold" onClick={() => { void navigator.clipboard?.writeText(exportSecret(kp)); }}>Copy</button>
              <label className="block"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved my key pair somewhere safe</label>
              <label className="block">Step 2: testnet secret key (not saved) <input className="card w-full p-1" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} /></label>
              <button className="pill bg-mint font-bold" disabled={busy || !saved || secret.trim() === ""} onClick={doBuy}>Buy viewing key (testnet)</button>
            </>
          )}
        </div>
      )}
      {state?.kind === "can_refund" && (
        <div className="space-y-2 text-sm">
          <label className="block">Testnet secret key (not saved) <input className="card w-full p-1" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} /></label>
          <button className="pill bg-mint font-bold" disabled={busy || secret.trim() === ""} onClick={doRefund}>Ask for a refund (testnet)</button>
        </div>
      )}
      {state?.kind === "delivered" && (
        <div className="space-y-2 text-sm">
          {!kp && <label className="block">Paste your saved backup <textarea className="card w-full p-1 text-xs" rows={4} value={backup} onChange={(e) => setBackup(e.target.value)} spellCheck={false} /></label>}
          <button className="pill bg-mint font-bold" disabled={busy || (!kp && backup.trim() === "")} onClick={unlock}>Unlock rules</button>
        </div>
      )}
      {result && <UnlockedView result={result} />}
      {error !== null && <p role="alert" className="text-sm">{error}</p>}
    </div>
  );
}
