# Audits of scripts/mainnet-roundtrip.ts (4b46c45)

Fresh agents, scope only. Both ran the tests and the `dry` mode (view calls only); neither sent a transaction.

- **security-auditor: fix before merge** (Medium 2, Low 6). M-1: no stop on errors, no preflight, no recovery for a half-done run (a person with no USDC could lose the 0.5 NEAR DCL storage for nothing, and a stale predict could leave tokens in DCL). M-2: EC-S01 to S03 untested by name; the RPC's network unchecked. Lows: no method allow-list; unwrap of the whole wNEAR balance; the fee comparison could read a decoy receipt or a wrong hash; zero withdraws; unchecked RPC numbers and no timeout; missing process note, readability and docs.
- **test-auditor: block** (31 hand mutants, 21 survived). Cap values not pinned; the run gate untested; several limits only tested at limit + 1; no EC IDs; no method allow-list; `removeResult` test order hid a missing check.

| Finding | Resolution |
|---|---|
| No stop on errors; no preflight; no recovery (sec M-1) | `preflight` (USDC and NEAR balances, pool Running, tokens and fee); every send checks the transaction outcome (`txFailed`) and stops; deposits checked in DCL before the add; the add re-predicted just before sending, refused if the price left the range or the predict exceeds the deposits; `recover` mode; tests |
| Network and run gate (sec M-2, test) | `chain_id` must be mainnet; `.testnet` accounts refused; `assertRunAllowed` for `run` and `recover`; EC-S01, S02, S03, S07, S08 named in the tests |
| Method allow-list (sec L-1, test) | Nine (receiver, method) pairs; storage only for the signer; deposits only with msg `"Deposit"`; `near_withdraw` capped; payouts must skip unwrapping; add minimums above 0 |
| Unwrap (sec L-2) | Only the wNEAR the run added, at most 1 NEAR |
| Fee comparison source (sec L-3, test) | The transaction's top-level return; the hash must be this account's `remove_liquidity` on DCL; events only from DCL receipts that succeeded; decoy receipts placed after DCL's in the test |
| Zero withdraws (sec L-4) | Only non-zero DCL balances withdrawn |
| RPC numbers and timeout (sec L-5) | Strict `u128` reads; the predict refused if above the deposits; 20 s timeout |
| Docs (sec L-6) | Process note in gate 3 part D; network printed; NEAR shown in decimals; flags without values refused; Node 22.18; proxy note marked as for cloud sessions |
| Test strength (test) | Literal values pinned; every limit at the limit and one past; exact messages; full CLI argv; 18 tests (from 9) |

Before `run` on mainnet: a second independent security audit, `/security-review` and a co-lead reading both reports.


## Rounds 2 and 3 (4be11f5, then aae12cd)

Each round had two fresh security-auditors and one fresh test-auditor, scope only.

| Round | Finding | Resolution |
|---|---|---|
| 4be11f5 security 2, M-1 | The fee comparison only compared the event's own fields and couldn't show where the fees went | The remove now prints the change in wallet plus DCL internal balance, and the predict, next to `refund_token` and `refund_token + claim_fee_token`; it refuses to conclude without fees or with a missing field, and says it is evidence, not the answer |
| 4be11f5 security 1 L-1 to L-6, security 2 L-1 to L-8 | Fees-above-0 not enforced; withdraws and recover not size-limited; contract accounts accepted (EC-S04); no retry or recover guidance mid-run; storage-locked NEAR ignored; EC-S07/S08 undefined; outcomes not bound to the sent transaction; run's weaker owner check; `BigInt` parsing; dry mode not predicting; existing DCL balance not guarded; unchecked `current_point` | All fixed in aae12cd (helpers named in the commit) |
| 4be11f5 test | 10 surviving mutants, `main` untested | Tests for each; `main` made injectable |
| aae12cd security A, M-1 | An add that lands but stops the script lost its `lpt_id` from the recover hint | The `lpt_id` is read as soon as the transaction is found, before its outcome is judged; recover without `--lpt` lists open positions; the run ends "not done" while anything is left |
| aae12cd security A, M-2 | `--lpt` accepted in run mode, skipping the size check | `--lpt` only in recover; the size check in both modes; run removes only a position with its own range |
| aae12cd security A M-3, test block, security B L-6 | The run path after the first send was untested (18 of 29 mutants survived) | A stateful stubbed chain drives whole runs: the full sequence with exact arguments and minimums, failed, mismatched and hash-less transactions, lookup retries, each refusal before the add, the fee gate, wNEAR caps, the recover listing (EC-S11, EC-S12). Line coverage 97%; uncovered lines are only the real RPC and the entry point |
| aae12cd Lows | Pasted hash matched loosely; failed withdraw payout still "done"; no slot check; remove minimums rounding to 0; agent accounts with function-call keys and global contracts accepted | Arguments compared; "not done" ending; slot preflight; minimums at least 1; agent-style accounts refused |

Still unverified, only checkable on a machine with near-cli-rs: its argument syntax and deposit units, exit codes, where it prints "Transaction ID:", and whether its prompts stay visible with stdout piped. Each fails closed: a misread deposit or argument is refused by the transaction match after the send, before the next one.


## Round 4 (9e3d748)

Two fresh security-auditors and one fresh test-auditor.

