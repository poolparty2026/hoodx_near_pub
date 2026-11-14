# Security process

Poolside holds other people's money in a contract driven by an autonomous agent. Every step of development is treated as security-relevant. This process is mandatory for every change, by every person and every Claude Code session. `CLAUDE.md` points here.

## 1. Principles

- **Secure by default.** Deny unless explicitly allowed. Every public method checks the caller, the status and every limit before it changes state or calls out.
- **Least privilege.** Each key, account and component gets the smallest power that works. The agent's key calls only the `agent_*` and `exit_*` methods, `cleanup_gift` and `resolve_stale` (and `update_anchor` if Q15 keeps it) on one contract, and the model never sees a key.
- **Fail closed.** On any error, unknown input or unexpected state, refuse and keep funds where they are. Never guess past an error.
- **No unverified assumptions.** External behaviour (Rhea, NEP-141 tokens, Intents, NEAR AI) is used only once it is recorded as confirmed in `docs/gates/` or a skill. Anything else is marked as a guess and must not ship.
- **Simple over clever.** Less code, fewer paths, no upgrade hooks, no admin backdoors beyond what `docs/DECISIONS.md` records.
- **Everything recorded.** Threats in `THREAT_MODEL.md`, edge cases in `EDGE_CASES.md`, audit results in `AUDIT_LOG.md`.

## 2. Independent audit at every step

An **independent audit** is run by a separate agent that did not write the change. It starts fresh, with no access to the author's reasoning. It gets only the change, the specification documents and this process. It reads, runs tests and reports. It never edits code. The author fixes, and the audit runs again on the fix.

| Step | Audits required (each by a separate, fresh agent) |
|---|---|
| Design or interface change (architecture, rule schema, contract signatures, `ActionRecord`, key layout) | `security-auditor` on the **diff** of the design documents (the full documents are reference only). Not `test-auditor` or `contract-reviewer`: there are no tests or contract code to judge, and missing tests are tracked as edge cases instead (D52) |
| Every change before it is merged | `security-auditor` on the diff, plus `test-auditor` on the diff and its tests |
| Any change under `contracts/` | Also `contract-reviewer` |
| Any change to `packages/rules`, the agent's decide step, or the check page's replay | Also `rules-verifier` |
| Any user-facing text | Also `claims-checker` |
| Before any mainnet deployment or mainnet script run | `security-auditor` on the full contract and scripts, **two independent runs**, plus `/security-review`. The lead reads both reports before signing |
| Before submission (M8) | A full-repo `security-auditor` run and a `test-auditor` run |

Design phase (D16, D52): after the final design round, new Critical or High findings are fixed and verified by a **targeted** fresh audit of that fix only, and the design is then cleared. Open Medium and Low design findings are recorded as edge cases in `EDGE_CASES.md` (or as items in ARCHITECTURE 5.11) and must be closed by tests and code audits before the code that implements them is merged; they are not folded back into the design as new revisions. If a targeted re-audit finds a new Critical or High in the same mechanism, the author doesn't write another revision: the co-leads choose a simplification.

Audit rules:

