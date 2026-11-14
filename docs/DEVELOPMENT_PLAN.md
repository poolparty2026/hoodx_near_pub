# Poolside on NEAR: development plan

> **11 November 2026: scope and schedule are superseded by [`MINIMAL_PLAN.md`](MINIMAL_PLAN.md) (D55).** Sections 3 to 6 below describe the original plan; the cut order, the day-by-day schedule and the audit routine now follow the minimal plan. Section 9 (backend build gates) still applies.

Written 5 November 2026. Submissions close 14 November 2026 at 23:59 UTC. This plan builds the system in [`ARCHITECTURE.md`](ARCHITECTURE.md) to meet the [build brief](build-brief.md), with Claude Code as the main development tool.

The dates follow the brief. The team is two builders, Erik and Vipasana (D5 in `DECISIONS.md`). The plan is written per role, and each person holds several roles and runs several Claude Code sessions at once.

## 1. How we work with Claude Code

### 1.1 The idea

People own decisions, keys, money and anything public. Claude Code does most of the writing, testing and reviewing of code, in many parallel sessions, each with one clear task and one branch. Every session starts from the same repo context (`CLAUDE.md`, skills, subagents), so the quality doesn't depend on who opened it.

| People do | Claude Code does |
|---|---|
| Answer the gates and make the decisions in `docs/gates/` | Run the spikes that produce the evidence for each gate |
| Hold every mainnet key with funds, and sign every mainnet transaction that moves money | Write and test the scripts that build those transactions, and run view calls |
| Merge to `main`, publish the repo, post on X, submit | Open pull requests on feature branches, fix CI, answer review comments |
| Run the cold test with someone outside the team | Run a simulated judge review of the repo |

The brief's rule "Do not push, publish, post or submit until the team lead confirms each step" maps to this: Claude may push feature branches and open pull requests, while `main` is protected and only the lead merges.

### 1.2 Repo setup for Claude Code (day 0, 5 November)

| File | Purpose | Status |
|---|---|---|
| `CLAUDE.md` | Commands, layout, conventions, hard rules (keys, claims, branches) | Added with this plan |
| `AGENTS.md` | Short pointer to `CLAUDE.md` for other coding agents. The brief says Claude Code and Codex screen entries, so this helps the judges' agents too | Added with this plan |
| `.claude/agents/contract-reviewer.md` | Reviews contract changes for access control, callback handling, deposits, storage and limit checks | Added with this plan |
| `.claude/agents/claims-checker.md` | Checks README, posts and UI text against the claim limits in the brief | Added with this plan |
| `.claude/agents/rules-verifier.md` | Checks that the agent and the check page use `packages/rules` the same way, and that replay is deterministic | Added with this plan |
| `.claude/skills/poolside-brand/` | Brand rules | Done |
| `.claude/skills/near-contract/` | How we build, test and deploy NEAR contracts here: `cargo-near`, `near-workspaces`, 1 yoctoNEAR deposits, storage, callbacks, function-call keys | Started 5 Nov from the gate 3 spike |
| `.claude/skills/rhea-dcl/` | Confirmed Rhea DCL contract ids, methods, arguments, pool ids and fee reporting | Started 5 Nov. Liquidity calls still open |
| `.claude/skills/demo-runbook/` | The exact demo steps, accounts, transactions and recovery steps | 11 November |
| `.claude/settings.json` | Allow the usual read-only and build commands (`cargo`, `pnpm`, `near ... view`) without prompts. Ask for anything that signs a transaction. Add a PostToolUse hook that runs `cargo fmt` or `prettier` on edited files | Day 1 |
| `.github/workflows/ci.yml` | `cargo test` (including sandbox tests), `pnpm -r test`, lint, `next build`, contract WASM build | Day 1 |

Skills hold knowledge that has been verified. Anything a spike confirms about Rhea, Intents or NEAR AI goes into a skill right away, so no later session has to guess or search again.

### 1.3 The loop for each task

