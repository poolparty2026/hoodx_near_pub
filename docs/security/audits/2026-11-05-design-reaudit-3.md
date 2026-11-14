# Design re-audit 3, 5 November 2026

- **Scope:** revision 4 (commit `2552b2e`): the status of R1 to R13 and L1 to L4, a fresh audit, and cross-document consistency.
- **Auditor:** `security-auditor`, a fourth fresh instance. Read-only. No tests, because there is no production code.
- **Verdict:** **block.** New findings: Critical 2, High 4, Medium 6, Low 5.

## Status of earlier findings

| Status | Findings |
|---|---|
| Resolved | R1 (in design), R4, R6, R7, R8, R9, R10, R12 (as specified), R13, L2, L3, L4, N4, N7, N11, N12 (in design), M1 (in design) |
| Partly resolved | R2, R3, R11, L1, N3, N14, N17, C1, C2 |
| Not resolved | R5 (sweep race), M10 (USDC freeze powers) |

## New findings

| ID | Severity | Finding |
|---|---|---|
| F1 | Critical | `sweep` isn't locked and reads the balance asynchronously, so concurrent sweeps, or a sweep and a claim, can add the same tokens more than once |
| F2 | Critical | Each cut is capped at the balance separately, so together they can exceed it, and `settle` panics or over-allocates |
| F3 | High | `paid` changes only in the claim callback, so two claims in one block both pay out. A callback that runs out of gas leaves `in_flight` stuck |
| F4 | High | Anyone can call `update_anchor`, and every lock counts toward the agent's interval and 24-hour count, so outsiders can stop the agent acting |
| F5 | High | Per-token cuts from collected fees contradict the gate 5 and EC-C14 rule that a strategy which loses value pays no cuts |
| F6 | High | Rhea internal balances in tokens the contract doesn't hold can block `settle` (premise unverified) |
| F7 | Medium | The anchor check also blocks removals and fee claims, so a stop loss can be delayed by days in a crash. Nobody is assigned to call `update_anchor` |
| F8 | Medium | The shared 24-hour anchor budget can be used up by an attacker, and a single counter can't represent a rolling window |
| F9 | Medium | The starting anchor comes from one spot read, with no bound |
| F10 | Medium | No exit path after `Closed`. A zero cooldown and an unbounded dust threshold make that worse. `fees_collected` isn't frozen at settle |
| F11 | Medium | Missing bounds: dust maximum, minimum range width, cap ordering, `min_join`, the start deadline, and deliverer ≠ creator |
| F12 | Medium | Calls anyone can make that take the lock write records with no storage payment and no rate limit, so they drain storage and grief `settle` |
| F13 | Low | Document inconsistencies (deliverer location in `CLAUDE.md` and the plan, "in kind is the fallback", EC-C26 against EC-C49, EC-C12, a threat-model table break, the T2 outflows, the agent list, the deliverer and `decryptRules`, the reviewer's "per token") |
| F14 | Low | Caps are relative to the maximum principal, not the principal actually joined |
| F15 | Low | Plain NEAR transfers to a deleted account leave NEAR untracked |
| F16 | Low | Alerter hardening: rename the token variable, no inbound handling, plain-text messages, missing triggers, pin the client |
| F17 | Low | The rounding remainder isn't actually sweepable; `pool_total` doesn't say whether it includes unclaimed cuts |
