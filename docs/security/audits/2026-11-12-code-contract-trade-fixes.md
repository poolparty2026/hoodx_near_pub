# Audit: slice 7 fixes, `contracts/strategy` (edda893..10c422d)

Date: 12 Nov 2026. Fresh auditors, scope only: security-auditor, contract-reviewer, test-auditor (each resumed once after the usage limit). Reported to the backend session through this file. Earlier audits of the original slice are in `2026-11-11-code-contract-trade.md`; this is the re-check of the fix commits (66ebf42, db54e82, 10c422d), which change a funds path. `cargo test -p strategy`: 220 pass; clippy `-p strategy --all-targets -D warnings` clean (contract-reviewer). Sandbox/wasm tests, `cargo llvm-cov` and `cargo mutants` were not run.

## Blocking

**H1 (test-auditor). The `min_out == 0` refusal at `trade.rs:676` has no test.** Replacing it with `false` left all 27 trade tests passing. If the line is lost, a swap with no slippage protection is sent and nothing notices. Test to add: an input small enough that `price::swap_min_output` returns 0 asserts `Refused("floor")`, no promise sent, lock released, no window opened; one unit higher passes the floor and the swap proceeds. The auditor rates it High as a funds-protection line (fix before merge). It is a missing test, not a code defect, so under `SECURITY_PROCESS.md` it is Medium by definition; recorded as High here because the mutant survived on a funds path. Contract-reviewer independently noted the same missing test (Low).

## Medium

- **M1 (security-auditor, contract-reviewer, same finding).** `trade.rs:506-512`, `on_swapped` `None` arm (failed or unparsable result): opens the settle window but does not count `swaps_used`; the lost-callback path (`funding.rs:416`) does. A failed `ft_transfer_call` result after the pool took the input leaves the 2-swaps-per-run cap unconsumed and the agent can retry. Pick one rule (conservative: count any failed or unreadable result). Test with an EC ID asserting `swaps_used` and a refused third swap `LIMIT: swaps per run`. Whether Rhea can fail this way is unverified; the inconsistency is fact. The existing test `a_refused_swap_and_a_failed_swap_are_not_ok` asserts only the window. The reviewer also asks that the "failed transfer may have moved tokens" fact be recorded in `docs/gates/` or the rhea-dcl skill.
- **M2 (test).** `the_pool_identity_is_exact` discards `why` and its accepting half only asserts `!= Refused("pool")`; assert the lock is in `Swapping`.
- **M3 (test).** EC-C97 step cap: no one-unit-over and no fractional case (steps by whole basis points); assert nothing moved (no promise, `swaps_used` unchanged, no window).
- **M4 (test, reviewer L, security L1).** `RESERVED_SLOTS` is enforced on the swap side only and nothing proves that `agent_open`, `agent_close_position` and `exit_remove` still succeed at 60 to 63 records and refuse only at 64; exits must never be refused for storage. EC-C171 says 59/60 but the code is 60; reconcile the row and the test names. Add a hard cap in `open_action` with an `is_reserved` flag.
- **M5 (test).** `within_bps` proptest skips overflowing multiplies, so the large-value regime is only sampled; add a proptest with a 256-bit reference.

## Low

- Security L3 / contract: `parse_hash` accepting uppercase is unverified; add an uppercase `chain_head` test (the test-auditor saw 64 `A`s refused, consistent with EC-C31).
- Interval at minus one nanosecond and at the limit (EC-C170) not seen in this file; two check-order pairs unasserted (`inside payout margin` before `gas`, `observation age` before `decision hash`).
- Test labels: several new tests name no EC ID (platform-owed, observation age, order, interval, spacing); `the_drift_limit_is_inclusive` is labelled EC-C95 but that row is the step cap, so relabel (EC-C30 / EC-C170); EC-C97 is used for both the `within_bps` unit test and the step cap test, check uniqueness in `EDGE_CASES.md`; `let _ = why;` and the duplicate `s`/`s2` setup.
- The log-full refusal comes after observation, hash and points checks (cosmetic, principle 5). `funding.rs` stale `Op::Swap`: the `stage == Swapping` test is the only discriminator, so every new stage before the swap send needs a branch or a test.

## Checked, no finding

The stale-timeout split by stage (`Swapping` finishes Unknown, counts toward the cap, opens the window; the read stage is `Failed("read")` with no window; the lock is released first in both), the zero-floor refusal before the external call, no underflow in `MAX_ACTIONS_STORED - RESERVED_SLOTS`, the `chain_head` bound (64 lowercase hex or absent) with `RECORD_BYTES` asserted, and the zero-floor/cap mutants: 4 of 5 hand mutants killed (`>=` to `>` on the log cap, removed `swaps_used += 1` on a lost swap, removed `chain head` refusal, removed window on a failed result); 1 survived (H1).

## Verdicts

Security: fix before merge (0 Critical, 0 High, 1 Medium, 3 Low). Contract review: ready after fixes (0 Critical, 0 High, 1 Medium, 4 Low plus info). Test: fix before merge (1 High, 4 Medium, 3 Low). The one High is a missing test for a line that is correct as written; no Critical, and no code defect above Medium.

## Re-check

Not required for the tests. M1 changes funds-path behaviour (it counts a swap); a targeted fresh security-auditor pass on the fix is kept (MINIMAL_PLAN section 6).
