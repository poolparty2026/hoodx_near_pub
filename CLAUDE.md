# hoodx on NEAR

An autonomous LP agent on Rhea (NEAR) where creators run strategies with hidden rules, followers can buy a viewing key to see the rules during the run, and anyone can check at close that the agent followed them. A NEAR hackathon entry, due 14 November 2026 at 23:59 UTC.

Read these before changing anything:

- `docs/build-brief.md`: what we are building and the rules we must keep.
- `docs/ARCHITECTURE.md`: components, contract methods, the rule format, the check page.
- `docs/DEVELOPMENT_PLAN.md`: how we work, the gates and the day-by-day plan.
- `docs/gates/`: verified answers about Rhea, Intents and NEAR AI. Trust these over memory.
- `docs/security/`: the security process, threat model, edge cases and audit log. **Mandatory for every change.**

## Code graph

Use graphify to orient yourself before searching: `graphify update .`, then `graphify query`, `path` and `explain`. Setup and rules are in `docs/GRAPHIFY.md`. It is an aid, not evidence: verify in the source.

## Layout

- `contracts/strategy`: Rust strategy contract (`near-sdk` 5.x), sandbox tests in `tests/`.
- `packages/rules`: rule schema, canonical JSON, hash, encryption, `evaluate`, `withinRules`. Shared by the agent and the check page, so it must stay pure: no clock, network or randomness inside.
- `packages/near`: typed contract client and Rhea view helpers.
- `apps/agent`: agent loop and decision log.
- `apps/deliverer`: viewing-key delivery, on its own host with its own account.
- `apps/alerter`: read-only Telegram alerts; no NEAR keys, outbound only.
- `apps/web`: Next.js app and the `/check/[strategy]` page.
- `scripts/`: deploy, demo, quotes, fee report.

## Commands

The skeleton is being set up on 5 to 7 November, so some of these don't exist yet.

- Contract tests: `cargo test -p strategy`
- Contract build: `cargo near build` in `contracts/strategy`
- TypeScript tests: `pnpm -r test`
- Web dev server: `pnpm --filter web dev`
- Lint and format: `pnpm lint`, `cargo fmt`, `cargo clippy`

## How to work

- One task, one branch, named `<role>/<task>`, for example `contract/limits`. Never commit to `main`.
- Plan first, then write failing tests, then code. Contract and `packages/rules` changes need tests for every limit and failure path.
- **Security first, at every step.** Follow `docs/security/SECURITY_PROCESS.md`. Every design change and every code change gets an independent audit by a fresh `security-auditor` agent, and every code change also gets a fresh `test-auditor` agent, before it is merged. Add `contract-reviewer` for `contracts/`, `rules-verifier` for rules and replay, and `claims-checker` for user-facing text. Launch auditors with only the scope and no conclusions of your own. Critical and High findings block the merge. Log every audit in `docs/security/AUDIT_LOG.md`.
- **Tests cover edge cases.** Every applicable case in `docs/security/EDGE_CASES.md` has a test that names its ID and asserts the exact outcome: the refusal message, the balances, and that nothing changed. Test limits at the limit and at limit + 1. Use property tests for arithmetic and rules logic. New edge cases found along the way get a new ID and a test.
- Before a pull request: run the tests and `/code-review`, then the audits above.
- Changes to shared interfaces (rule schema, contract signatures, `ActionRecord`) go in their own small pull request.
- When a spike confirms how Rhea, Intents or NEAR AI behaves, write it into `docs/gates/` and the matching skill straight away.
- Anything people will see follows the `hoodx-brand` skill.

## Hard rules

- **Never handle private keys that control funds.** View calls and `dry: true` quotes on mainnet are fine. Any mainnet transaction is written as a script for a person to review and run. Sandbox and testnet transactions are fine.
- **Never push to `main`, publish, post or submit.** A co-lead (Erik or Vipasana, D22) does those, one step at a time. Two exceptions. (D23) You may post questions to Vipasana in the team Telegram group, tagging @vipassana19, using `TG_BOT_TOKEN` and `CHAT_ID`. Plain text, questions only, never keys, rules or decrypted data. (D56) When Erik asks for it in the current session, you may deploy `apps/web` to Vercel as described in `docs/DECISIONS.md` D56, and nothing else that is published, posted or submitted.
- **Claims:** never say the agent makes money or beats the market, never claim hidden pool positions or full anonymity, never say a viewing key can't be shared, never call Intents "unstoppable", never cite agent volume, and never use "harness" in a way that implies a link to NEAR's own work.
- **Don't show a fee split number until gate 5 is settled** in `docs/gates/`.
- **Don't use Shade Agents.** NEAR's docs mark them as deprecated.
- **Rebuilt from scratch.** No earlier code is reused, including the work done under the former name, Poolside. Don't copy in code from before 19 October 2026, from earlier Poolside work, or from any other hackathon entry. Code in `spikes/` is throwaway: carry over findings through `docs/gates/` and skills, not by copying code.
- **Mark guesses.** If you aren't sure how an external contract or API behaves, say so and check it, instead of writing code against a guess.
