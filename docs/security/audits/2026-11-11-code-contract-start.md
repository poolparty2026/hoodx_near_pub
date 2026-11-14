# Code audit: `contracts/strategy` slice 4, `start` (`468faad..616212e`)

Four fresh auditors on the diff (D52): `security-auditor` (pass, 0/0/0/6), `contract-reviewer` (ready after fixes, 0/0/3/6), `rules-verifier` (pass, 0/0/0/2 + 2 info), `test-auditor` (reported separately below). No Critical or High. Fixed in the next commit unless marked:

| Finding | Resolution |
|---|---|
| Contract M1: callback refusal reasons were bare words, not `LIMIT:` messages | **Fixed:** reasons are the `LIMIT:` messages; ARCHITECTURE-facing docs (INTERFACE, EC-C167) state that callbacks refuse by event |
| Security L3: the refusal reused the event name `start`, which a client could read as a start | **Fixed:** refusals are `start_refused`; `start` is success only; INTERFACE tells clients to treat only `start` as a start |
| Contract M2: callback gas measured at one point only | **Fixed:** sandbox test at +786,431 (19 set bits, division path, 3.2 Tgas) and -786,431 (refused `LIMIT: dust threshold`, 2.8 Tgas), both under half of 30 |
| Contract M3: `escrow_total` and `near_owed_total` not in the reserve check | **Tracked:** `TODO(slice 7, key sales)` in `start.rs` and in EC-C167 |
| Contract L1, security L1: stale "unverified" gas comments; `RECORD_BYTES` is a real assumption | **Fixed:** comments updated; `RECORD_BYTES` tracked in EC-C167 (a test asserts the largest record fits once `ActionRecord` exists) |
| Contract L2, security L1: `RING_SIZE` in the reserve while the design allocates the ring at `new` | **Tracked:** settle before slice 5, or the ring is counted twice (safe over-reserve of about 3.8 NEAR) |
| Contract L3: a failed payee read reports `payee not registered` | **Logged:** a read that cannot show registration fails closed; documented |
| Contract L4, security L5: `Running` inserted before `Cancelled` shifted a Borsh discriminant | **Fixed:** `Running` appended last |
| Contract L5, security L6: `Running` has no exit in this slice | **Fixed (doc):** noted on the enum and in INTERFACE; this build must never hold a funded account |
| Contract L6: the base-token parse after the lock | **Fixed:** parsed before the lock |
| Security L2: floored base dust can pass up to a fraction of a quote unit above the line | **Logged:** disclosed in EC-C136/C167 and the code comment |
| Security L4 (unverified): `get_pool` answer over 4 KB would make every start `read failed` | **Settled by measurement:** mainnet's `get_pool` answer is 849 bytes (view call, 11 November 2026), recorded in `start.rs` and gate 3 Part H |
| Rules L1: `swap_min_output` didn't check the fee tier and slippage range as `swapFloor` does | **Fixed:** only the five tiers and 11..=100 bps; both sides refuse the same inputs; test |
| Rules L2: the wide division was covered only by 21 vectors | **Fixed:** `swap_floor_wide.json` (28 vectors from a fixed seed across the whole point range, both orders, every tier), checked by `check_swap_floor.py` (CI), `floor.test.ts` and the Rust tests |

## Test audit of the same range (`test-auditor`; fix before merge, 0/0/4/8)

About 70 hand mutants, 65 killed; 5 survived (2 mattered, 3 equivalent). Fixed in the slice 5 commit:

| Finding | Resolution |
|---|---|
| M1: `fee_bps = fee_tier / 100` changed to `/ 10` survived (no vector made the reference term win with a non-trivial fee) | **Fixed:** exact values for every fee tier at slip 11 and 100, computed independently from the shared live-point vector (`the_reference_term_carries_the_fee`); a test that the result is the larger term and that a higher tier never raises it |
| M2: swapping the deadline and lock checks survived | **Fixed:** the lock held with the deadline passed reports the deadline |
| M3: later checks' order and per-refusal snapshots | **Fixed:** `start_refusals_in_order` snapshots and asserts no promise on every refusal and checks registrations before the reserve, funding before registrations, the point before funding, the gas before the point |
| M4: a tautological assertion in `storage_reserve_formula` | **Fixed:** exact values for `deploy_ns` after the run end (D = 0), a zero interval, and saturation to `u128::MAX` |
| Low: the callback with the status `Running`; precedence of the callback's checks; drift and slots as exact properties; `mul` across limbs; `price_q128` against the exact rational | **Fixed:** `the_callback_check_order`, `drift_and_slots_are_exact`, `mul_matches_the_wide_product`, `price_q128_against_the_exact_rational` |
| Low: no-op `let _ =` lines | **Fixed** |
| Low: sandbox covers part of the listed items (wrong tokens, a `Paused` pool on the real DCL) | **Accepted:** unit-tested; the real pool in the sandbox is `Running` |
