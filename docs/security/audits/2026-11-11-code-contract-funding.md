# Code audit: `contracts/strategy` slice 3, funding (`05a8245..4e8feca`)

Three fresh auditors on the diff only (D52): `security-auditor` (pass, 0/0/0/2), `test-auditor` (fix before merge, 0/0/3/9), `contract-reviewer` (ready, 0/0/0/5). No Critical or High. Resolutions, in the next commit unless marked:

| Finding | Resolution |
|---|---|
| Test M1: withdraw's check order only partly tested (two reordering mutants survived) | **Fixed:** `withdraw_reports_the_earlier_of_two_failing_checks` sets each adjacent pair at once; both mutants now fail |
| Test M2: `on_withdrawn` never got another `op_id` at the right stage (a stage-only mutant survived) | **Fixed:** `a_late_callback_of_another_op_at_the_same_stage_is_ignored` for both callbacks; the mutant now fails |
| Test M3, security U-1 to U-3, contract unverified: gas constants, the 4 KB `msg` gas ceiling, the gas-starved transfer, the real tokens' `ft_balance_of`, `ft_transfer` and unregistered-payee answers, `QUIET_INBOUND_BLOCKS` | **Tracked, blocks any deployment:** slice 3b sandbox tests on the pinned native USDC and wrap.near code. Minting with native USDC's code (a multisig `ConfigureController` request) is being worked out first; `PAYOUT_SETTLE_BLOCKS` stays a 5.11 item |
| Security L-1, contract L2: `resolve_stale` releases any lock without looking at the operation; no rate limit or `StaleRead` | **Fixed (guard):** an exhaustive `match` on `Op` with no wildcard, so the next `Op` variant must decide its resolution; the rate limit and `StaleRead` come with the general `resolve_stale`, before any trading or exit `Op` |
| Security L-2, test L1, contract L5: EC-C46 said a zero balance is refused with a `LIMIT:` message | **Fixed:** EC-C46 now states the event outcome the code and EC-C166 have (the zero is only known in the callback) |
| Test L2 to L7: a later arrival, a kept transfer before `withdraw`, no-lock callbacks' calls and events, `resolve_stale`'s event fields and refusal snapshot, amount 0 and an edge-weighted property test, the base token in upper case | **Fixed:** one test each |
| Test L8: `parse_balance`'s 39-digit guard is an equivalent mutant | **Logged:** kept as a cheap bound before the parse; no behaviour depends on it |
| Test L9: `cancel`'s caller-before-lock order untested | **Tracked:** no lock can exist in `Open` until `start` lands; that slice tests it |
| Contract L1: `withdraw` has no `LIMIT: storage` check | **Tracked:** added with `storage_reserve` (5.3); today the lock is about 100 bytes inside `STORAGE_MARGIN_BYTES`, and a failed write is a runtime error the creator fixes by sending NEAR |
| Contract L3: callbacks use an explicit check, not `#[private]` | **Logged:** same rule as slice 2's `on_registered` (contract re-review L-1), so the `AUTH: callback only` message reaches the chain |
| Contract L4: `ft_on_transfer`'s `amount: U128` accepts `+` and leading zeros | **Logged:** only the two pinned pool tokens can be credited, and they send canonical amounts; the strict newtype replaces it when it lands for the agent's arguments |
