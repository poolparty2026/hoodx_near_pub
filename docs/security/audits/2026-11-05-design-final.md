# Final design audit, 5 November 2026

- **Scope:** revision 5 (commit `6ce575a`). Checked: the status of F1 to F17, a fresh audit, and cross-document consistency. This is the final round under D16.
- **Auditor:** `security-auditor`, a fifth fresh instance. Read-only. No tests, because there is no production code.
- **Verdict:** **block.** New findings: Critical 1, High 3, Medium 3, Low 4.

## Status of earlier findings

| Status | Findings |
|---|---|
| Resolved | F1, F2, F3 (in design), F4, F5 (by decision D15), F6 (internal balances), F7, F8, F9, F10, F13 (as listed), F14, F15, F16, R2, R3, R5, N17, C1 (in design) |
| Partly resolved | F11, F12, F17, R11, N3, N14, C2 |
| Not resolved, disclosed | M10 (USDC freeze powers) |

## New findings and how revision 6 handles them

Under D16, the Critical and High findings are fixed in revision 6 and checked by a targeted fresh audit. The Medium and Low findings are also addressed in revision 6, and they are tracked as edge cases so code audits confirm them.

| ID | Severity | Finding | Revision 6 |
|---|---|---|---|
| V1 | Critical | A transfer that will be refunded is credited before `ft_on_transfer` runs, so a `settle` or `sweep` balance read can count tokens that are about to leave, over-allocating payouts | Internal `held` ledger. In Closing and Closed, every allowed-token transfer is kept. `settle` allocates `min(held, read)`. `sweep` adds only `balance - held - disputed` (EC-C80) |
| V2 | High | Tracked positions can disagree with Rhea (for example after `resolve_stale`), so `exit_remove` and `settle` deadlock | `reconcile()` reads positions and internal balances from Rhea. Exits take the position id. Positions in pools outside the allowed list are ignored (EC-C81) |
| V3 | High | The check page accepts any refusal as an excuse for a missed action, including refusals the agent caused | Refused attempts get the full checks, and only truthful, market-caused refusals excuse a required action (EC-W13) |
| V6 | High | `dcl_contract` and `quote_token` aren't pinned, so a lookalike contract can make every check pass | Compile-time constants per network. `new` refuses others. The check page verifies them (EC-C83, EC-W14) |
| V4 | Medium | `settle` and `sweep` spam can keep the lock held | Refused at the first check while anything remains. Outsiders rate-limited (EC-C82) |
| V5 | Medium | The contract pays for storage that callers add, and escrow isn't protected | `storage_reserve` required before start. Only the latest heartbeat is stored. Writes keep escrow intact (EC-C84) |
| V7 | Medium | Claim recovery underspecified; a failed transfer gets redistributed | `resolve_stale_claim` row, per-claim `in_flight`, `paid_total`, a `disputed` reserve excluded from sweep (EC-C79) |
| V8 | Low | The agent can update the anchor while paused | Refused while paused (EC-C85) |
| V9 | Low | No cap on open positions; intervals unbounded above | `max_open_positions`, and upper bounds on both intervals (EC-C86) |
| V10 | Low | Owed NEAR paid by account name, and names can be re-registered | Disclosed |
| V11 | Low | Document inconsistencies (reviewer, EC-C30, the remainder wording, "never principal", sweep in `split()`, T13, D16, decision order, NEAR vs wNEAR) | Aligned |
