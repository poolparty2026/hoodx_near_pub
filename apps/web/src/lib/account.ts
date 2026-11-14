// No outside interference with the strategy account (EC-W02, EC-W07, ARCHITECTURE section 8, item 2).
// GUESS: the snapshot shape stands in for what packages/near will read (access-key list with permissions and
// nonces, code hash) at deployment, start, every action block, settlement and the latest block, from both providers.
import { agree, type Read } from "./providers.ts";
import type { Finding } from "./checks.ts";

/** `permission` is a canonical string: "FullAccess", or the function-call receiver, methods and allowance. */
export interface KeyInfo { readonly publicKey: string; readonly permission: string; readonly nonce: bigint }
export interface AccountSnapshot { readonly block: number; readonly codeHash: string; readonly keys: readonly KeyInfo[] }

/** What each provider returned for each sampled block. */
export interface SnapshotPair { readonly block: number; readonly a: Read<AccountSnapshot>; readonly b: Read<AccountSnapshot> }

const byKey = (p: KeyInfo, q: KeyInfo) => (p.publicKey < q.publicKey ? -1 : p.publicKey > q.publicKey ? 1 : 0);
const sameSnapshot = (x: AccountSnapshot, y: AccountSnapshot): boolean => {
  if (x.block !== y.block || x.codeHash !== y.codeHash || x.keys.length !== y.keys.length) return false;
  const a = [...x.keys].sort(byKey), b = [...y.keys].sort(byKey);
  return a.every((k, i) => k.publicKey === b[i]!.publicKey && k.permission === b[i]!.permission && k.nonce === b[i]!.nonce);
};

/**
 * `deployBlock`: the block of the single creating transaction; the first pair must be for it, so a later
 * block can't be passed off as the baseline. `recoveryKey`: its nonce changes only when it signs, so any
 * change is interference. Other keys' nonces (the agent's) change with normal use and are not compared,
 * but every key's permission is.
 *
 * Only the sampled blocks are compared: a key added and removed between two samples, without the recovery
 * key signing, is not seen. The matching text says so. Reading every block is the fuller design.
 *
 * Proven tampering at a readable snapshot wins over an unreadable one (EC-W18: not matching beats unverifiable).
 */
export function checkAccountIntegrity(pairs: readonly SnapshotPair[], recoveryKey: string, deployBlock: number): Finding {
  if (pairs.length < 2) return { verdict: "unverifiable", text: "Can't check the account: too few snapshots were read." };
  if (pairs[0]!.block !== deployBlock) return { verdict: "unverifiable", text: "Can't check the account: the first snapshot is not the deploy block." };
  for (let i = 1; i < pairs.length; i++) {
    if (pairs[i]!.block <= pairs[i - 1]!.block) return { verdict: "unverifiable", text: "Can't check the account: snapshots were not in block order." };
  }
  const read = pairs.map((p) => ({ block: p.block, r: agree(p.a, p.b, sameSnapshot) }));
  const first = read[0]!;
  if (first.r.kind !== "agreed" || first.r.value.block !== first.block) {
    return { verdict: "unverifiable", text: "Can't check the account: the deploy block could not be read." };
  }
  const base = first.r.value;
  const dup = (s: AccountSnapshot) => new Set(s.keys.map((k) => k.publicKey)).size !== s.keys.length;
  if (dup(base)) return { verdict: "unverifiable", text: "Can't check the account: a key was listed twice." };
  const baseKeys = new Map(base.keys.map((k) => [k.publicKey, k] as const));
  if (!baseKeys.has(recoveryKey)) return { verdict: "unverifiable", text: "Can't check the account: the recovery key is not in the first snapshot." };

  let prevBlock = base.block;
  let unreadable: Finding | null = null;
  for (const { block, r } of read.slice(1)) {
    if (r.kind === "failed") { unreadable ??= { verdict: "unverifiable", text: `Can't check the account at block ${block}: a provider could not be read.` }; continue; }
    if (r.kind === "disagree") { unreadable ??= { verdict: "unverifiable", text: `The two providers disagree about the account at block ${block}.` }; continue; }
    const s = r.value;
    if (s.block !== block || dup(s)) { unreadable ??= { verdict: "unverifiable", text: `Can't check the account at block ${block}: the answer was not usable.` }; continue; }
    const where = `between block ${prevBlock} and block ${block}`;
    if (s.codeHash !== base.codeHash) return { verdict: "not_matching", text: `The account's code changed ${where}.` };
    const now = new Map(s.keys.map((k) => [k.publicKey, k] as const));
    for (const k of now.keys()) if (!baseKeys.has(k)) return { verdict: "not_matching", text: `A key was added ${where}.` };
    for (const k of baseKeys.keys()) if (!now.has(k)) return { verdict: "not_matching", text: `A key was removed ${where}.` };
    for (const [k, was] of baseKeys) if (now.get(k)!.permission !== was.permission) return { verdict: "not_matching", text: `A key's permission changed ${where}.` };
    if (now.get(recoveryKey)!.nonce !== baseKeys.get(recoveryKey)!.nonce) return { verdict: "not_matching", text: `The recovery key signed a transaction ${where}.` };
    prevBlock = block;
  }
  return unreadable ?? { verdict: "matching", text: "No change to the account's keys or code at the sampled blocks." };
}
