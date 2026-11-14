# Poolside viewing keys: build brief

For the Poolside team. NEAR HACKATHON: Build Beyond Boundaries. Written 5 November 2026. Submissions close 14 November 2026 at 23:59 UTC.

Nothing here has been tested, and this brief rests on the October product overview, not the code. Lines marked **Assumption** are unverified and are covered by the gates below.

## The entry

Poolside stays an autonomous LP agent on Rhea with creators, hidden rules, joiners and a fee split. Three things change: each strategy shows public profit and loss, a follower can buy a viewing key to see its rules and position while it runs, and anyone can check at close that the agent followed the rules.

The one-line pitch: **follow a private LP strategy, and prove the agent did what it promised.**

- **Tracks:** `defi` first, then `privacy` and `agents`. Tick only what the demo shows, so `business` is out unless the split is central to the demo.
- **Why it can win:** private trading with viewing keys and public profit and loss is judge Illia Polosukhin's second idea, none of the 135 entries read describes an LP agent, and it needs no claim that an agent beats the market.
- **Target score:** 5.00 out of 5 on the internal assessment, or 4.80 if NEAR's private AI does not fit. That is a target for a plan nobody has built, not a sure win.

## What changes from the overview

| Area | Overview | This entry |
|---|---|---|
| Rules | Hash at creation, reveal at close | Same, plus a paid viewing key during the run |
| Results | Public after close | Public profit and loss while running |
| Proof | Hash shows the rules did not change | A check page shows the agent followed them |
| Agent limits | Limited-permission wallet | NEAR access key that can only call our contract |
| Fee split | Intent-settled or hybrid | A NEAR contract, decided now |
| Agent decisions | Off-chain agent | NEAR's private AI with attestations, if gate 2 passes |

Out of scope: the token, points, Launch Kit, the partner share, social extras and JustHoot beyond tagging. Everything already marked post-hackathon stays there.

## What must be true at submission

| Requirement | Done means |
|---|---|
| Live strategy | A small mainnet strategy has run for days with team funds and has real fees |
| Viewing key | A follower buys a key and sees the rules and position |
| Follow | The follower joins, or mirrors from their own wallet |
| Refusal | The agent is refused an action outside the public limits |
| Close and split | The creator closes and the fee split settles on a NEAR contract |
| Check page | A stranger verifies every agent action with no wallet |
| No-funds path | A reviewer can follow the flow without money |

## Architecture

1. **Rule format:** a small, machine-checkable format covering pool, range width, rebalance trigger, take profit, stop loss and close conditions. The check page depends on this, so free-text rules will not work.
2. **Commit:** the creator posts a hash of the rules at creation. Rules are encrypted with a key for that strategy.
3. **Strategy contract:** a NEAR contract per strategy, or one contract with strategy records. It holds positions, enforces public limits, tracks joiners and settles the split.
4. **Agent key:** an access key that can call only the strategy contract. **Assumption:** the contract must make the Rhea calls itself, because a function call key cannot attach the deposit those calls may need.
5. **Public limits:** the contract enforces what can be public, such as allowed pools, slippage and withdrawal only to joiners. This is what produces the on-chain refusal.
6. **Viewing key:** a follower pays the contract, and the strategy key is delivered encrypted to that follower's public key. It unlocks the rules and links them to the strategy wallet.
7. **Decisions:** NEAR's private AI runs the agent's decisions, with an attestation for each action. Hard limits sit outside the model, because keys must never reach it and a model must not be able to widen a limit.
8. **Funding:** every deposit and exit goes through Intents from any chain. Use Confidential Intents only where NEAR confirms it is live.
9. **Check page:** at close, it reads the revealed rules, checks them against the hash, replays each Rhea transaction from the strategy wallet, and marks each action as matching or not.

Stack from the overview: Next.js and Tailwind, NEAR Lake Framework, Aurora Intent Connect. Keep it unless a gate says otherwise. Do not use Shade Agents, which NEAR's docs mark as deprecated.

### Why this avoids NEAR's missing view keys

NEAR's docs show no view key or selective disclosure as of 5 November, and the history API is invite-only. This entry does not need either. The key unlocks Poolside's own rules, and Rhea positions are public, so a buyer can check them on-chain.

## Gates: do these first

Gates 1 to 4 are due by 7 November. Stop other work until each has an answer.

| # | Question | Owner | If it fails |
|---|---|---|---|
| 1 | What does the code do today, and what predates 19 October? | Lead | Treat old code as baseline. Only new work is judged |
| 2 | Does NEAR's private AI fit this agent? Ask NEAR and try one attested decision. | Agent | Keep decisions deterministic and post a hash log. The entry falls to 4.80 |
| 3 | Can the access key design work with Rhea? Track 06 warns that an account with only function call keys cannot transfer NEAR and can lock itself out. | Contract | Redesign before writing more contract code |
| 4 | Which Confidential Intents operations are live for this flow? The overview already lists this as an open question. | Payments | Ship the commit and reveal with a fresh wallet, and claim only what the demo shows |
| 5 | How is the fee split defined? See the note below. | Lead | Do not show a number that is not settled |

