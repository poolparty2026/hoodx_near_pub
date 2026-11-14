# Design re-audit, 5 November 2026

- **Scope:** revision 2 of the design (commit `639fce5`): `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/security/THREAT_MODEL.md`, `docs/security/EDGE_CASES.md`, checked against the build brief, the gates and the skills.
- **Auditor:** `security-auditor`, a fresh instance, not the original auditor. Read-only.
- **No tests were run.** No production code exists yet.
- **Verdict:** **block.** New findings: Critical 2, High 4, Medium 8, Low 5.

## Status of the first audit's findings after revision 2

| Status | Findings |
|---|---|
| Resolved | C3 (the gas problem), H2, H3, H4 (as a disclosure), H6 (for swaps), M3, M4, M5, M6, M7, M8 (in design), L3, L4, L5, L7 |
| Partly resolved | C1, C2, H1, H5, M1, M2, M9, L2, L6 |
| Not resolved | M10 (USDC freeze powers), L8 (pinning and reviewing the NEAR AI SDK) |
| Accepted | L1 (spike code) |

## New findings

| ID | Severity | Finding | Fix in revision 3 (awaiting re-audit) |
|---|---|---|---|
| N1 | Critical | `exit_step` is a swap path with no caps, priced from a spot price that can be manipulated, and anyone can call it after the grace period. `pause` doesn't stop the agent from calling it in Closing | Outsiders may only remove positions and withdraw; they never swap. Exit swaps by the agent or creator use the same caps and price anchor as other actions. `pause` blocks the agent's exit calls |
| N2 | Critical | TOCTOU: the lock is taken only after the `get_pool` callback, so concurrent calls get past the pending lock, the interval and the daily caps | Take the lock and reserve the budget before the first external call. Re-check everything in the callback. A refusal in the callback is recorded and releases the lock |
| N3 | High | Pending-lock lifecycle: a late callback can clear another action's lock, the stale threshold is undefined, `settle` reads balances without a lock, and tokens arriving after `Closed` are stranded | Index-bound locks, a bounded stale threshold, a cooldown after stale resolution, a locked `settle` chain, and `sweep` after Closed |
| N4 | High | Settling in kind has an undefined trigger, outsiders can force it to erase the cuts, and it can strand positions still inside Rhea | Settle in kind only when no positions or Rhea balances remain, after recorded failed exits. Cuts are taken in kind at the anchor price. Removing positions and `sweep` stay available |
| N5 | High | Interference detection rests on one indexer and covers only the run | Read the recovery key's nonce, the key list and the code hash from both RPC providers at fixed points and the latest block, until every claim is paid. The indexer only adds details |
| N6 | High | Redelivery after `rekey` can release a key payment again | A sale state machine (Escrowed, then Released or Refunded) that moves NEAR at most once |
| N7 | Medium | The daily value cap is measured at a price that can be manipulated; no caps have numbers; D4 lists obsolete caps | Value moves at the anchor price. Caps are fractions of the principal, checked in `new`. Correct D4 |
| N8 | Medium | Limits are checked on basis-point inputs, not on the rounded points actually sent | Check every limit on the final points, and record them |
| N9 | Medium | Claims by an account holding several roles are undefined | Claims per role |
| N10 | Medium | Token registration in `new` has no failure path | Registration results recorded by callbacks, retry before `start`, and `start` requires them all |
| N11 | Medium | Deadlines have no bounds; the delivery deadline and stale threshold aren't defined | Explicit fields with bounds checked in `new`. `start` checks the deadlines |
| N12 | Medium | `ActionRecord`, state and the full signatures were dropped from the design | Restored, with every field the check page reads |
| N13 | Medium | The Mirror page acts on untrusted rules with the follower's own funds | Mirror only for pools in `allowed_pools` with matching tokens. Show full token ids |
| N14 | Medium | `contract-reviewer`, several edge cases, the plan, a skill, gate 5 and D4 contradict the revised design | All updated with revision 3 |
| N15 | Low | One dust threshold for tokens with different decimals; ignored dust is locked forever | A threshold per token, and dust goes to `sweep` |
| N16 | Low | The daily window isn't defined | A rolling 24-hour window |
| N17 | Low | The threat model and the architecture disagree on whether the agent host holds the deliverer key | Separate hosts, stated in both |
| N18 | Low | Viewing-key escrow is outside money in unaudited code | Small key price and sales cap checked in `new`, disclosed |
| N19 | Low | Heartbeat chain continuity across pauses and `set_agent` | Heartbeats allowed while paused. The first heartbeat after `set_agent` commits to the previous head |

## Unverified by the auditor

- Rhea: converting points to a price, reading `get_pool` inside a callback, the liquidity calls, storage per position, how swap output arrives, whether a time-weighted price exists, and fees and value per position at past blocks.
- Whether a function-call key's allowance can be topped up in place.
- USDC freeze powers and the D3 account id.
- NRAS expiry.
- Whether two independent archival RPC providers and an account-history indexer exist.
- How long NEAR receipts can be delayed.