1. **An issue per task.** The lead or a role owner opens a GitHub issue with the goal, the done check and links to the architecture section. Issues are small enough for one session, roughly half a day.
2. **One session, one branch.** Start a Claude Code session (cloud or local) on a branch named `<role>/<short-task>`, for example `contract/limits`. For parallel work on one machine, use worktrees so sessions don't share a checkout.
3. **Plan first.** Begin in plan mode: Claude reads the issue, `CLAUDE.md` and the relevant architecture section, and proposes the change and the tests. The owner approves or corrects the plan.
4. **Tests first.** For the contract and `packages/rules`, Claude writes failing tests before code. Sandbox tests cover every limit, every failure callback and the split arithmetic.
5. **Build until green.** Claude implements and runs the tests until they pass locally.
6. **Independent audits before the pull request** (`docs/security/SECURITY_PROCESS.md`):
   - `/code-review` on the diff, at `high` for contract and rules code, `medium` elsewhere.
   - A fresh `security-auditor` agent and a fresh `test-auditor` agent on the diff, launched with only the scope.
   - Also `contract-reviewer` for anything under `contracts/`, `rules-verifier` for rules and replay, and `claims-checker` for user-facing text.
   - Critical and High findings block. Fixes get a new auditor. Every audit gets a row in `docs/security/AUDIT_LOG.md`.
   - Before any mainnet deployment: two independent `security-auditor` runs, `/security-review` and `cargo mutants`.
7. **Pull request.** Claude opens it with the issue linked and the test output. The session subscribes to the pull request so it can fix CI failures and answer review comments.
8. **Merge.** The lead reviews and merges. Nothing reaches `main` without a person.

### 1.4 Running sessions in parallel

Most days have three to four tracks that don't touch the same files. A typical day:

| Session | Branch | Touches |
|---|---|---|
| Contract | `contract/*` | `contracts/`, `packages/near` |
| Rules and agent | `agent/*` | `packages/rules`, `apps/agent` |
| Front end | `web/*` | `apps/web` |
| Docs and demo | `demo/*` | `README.md`, `docs/`, `scripts/` |

Shared interfaces are fixed first (rule schema, contract method signatures and the `ActionRecord` format) on 6 to 7 November, so the tracks can work against them without waiting for each other. Changes to a shared interface go in their own small pull request that the lead merges first.

### 1.5 Mainnet safety rules for sessions

- No session ever sees a private key that controls funds. Function-call keys for the agent live on the agent server only.
- Claude may run `near ... view` calls and `dry: true` quote requests against mainnet freely.
- Any command that signs a mainnet transaction is written by Claude as a script, reviewed by a person, and run by a person. Testnet and sandbox transactions are fine for Claude to run.
- Team money only, with capped amounts, as the brief requires. Each script checks a hard cap before building a transaction.

## 2. Gates (5 to 7 November)

The brief says to stop other work until gates 1 to 4 have answers. Each gate gets a file in `docs/gates/` with the question, the evidence, the answer and what changes in the plan. Claude Code runs the research and spikes, and the owner signs off.

| Gate | Claude Code task | Evidence to collect | Owner signs off |
|---|---|---|---|
| 1. What exists, what predates 19 October | Inventory this repo and any older Poolside code the team points to. Write a dated list of files and commits | This repo was empty on 5 November apart from the brief, so all code in it is new. Confirm whether older code exists elsewhere, and keep it out of this repo | Lead |
| 2. NEAR private AI fit | Read NEAR AI's current docs, write a spike that sends one decision request and saves the response and attestation, and document how an attestation is verified | One attested decision and a verification script, or a clear "doesn't fit" with reasons. Ask NEAR in parallel | Agent |
| 3. Access keys with Rhea | Spike in the sandbox: a minimal contract that receives tokens, calls Rhea DCL with 1 yoctoNEAR, and is driven by a function-call key with no deposit. Use `near-workspaces` to import Rhea's contracts from mainnet into the sandbox if that works, otherwise read Rhea's source and mock it. Then repeat with tiny amounts on mainnet, signed by a person | Working call sequence, exact methods and arguments, storage costs, fee reporting per position. Written into `.claude/skills/rhea-dcl/` | Contract |
| 4. Confidential Intents | Read the current Intents docs, run `dry: true` quotes for our token pairs, and list which confidential operations are documented as live | A table of operations: live, not live, unknown. Questions sent to NEAR for the unknowns | Payments |
| 5. Fee split | Write out the overview's numbers, the inconsistency, and the proposal in the architecture doc (section 5.9) with worked examples | A one-page decision with exact amounts for a sample run | Lead |

