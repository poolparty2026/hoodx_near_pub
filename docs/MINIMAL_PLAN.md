# Minimal implementation plan (from 11 November 2026, 09:00 UTC)

Written on the session owner's instruction of 11 November to **target a minimal implementation by the deadline** (14 November 2026, 23:59 UTC). It replaces `DEVELOPMENT_PLAN.md` sections 3 to 6 for scheduling and the cut order, and is recorded as **D55** (`DECISIONS.md`) for a co-lead to confirm. Everything in `CLAUDE.md` still binds: the hard rules, the claim limits, "never push to `main`", "a person runs every mainnet transaction", and the audits (reshaped in section 6, not dropped).

## 1. What "minimal" means: the acceptance test

One scripted scenario, run end to end, on the real Rhea (DCL 2.4.2) and native USDC code in the local sandbox, and recorded so the check page can replay it:

1. A creator deploys a strategy contract whose **rules are hidden**: only the SHA-256 and the encrypted rules are on chain (`new`, built).
2. The creator funds it with USDC, registers the DCL tokens, and starts it (`start`, built; `register_tokens` step new).
3. The **agent** decides from the rules (`packages/rules`, shared with the check page), swaps about half into wNEAR, opens one position, and later closes it on a rule (time, stop loss or take profit). Every action is a record on chain.
4. The strategy closes, settles, the rules are **revealed** and checked against the hash, and the claims pay the platform 5% of the fees and the creator the rest (built).
5. The **check page** replays the recorded run from public data only: every action "matching" for the good run, and "not matching" for a deliberately bad one (tampered rules, a missed close, a changed code hash).

Done = that scenario passes in CI-style scripts, the README says exactly that and no more, and a co-lead can run the mainnet deploy script (stretch, section 5).

## 2. In, out, and only if ahead

| In (must) | Why |
|---|---|
| `ActionRecord` log and views (`get_actions`, `get_action`) | The check page's whole input |
| `register_tokens` step | DCL refuses deposits without it (gate 3 Part J) |
| `agent_swap`, `agent_open`, `agent_close_position`, `exit_remove` | The strategy |
| `settle`'s own-position rule, `fees_collected` from a removal | Gate before any position can exist (`DEVELOPMENT_PLAN.md` section 9) |
| `reveal` | The "check after close" promise |
| Interface freeze (docs-only commit) | Unblocks the front end and the agent |
| `apps/agent` v1: deterministic decisions, decision log, a function-call key limited to the agent methods | The autonomous part |
| A transaction client in `packages/near` (signing, call builders) | The agent needs it |
| Recorded-run fixtures and the live-data layer for `/check/[strategy]` | The one screen that is never cut |
| README, claim table, a short no-funds path | Submission |

| Out (cut now, disclosed as "not in v1") | What it costs the story |
|---|---|
| Viewing keys: `buy_viewing_key`, `deliver_key`, `refund_key`, `rekey`, `apps/deliverer` | The "followers can buy a viewing key" half of the pitch. **First thing to reinstate if time appears:** about one contract slice plus half a day for the deliverer |
| `apps/alerter` | No Telegram alerts |
| `pause`, `set_agent`, `agent_heartbeat`, `abort_pending`, `agent_continue`, parked chains | The agent attaches the gas in one go (the contract refuses below the measured minimum); no mid-chain resume |
| Lost-add recovery: `adopt`, `dismiss_unknown_add`, `expire_unknown_add`, the `StaleRead` stages | A lost add leaves the lock until `resolve_stale`; a stranded position is an accepted, disclosed risk (callbacks have fixed gas) |
| `cleanup_gift`, `withdraw_storage_surplus`, the ring | Gifted positions are ignored by `settle`; disclosed (T61) |
| NEAR private AI, mirroring, confidential Intents funding, pools dashboard, Zap | Already on the plan's cut list; no claim about any of them |
| Rebalance | Already v2 (D47) |

| Only if ahead of schedule (in this order) | Trigger |
|---|---|
| Viewing-key sale with escrow (`buy_viewing_key`, `deliver_key`, `refund_key`) and a one-file deliverer | Slice 10 done before Nov 13 06:00 UTC |
| Mainnet deploy script reviewed and run by a co-lead | Section 5 |

## 3. Assumptions made so nothing waits on a reply

The open co-lead questions (Telegram messages 45 and 48) are answered **provisionally with the recommendations**; each is marked in `ARCHITECTURE.md` 5.11 as "built provisionally" and is cheap to change in the first slice that uses it. If a co-lead answers differently, the affected slice absorbs it:

