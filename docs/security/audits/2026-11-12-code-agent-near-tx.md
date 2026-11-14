# Audit: packages/near tx client and apps/agent (3f51bef^..a0dd574)

Date: 12 Nov 2026. Auditors: security-auditor and rules-verifier (fresh, scope only). The test-auditor stopped at the usage limit and is tracked below. Reported to the backend session through this file.

## security-auditor: fix before merge (0 Critical, 0 High, 5 Medium, 4 Low)

Borsh layout, ed25519 signing, key handling and error text checked and correct. Agent tests 7/7 pass. The near tests showed 1 of 196 failing (`nonce: -1n` case in `tx.test.ts`); a hand mutation was in the working tree at the time, so re-run on a clean tree.

| # | Sev | Finding |
|---|---|---|
| M1 | Medium | `loop.ts` never calls `withinRules`; `state` and `observed` (point, block) are separate, so a mismatch sends one point and hashes another. Gate every send on `withinRules(...).ok` and `observed == state`; tests with zero sends |
| M2 | Medium | `plan`/`evaluate` throw (`checkState`) is not caught; one bad observation ends `run`. Wrap in the try, log, continue |
| M3 | Medium | A refused swap (`no_swap_needed`, floor, drift) is retried every round: `swaps_used` stays 0, records fill to the 64 cap, allowance drains, `agent_open` is never tried |
| M4 | Medium | `sendTransaction` returns `ok:true` with no `status`/`SuccessValue`/hash match; `rpc` ignores HTTP status and has no size cap; `senderId` unused |
| M5 | Medium | `decisionHash` is in the agent with a local `stable()`, not the shared `packages/rules` helper INTERFACE section 5 requires; the page cannot recompute it |
| L1 | Low | `agent_close_position` lacks `position` and `meta.confirm_observed` |
| L2 | Low | `AGENT_METHODS` differs from the key scope in the process; receiver not pinned to the strategy account |
| L3 | Low | Nonce/block hash from `final`; no `tx` lookup after a `send_tx` timeout |
| L4 | Low | No EC-tagged, property, base58 leading-zero or key-logging tests (the real chain adapter is absent) |

Unverified: the signed encoding against a sandbox node; the `send_tx` `FINAL` response shapes (not in `docs/gates/`).

## rules-verifier: not ready to claim "a run replays identically" (4 High, 4 Medium, 4 Low)

Deciding is deterministic and uses `evaluate` from `packages/rules`; no clock, network or randomness. Tests could not be run by this auditor (no `node_modules`).

| # | Sev | Finding |
|---|---|---|
| H1 | High | `decide.ts:39-55` hashes a local `stable({rules,state,decision})`; the page (`checks.ts:31-38`) hashes the published record bytes; `INTERFACE.md:145` requires one shared helper in `packages/rules` (RFC 8785 `canonicalize`). The page can never recompute the hash |
| H2 | High | The agent never publishes a decision record (`loop.ts:73-82`); the page reports "A decision record is missing" |
| H3 | High | `agent_close_position` sent as `{meta}` only; ARCHITECTURE 293/323 and INTERFACE 85 need `position` and `meta.confirm_observed`; `Observation` has no confirm read. Every due close is refused or fails to parse, which the page then reports as a missed close |
| H4 | High | `agent_swap` sent whenever `swapsUsed === 0` without the `swapForRange` non-zero check (ARCH 323); repeats each round (same path as security M3) |
| M5-M8 | Medium | no `withinRules` guard; `observed.point` can differ from `state.point`; `confirmFromBlock`, `valuationPoint`, `fees`, `closedBy` rebuildability by the page unverified (add a shared-code fixture test); the open's hash differs from the swap's, so no interval exemption (liveness only) |
| L9-L12 | Low | observe failure logged as `block 0` hold with an empty hash; send-timeout ambiguity; `stable` is not RFC 8785; no agent-vs-page hash test, no property tests, no EC IDs |

Fix order from the auditor: H1 and H2 together as a separate shared-interface pull request (CLAUDE.md), then H3, H4 and M6, then M5 and M7, then the replay test.

## Blocking status

The rules-verifier Highs block merging `apps/agent` as a replayable agent. Under MINIMAL_PLAN section 6 these are fixable in one pass (not a cut). Security and rules-verifier agree on three items (decision hash, `withinRules` gate, swap repeat).

## test-auditor: BLOCK

Tests pass (near 196/196, agent 7/7) after `pnpm install --frozen-lockfile`. The stray mutation seen earlier in `tx.ts` was this auditor's own and is restored (`git diff a0dd574` empty). The severity labels below are the auditor's own; by `SECURITY_PROCESS.md` section 2 a missing test for a listed edge case is Medium, but the auditor blocks because EC-A01 is a funds-flow case and EC-A06 is key leakage.

| # | Auditor level | Finding |
|---|---|---|
| 1 | Block | No agent test names an EC ID. EC-A01 (never send what `withinRules` rejects) has no code or test; EC-A02 (bad model output) no path and no test (state in EDGE_CASES if the model is out of v1); EC-A03 (timeouts, inconsistent reads) only "boom"; EC-A04 (stale observation) no age check; EC-A06 (no key in logs, `message(e)` copies raw error text) untested; EC-A07 (allowance near zero) unbuilt; EC-A05 and EC-A08: `chain_head` hard-coded `null` and asserted so |
| 2 | Block | `sendTransaction` returns `ok:true` for `result: {}`; only `SuccessValue` and `Failure` are tested; removing the "result missing" branch left all 196 tests passing |
| 3 | High | Surviving mutants: key length `!== 64` to `< 64`, `redirect: "error"` to `"follow"`, `body.result === undefined` removed. `rpc()` timeout, URL scheme, size limit, non-JSON and non-200 untested; receiver not pinned |
| 4 | High | `decisionHash` has no fixed vector and no per-input sensitivity test; the `stable()` comparator mutant was not run; `plan` at `swapsUsed` 0, 1, 2 and the property "send only for open or close" untested |
| 5 | High | Boundaries: gas 1, nonce 0 and 2^64-1, string and huge nonce from `nextNonceAndBlock` |
| 6-8 | Low | `senderId` unused; `run()` only tested on the happy path; test hygiene fine |

Hand mutants: 12 killed, 3 survived, 1 not run.

Before merge the auditor wants the tests in items 1 and 2 (property test that every send satisfies `withinRules`, a stubbed out-of-rules decision sends nothing, a key-scan of the log, an unknown reply shape gives `ok:false`).
