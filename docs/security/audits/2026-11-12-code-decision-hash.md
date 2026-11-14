# Audit: shared decision record, hash and chain link (`c15025a..d44467a`), and the agent fixes that use it (`88a4b6c..045dbce`)

Date: 12 Nov 2026. Fresh auditors, scope only. Refs: `origin/rules/decision-hash-small` (d44467a, one commit: `packages/rules/src/decision.ts`, tests EC-R31 and EC-R32, INTERFACE section 5 text format), `origin/backend/s8-open-position` (045dbce, the agent imports the helper and sends a real `chain_head`; adds the `withinRules` gate, observed==state check, swap skipped when none is needed, backoff, close arguments, `packages/near` `accountSnapshot`), page at `origin/web/check-page` (a7f309a). Decision A (the helper goes into `packages/rules` now) was relayed by the lead session. The earlier findings this closes or leaves open are in `2026-11-12-code-agent-near-tx.md`, `2026-11-12-code-agent-adapter.md` and `2026-11-12-code-web-check-page.md`. The agent test re-check is section 4.

## 1. The helper (`decision.ts`)

| Auditor | Verdict | Counts |
|---|---|---|
| security-auditor | **fix before merge** | 0 Critical, 0 High, 2 Medium, 4 Low |
| test-auditor | **fix before merge** | 0 Critical, 0 High, 5 Medium, 4 Low |

`decision.test.ts` 11 of 11 pass; `packages/rules` 704 tests pass. Under coverage, the full suite showed timeouts in property tests (`read.test.ts` about line 127), which pass in isolation; unrelated to this change but flaky under load. `decision.ts` coverage 100% lines, 96% branches.

**Security.** No way found to publish bytes that hash to the committed value but read differently on the page: the parse refuses duplicate keys, lone surrogates, non-integer numbers, `-0`, text over 4,096 UTF-16 units and nesting over 32, and requires `canonicalize(parsed) === text`; every string is a fixed enum, 64 lowercase hex or a decimal u128. Pure (no clock, network, randomness).

- **M-1.** `decisionRecordText` validates the state but casts the decision unchecked (`decision.ts` ~37), so an agent bug can hash a record the page cannot read, leaving an action that moved funds permanently unverifiable. Fix: parse the output with `parseDecisionRecord` before returning (throw STATE); optionally require the decision to equal `evaluate(rules, state)`.
- **M-2.** `decisionHash` and `parseDecisionRecord` are separate exports, so nothing forces the page to hash the fetched bytes, parse the same bytes, compare `rulesHash` with `hashRules(revealedRules)` and re-run `evaluate`. Fix: one `verifyDecisionRecord(text, expectedHash, rules)` that the page imports alone.
- L-1: no strategy id or sequence in the record or the chain-link preimage, so two strategies with identical rules and state share a `decision_hash`. L-2: `chainHead(null, h)` equals `chainHead(ZERO_HEAD, h)`, so a reset to zeros looks like a first record; the page must require genesis only at the first record. L-3: decision and rules hashes are separated by schema only (optional tag prefix). L-4: INTERFACE says the page re-runs `evaluate` but the helper does not; `open` left/right not range-checked in the parser; BOM, invalid UTF-8 and trailing-newline cases and a vector file for ports are missing.

**Tests.** Hash-input, chain-link and first-link tests are strong (24 of 30 hand mutants killed). Surviving:

- The close-reason check at `decision.ts:111` can be removed with all tests passing (a record with a bogus close reason would be accepted). Add `{"kind":"close","reason":"panic"}` and extra/missing-key decisions.
- The `rules_hash` anchor (`decision.ts:87`): a 65-character lowercase hex string is accepted with the `$` removed.
- `decisionHash` is never tested on bytes that differ from the canonical text (a trim before hashing survives; EC-R31 says "exact published bytes"); add trailing-newline and non-ASCII cases.
- No literal pinned vectors (the process asks for fixed hash vectors): the reference record hash and chain heads are compared with the test's own recomputation. Add literal 64-hex values for the reference hash, `chainHead(null, h1)`, `chainHead(h1, h2)` and a three-link chain.
- Refusals assert only `toThrow()`, so a case refused for the wrong reason keeps passing; `strictParse` replaced by `JSON.parse` survives because the canonical check rejects the duplicate anyway.
- Weak properties (hold decision only; no single-character-mutation property); boundary cases (point at ±800,000/800,001, u128 max and 2^128, 2^53) thin; no record-size cap test (the security auditor reports `strictParse` caps at 4,096 units; the test auditor found no size check in `decision.ts`; settle by asserting the cap in a test, which also names a new EC ID). EC-R31 and EC-R32 are named only in `describe` titles.

