# Audit: apps/agent real chain adapter (10f6148..88a4b6c) and the interface freeze design diff (10f6148..4727312)

Date: 12 Nov 2026. Fresh auditors, scope only, refs on `origin/backend/s8-open-position` and `origin/backend/interface-freeze`. The contract slices S8 to S10 (`modest-bardeen..10f6148`) are in `2026-11-12-code-contract-s8-s10.md`. Reported through the lead session; severity labels follow `SECURITY_PROCESS.md` (the rules-verifier labelled two items Critical; they are High by the process: an unverifiable check-page result, no funds loss).

## Agent adapter: block

| Auditor | Verdict | Counts |
|---|---|---|
| security-auditor | **block** | 0 Critical, 1 High, 4 Medium, 4 Low |
| rules-verifier | **not ready** (static read, no tests run) | 2 High (labelled Critical), 3 High, 3 Medium, 2 Low |
| test-auditor | **block** | 5 blocker, 2 High, 3 Medium; 14 agent and 196 near tests pass; coverage stmts 84.1%, branches 78%; 10 of 22 hand mutants survived |

### High

1. **The decision hash cannot be verified by the page** (rules-verifier C1). `decide.ts:205-207` hashes `stable({rules, state, decision})`; the page (`checks.ts:31-38`, `run.ts:139-140,262-263`) hashes the published decision text. The agent publishes no record (`LogEntry`, `loop.ts:231-237`). Same defect as in `2026-11-12-code-agent-near-tx.md` and `2026-11-12-code-web-check-page.md`; it is still open in the freeze (design audit F1 below). Needs one shared helper in `packages/rules`, in its own interface pull request.
2. **The page cannot rebuild the agent's state** (rules-verifier C2). `run.ts:149` reads the guessed `fixture:market_state`; the fixture at `ba8e149` has no `fixture:*` responses and no decision text, so it cannot show agent output accepted.
3. **No confirmation replay over the grid** (security H1). `chain.ts:126-131` carries the run over the agent's own roughly 60-second rounds and never calls `checkConfirmation`. A dip at a grid height between two true rounds is missed, the close is sent (the contract checks only span and quiet), the page replays the grid, reports "the confirmation restarted", and an honest, irreversible close reads "not matching". Fix: read the state at each `gridPoint`, call `checkConfirmation(O1, grid, O2)` before any close; test names EC-A11.
4. **`closedBy` is always "time"** (rules-verifier H3; security L4). `chain.ts:88,100,120,130`: the latch ignores the real close reason, so state, confirm run and hash input diverge after a stop-loss or take-profit close; the page's `withinRules` wants the real reason.
5. **The paired open reuses the swap's hash with a range recomputed from a fresh point** (rules-verifier H4). `loop.ts:254` and `decide.ts:178-185` against `run.ts:129`; honest runs rejected when the point moved. Pairing is also decided at head time (`chain.ts:94`) while the contract decides at the call's timestamp.
6. **`valuationPoint` is the spot point** (rules-verifier H5; security M3). `chain.ts:123,129`; ARCHITECTURE line 148 says the contract's public anchor; Q15 is pending. A flash move held for the confirmation could fire a stop loss, and the page cannot read an anchor.
7. **Test-auditor blockers:** `withinRules` is never called in `round` and there is no EC-A01 test (also security M1); no test names any EC-A ID (A01 to A11); the close latch mutant (`chain.ts:100`) survives; the platform-owed subtraction (`chain.ts:118`) is untested, so platform fees could be counted as spendable (funds-flow); pool and token validation (`chain.ts:78-86,131`) untested; `real.ts`, which holds the signing path, is 0% covered (also security M4).

### Medium (selected)

Swap and open sent without the contract's first checks (security M2: margin, quiet, lock), so a refused send repeats and drains the key allowance (rate unverified); possible fee double count between `predict_remove_liquidity` and `fees` (rules-verifier M6, ARCH 368 open); holdings formula lives in `apps/web`, not `packages/rules`; records the page cannot read (`decision_hash: ""` on `ExitRemove` against the 64-hex rule; `get_actions` pages vs `get_action`); confirmation run held in memory (a restart or off-grid start may not replay); boundaries thin (`PAIR_WINDOW_S` and +1, pagination 0/20/21, `close_after_s` and -1); no property tests in the agent; loose outcomes (`not.toBeNull`).