- **Independence.** Launch each auditor as a new agent. Give it the scope (the diff range, or the paths of new files) and the documents to judge against. Audit the diff, not the whole system again: unchanged parts were audited when they changed. Don't tell it what you believe is safe, and don't pass it the author's conclusions.
- **Severity.** `Critical` (loss or lock of funds, key exposure, bypass of a limit or access check), `High` (wrong payout, refusal path broken, unverifiable check-page result, claim the code can't support), `Medium` (defence-in-depth gap, missing test for a listed edge case), `Low` (clarity, hardening). **On a design, a Critical or High needs a concrete failure path that uses only behaviour confirmed in `docs/gates/`.** A failure that depends on unconfirmed Rhea, token or NEAR behaviour is recorded as an ARCHITECTURE 5.11 item to measure before M1, not as a blocking finding (D52).
- **Blocking.** Critical and High findings block the merge, with no exceptions. Medium findings are fixed, or accepted by the lead with a written reason in `AUDIT_LOG.md`. Low findings are fixed or logged.
- **Re-audit.** After fixes for a Critical or High finding, a new auditor (not the one that found it) checks the fix.
- **Log.** Every audit gets a row in `AUDIT_LOG.md`: date, scope, commit, auditor, counts by severity, and how each finding was resolved.

## 3. Testing requirements

Tests are written before the code they test (see `CLAUDE.md`).

| Layer | Requirement |
|---|---|
| Every public contract method | A positive test, a test for each `require!` or refusal (asserting the exact message), and a test for each status it must reject in |
| Every limit | Tests at the limit (allowed), at limit + 1 (refused), and at zero and maximum values |
| Every cross-contract call | Tests for success, failure of the call, and a callback invoked directly by an outsider |
| Arithmetic | Unit tests at 0, 1, the maximum `u128`, and rounding boundaries, plus property tests (`proptest`) that payouts never exceed the balance, that the platform's cut is exactly `fees / 20` per token, and that no account gets more than it is owed |
| `packages/rules` | Fixed hash test vectors, canonical JSON edge cases, and property tests (`fast-check`) for `evaluate` and `withinRules` |
| Agent | Tests that it never sends an action `withinRules` rejects, falls back safely on bad model output, and never logs a key |
| Check page | Tests that tampered or inconsistent data shows **not matching**, and that untrusted strings render as text |
| Scripts | Tests that the money cap, network check and dry-run default refuse correctly |

Every edge case in `EDGE_CASES.md` that applies to a component must have at least one test that names its ID (for example `// EC-C09`). `test-auditor` checks this. Tests under `spikes/` don't count: they check how external contracts behave, not our code, and are tagged "Evidence (not a contract test) for: …".

Quality bars, enforced in CI once the skeleton exists:

- **Coverage:** at least 90% line coverage, and 100% of refusal branches, for `contracts/strategy` (`cargo llvm-cov`) and `packages/rules` (`vitest --coverage`).
- **Mutation testing:** `cargo mutants` on the contract before every mainnet deployment. Every surviving mutant in a security-relevant function gets a new test or a written reason.
- **Static checks:** `cargo clippy -- -D warnings`, `cargo fmt --check`, TypeScript `strict`, and ESLint with no warnings.
- **Dependencies:** pinned versions and committed lockfiles. `cargo audit` (or `cargo deny`) and `pnpm audit` in CI. New dependencies need a reason in the pull request.

## 4. Mainnet rules

In addition to the hard rules in `CLAUDE.md`:

- Mainnet transactions are made only by a person, from a reviewed script. Each script prints the network, accounts, amounts and calls, and asks for confirmation. It defaults to a dry run, and it refuses anything over the cap in `DECISIONS.md` (D4).
- Deploy only code that matches an audited commit. Record the commit, the WASM hash and the transaction in `AUDIT_LOG.md`.
- Keys with funds never enter a repository, a prompt, a log or a Claude Code session. Agent function-call keys live only on the agent host as secrets.
- If anything unexpected happens on mainnet, stop the agent first, then investigate.

## 5. Secrets

- No secret goes in the repo, the chat or an artifact. Use environment secrets and a `.env` file that git ignores.
- CI uses no mainnet keys.
- CI runs `scripts/secret-scan.sh` over every blob in the history (EC-S05). Its known blind spots: base64-encoded keys, keys inside compressed files, UTF-16 text, seed phrases split across lines, seed phrases under a bare `secret:` name without an `=` assignment, a match exempt as a public key (only a match that is exactly a key name, dotted and slashed paths included, ending in `pub`/`public` key, then a separator and one value of exactly 64 hex, with none of priv, secret, seed, mnemonic, passphrase or signing in it; any longer value, or any hex followed later on the line by a 64-hex run, is never exempt; tested in `scripts/secret-scan.test.sh`), and 64-hex values whose own name has no key, secret, priv or pk (including a bare 64-hex value), and key formats it doesn't name. Don't rely on it; keep secrets out in the first place.
- **Deliberate false positives:** a match that starts at a public-key name and continues with any hex character (0-9 or a-f) and then a 64-hex value fails the scan, unless the whole match is exactly `name = <64hex>` (or the same with a colon, quotes or a type); text before or after the match on the line is ignored. This includes prose such as "The public key for the rules hash: <64hex>" and "The public key 1 is <64hex>". The scan has no allowlist and covers all history, so put hashes on lines that don't mention a public key rather than weaken the scanner.
- If a secret is exposed, treat it as compromised: rotate it, and log the incident in `AUDIT_LOG.md`.
