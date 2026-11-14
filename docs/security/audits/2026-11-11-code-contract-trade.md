# Slice 7 audit (security-auditor and contract-reviewer), 11 Nov 2026

Scope: `ActionRecord` log and `agent_swap` (`6628d2b..edda893`). Fresh auditors, diff only. Both found no Critical issue.

## Fixed in the follow-up commit

| ID | Finding | Fix | Test |
|---|---|---|---|
| H1 (review), M1 (security) | `chain_head` was agent-supplied free text stored in every record | Must be 64 lowercase hex or absent, checked before the lock: `LIMIT: chain head` | `chain_head_is_bounded_and_a_record_fits_the_reserve` (EC-C171), also asserts the record is within `RECORD_BYTES` |
| M1 (review), L4 (security) | Swaps could fill all 64 slots and block the open, close and exits | `RESERVED_SLOTS = 4`; `agent_swap` stops at 60 | `the_action_log_is_capped` at the limit - 1 and the limit |
| M2 (review) | A lost swap was not counted; a failed result opened no window; a stale read round opened a window | `Unknown` counts toward `swaps_used`; `Failed("swap")` opens the window; stale at `ReadRound` is `Failed("read")` with no window | `a_lost_swap_is_unknown_and_opens_the_window`, `a_call_lost_in_the_read_round_is_failed_and_opens_no_window`, `a_refused_swap_and_a_failed_swap_are_not_ok` |
| L3 | `min_out` could be 0 | Refused `floor` | covered by the refusal tests; a direct 1-unit case is still to add |

## Open and disclosed (not fixed in v1)

- Security M2: the reference price is read in the same round as the pool, with no earlier anchor (Q15). The loss per swap is bounded by `step_cap * (drift + slippage + fee)`. Stated for the README and T61/T65. Whether `get_pool` and `predict_add_liquidity` can run in different blocks is unmeasured.
- Review M3 / T62: `GAS_SWAP` (90 Tgas) is unproven against many gifted positions; a swap can then fail without moving tokens. Disclosed.
- Review L2: no 24-hour swap-share cap (EC-C98); the per-step cap and at most 2 swaps per run bound it.
- Review L5: `paused` is not built (out of v1).
- Review L6: the state layout changed before any deploy; no upgrade path is claimed.
- The lowest working `MIN_GAS_SWAP` was not searched.

## Test audit of slice 7 (BLOCK on 8 High, 7 Medium; 83% of 105 hand mutants killed)

Fixed in the same pass, all in `tests_trade.rs` and `price/tests.rs` (222 unit tests pass):

| # | Gap | Test |
|---|---|---|
| 1 | Step cap at the limit (EC-C97), `within_bps` untested | `the_step_cap_holds_at_the_limit_and_one_below` (the smallest admitting cap, then one below), `within_bps_is_exact_at_the_boundary`, a property test against exact arithmetic |
| 2 | Deploy cap (EC-C116) | `the_deploy_cap_holds_at_the_limit_and_one_below`. **Decision:** the minimal build refuses `swap_step` when the step exceeds `max_principal` instead of scaling it down; the EC-C116 row is read that way for v1 |
| 3 | `platform_owed` not subtracted per token | `platform_owed_is_not_spendable` asserts `spendable_quote` 490,000,000 and `spendable_base` 940 exactly, and a share above the balance |
| 4 | Pool identity | `the_pool_identity_is_exact` (EC-C170): wrong partner in both orders, another pool id, missing and non-string tokens, not an object; both orders of the right pair accepted |
| 5 | Drift at the limit | `the_drift_limit_is_inclusive`: 30 accepted either side, 31 refused |
| 6 | Observation age at the limit | `the_observation_age_is_inclusive` |
| 7 | Check order | `the_first_checks_run_in_order`: lock, interval, 24-hour count, opened, position, swaps, quiet, gas, points, log full, each pair |
| 8 | Interval reads `last()` | `the_interval_uses_the_last_record_and_the_day_edge_is_exact` |
| 9, 10 | Spacing on both ends and unknown tier; the day edge | `point_spacing_is_checked_on_both_ends`, same test as 8 (`day - 1` counts, `day` does not) |

Still open from the test audit:

- 11: EC-C106 (`SlotsFull` for `agent_swap`) is **deferred**: the minimal swap does not read `get_user_storage_detail`, and a swap adds no position. It belongs to `agent_open` (S8). EC-C128 and EC-C126's `unknown_add` / paused rows are out of v1 (D55).
- 12: a direct 1-unit `floor` refusal and a `predict` refusal from a failing `swap_for_range`.
- 14 and 15: more properties for `swap_for_range`, and sandbox cases for `centring`, `pool`, `swap_step`, a failed swap and a hash replay on chain.
- The auditor's 112-mutant list should be re-run in the final hardening pass (about 25 minutes) to confirm the new tests kill the survivors.
