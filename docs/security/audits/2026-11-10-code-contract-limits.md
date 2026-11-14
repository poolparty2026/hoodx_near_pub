# Code audit: `contracts/strategy` slice 1, `new`'s configuration checks (`3e9e97a..3df214f`)

Three fresh auditors on the diff only (D52): `security-auditor`, `test-auditor`, `contract-reviewer`. All three checked the new drift bound independently and found no counterexample. Fixed in the next commit:

| Finding | Resolution |
|---|---|
| Test H-1, H-2; security M-1; contract review M-1: EC-C54 pairs untested (3 of 6 role pairs, agent and deliverer never against the other accounts) | **Fixed:** all 6 role pairs and all 16 role-to-account pairs, counted in the test |
| Test M-1: `run_end_ns` at 0 and below now untested | **Fixed** |
| Test L-1: `stale_cooldown_blocks` and `max_range_width_bps` at 0 | **Fixed** |
| Test L-2: EC IDs not named | **Fixed:** EC-C54, EC-C64 named; EC-C54's sandbox part noted |
| Security L-2, contract review L-5: `attested: true` accepted before gate 2 | **Fixed:** `ATTESTATION_ENABLED = false`, `LIMIT: attested` |
| Security L-3: D51 and the revision 26 summary still gave the old bound | **Fixed:** D54, both annotated |
| Security L-4, test L-3, contract review L-4: the exhaustive claim untested | **Fixed:** `width_bound_holds_for_every_width` checks every pair and the monotonicity |
| Security L-5, contract review L-3: helpers panic outside their range | **Fixed:** the add-ratio helper is test-only; `max_drift_for_width` is 0 below 4 points |
| Contract review L-2: dust threshold 0 accepted | **Fixed:** at least 1, `LIMIT: dust threshold zero` |
| Contract review L-6: `platform_account` chosen by the deployer | **Open:** a co-lead decision before the first mainnet deploy (5.11) |
| Contract review: pool and USDC ids not in the gates | **Fixed:** confirmed by a mainnet view and written into gate 3 |
| Contract review notes for the chain slice (`AccountId`, network selection by feature, a shared distinctness helper for `set_agent`, checked arithmetic, the 41-byte minimum) | **Tracked** for slice 2; the 41-byte minimum is now in 5.3 |
| Security and test Info: the drift's own 300 bound is unreachable above 90 | **Noted** in the width test's comment |

## Targeted re-audit of the fix (`b430bd6..eae181d`)

Security: **pass** (every fix confirmed; the pool view re-run on mainnet; `platform_account` still open). Test: **pass** (2 Low, 1 Info; 11 of 15 hand mutants killed, the survivors a no-op and the bound being too strict). Low 1, the bound's maximality, is fixed in the next commit (every minimum width: one more drift breaks the bound). Low 2, EC-C54's sandbox tests and `set_agent`'s check, and the security note that `agent_open` must refuse ranges wider than `max_range_width_bps`, go with slice 2.
