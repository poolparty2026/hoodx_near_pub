# Code audit: `contracts/strategy` slice 2, the on-chain `new` (`a1880b0..bb29935`)

Three fresh auditors on the diff only (D52): `security-auditor`, `test-auditor`, `contract-reviewer`. Fixed in the next commit:

| Finding | Resolution |
|---|---|
| Security H-1: `new` sent DCL `register_tokens` with 1 yoctoNEAR, which gate 3 confirms panics `E104`, so no strategy could start and every deploy lost its DCL storage; my new gate and skill notes misstated the gate | **Fixed:** `register_tokens` removed; three registrations; the gate paragraph and the skill corrected with a note of the mistake |
| Contract review H1, security M-1: a callback lost to gas left a registration `Pending` for ever (no retry, `start` blocked, DCL NEAR lost) | **Fixed:** no callback starts a promise; callbacks have fixed gas and no share of unused gas; `MIN_GAS_NEW` and `MIN_GAS_RETRY` at the first checks (from the mock's measurement, about 50% over); a `Pending` registration can be retried after `stale_after_blocks`; a stale DCL storage is only re-checked with `storage_balance_of`, never deposited twice; each launch has a nonce and a stale callback is ignored |
| Test H-1 (F1): `to_pure`'s field copies untested (mutants survived) | **Fixed:** every field mapped to its own place with distinct values; each bound one past its limit through `new` with its exact message |
| Contract review M2, security M-2: anyone could call `new` first | **Fixed:** `#[private]` plus an explicit check; T72 |
| Contract review M1, security L-1, L-2: the balance check ignored the contract's own storage | **Fixed:** the cost plus the storage stake of what the account uses plus a margin, in `new` and `retry_registration`, tested at the limit and one below for each target |
| Test F2, F3: outgoing calls checked only by receiver | **Fixed:** method, arguments, deposit, gas and gas weight asserted for every call and callback |
| Test F4: callbacks only with an empty answer | **Fixed:** a realistic `storage_deposit` answer, no result, a failure, over 4 KB and exactly 4 KB |
| Test F5: balance and gas limits not at the limit | **Fixed** |
| Test F6: refusals didn't show nothing changed; outcomes missing | **Fixed:** each refusal leaves registrations and receipts unchanged; every target succeeds and fails |
| Test F7, security L-6, contract review L2: events | **Fixed:** `new`, `registration_started`, `registration`, `registration_ignored`, exact lines asserted |
| Test F8: EC IDs | **Fixed** (EC-C11, EC-C54, EC-C56, EC-C165 in the test docs) |
| Test F9, security L-3, contract review L4: the misleading comment | **Removed** with `register_tokens` |
| Contract review L1: caller checked before status in `retry_registration` | **Fixed:** status, caller, gas, registration |
| Contract review L3: no nonce on the callback | **Fixed** |
| Security L-4, contract review L5: the mainnet build test couldn't fail; a sandbox build could run on mainnet | **Fixed:** CI checks the release wasm has the mainnet DCL and no `test.near`; a sandbox build refuses `new` off `.test.near`; CI tests both builds |
| Security L-5: CI without `--locked`, no Rust dependency audit | **Partly:** `--locked` everywhere; `cargo audit` tracked (5.11) |
| Security unverified: `TOKEN_STORAGE` is a constant | **Tracked:** if a token raises its bound, retries fail the same way; read the bound at deploy in a later slice |

## Targeted re-audit of the fix (`bb29935..2d73bf5`)

Contract review: ready after fixes (1 High, 3 Low). Security: fix before merge (1 Medium, 3 Low). Test: fix before merge (3 Medium, 6 Low). The earlier blockers were all confirmed fixed. Fixed in the next commit:

| Finding | Resolution |
|---|---|
| Contract re-review H-1, security M-1: the documented one-batch deploy is signed by the parent, so a `#[private]` `new` could never run | **Fixed:** `new` accepts the strategy account or its parent (only the parent can create it; a refused `new` reverts the deploy); grandparent, sibling and child refused; N4 unchanged. The security auditor's alternative (two transactions, the strategy key signing `new`) was rejected, recorded in T72 |
| Contract re-review L-1: `#[private]` hides the `AUTH:` messages on chain | **Fixed:** removed from `new` and `on_registered`; the explicit checks are the same rule |
| Contract re-review L-2, security L-2: DCL storage could be paid twice | **Fixed:** `deposit_may_have_landed`; only a failed deposit receipt or a `null` re-check clears it; while set every retry re-checks |
| Contract re-review L-3: the sandbox suffix | **Confirmed and documented:** `test.near` exists on mainnet (view, block 223,852,887); the suffix check is a backstop, CI's wasm check and a pinned wasm hash are the protection |
| Contract re-review Info: CI's `! grep` | **Fixed:** an explicit exit |
| Test M-1: an `Ok` registration retried when stale | **Tested:** refused at every block (the mutant is killed) |
| Test M-2: predecessor and signer never told apart | **Tested** for `new` and `retry_registration` |
| Test M-3: the re-check's non-object answers | **Tested:** seven non-object answers `Failed` |
| Test L-1 to L-6 | **Tested:** the re-check's balance at the stake; a stale retry of each target in full; two results; the lookalike suffix; the largest state fits the margin; the caller before the gas |
| Security L-1: gas floors from the mock | **Tracked** for the slice 2b sandbox (real wasm) |
| Security L-3: escrowed NEAR in the balance check | **Tracked** for the key-sales slice |
| Test: two refusal branches unreachable while `Status` has only `Open` | **Noted:** tested when a second status lands |

Ten targeted mutants (the stale state, signer for predecessor in both methods, non-object as `Ok`, the re-check paying in full, `check_only = stale`, two results, the flag never cleared, the flag ignored, the parent check dropped) are all killed.

## Targeted check of `2d73bf5..35c1691` (the parent may call `new`)

Security: **pass** (1 Low). Contract review: **ready** (1 Low, 4 Info). Test: fix before merge (3 Low, 2 Info). No Critical, High or Medium: slice 2 is cleared. Fixed in the next commit:

| Finding | Resolution |
|---|---|
| Security L-1: a stale re-check reading `null` while the deposit is still in flight cleared the flag | **Fixed:** a `null` (or a total below `dcl_storage`) clears it only when the re-check was launched at least 2 × `stale_after_blocks` after the deposit; tested one block early and at it |
| Contract review L-1: any JSON object counted as `Ok`, so an outsider's 0.5 NEAR registration could pass | **Fixed:** `Ok` only if `total >= dcl_storage`; tested at, above and below it and for unreadable totals |
| Contract review Info-1: `stale ||` redundant | **Kept** as defence in depth, with a `debug_assert!` |
| Contract review Info-2: the parent rule trusts the parent | **Documented** in 5.5: a plain account, or a factory calling `new` in the same batch |
| Contract review Info-3: EC-C165 mixed unit and sandbox | **Fixed:** unit outcomes first, the sandbox list on its own |
| Contract review Info-4: a view type changed | **Accepted:** nothing deployed; kept in this slice |
| Rhea behaviour unconfirmed (three items) | **Listed** in gate 3 for the slice 2b sandbox |
| Test F1: the flag-driven re-check's balance | **Fixed:** at the stake, and one below with nothing changed |
| Test F2: two results on a DCL deposit | **Fixed:** the flag stays, the retry re-checks |
| Test F3: the parent's `new` asserted nothing | **Fixed:** stores and sends exactly what the account's own does; a top-level account has no parent |
| Test F4: 63-character accounts, dead code | **Fixed:** 64 characters |
| Test F5: EC IDs per test | **Accepted** as before |

## Targeted check of `35c1691..80222b1` and slice 2b

Security: **pass** (3 Low). Fixed in the next commit: a low total one block early (L-1); the late window counted from the latest deposit (L-1); the parent's `new` compared call by call (L-2); the doc comment. L-3 (a receipt delayed past the window) is **disclosed** as T73. Slice 2b, the sandbox tests on the real wasm, is in the same commit and goes to its own audit.

## Slice 2b: sandbox tests on the real wasm (`80222b1..0df60ce`)

Security: **fix before merge** (2 Medium, 4 Low). Test: **fix before merge** (3 Medium, 5 Low; F1 to F8). No Critical or High. All fixed in the next commit:

| Finding | Resolution |
|---|---|
| Security M-1: near-workspaces' build script downloads and runs the near-sandbox binary with no hash check, and any root cargo command triggered it | **Fixed:** `default-features = false, features = ["rustls"]` (no build-time download); `fetch_wasm.py` fetches the binary and refuses one whose SHA-256 isn't pinned (it matches the 26 October copy); run.sh sets `NEAR_SANDBOX_BIN_PATH` and unsets `SANDBOX_ARTIFACT_URL`; the tests refuse to start without both; `default-members = ["contracts/strategy"]`. Checked: a root `cargo clippy` builds only the contract |
| Security M-2, test F1, F2: gate 3 Part F recorded printed facts as confirmed; the wrap refund check passed on a panic | **Fixed:** DCL's exact `{available, total}` answers (1, then 2 NEAR), both successes, and its receipt's status a value, not a promise; both re-registrations succeed, cost the same to within 0.001 NEAR, and leave the total unchanged. Part F now lists only asserted facts, and marks the gas figures printed only; the old "not yet confirmed" list points to it |
| Security L-1: native USDC's code was never run | **Fixed:** the quote token now runs native USDC's mainnet code (pinned hash, its own `init`). Its storage bound, registration, re-registration refund and gas (under half of `GAS_REGISTER`) are asserted |
| Security L-2: T73 said the extra DCL storage was recoverable | **Fixed:** not recoverable (DCL has no storage withdraw); it stays as unused DCL storage |
| Security L-3, test F3: `MIN_GAS_NEW` not tested on chain at the limit; the 34 Tgas figure was the whole batch receipt, not `new` | **Fixed:** the deploy at exactly 200 Tgas must succeed with all three `Ok`; each `storage_deposit` and callback under half its budget, and the retry's receipt under 10 Tgas. The `contract.rs` comment and Part F state the batch receipt |
| Security L-4: stale or unchecked wasm; no `--locked` | **Fixed:** the tests re-check every pinned hash and refuse a strategy wasm older than its source; `--locked` added. Mutation-checked: a tampered `wrap.wasm`, a touched source file, and a missing `NEAR_SANDBOX_BIN_PATH` each refuse |
| Test F4: events, nonce, exact totals, balance; the stale DCL re-check on real DCL | **Fixed:** exact events and nonce 1, each token's total exactly 0.00125 NEAR, the strategy paid exactly the three deposits. A new test patches DCL's registration to `Pending`, is refused before it is stale, then re-checks (`check_only: true`), with no deposit, DCL's real answer parsed, and `Ok` |
| Test F5: the failure path | **Fixed:** the other two stay `Ok`, the `ok: false` event, and the 0.00125 NEAR refund, compared with an all-`Ok` deploy to within 0.0001 NEAR |
| Test F6: nothing changed after refusals | **Fixed:** registrations, status and every storage balance compared before and after; a refused batch leaves no events or storage |
| Test F7: a root `cargo test` ran the sandbox crate | **Fixed:** `default-members` |
| Test F8 (optional) | **Covered** by the exact event lists on each retry |
| Unverified: `cargo audit` of the 156 crates near-workspaces brings in | **Tracked** with the existing `cargo audit` item (dev-only; never in the wasm) |

## Targeted check of `0df60ce..0f8a6ba` (slice 2b fixes)

Security: **pass** (2 Low). Test: **pass** (5 Low or info). All earlier slice 2b findings confirmed fixed; **slice 2b is cleared**. Resolutions, in the next commit:

| Finding | Resolution |
|---|---|
| Security Low-1: the near-sandbox pin trusts its first download from the same bucket | **Accepted** and recorded under T16 and in `wasm/README.md`; whether nearcore publishes an independent checksum is unverified |
| Security Low-2, test L5: the freshness check missed `Cargo.lock`, the root manifest and the build kind | **Fixed:** both files in the time check, and the wasm must be the sandbox build (it names `.test.near`). Checked: touching `Cargo.lock` refuses |
| Test L1: one test without its EC ID | **Fixed** |
| Test L2: "exact events" and "paid exactly" looser than stated | **Fixed:** the full event list of both deploys asserted (`new` with its data, three starts in order, three results); the balance margin 0.002 NEAR, and Part F reworded to match |
| Test L3: refund tolerance | **Fixed:** each re-registration costs under half the bound |
| Test L4: 199 Tgas events, an unchecked index, the snapshot comment | **Fixed:** no events asserted; length checked; the comment says why the balance isn't compared |
| Test L5: the refusal depended on `ATTESTATION_ENABLED` | **Fixed:** the refused deploy uses an uppercase rules hash (`LIMIT: rules hash`) |