### Low

`real.ts` `head()` bypasses the hardened RPC path (https, redirect, size cap, `body.error`); block timestamp read as a float (about 256 ns error; use `timestamp_nanosec` string; `nowS` and `isPairedOpen` can be off by one second at a boundary); 300 Tgas prepaid for every method and the whole action log paged every round; `deps.dcl` not compared with `get_config().dcl_contract`; `stable` comparator not RFC 8785.

### Checked, sound

`decide` purity; all reads at one block with `nowS` from that block's own timestamp; the shared helpers used from `packages/rules` (`nextConfirmRun`, `isPairedOpen`, `nsToS`, `readU128`, `readU64`); `meta.observed` matches the page's comparison; close arguments `position` and `confirm_observed` match INTERFACE; key handling (the seed only reaches `publicKeyOf` and `signTransaction`, no env read; untested); `packages/near` unchanged; no new dependencies.

## Interface freeze, design audit (security-auditor, diff `docs/INTERFACE.md`): fix before merge, 0 Critical, 0 High, 4 Medium, 2 Low

No Critical or High with a path built only on behaviour confirmed in `docs/gates/`. The frozen text agrees with the contract for `register_tokens`, `agent_open`, `agent_close_position` and `reveal` (refusal orders, minimum gas, the 3,600 s pair window, the 40 to 400 block span, the 4,096-byte cap; limits before the first external call; `AUTH: callback only`).

- **F1 (Medium, 5.11 item):** the decision-hash and chain definition is still "proposed" (`INTERFACE.md:159`) while `decision_hash` and `chain_head` are frozen as Built; no record format or helper exists (the contract's `trading_meta` only checks 64 hex and unseen), so an agent can attach any unused hash and only the page's replay can catch it. Specify the record schema, canonical bytes, `decision_hash = sha256(bytes)` and `chain_head = sha256(prev_head || record_hash)` in `packages/rules` with shared vectors. This is the same gap as High 1 above.
- **F2 (Medium):** removal fees (`min(unclaimed, reported)`, `INTERFACE.md:117,121`) cannot be reproduced from public data: no read block is stored (`remove.rs:78`, `reference: None`), and whether `remove_liquidity` includes fees is unconfirmed (MINIMAL_PLAN line 94). Say the page reports fees and `platform_owed` as "can't check" unless the sandbox run reconciles them, or record the read block in `RemoveInfo`.
- **F3 (Medium):** the "frozen" text contradicts itself ("this file wins" against "ARCHITECTURE wins until the freeze", `Built, growing` rows, lenient inputs against a freeze, a Planned table that says "stable" beside Open items). Delete the stale sentences and add an explicit "not in v1" list.
- **F4 (Medium):** a lost add strands the position (`on_open_added`, `open.rs:466-474`: success with an unparsable id leaves `own_position = None`, `adopt` is cut, `settle` proceeds). Gate 3 line 80 confirms a plain `lpt_id`, so this needs an unconfirmed deviation and MINIMAL_PLAN accepts it; the freeze and the page must say "possibly stranded", never a pass.
- **F5 (Low):** `INTERFACE.md:87` misdescribes the `exit_remove` caller rule (in `Running` only an outsider after the grace period; agent and creator get `LIMIT: exit not open yet`).
- **F6 (Low):** `reveal` reuses the refusal `LIMIT: balance for registration`; an `ExitRemove` record has `decision_hash` `""`, against the "64 lowercase hex" rule.

## Blocking status and order of fixes

The agent adapter is blocked from being called a faithful, replayable agent until Highs 1 to 7 are fixed. Under MINIMAL_PLAN section 6 they are fixable in one pass. Suggested order: (1) the shared decision-record helper (own pull request: it fixes High 1, F1 and the web audit's matching finding), (2) grid confirmation replay and the `closedBy` and paired-open range fixes (3 to 5), (3) `withinRules` gate, platform-owed, pool validation and `real.ts` tests (7), (4) the `valuationPoint` decision (6, needs a co-lead: Q15). A targeted fresh re-check of a funds-path or hash fix is kept.
