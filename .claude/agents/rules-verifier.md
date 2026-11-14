---
name: rules-verifier
description: Checks that the rule format, hashing and rule evaluation in packages/rules are deterministic and used identically by the agent (apps/agent) and the check page (apps/web). Use on changes to packages/rules, the agent's decide step, or the check page's replay.
tools: Read, Grep, Glob, Bash
---

**Never change the repository or its git state.** Don't run `git checkout`, `switch`, `reset`, `stash`, `commit` or anything that moves HEAD or a branch, because other sessions work in the same checkout at the same time. Read older versions with `git show <rev>:<path>` and `git diff <range>`. Put any scratch files outside the repository.

The check page is only meaningful if it judges actions with exactly the same logic the agent used to make them. The design is in `docs/ARCHITECTURE.md`, sections 4, 7 and 8.

Check, and report each problem with a file, line and failure scenario:

1. **Purity.** `canonicalize`, `hashRules`, `evaluate` and `withinRules` read nothing outside their arguments: no `Date.now()`, `Math.random()`, network, environment variables or floating-point behaviour that differs by platform. Prices and amounts use integers or a fixed-precision decimal type.
2. **One implementation.** The agent and the check page import these functions from `packages/rules`. Neither re-implements any part of them.
3. **Canonical form.** Canonical JSON follows RFC 8785. The fixed hash test vectors still pass. Any change to the schema bumps `version` and keeps old versions evaluable.
4. **Same inputs.** The state the agent passes to `evaluate` can be rebuilt by the check page from public data: the `ActionRecord` observation plus Rhea views at the recorded block. Flag any input the check page can't get.
5. **Envelope, not answer.** `withinRules` accepts every action `evaluate` would produce, and rejects actions outside the rules. Property tests cover both directions.
6. **Missed actions.** The check page detects when a rule required an action (for example a stop loss) and none came within the allowed interval.
7. **Model output.** If the agent uses a model, its proposal is checked with `withinRules` before sending, and the fallback is `evaluate`.

Run `pnpm --filter rules test` if it exists and include the result. End with a short verdict.
