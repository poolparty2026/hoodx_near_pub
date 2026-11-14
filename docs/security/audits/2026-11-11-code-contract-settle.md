# Code audit: `contracts/strategy` slice 5, `close`, `settle` and the rate limit (`5ef683c..2145133`)

`security-auditor` (fix before merge, 0/0/2/3, both Mediums unverified), `contract-reviewer` (ready after fixes, 0/1 deployment gate/2/3), `test-auditor` (reported separately). No Critical. Fixed in the next commit unless marked:

| Finding | Resolution |
|---|---|
| Security M-1 (unverified): a non-empty `list_user_assets` answer in an unexpected shape could read as no balance and close early | **Fixed:** every entry, for any token, must be a strict amount; anything else is `LIMIT: read failed`; tests for nested objects, a renamed wrapper, numbers, null, arrays and unreadable amounts of tokens that aren't ours |
| Security M-2 (unverified): a very large answer could make the callback panic | **Fixed (shown not to panic):** the read is capped at 4 KB by `promise_result_checked`, which returns an error, not a panic; a valid answer over 4 KB is `LIMIT: read failed` with the lock released (test). A genuinely long real answer would block `settle` (liveness, tracked: contract review M1) |
| Contract H1 (deployment gate, not a defect): `Closed` has no payout path until the exits and claims exist | **Recorded:** `DEVELOPMENT_PLAN.md` section 9 lists what a build needs before it may hold a funded account; `withdraw` after `Closed` is deliberately not offered |
| Contract M1: no way past an internal balance at or above dust; a long answer blocks for good | **Tracked as a gate:** the stuck-token rule lands with the exit slice, before any slice that can create an internal balance |
| Contract M2: `Closed` is reachable with no `own_position` check | **Tracked as a gate:** `agent_open` does not land before `settle` checks `own_position`, with tests that fail if it is ignored |
| Contract L1, security L-1: `resolve_stale` checked the rate limit before checking for a lock | **Fixed:** `nothing in flight` first (no stamp), then the rate limit, then `not stale yet` |
| Contract L2, security L-2: a settle refused in its callback keeps the stamp, so an outsider can use the outsiders' slot | **Logged:** disclosed in principle 5; the creator's and agent's slots are separate |
| Contract L3: `close()` after `run_end` must abort a parked chain | **Tracked as a gate** on the trading slice |
| Security L-3: the dust property test's ID | **Fixed:** it names EC-C168 and the boundary values |

## Test audit of the same range (`test-auditor`; fix before merge, 0/0/3/6)

21 hand mutants; 17 killed, 2 survived, 1 did not compile. Fixed in the next commit; all three surviving or missing items now fail their mutant (checked by hand):

| Finding | Resolution |
|---|---|
| M1: the signer was never distinguished from the predecessor in `close`, `settle` or `resolve_stale` (a signer-based mutant survived) | **Fixed:** `roles_are_the_predecessor_not_the_signer` (a relayed creator-signed call is an outsider's; a creator call relayed by another signer still closes; classes by predecessor for `settle` and `resolve_stale`); the `signer_account_id` mutants in `caller_class` and `close` now fail |
| M2: the leading-zero rule of the strict amount (`len > 1` to `len > 2`) survived | **Fixed:** `strict_amounts` (`00`, `01`, `0123`, `0`, `10`, the largest value, one above it, a number, null); the mutant now fails |
| M3: EC-C155's "forwarded gas identical at the minimum and at 300 Tgas" was untested | **Fixed:** `forwarded_gas_does_not_depend_on_what_the_caller_attached` for `settle`, `start` and `withdraw` |
| L1: `close`'s status-before-caller order killed only incidentally | **Fixed:** an outsider at `run_end - 1` in every other status |
| L2: dead `before` lines; no snapshot after each later `settle` refusal; the cooldown/window pair was not really tested at once | **Fixed:** one helper snapshots every refusal; values chosen so each adjacent pair fails together |
| L3: `u128::MAX` for the base token | **Fixed** |
| L4: the rate limit before the staleness in `resolve_stale` | **Fixed:** `resolve_stale_rate_limit_comes_before_staleness` |
| L5: `settle_until_block` is written directly; the own-position and stuck-token rules and the parked-chain abort are untested | **Accepted, gated:** deferred to the trading and exit slices (`DEVELOPMENT_PLAN.md` section 9) |
| L6: the untracked probe file | **Fixed:** the probe was deleted and never committed |