If gate 3 fails, stop contract work and redesign, as the brief says. The most likely fallback is the agent account holding the position and our contract acting only as a limit checker and log, which is weaker and must be described as such.

## 3. Day-by-day plan

Each day lists the work, the Claude Code sessions, and the check that says it's done. Done checks are things a person can run or see, not opinions.

### 5 to 7 November: gates, formats and skeleton

| Work | Sessions | Done when |
|---|---|---|
| Gate spikes 1 to 5 | One session per gate | Each `docs/gates/*.md` has an answer signed off by its owner |
| Monorepo skeleton: pnpm workspaces, Cargo workspace, CI, lint, formatting hooks | Setup session | CI runs green on an empty contract, an empty package and an empty Next.js app |
| Rule schema v1, canonical JSON, hash, encrypt and decrypt in `packages/rules` | Rules session | Unit tests pass, including fixed test vectors for the hash |
| Contract interface: method signatures, `ActionRecord`, events, limits | Contract session, reviewed by the lead | Merged as a stub contract with tests that only check signatures and access control |
| Choose the live pool and quote token | Lead, with a Claude session pulling pool fee and volume data from Rhea | Pool written in `docs/gates/3-rhea.md` |

### 7 to 8 November: strategy contract and the live strategy

| Work | Sessions | Done when |
|---|---|---|
| Contract: joins, start, public limits, `agent_*` methods with Rhea calls and callbacks | Contract session, `contract-reviewer` on every pull request | Sandbox tests cover every limit, a refused action, a failed Rhea call and a successful add and remove |
| Agent key setup script: function-call key per strategy | Contract session | Script tested on testnet. The key can call `agent_*` and nothing else |
| Agent loop with deterministic `evaluate`, decision records and hashes | Agent session | The agent runs against the sandbox and testnet, and its actions show up in `get_actions` |
| **Start the small mainnet strategy as soon as gate 3 passes** | Lead runs the deploy and funding scripts | The strategy is live, the agent has made its first action, and fees start to accrue |

The live strategy starts on day 3 at the latest, because fees build slowly. If the contract isn't ready, start the strategy with the earliest working version and keep that run. A new contract version means a new strategy, so the code hash check stays honest.

### 9 November: close, split and action log

| Work | Sessions | Done when |
|---|---|---|
| `close`, `exit_remove`, `exit_withdraw`, `update_anchor`, `resolve_stale`, the locked `settle` in held tokens, `claim(role, token)`, `sweep`, and `reveal` with the on-chain hash check | Contract session | A test strategy on testnet or in the sandbox closes and splits with the exact expected amounts |
| Fee report script: prints the split in exact amounts from contract state | Demo session | Output matches the sandbox test amounts to the smallest unit |
| Decision log publishing at close | Agent session | Published records match the `decision_hash` values on-chain |

### 10 November: check page

| Work | Sessions | Done when |
|---|---|---|
| `withinRules` and the replay logic in `packages/rules` | Rules session, `rules-verifier` subagent | Property tests: replaying the agent's own decisions always matches, and hand-made bad actions never match |
| `/check/[strategy]` page: hash check, code hash check, per-action verdicts, missed actions, split check | Front-end session | Every action of the test strategy is marked matching, and a deliberately bad test strategy shows not matching |
| Archival RPC choice and rate-limit handling | Front-end session | The page loads for the live strategy with no wallet |

### 11 November: viewing key and public P&L. Working demo complete