### Fix the fee sums

The overview says the strategy fee is 5% of LP fees, then says the creator gets 7%, Poolside 5% and joiners 88%. A separate 8% automation fee applies when a guardrail acts, which may cut into the 88% joiners are promised. Decide the real order, then show exact amounts in the demo.

## Plan

**Start the mainnet strategy as soon as gate 3 passes.** Fees build slowly, so a run started on demo day shows almost nothing. Use only team money.

| Date | Work | Finished when |
|---|---|---|
| 5 to 7 Nov | Read the code, run the gates, fix the rule format and fee sums | Gates answered, formats agreed |
| 7 to 8 Nov | Strategy contract with public limits and access key. Start the small mainnet strategy | The strategy is live and fees accrue |
| 9 Nov | Close and fee split, plus the action log | A test strategy closes and splits |
| 10 Nov | Check page | Every action is marked matching or not |
| 11 Nov | Viewing key and public profit and loss. Rerun the competitor check. **Working demo complete** | A follower buys a key and sees the rules |
| 12 Nov | README, claim table, no-funds path, cold test with someone outside the team | They finish from the README alone |
| 13 Nov | Publish the repository. Post the X demo with @NEARProtocol and #NEARHackathon | Public links work |
| 14 Nov | Re-read the live rules. Submit once, ahead of 23:59 UTC | Submission confirmed |

Build proof first, then the viewing key, then NEAR depth. If time runs short, cut in this order: the Pools dashboard and Zap, mirroring from a follower's own wallet, then private AI. Never cut the check page or the refusal.

## Roles

Assign one owner per line. One person may hold several.

- **Lead:** gates, scope, fee sums, legal questions.
- **Contract:** strategy contract, access keys, split, Rhea calls.
- **Agent:** decisions, attestation, action log.
- **Payments:** Intents, confidential path, viewing key payment.
- **Front end:** the four screens and the check page.
- **Demo:** README, video, cold test, submission.

## Demo script

Keep it under three minutes.

1. Show a live strategy with public profit and loss, its rules hidden, and real fees from its run.
2. A follower buys a viewing key and sees the rules and position.
3. The agent tries an action outside the public limits, and the contract refuses it.
4. The creator closes the strategy, and the split settles with exact amounts.
5. A stranger opens the check page with no wallet and sees each action matched against the revealed rules.

## README rules

Claude Code and Codex screen the entry, and humans decide.

- Open with the problem and NEAR's role.
- Give "do X, see Y" steps, and a path that needs no funds. Intents has no testnet, so use `dry:true` quotes and recorded tiny mainnet transactions.
- Add a table mapping each claim to a file, command, expected output and transaction.
- List what is built, stubbed and planned.
- State the limits openly (see below).
- If anyone on this team also works on another entry, name that project in this README, as `HACKATHON.md` requires.

## What we claim, and what we do not

**We claim:** rules that are committed, private until close or until a key is bought, and checkable afterwards, plus funding privacy only where the demo shows it.

**We do not claim:** that the agent makes money, hidden pool positions, full anonymity, or that a key cannot be resold. No credible public record shows LLM agents earning durable returns, and judges will read a profit claim as a warning sign.

State these limits in the README:

- Public positions leak part of the rules once a wallet is linked.
- A buyer of a viewing key can copy or pass on the rules.
- The strategy wallet is visible on Rhea, so the separation depends on what links it to a person.

## Rules and boundaries

- Only work from 19 October 2026 counts. Keep it separate from older work by branch or tag.
- Use only team money, with capped amounts and no outside funds until the code is audited. Rhea lost up to a reported $18.4M in April, and Intents lost about $3.8M on 1 October and paused.
- Running pooled funds for a fee, or selling access to strategies, may be regulated. Get legal advice before any launch.
- Do not share code with any other hackathon entry.
- Do not use "harness" in a way that implies a link to NEAR's own work. Do not cite agent volume. Do not call Intents unstoppable.
- Do not push, publish, post or submit until the team lead confirms each step.

## Competitors to recheck on 11 November

No LP agent was found on 5 November. Tontine, where agents make markets as firms, looks closest. Trading entries were not checked in depth, so read them on the recheck, and look for anything built on viewing keys.

## Open questions

- Who are the named owners, and how many builders does the team have?
- Which pool does the live strategy use?
- Does the contract hold joiner funds in one account or per strategy?
- Is the name Poolside clear? The overview notes Poolside AI and a Poolside AMM on Base, and no trademark check has been done.
- Which NEAR account receives any prize, and what is the team name?