## 2. Both sides of the format (rules-verifier, static read, nothing run)

Bytes and hashes agree: the agent publishes the exact record text it hashes (`decide.ts:58-61`, `loop.ts:49`); the page's SHA-256 over the text bytes (`checks.ts:34`, `run.ts:402`) is the same function; `chain_head` is computed identically (`loop.ts:80`, SHA-256 of `poolside-chain-v1\n` + prev + `\n` + hash, prev defaulting to 64 zeros); the agent checks `withinRules` before every send and `observed == state`. **A run the agent produces does not yet pass the page**, because the page does not contain the helper (a7f309a).

**Agent side (backend), High:**

1. A paired open sends the swap's `decision_hash` but logs a record built from the new state (`loop.ts:48-49`), so `sha256(record)` differs from the sent hash and two log lines share one hash.
2. Honest paired opens fail the page: the observed check (`run.ts:282`) and the range check (`run.ts:241-249`) break when the point or block moved between swap and open. Either the open reuses the swap's exact range, or the page judges a paired open against the swap record's state and range. (Earlier H4, unfixed.)
3. `closedBy` is always "time" (`chain.ts:200`); the replayed decision differs after a stop-loss or take-profit close.
4. `valuationPoint` is the spot point (`chain.ts:199`, Q15 open, needs a co-lead decision).

Medium: no chain-link check on the page (`record.ts` does not parse `chain_head`; fixtures write `null`); the agent restarts the chain from zeros when the last record's `chain_head` is null (`chain.ts:156-158`); page state is not rebuilt from views, the holdings formula exists only in `apps/web` (agent copy at `chain.ts:174-196`), and the fee double count is open (ARCH 5.11); a missing record reads "not matching", INTERFACE says "decision record not published".

**Page changes required (frontend):** rebase onto the helper and delete `stateJson` (`run.ts:195`) and `hashDecisionText` (`run.ts:402`); publish canonical record text in the fixtures (`fixtures.ts:63-69`); in `actionRow` do hash check, then `parseDecisionRecord`, then `rulesHash == config.rules_hash`, then `evaluate(rules, state) == decision`, then `withinRules` (today `decisionMatchesRecord`, `run.ts:241`, reads `d.kind`, which a record object does not have, so every Swap, Open and Close would read "not matching"); stop taking state from `fixture:market_state` and rebuild it from views at the observed block; add a chain check; handle the paired open; change the missing-text wording.

## 3. Agent fixes, security re-check (`88a4b6c..045dbce`): fix before merge, 0 Critical, 0 High new, 2 Medium, 3 Low

Tests (from an archive of the ref): agent 19 of 19, `packages/near` 199 of 199.

| Earlier finding | Status |
|---|---|
| M1 no `withinRules`, observed vs state | **Fixed** (`loop.ts:37-46`, EC-A01 test `agent.test.ts:103`) |
| M2 `plan` or `evaluate` throw ends `run` | **Partly** (`chainHead` at `loop.ts:48` is outside the try: N2) |
| M3 refused swap repeated every round | **Fixed** (`swapNeeded`, one-hour `recentRefusal`; side effect N1) |
| M4 `sendTransaction` and `rpc` | **Mostly** (redirect, non-200, size, non-JSON, null result refused; `ok:false` without `SuccessValue`); open: tx hash not compared with the signed hash, `senderId` unused, cap after full read (N5) |
| M5 local hash / High 1 not page-verifiable | **Fixed on the agent side** (shared helper, `LogEntry` carries the record text) |
| L1 close arguments | **Fixed** (`loop.ts:50-59`) |
| High 7 `withinRules` never called | **Fixed** |
| High 3 grid confirmation replay, High 4 `closedBy`, High 5 paired-open range and hash, High 6 `valuationPoint` | **Not fixed** (not claimed) |
| L2 key scope and receiver pin, L3 nonce and timeout lookup, `real.ts` untested, `head()` bypass, EC-A06 key-log scan | Open |