| Work | Sessions | Done when |
|---|---|---|
| `buy_viewing_key`, `deliver_key`, `refund_key`, `rekey` in the contract | Contract session | Sandbox tests for delivery, refund after the deadline, and rekey |
| Mirror page: the unlocked rules as a position the follower opens from their own wallet (D10) | Front-end session | A follower with a key sees every amount and fee and can open the mirrored position |
| Key deliverer in `apps/deliverer`, on its own host | Payments session | A test purchase is delivered within one minute |
| Strategy and unlocked strategy screens, browser key pair, hash check in the browser | Front-end session, using the `poolside-brand` skill | A follower buys a key on the live strategy and sees the rules and position |
| Public profit and loss on the strategy screens | Front-end session | P&L matches the fee report script |
| Private AI in the decide loop, if gate 2 passed | Agent session | Each new action carries an attestation the check page verifies |
| Competitor recheck (brief: Tontine, trading entries, anything with viewing keys) | Research session | Short note in `docs/gates/competitors.md` |
| `demo-runbook` skill | Demo session | A fresh session can run the whole demo on the test strategy from the skill alone |

**End of 11 November: the full demo runs end to end.** From here on, only fixes, docs and polish.

### 12 November: README, claim table, no-funds path and cold test

| Work | Sessions | Done when |
|---|---|---|
| README: the problem and NEAR's role first, "do X, see Y" steps, the no-funds path, built, stubbed and planned, limits, other entries any team member works on | Demo session, then the `claims-checker` subagent | `claims-checker` passes with no findings |
| Claim table: each claim mapped to a file, command, expected output and transaction | Demo session | Every row has a working link or command |
| No-funds path: `dry: true` quote script, recorded tiny mainnet transactions, and the check page for the live strategy | Demo session | Runs on a clean machine with no wallet |
| **Simulated judge review:** a fresh Claude Code session with no team context is given only the public repo and asked to assess it the way the brief says judges' agents will | Separate session | Its findings are fixed or answered in the README |
| Cold test with someone outside the team | Demo owner | They finish from the README alone |

### 13 November: publish

| Work | Who | Done when |
|---|---|---|
| Final `/security-review` and `contract-reviewer` pass over `main` | Claude, reviewed by Contract | No open high findings |
| Record the demo video, under three minutes, following the brief's script | Demo owner | Video shows all five steps |
| Publish the repo, post the demo on X with @NEARProtocol and #NEARHackathon | Lead confirms each step | Public links work |

### 14 November: submit

| Work | Who | Done when |
|---|---|---|
| Re-read the live hackathon rules, check every README link, close the live strategy if the demo needs the close on record | Lead, with a Claude session checking links | Everything resolves |
| Submit once, well before 23:59 UTC | Lead | Submission confirmed |

## 4. Testing

| Layer | Tool | What is covered |
|---|---|---|
| `packages/rules` | `vitest`, property tests with `fast-check` | Canonical JSON test vectors, hash, encryption round trips, `evaluate` and `withinRules` on generated market paths |
| Contract unit | `cargo test` | Arithmetic for shares and the split, limit checks, status changes |
| Contract integration | `near-workspaces` sandbox | Access control, every refusal, every Rhea call and failure callback (with Rhea imported or mocked), close and settle, key sales and refunds |
| Agent | `vitest` with a fake chain | Decision records, hashing, fallback when private AI fails, never sending an action that `withinRules` rejects |
| Web and check page | Playwright | The four screens and the check page, including the no-wallet path, at phone width |
| Testnet | Scripts | The full flow, wherever Rhea testnet support allows (Verify, gate 3) |
| Mainnet | Scripts run by a person | Tiny amounts first, then the live strategy |

CI runs everything except testnet and mainnet on every pull request.

## 5. Roles and their Claude Code focus

Proposed owners, to be confirmed by Vipasana (`questions-for-vipasana.md`): **Vipasana** holds Contract and Agent, and **Erik** holds Lead, Payments, Front end and Demo.

| Role | Main sessions | Subagents and skills they lean on |
|---|---|---|
| Lead | Gates 1 and 5, scope, reviewing and merging, mainnet signing | `claims-checker` |
| Contract | Contract, keys, deploy scripts, Rhea calls | `contract-reviewer`, `near-contract`, `rhea-dcl`, `/security-review` |
| Agent | `packages/rules`, agent loop, private AI, decision log | `rules-verifier` |
| Payments | Intents quotes, viewing key payment and delivery, gate 4 | `near-contract` |
| Front end | Screens, check page, P&L | `poolside-brand`, `rules-verifier` |
| Demo | README, claim table, no-funds path, video, runbook, simulated judge | `claims-checker`, `demo-runbook` |

