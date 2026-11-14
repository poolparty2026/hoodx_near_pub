import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { agree } from "../src/lib/providers.ts";
import { checkAccountIntegrity, type AccountSnapshot, type KeyInfo, type SnapshotPair } from "../src/lib/account.ts";

const REC = "ed25519:recovery", AGENT = "ed25519:agent";
const FC = "FunctionCall:strategy.near:agent_swap,agent_open:allowance=1000";
const keys = (o: { agentNonce?: bigint; recNonce?: bigint; agentPerm?: string; recPerm?: string } = {}): KeyInfo[] => [
  { publicKey: REC, permission: o.recPerm ?? "FullAccess", nonce: o.recNonce ?? 5n },
  { publicKey: AGENT, permission: o.agentPerm ?? FC, nonce: o.agentNonce ?? 1n },
];
const snap = (block: number, o: Partial<AccountSnapshot> & Parameters<typeof keys>[0] = {}): AccountSnapshot => ({
  block, codeHash: o.codeHash ?? "H1", keys: o.keys ?? keys(o),
});
const both = (s: AccountSnapshot): SnapshotPair => ({ block: s.block, a: { ok: true, value: s }, b: { ok: true, value: s } });
const failed = (block: number): SnapshotPair => ({ block, a: { ok: false }, b: { ok: true, value: snap(block) } });
const run = (...s: AccountSnapshot[]) => checkAccountIntegrity(s.map(both), REC, s[0]!.block);

describe("EC-W08 providers", () => {
  const eq = (x: number, y: number) => x === y;
  it("agreement", () => expect(agree({ ok: true, value: 1 }, { ok: true, value: 1 }, eq)).toEqual({ kind: "agreed", value: 1 }));
  it("disagreement", () => expect(agree({ ok: true, value: 1 }, { ok: true, value: 2 }, eq)).toEqual({ kind: "disagree" }));
  it("either failing is failed", () => {
    expect(agree({ ok: false }, { ok: true, value: 1 }, eq)).toEqual({ kind: "failed" });
    expect(agree({ ok: true, value: 1 }, { ok: false }, eq)).toEqual({ kind: "failed" });
    expect(agree<number>({ ok: false }, { ok: false }, eq)).toEqual({ kind: "failed" });
  });
});

describe("EC-W07 account integrity", () => {
  it("unchanged is matching, even when the agent's nonce rises", () => {
    expect(run(snap(100), snap(200, { agentNonce: 9n }), snap(300, { agentNonce: 20n }))).toEqual({
      verdict: "matching", text: "No change to the account's keys or code at the sampled blocks." });
  });
  it("EC-W07: the recovery key's nonce changing is not matching, with the blocks", () => {
    expect(run(snap(100), snap(200, { recNonce: 6n }))).toEqual({ verdict: "not_matching", text: "The recovery key signed a transaction between block 100 and block 200." });
  });
  it("EC-W07: the recovery key's nonce going backwards is not matching too", () => {
    expect(run(snap(100), snap(200, { recNonce: 4n })).verdict).toBe("not_matching");
  });
  it("EC-W02: a code change reverted before the last snapshot is found at its own snapshot, with the blocks", () => {
    expect(run(snap(100), snap(200, { codeHash: "H2" }), snap(300))).toEqual({ verdict: "not_matching", text: "The account's code changed between block 100 and block 200." });
  });
  it("EC-W07: a key added or removed is not matching", () => {
    const extra = [...keys(), { publicKey: "ed25519:evil", permission: "FullAccess", nonce: 0n }];
    expect(run(snap(100), snap(200, { keys: extra })).text).toBe("A key was added between block 100 and block 200.");
    expect(run(snap(100), snap(200, { keys: keys().slice(0, 1) })).text).toBe("A key was removed between block 100 and block 200.");
  });
  it("EC-W07 (security M-2): a changed permission on the agent key or the recovery key is not matching", () => {
    expect(run(snap(100), snap(200, { agentPerm: "FullAccess" }))).toEqual({ verdict: "not_matching", text: "A key's permission changed between block 100 and block 200." });
    expect(run(snap(100), snap(200, { recPerm: FC })).verdict).toBe("not_matching");
  });
  it("EC-W18 (test H1): proven tampering beats an unreadable later snapshot", () => {
    const code = snap(200, { codeHash: "H2" });
    for (const bad of [failed(300), { block: 300, a: { ok: true, value: snap(300) }, b: { ok: true, value: snap(300, { codeHash: "X" }) } } as SnapshotPair]) {
      expect(checkAccountIntegrity([both(snap(100)), both(code), bad], REC, 100)).toEqual({
        verdict: "not_matching", text: "The account's code changed between block 100 and block 200." });
    }
  });
  it("with nothing proven, an unreadable snapshot is unverifiable, never matching", () => {
    expect(checkAccountIntegrity([both(snap(100)), both(snap(200)), failed(300)], REC, 100)).toEqual({
      verdict: "unverifiable", text: "Can't check the account at block 300: a provider could not be read." });
    const dis: SnapshotPair = { block: 200, a: { ok: true, value: snap(200) }, b: { ok: true, value: snap(200, { codeHash: "H2" }) } };
    expect(checkAccountIntegrity([both(snap(100)), dis], REC, 100)).toEqual({ verdict: "unverifiable", text: "The two providers disagree about the account at block 200." });
  });
  it("providers answering for different blocks, or a wrong block from both, are unverifiable", () => {
    const a: SnapshotPair = { block: 200, a: { ok: true, value: snap(150) }, b: { ok: true, value: snap(200) } };
    expect(checkAccountIntegrity([both(snap(100)), a], REC, 100).verdict).toBe("unverifiable");
    const w = snap(150);
    expect(checkAccountIntegrity([both(snap(100)), { block: 200, a: { ok: true, value: w }, b: { ok: true, value: w } }], REC, 100).verdict).toBe("unverifiable");
  });
  it("(security L-5) the first snapshot must be the deploy block", () => {
    expect(checkAccountIntegrity([both(snap(150)), both(snap(200))], REC, 100)).toEqual({
      verdict: "unverifiable", text: "Can't check the account: the first snapshot is not the deploy block." });
  });
  it("an unreadable deploy snapshot is unverifiable", () => {
    expect(checkAccountIntegrity([failed(100), both(snap(200))], REC, 100).verdict).toBe("unverifiable");
  });
  it("too few, out of order, no recovery key, and duplicate keys are unverifiable with exact text", () => {
    expect(run(snap(100)).text).toBe("Can't check the account: too few snapshots were read.");
    expect(checkAccountIntegrity([both(snap(200)), both(snap(100))], REC, 200).text).toBe("Can't check the account: snapshots were not in block order.");
    expect(run(snap(100, { keys: [keys()[1]!] }), snap(200)).text).toBe("Can't check the account: the recovery key is not in the first snapshot.");
    const dupKeys = [keys()[0]!, keys()[0]!];
    expect(run(snap(100, { keys: dupKeys }), snap(200)).text).toBe("Can't check the account: a key was listed twice.");
    expect(run(snap(100), snap(200, { keys: dupKeys })).verdict).toBe("unverifiable");
  });
  it("the same keys in another order are the same (providers may list differently)", () => {
    const rev = snap(200, { keys: [...keys()].reverse() });
    const p: SnapshotPair = { block: 200, a: { ok: true, value: snap(200) }, b: { ok: true, value: rev } };
    expect(checkAccountIntegrity([both(snap(100)), p], REC, 100).verdict).toBe("matching");
  });
  it("providers that differ only in one key's permission are unverifiable (the sameSnapshot half)", () => {
    const p: SnapshotPair = { block: 200, a: { ok: true, value: snap(200) }, b: { ok: true, value: snap(200, { agentPerm: "FullAccess" }) } };
    expect(checkAccountIntegrity([both(snap(100)), p], REC, 100)).toEqual({ verdict: "unverifiable", text: "The two providers disagree about the account at block 200." });
  });
  it("the same block twice is not in block order", () => {
    expect(checkAccountIntegrity([both(snap(100)), both(snap(100))], REC, 100).text).toBe("Can't check the account: snapshots were not in block order.");
  });
  it("with two unreadable snapshots the first is reported", () => {
    expect(checkAccountIntegrity([both(snap(100)), failed(200), failed(300)], REC, 100).text).toBe("Can't check the account at block 200: a provider could not be read.");
  });
});