- **N1 (Medium).** The one-hour backoff applies to every non-hold decision, including a close for a stop-loss or take-profit: a refused close leaves the position exposed for up to 3,600 s. Back off only opens and swaps, or use a one or two round backoff for a close. Unverified: the `Refused` and `Failed` result shapes and `timestamp_ns` are not in the gates; if the contract writes them differently the backoff never fires and M3 returns.
- **N2 (Medium).** `chainHead` throws `RulesError` unless `prevHead` is 64 lowercase hex (`chain.ts:96`, `loop.ts:48`); a last record with `chain_head` `""` ends `run()`. Validate in `chain.ts` and wrap the call.
- N3 (Low, unverified): wrong chaining if the contract does not advance `chain_head` on a refused record. N4 (Low): `swapNeeded` is read at head time while the contract recomputes at call time; same gap as High 5. N5 (Low): `sendTransaction` accepts a reply for a different transaction.
- `accountSnapshot` (`packages/near/account.ts`): no finding; the caller must pass a `blockId` so the two reads agree on a block.
- Keys are not logged (`LogEntry` has method, ok, hash, failure); there is still no EC-A06 scan test.

## 4. Agent fixes, test re-check (`88a4b6c..045dbce`): BLOCK

test-auditor (fresh, scope only). agent 19 of 19, `packages/near` 199 of 199, `packages/rules` 704 of 704 pass; one `read.test.ts` property test (EC-R25) timed out at the 5 s default when the three packages ran in parallel and passed at 30 s (flaky under load; give it an explicit timeout or fewer runs). Coverage: agent statements 84.5% and branches 79.1% (`real.ts` 0% on every metric); near 96.9% and 94.7%. **60 hand mutants: 24 killed, 36 survived.** Only EC-A01 is named in a test (two tests); EC-A02 to A11 are not, and EC-A10 (settle boundary) and EC-A11 (grid confirmation) have no test.

Fixed: `sendTransaction` on an empty result (killed), `rpc` non-200, non-JSON, size and null result, close-argument check, refusal-loop handling (`swapNeeded` skip and backoff mutants killed), and the `withinRules` verdict inversion. Partly: the EC-A01 gate (the point mismatch is tested with a message; the invalid-state case asserts only `error != null`; removing the gate, or the `observed.block` check, survives), fee mapping (holdings killed; both fee mappings survive), `plan` at `swapsUsed` 0 and 1 only.

**Funds-flow and limit paths still without a test (the auditor's High, each blocks as a missing test of a funds-flow edge case):**

1. Platform-owed counted as spendable (`chain.ts` ~118): `+` for `-`, dropping it and removing the clamp all survive; the fake `get_platform_owed` is always "0" and the test titled "clamps what the platform is owed" never sets a non-zero owed.
2. The close latch (`chain.ts` ~92-100): `closed = false` and the `!== "Ok"` flip survive; no test has a `ClosePosition` Ok record.
3. Pool and token validation (`chain.ts` ~78-86, ~131): pool state, `pool_id` echo and quote-in-pool checks all removable (only the flipped `quoteIsX` is killed).
4. Both fee mappings (the fake always returns 0 fees).
5. `real.ts` (the signing path, receiver, `redirect`, `blockId`, the seed path) is 0% covered.

Medium: the gate and `observed.block` mutants; `used > 0n` and pagination (0, 20, 21) untested; the redirect checks (`tx.ts:165`, `account.ts:27`) and key length `< 64` survive; no EC-A06 key-log scan; seven `accountSnapshot` mutants survive (size cap, receiver check, allowance and method-name types, nonce 2^64 bound, code-hash length, unknown permission). Low: backoff at 3,599 s and for `Failed`; no property tests in the agent; the close exemption from the backoff is untested.

Concrete tests to add: non-zero owed above the balance (spendable = balance + internal - owed, clamped at 0); a `ClosePosition` Ok world; one refusal test per pool or token check with exact messages; non-zero fees with x differing from y in both token orders; a `real.ts` test with a fake RPC client including the key scan; the gate refusing an out-of-rules decision (needs a seam, since `plan` comes from `evaluate`) and an `observed.block` mismatch; EC-A02 to A11 named; boundaries at 3,599 s, `last_payout + margin - 1` and `+ margin`, and 19, 20 and 21 actions.

## Blocking status

No Critical. The helper itself is sound and nearly mergeable once M-1, M-2 and the missing close-reason, anchor and exact-bytes tests are added. The four agent-side Highs above (paired open, `closedBy`, `valuationPoint`, grid confirmation replay) and the page's unwired helper still block calling a run replayable, and block any README claim that the page and the agent judge with the same code. A targeted fresh re-check is kept for each funds-path or hash fix.
