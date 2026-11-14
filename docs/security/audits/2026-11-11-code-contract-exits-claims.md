# Code audit: `contracts/strategy` slice 6, `exit_withdraw`, `claim_platform`, `claim_creator` (`7e5e203..a25e538`)

`security-auditor` (pass, 0/0/0/3), `contract-reviewer` (ready after fixes, 0/0/2/7), `test-auditor` (reported separately). No Critical or High. Both audits judged the deliberate `claim_creator` deviation (one wallet read, 5.11) safe: the legs sum to the wallet read, a late arrival only raises the wallet, a failed platform leg is restored exactly once, and the T66 gas-starve window of the two-read design no longer exists. Fixed in the next commit unless marked:

| Finding | Resolution |
|---|---|
| Contract M1, security 1: a `withdraw_asset` that reverts every time (out of its fixed gas, a paused DCL) was never counted, so the token could never become stuck and `settle` would refuse for ever | **Fixed:** a failed receipt and any result but an exact `true` count like a `false` (same interval gap); tests with 3 failed receipts over 24 hours and with a garbage result, both reaching "stuck" |
| Contract M2 (unverified): `withdraw_asset` by the strategy account, the 60 and 90 Tgas budgets and a non-empty answer are unmeasured | **Kept marked unverified** in `exit.rs`, gate 3 Part K and EC-C169; not measured until `agent_open` can create a strategy-owned internal balance (`DEVELOPMENT_PLAN.md` section 9) |
| Contract L1: first-check order differed from principle 5 (the outsider time gate before the token; the platform window after the lock and rate limit) | **Fixed:** status, caller, token, time, lock, rate limit for `exit_withdraw`, `claim_platform` and `claim_creator`; tests pin each adjacent pair |
| Contract L2: `nothing to withdraw` had no `LIMIT:` prefix | **Fixed:** `LIMIT: nothing to withdraw`; INTERFACE and EC-C169 updated |
| Contract L3: the two-leg claim was exercised only in unit tests | **Fixed:** a sandbox test patches `closed_at_ns` to the epoch and sends both legs from one read on native USDC (1,000,000 to the platform, 499,000,000 to the creator, the lock released) |
| Contract L4, security: 5.5, EC-C114 and THREAT_MODEL still describe the two-read sequence | **Fixed:** the 5.5 row points to the 5.11 deviation; T66 describes the single read; the deviation still awaits a co-lead (asked on Telegram, 11 November) |
| Contract L5: 1 yoctoNEAR per transfer is outside the NEAR accounting | **Tracked** in EC-C169: counted with `escrow_total` when key sales land |
| Contract L6, security 2: a lost claim keeps `paid_platform` raised, and the ring and `get_lost_counts()` do not exist yet | **Tracked:** new threat T75 (bounded by 5% of that token's fees, disclosed); a late failed platform leg after `resolve_stale` is covered by `a_lost_claim_keeps_paid_platform_raised` |
| Contract L7: Borsh layout (new fields inserted before `rate_stamps`) | **Logged:** no deployed state exists; no funded account may hold any build before the gates in `DEVELOPMENT_PLAN.md` section 9 |
| Security 3: INTERFACE `get_settle_window` still "Planned"; "not while paused" has no `pause()` yet | **Fixed / tracked:** the row is Built; the paused flag joins `exit_withdraw` with `pause()` (EC-C169) |
| Security (process): the sandbox run failed mid-audit because the working tree changed under it | **Noted:** edits during an audit's sandbox run trip the stale-wasm guard; the full suite was rerun on a stable tree (15 tests pass) |

## Test audit of the same range (`test-auditor`; fix before merge, 0/1/5/5)

About 42 hand mutants; 5 survived. The audit ran on `a25e538`, before the contract review's fix (failed receipts now count), so its High ("recorded without counting is not asserted") concerned the old rule; its real finding is that *what counts and what resets* was never asserted exactly. Fixed in the next commit; the four mutants that mattered now fail:

| Finding | Resolution |
|---|---|
| H1: the classification of `withdraw_asset` results (what counts as a failure, what resets) was not asserted; a garbage `1` read as `true`, or a transient failure treated as a success, would pass | **Fixed:** `every_withdraw_result_is_classified_exactly` drives 15 results (exact `true`, exact `false`, a failed receipt, empty, `1`, `0`, a string `"true"`, a string `"false"`, `False`, `True`, spaces, `falsey`, two results, none) from a clean count and from a count of 2, asserting the exact reason, the counts, the first and last timestamps and the reset only for an exact `true`; the mutants `true` also accepting `1` and `false` matched by prefix now fail |
| M1: `claim_creator`'s status, caller and token order was half tested; a leftover placeholder call | **Fixed:** `claim_creator_status_then_caller_then_token` (every role in `Closing` gets `wrong status`; every non-creator gets `AUTH` with a bad token, a held lock and a rate stamp); the placeholder was removed; the mutant moving the caller check after the token now fails |
| M2: the signer was never distinguished from the predecessor on the new methods | **Fixed:** `the_new_methods_use_the_predecessor_not_the_signer` for `claim_creator`, an outsider's early exit and an outsider's below-dust platform claim |
| M3: exits and claims while the settle window is open (EC-C133) | **Fixed:** `claims_and_exits_ignore_the_settle_window` with exact transfers |
| M4: both legs failing, duplicate callbacks | **Fixed, with a code hardening:** a leg that is not pending is ignored (`callback_ignored`), so `paid_platform` can never be restored twice; `both_legs_failing_and_duplicate_callbacks`; the mutant removing the guard now fails |
| M5: the property test was capped at 1e9 and tautological; no 1,000-cycle test | **Fixed:** `claims_over_the_whole_u128_range` (fees, prior payment and wallet over all of `u128`, creator and platform claims, no overflow, never above `fees / 20`), `a_thousand_donation_and_claim_cycles` |
| L2, L3, L4: an outsider exit's window class; the failure gap across classes; a duplicate read callback | **Fixed:** `outsider_exit_class_and_the_shared_failure_gap`, `a_duplicate_exit_read_callback_is_ignored` |
| L5: `closed_at_ns == None` in `claim_creator` | **Accepted:** unreachable (`Closed` always sets it); the code reads it as never |
| Sandbox notes: `exit_withdraw` only with nothing to withdraw; assertions use `contains` | **Accepted, tracked:** a real `withdraw_asset` by the strategy needs `agent_open`; `contains` is how the earlier slices assert on-chain refusals |