describe("EC-W07 property: no single change to the baseline is ever matching", () => {
  const change = fc.constantFrom(
    (s: AccountSnapshot): AccountSnapshot => ({ ...s, codeHash: "OTHER" }),
    (s: AccountSnapshot): AccountSnapshot => ({ ...s, keys: s.keys.slice(1) }),
    (s: AccountSnapshot): AccountSnapshot => ({ ...s, keys: [...s.keys, { publicKey: "ed25519:new", permission: "FullAccess", nonce: 0n }] }),
    (s: AccountSnapshot): AccountSnapshot => ({ ...s, keys: s.keys.map((k) => (k.publicKey === AGENT ? { ...k, permission: "FullAccess" } : k)) }),
    (s: AccountSnapshot): AccountSnapshot => ({ ...s, keys: s.keys.map((k) => (k.publicKey === REC ? { ...k, nonce: k.nonce + 1n } : k)) }),
    (s: AccountSnapshot): AccountSnapshot => ({ ...s, keys: s.keys.map((k) => (k.publicKey === REC ? { ...k, nonce: k.nonce - 1n } : k)) }),
  );
  it("a changed snapshot anywhere in the run is never matching, and key order never matters", () => {
    fc.assert(fc.property(change, fc.integer({ min: 1, max: 4 }), fc.boolean(), (mutate, at, reverse) => {
      const snaps = [100, 200, 300, 400, 500].map((b, i) => {
        const s = snap(b, { agentNonce: BigInt(i + 1) });
        return i === at ? mutate(s) : s;
      }).map((s) => (reverse ? { ...s, keys: [...s.keys].reverse() } : s));
      expect(checkAccountIntegrity(snaps.map(both), REC, 100).verdict).toBe("not_matching");
    }), { numRuns: 300 });
  });
  it("an unchanged run is matching whatever the key order and the agent's nonce", () => {
    fc.assert(fc.property(fc.boolean(), fc.bigInt({ min: 0n, max: 1_000_000n }), (reverse, n) => {
      const snaps = [100, 200, 300].map((b) => snap(b, { agentNonce: n + BigInt(b) })).map((s) => (reverse ? { ...s, keys: [...s.keys].reverse() } : s));
      expect(checkAccountIntegrity(snaps.map(both), REC, 100).verdict).toBe("matching");
    }), { numRuns: 100 });
  });
});
