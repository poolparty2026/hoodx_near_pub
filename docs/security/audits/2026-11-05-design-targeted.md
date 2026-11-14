# Targeted design audit, 5 November 2026

- **Scope:** revision 6 (commit `c191033`). Under D16, this checks the fixes for V1, V2, V3 and V6, and any new Critical or High issue those fixes introduce.
- **Auditor:** `security-auditor`, a sixth fresh instance. Read-only. No tests, because there is no production code.
- **Verdict:** **block.** Critical 1, High 3, Medium 3, Low 3.

| Finding | Status in revision 6 |
|---|---|
| V1 | Partly resolved: `settle` is protected, `sweep` isn't (C1) |
| V2 | Resolved in design, depending on the gate 3 view that lists positions; the fix adds a new lock path (H1) |
| V3 | Partly resolved: the agent can manufacture market-caused refusals (H2) |
| V6 | Partly resolved: the check page doesn't verify the deployed code (H3), and wNEAR isn't pinned (M3) |
| V4, V5, V7 to V11 | Present; tracked as edge cases |

## New findings and revision 7

| ID | Severity | Finding | Revision 7 |
|---|---|---|---|
| C1 | Critical | A gas-starved `ft_transfer_call` that the token then refunds still reaches `sweep`'s balance read, inflating payouts | No method allocates from a balance read. `sweep` only moves ledger amounts credited by successful `ft_on_transfer` or Rhea result callbacks |
| H1 | High | Positions given to the strategy by third parties can block settle forever | `close()` snapshots the strategy's positions, capped. Settle waits only for the snapshot. Later gifts, other pools and anything beyond the cap are ignored |
| H2 | High | The agent can produce "market-caused" refusals by never updating the anchor, or with oversized swaps | An excuse needs prompt anchor updates, retries every interval, and sizes within `evaluate`. Slippage and Rhea `Failed` results aren't excuses |
| H3 | High | The check page doesn't check the deployed code against the audited build | WASM hash checked against a reproducible build of a published, audited commit, at every sampled block |
| M1 | Medium | The `held` ledger's semantics are underspecified | One crediting path per inflow; `unallocated`; `resolve_stale_claim` debits `held` |
| M2 | Medium | `reconcile` could starve outsider exits | Its own rate limit; outsiders only after close; it never adds to the snapshot |
| M3 | Medium | The wNEAR pin isn't specified | `allowed_tokens` ⊆ {quote, wrap.near}; the page checks every token and pool |
| L1 | Low | Drift with a truthful observation is market-caused | Classified as market-caused |
| L2 | Low | Kept transfers in Closing and Closed | Disclosed |
| L3 | Low | `get_heartbeats` and the missing `claiming` field | Fixed |
