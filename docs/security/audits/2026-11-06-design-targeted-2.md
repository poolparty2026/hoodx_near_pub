# Targeted design audit 2, 6 November 2026

- **Scope:** revision 7 (commit `5c70050`), checked against C1, H1, H2 and H3 from the previous targeted audit, under D16.
- **Auditor:** `security-auditor`, a seventh fresh instance. It paused on a usage limit and was resumed. Read-only.
- **Verdict:** **block.** Critical 0, High 3, Medium 2, Low 1.

| Finding | Status |
|---|---|
| C1 | Resolved for the original vector; the replacement ledger has N1 |
| H1 | Partly resolved; the fix adds N2 |
| H2 | Partly resolved; the drift excuse adds N3 |
| H3 | Resolved in design; N4 tracked |

| ID | Severity | Finding |
|---|---|---|
| N1 | High | Ledger credits from Rhea results can fire twice (DCL `ft_transfer_call` plus our callback), or be credited on swallowed failures, or never be credited, and nothing reconciles them. Depends on how DCL delivers withdrawals |
| N2 | High | The close snapshot is the only exit, so a missed position is stranded for good; gifts compete for its slots; `close` depends on an unconfirmed listing view. Positions are NFTs and can be transferred (confirmed 6 November), so the premise holds |
| N3 | High | An agent can manufacture a drift excuse with a deliberately old observation |
| N4 | Medium | The window for the code-hash and nonce checks has no defined start |
| N5 | Medium | A late claim callback after `resolve_stale_claim` is unspecified |
| N6 | Low | Stale text from revision 6 (`disputed`, EC-C69, EC-C79, T46, the 5.4 diagram) |

## Revision 8 (after the gate 3 Rhea sandbox run)

| ID | Revision 8 |
|---|---|
| N1 | Ledger credited only in our callbacks, by a fixed rule per operation, conservatively: DCL's reported amounts minus the lost-and-found increase, or the swap minimum. `skip_unwrap_near` on every DCL call. Exact predicted add amounts. `exit_lostfound`. Residual paid only by `sweep_residual`, whose transfer fails if the balance was inflated |
| N2 | Snapshot from recorded positions plus exact matches of lost adds. Any other strategy-owned position can be removed by anyone without blocking. `close` falls back to recorded positions. Entries drop only on a positive "not found" |
| N3 | Drift excuse only with an observation from no more than 3 blocks before inclusion, and the move also present at the block before the price read and at the nearest sample |
| N4 | Detection window from account creation; single creating transaction; nonce and join-event checks |
| N5 | Claim callbacks bound to their in-flight entry |
| N6 | Stale text fixed |

## Targeted audit 3 of revision 8 (commit `c643402`)

- **Auditor:** `security-auditor`, an eighth fresh instance. Read-only. Rhea facts from gate 3 part B treated as given.
- **Verdict:** **block.** Critical 0, High 3, Medium 3, Low 3.
- **N1:** partly resolved. **N2 and N3:** resolved. **N4 to N6:** present.

| ID | Severity | Finding |
|---|---|---|
| H1 | High | Lost-and-found crediting can count the same tokens twice: DCL may record the lost payout after our read, swaps subtract nothing, and there's no stored baseline. Recovery then credits again |
| H2 | High | `sweep_residual` can be blocked forever by one non-claimer, sends residual to the platform, double-pays unswept `unallocated`, and its "transfer fails if inflated" claim is false for NEP-141. Stale operations crediting nothing makes the residual large |
| H3 | High | `held` is debited only in the callback and not checked before sending, so a failed callback loses the debit and the tokens are later credited again |
| M1 | Medium | Fees appear only in the `liquidity_removed` event, which a callback can't read |
| M2 | Medium | Predicted add amounts don't prevent leftovers; leftover wNEAR may arrive as native NEAR |
| M3 | Medium | Gifted positions matching a lost add's points can enter the snapshot, and gift-removal spam delays settlement |
| L1 to L3 | Low | `withdraw_asset` returns only a bool; listing past its bound isn't proof a position is gone; the nearest-sample rule gives false "not matching" after short real moves |