## 6. Cut order

From the brief. If time runs short, cut in this order:

1. Pools dashboard and Zap (already left out of this plan).
2. Mirroring from a follower's own wallet.
3. NEAR private AI. Fall back to deterministic decisions and hashed logs, and the entry drops to the brief's 4.80 target.

Never cut the check page or the refusal.

## 7. Risks to the plan

| Risk | Early sign | Response |
|---|---|---|
| Gate 3 shows Rhea calls can't be made from our contract | The spike fails on 6 or 7 November | Redesign before more contract code, as the brief says. Tell the team the same day |
| Mirroring needs Rhea liquidity calls from a browser wallet that turn out awkward | Gate 3 part B | Show the mirrored position as exact instructions with a prefilled Rhea link instead |
| The live strategy starts late and earns almost nothing | No mainnet strategy by the end of 8 November | Start it with the earliest working contract version. Show exact small amounts rather than none |
| Historical Rhea views unavailable for the check page | Archival RPC fails during the 10 November work | Store fuller observations in `ActionRecord` and check consistency between them instead |
| Parallel sessions collide on shared interfaces | Merge conflicts in `packages/rules` or contract signatures | Interface changes go in their own small pull request first |
| A claim slips into the README or video that the demo doesn't show | `claims-checker` findings | Remove the claim, or add the evidence to the claim table |
| A session gets stuck in a long debugging loop | Same failure for more than an hour | Stop, write down what is known in the issue, and start a fresh session with that summary |

## 8. Hackathon rules we keep

- Only work from 19 October 2026 counts. This repo started on 5 November 2026, and older code stays out of it.
- No code shared with any other hackathon entry. If anyone on the team works on another entry, the README names it, as the brief says `HACKATHON.md` requires.
- Team money only, capped, until the code is audited.
- Never call Intents "unstoppable", never cite agent volume, and never use "harness" in a way that implies a link to NEAR's own work.
- Push, publish, post and submit only after the lead confirms each step.

## 9. Backend build gates (added 11 November 2026, from the slice 3 to 5 audits)

These are conditions on **which build may be deployed** and **which slice may land next**. A co-lead checks the first group before any run of a deploy script; the author of a slice checks the second.

**A build may hold a funded account only when all of these exist** (a started strategy otherwise has no way out; `Running`, `Closing` and `Closed` pay nothing out, and `withdraw` works only in `Cancelled` on purpose, so the platform's cut and the key-sale escrow can't be bypassed):

- ~~`exit_withdraw`, `claim_platform` and `claim_creator`, tested in the sandbox against native USDC and wrap.near code~~ (built in slice 6, 11 November: claims on native USDC incl. a blocklisted platform; `exit_withdraw` with an empty account only, a real `withdraw_asset` by the strategy waits for `agent_open`);
- the trading calls' exit path (`exit_remove`) and `settle`'s own-position rule;
- a deploy script that pins the wasm hash, and the two full security audits plus `/security-review` (`SECURITY_PROCESS.md` section 2).

**Slice gates:**

- `agent_open` (or anything that can create an own position or a DCL internal balance) does not land until `settle`'s callback checks `own_position` (`LIMIT: own position exists`) and the stuck-token rule (3 failed withdraws, EC-C103), with tests that fail if `settle` ignores them (contract review M2, M1 of 11 November).
- The trading slice also adds the abort of a parked chain to `close()` after `run_end` (5.5), and sets `settle_until_block` from the payout callbacks.
- The shape of a non-empty `list_user_assets` answer, and what makes DCL accept a token for deposit (`E016: token not registered` in the sandbox), are confirmed in the sandbox before the exit slice (gate 3 Part I).
- The key-sale slice adds `escrow_total` and `near_owed_total` to `start`'s reserve check (TODO in `start.rs`).
- Before slice 5 of the storage design (the ring), the reserve counts the ring once (`RING_SIZE` in `start.rs`).