- Q15: **no anchor**; adds and removes are checked against the contract's own read in the same round; a stop loss or take profit is confirmed over two observations (D53, already in `packages/rules`).
- Q16: one swap-step cap, `max_swap_step_bps` 5,000 to 6,000; no separate 24-hour cap; at most 2 swaps per run.
- Question 8: the swap is sized at the contract's own pool read (the reference).
- `register_tokens` is a **creator-called** step before the first `agent_open` (one method, one flag), not a fourth registration at `new`.
- `claim_creator` stays the single-read version (5.11).
- `platform_account` stays a `new` parameter for the sandbox and the demo; making it a network constant waits for Erik's account id and is a precondition of any mainnet run only.
- Range width 1,000 points (D39), fee tier 100.

## 4. Schedule (UTC)

Backend = this session. Front end = the front-end session. "Audit" = the three fresh auditors, run in the background while the next slice is written.

| When | Backend | Front end and people |
|---|---|---|
| **Tue 11 Nov, to midnight** | **S7** `ActionRecord` log + `agent_swap`; **S8** `register_tokens` + `agent_open` (deposit, add). Sandbox tests on real DCL | Front end: keeps the page on sample data; reads `INTERFACE.md` as the contract |
| **Wed 12 Nov, morning** | **S9** `agent_close_position`, `exit_remove`, `settle`'s own-position rule, fees from a removal; **S10** `reveal`. Audits of S7 and S8 land and are fixed | Co-leads: Telegram answers; Erik: `platform_account`, the round-trip run |
| **Wed 12, noon** | **Interface freeze** (docs-only commit on its own branch) | Front end maps its record parsing to the frozen shapes |
| **Wed 12, afternoon** | `packages/near` transaction client; `apps/agent` v1 (loop, decide with `packages/rules`, act, decision log) with a fake client in unit tests | Front end: live-data layer against the contract's views |
| **Thu 13 Nov, morning** | **Scenario harness**: the full acceptance scenario in the sandbox (agent against the real wasm and DCL); records every view response at the sampled blocks as fixtures; produces the good run and the bad runs | Front end: the check page on those fixtures |
| **Thu 13, afternoon** | Fix audit findings of S9, S10 and the agent; deploy script draft (stretch); gate review (`DEVELOPMENT_PLAN.md` section 9) | README and claim table (claims-checker); demo script |
| **Thu 13, 18:00** | **Code freeze for new features** | |
| **Thu 13 evening to Fri 14, 12:00** | Hardening only: two full `security-auditor` runs on the contract and scripts, `/security-review`, mutation passes, docs, `AUDIT_LOG.md` | Demo video; submission text |
| **Fri 14 Nov, 12:00 to 23:59** | Buffer; fixes only | Co-leads post and submit (never this session) |

## 5. Mainnet is a stretch, not the target

A live mainnet run needs: `platform_account` decided, `scripts/deploy-strategy.ts` written and reviewed, the mainnet round trip (does a removal return fees?) run by Erik, two full audits, and a co-lead to run the script. If all of that lands by Thursday evening, the strategy runs for the remaining hours (it will show few or no fees, and the README says so). If not, the submission states plainly that the run was demonstrated in the sandbox against the real Rhea and native USDC code, and claims nothing about mainnet. `CLAUDE.md`'s claim limits apply either way: no claim that the agent makes money, beats the market, or has volume.

## 6. How the process is reshaped (not dropped)

- Audits still run on every slice (`SECURITY_PROCESS.md`): security, test and contract review (plus rules-verifier where the rules are touched). They run **in the background while the next slice is written**, and their findings are fixed in one pass.
- A re-check of a fix is skipped when the fix is a test, or is shown by re-running the auditor's own mutant; it is kept when the fix changes behaviour of a funds path.
- Design deviations are recorded as 5.11 rows (D52), not as new revisions.
- Rhea behaviour that can't be measured before the deadline stays marked unverified and listed in the README's limits, with the tests that cover everything else.
- Stop-the-line rule: any Critical or High finding that is not fixable in one pass is cut (the method goes to "out"), not worked around.
- Hard stop for new contract methods: Thu 13 Nov 18:00 UTC.

## 7. Risks and the fallback for each