| Finding | Resolution |
|---|---|
| Security C, M-1: near-cli-rs re-encodes `json-args` with sorted keys, so the exact argument match refused every call with two or more keys after it was sent (a run would stop at the USDC deposit, after the 0.5 NEAR storage) | Arguments compared in canonical form (keys sorted at every level); the stubbed CLI now re-encodes with sorted keys like near-cli-rs, so the test suite would have caught it |
| Security C, L-1; security D, L-1: the hash is printed on stderr, so it is always pasted, and an older identical transaction could be pasted | A hash is accepted once per run, and only if its receipts ran at or after the final block read just before the send |
| Security C, L-2: CLI behaviours not recorded | Recorded in gate 3 part D from the 0.31.1 source; the installed version is printed at the start of `run` and `recover` |
| Security D, M-1: after the remove, the recover hint still named the removed position, and that recover stopped before withdrawing | `lpt` cleared once the remove lands; recover of a position that no longer exists goes on to the withdraws |
| Security D, M-2; test G2: the EC-S04 key and global-contract checks were optional and untested through `main` | Parameters required; tested through `main` in dry and run mode |
| Security D, L-2: ordinary wallets with dApp logins are refused without saying why | The message says to use a freshly created account with only a full-access key |
| Security D, L-3: dead test code | Removed |
| Test G1: only "no" was tested at the prompts | EC-S13: empty, `y`, `YES`, `yes please` and `no` send nothing; a declined unwrap sends no `near_withdraw` |
| Test G3 to G8 | Failed receipts on every non-payout call; the right-point range check; predict equal to the deposit; the add's y minimum; `ALLOWED_CALLS` pinned by content; strict parsing; a lookup that works on the fourth try; exactly one action and the gas compared |
| Contract review of revision 18, L-3: no measurement of `PAYOUT_SETTLE_BLOCKS` | Each send prints the block heights its receipts ran in and the span from first to last |


## Round 5 (5578c9f)

Two fresh security-auditors (both **pass**, 3 and 5 Low) and one fresh test-auditor (**block**: the fresh-account path untested).

| Finding | Resolution |
|---|---|
| Test G1: no test for an account not registered at wrap.near or DCL, the path every real run takes | EC-S14: storage paid once each, exact amounts, for the signer; a minimum over the cap refused; a failed storage receipt stops |
| Test G2, G3, G7: no-receipts refusal, the freshness boundary and order, a CLI-printed repeated hash | Tested, including the block read before every send |
| Test G4, G8, security E L-1: the hint after a failed remove, a position vanishing between reads, no way out of the fee wait | Tested; `stop` in the fee wait ends the run with the hint naming the position |
| Test G5, G9, G10 | Every non-yes unwrap answer; the unknown-account refusal; exact messages |
| Security E L-2: only the `tx` lookup was retried | Every RPC read retried three times with backoff; an unknown account isn't |
| Security E L-3, F L-1: an add minimum could round to 0 after the deposits | The add's minimums are at least 1 whenever the need is |
| Security F L-2: the CLI version was printed, not enforced | `run` and `recover` need near-cli-rs 0.31.x |
| Security F L-3: a transfer during the remove prompt skewed the fee evidence | The balance baseline is read after the confirmation, just before the CLI runs |
| Security F L-4: a failed CLI exit lost the position id | The message says recover without `--lpt` lists open positions |
| Security F L-5: slots checked only in the preflight | Re-checked just before the add (EC-S12) |
| `tx` result shape unrecorded | Written into gate 3 part D |


## Round 6 (7581d71)

Two fresh security-auditors (G and H, resumed after the usage limit; both **pass**, 2 and 3 Low) and one fresh test-auditor (**block**: registration at only one contract untested).

| Finding | Resolution |
|---|---|
| Test G1: registered at only one contract | Tested both ways, with the NEAR the preflight needs (EC-S14) |
| Test G2 to G6 | Recover's CLI version check; strict DCL minimum; a `removeMin` property; stronger assertions |
| Security G L-1, H L-1: an unknown account with a long id wasn't recognised (the error was cut before its name) | The cause name goes first in the error text; tested with the real error shape (8f6b8c8) |
| Security G L-2: the recover hint ignored wNEAR in the wallet | The hint and recover's ending mention it |
| Security H L-2: a stale add hash could set the position id before the freshness check | The id is read only after the freshness check |
| Security H L-3 (unverified): near-cli-rs could prompt on the inherited stdin | Every send prints "press Ctrl-C and never paste a key"; header and gate 3 part D say so |


## Round 7 (diff 7581d71..eaa3f5a)

One fresh security-auditor (**pass**, 2 Low) and one fresh test-auditor (**pass**, 5 Low). Two independent security audits of 7581d71 (round 6) had already passed.

| Finding | Resolution |
|---|---|
| Security L-1: near still read the terminal, guarded only by a warning | near is started with no terminal input (`NEAR_SPAWN`), so any prompt fails closed; tested |
| Security L-2: the RPC error name was printed raw | Printed only if it is plain `A–Z_`; tested with an escape sequence |
| Test L1 to L5 | Exact preflight message; last send asserted on stale hashes; the wNEAR report only in recover and only when non-zero; `removeMin` exact for 1 to 1000; EC-S15 to S17 named |