| Risk | Fallback |
|---|---|
| The TypeScript agent can't be integrated with the sandbox in time | The Rust sandbox test plays the agent: it submits the decisions that `packages/rules` produced (as vectors) to the real contract, and the TypeScript agent ships unit-tested against a fake client; the README says which run was which |
| `withdraw_asset` / `remove_liquidity` gas for the strategy account is higher than guessed | Measured in S8 and S9 in the sandbox; the fixed budgets are raised, the minimum prepaid gas with them (the agent attaches 300 Tgas) |
| Whether a removal's return includes fees is unknown until the mainnet round trip | The contract reads `unclaimed_fee` with `get_liquidity` before a removal and counts `min(unclaimed_fee, reported)` (5.7); the sandbox shows what DCL does |
| A co-lead overrides an assumption in section 3 | Absorbed by the first slice that uses it; the sandbox tests change with it |
| Audits find a High late | Section 6's stop-the-line rule |
| Time lost to the check page needing different record shapes | The freeze is at Wed 12 noon; later requests go to a "v1.1" list, not into the contract |

## 8. Status board (update as slices clear)

| Item | State |
|---|---|
| Contract slices 1 to 6 (validation, `new`, funding, `start`, `close`/`settle`, exits and claims) | **Cleared** |
| S7 `ActionRecord` + `agent_swap` | Built and tested on the real pool (17 sandbox tests); audits running |
| S8 `register_tokens` + `agent_open` | **Built and run on the real DCL** (gate 3 Part M); 3 audits run 12 Nov, one High (log reserve) fixed; see `AUDIT_LOG.md` |
| S9 close position, `exit_remove`, `settle` own-position rule | **Built and run on the real DCL**; audited with S8; fees count `min(unclaimed, reported)` (unverified whether a removal's return includes fees) |
| S10 `reveal` | **Built**, unit-tested, and run in the scenario harness |
| Interface freeze | `docs/INTERFACE.md` frozen for v1 on branch `backend/interface-freeze` (12 Nov); a co-lead merges |
| `packages/near` transaction client | Built (13 tests) |
| `apps/agent` v1 | Decide + loop + log + the real chain adapter (`createChain`, `realDeps`) built (14 tests, fake reads); run end to end against a local sandbox as a real process (runs 4 and 5, 13 and 14 November; agent commit in `fixtures/scenario/README.md`); never against mainnet |
| `apps/web` | Skeleton, sample screens, check-page verdict model and two-provider reads built on sample data (115 tests); live-data layer waits for the interface freeze |
| Brand guidelines draft (`docs/brand/hoodx/`) | Draft only; the October look stays until a co-lead decides |
| Scenario harness and fixtures | `contracts/strategy-sandbox/tests/scenario.rs` records the good run, a tampered-rules variant and a run without an agent close to `fixtures/scenario/` (see its header for what is not recorded) |
| Viewing keys (D57, D59) | **Built and audited, sandbox only.** Contract `buy_viewing_key`, `deliver_key`, `refund_key`, `withdraw_near`; `packages/seal`; `apps/deliverer`; the `/follow` buy flow. The sandbox end-to-end test passes on the real wasm (`bash contracts/strategy-sandbox/run.sh --test e2e`: buy, deliver, open, hash match; buy, refund). Final audit round: no Critical or High (`docs/security/audits/2026-11-14-final-round-c455344-5cfda61.md`). **Not run on testnet or mainnet**; the web page has not been driven against a chain, only by tests and a browser CSP check. |
| Deploy script (stretch), README, claim table | README and claim table done; web deployed to Vercel from `lead/consolidated` 8657a2c under D56 (CSP fix 4770d06 not yet deployed) |

## 9. Consolidation and session split (12 November 2026)

All work from `dazzling-galileo` (backend), `stoic-cerf` (web) and `awesome-newton` (brand) is merged on `claude/modest-bardeen-tvjho7`. On the merged tree: `packages/rules` 693, `packages/near` 196, `apps/web` 115 and `apps/agent` 7 tests pass, and `cargo test -p strategy` passes 220. `apps/web` lint needs `pnpm --filter web exec next typegen` once on a fresh checkout.

From here three sessions work in parallel, each on its own `<role>/<task>` branch cut from this one:

- **Backend:** S8 `register_tokens` + `agent_open`, S9, S10, interface freeze, agent chain adapter, scenario harness.
- **Frontend:** the check page on the frozen interface and recorded fixtures, README and claim table drafts for the claims-checker.
- **Audit:** fresh auditors on every landed slice, `AUDIT_LOG.md`, the Thursday hardening pass. It never edits code.
