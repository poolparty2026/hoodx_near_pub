# Poolside on NEAR: handover

> **Update, 11 November 2026:** the project now targets a minimal implementation. See [`MINIMAL_PLAN.md`](MINIMAL_PLAN.md) for the scope, the schedule and the status board; contract slices 1 to 6 are cleared (`AUDIT_LOG.md`), and section 6 below is replaced by the plan's slices S7 to S10.

Written 10 November 2026, at commit `6d1f1ba` on branch `claude/festive-shannon-i8qraw`. It is for whoever picks up the project next, a person or a fresh Claude Code session. It summarises where things stand and points to the documents that hold the detail. Where this file and those documents disagree, the documents win: they are kept current, and this file is a snapshot.

The hackathon deadline is **14 November 2026, 23:59 UTC**.

## 1. What the project is

Poolside is an autonomous liquidity-provider agent on Rhea Finance's concentrated-liquidity DCL contract on NEAR. Each strategy runs from its own contract account.

- **Hidden rules:** a creator runs a strategy whose rules are hidden. Only a SHA-256 hash and the encrypted rules are published.
- **Viewing keys:** followers can buy a viewing key to read the rules while the run is live.
- **Public check:** after close, anyone can confirm on the `/check/[strategy]` page that the agent's actions followed the rules.

Read these first, in this order:

1. `CLAUDE.md`: the layout, commands and **hard rules**. They are binding on every session.
2. `docs/build-brief.md`: what we are building and the rules we keep.
3. `docs/ARCHITECTURE.md`: revision 27, the cleared design. Section 5 covers the contract and 5.11 lists its open items.
4. `docs/DECISIONS.md`: D1 to D54. Later decisions supersede earlier ones where they say so.
5. `docs/security/SECURITY_PROCESS.md`: the audit routine. It is mandatory.
6. `docs/gates/`: verified facts about Rhea, Intents and NEAR AI. Trust these over memory.

## 2. People and authority

| Who | Role |
|---|---|
| Erik | Co-lead (D22). Lead, payments, front end, demo. Takes most design decisions (D47, D49, D52, D53) |
| Vipasana (@vipassana19 on Telegram) | Co-lead (D22). Contract and agent roles. Still to sign off several decisions (section 7) |
| Claude Code sessions | Build, test and audit. **Never** push to `main`, publish, post, submit or sign mainnet transactions |

Only a co-lead merges to `main`, publishes, posts, submits or runs a mainnet transaction, one step at a time. Claude's only outbound channel is plain-text questions to Vipasana in the team Telegram group (D23).

## 3. Where things stand

### 3.1 Summary

| Area | State |
|---|---|
| Design (`ARCHITECTURE.md` rev 27) | **Cleared** after 27 revisions and their audits (D16, D52). Open Mediums and Lows are tracked as edge cases and 5.11 items |
| `packages/rules` (rule schema, canonical JSON, hash, encryption, `evaluate`, confirmation, missed-close, swap floor) | **v1 done and cleared.** 664 tests, 100% coverage, Python cross-check vectors in CI |
| `packages/near` (typed RPC and Rhea view helpers) | Built and audited (`audits/2026-11-07-code-near-1.md`). About 70 tests |
| `scripts/` | `quote.ts` (Intents `dry: true` quotes), `mainnet-roundtrip.ts` (gate 3 part D, written for a person to run, **not yet run**), `secret-scan.sh` (in CI) |
| `contracts/strategy` slice 1 (`limits.rs`: pure validation of `new`'s configuration) | **Cleared** |
| `contracts/strategy` slice 2 (`contract.rs`: `new`, three storage registrations, callbacks, `retry_registration`, views) | **Cleared**. 61 unit tests, 63 with the `sandbox` feature |
| `contracts/strategy-sandbox` slice 2b (the real wasm against pinned mainnet DCL, native USDC and wrap.near code) | **Cleared**. 7 sandbox tests |
| Rest of the contract (funding, `start`, agent calls, exits, settle, claims, viewing keys) | **Not started** |
| `apps/agent`, `apps/deliverer`, `apps/alerter`, `apps/web` (including the check page) | **Not started.** The `apps/` directory doesn't exist yet |
| Live mainnet strategy | **Not started.** It needs a deployable contract, then a co-lead to run the deploy |

### 3.2 Against the plan

`docs/DEVELOPMENT_PLAN.md` section 3 planned the whole contract by 9 November, the check page on 10 November and the full demo on 11 November. **The project is well behind that plan.**

- **Why:** the design took 27 audited revisions. D52 changed the audit routine to cut the delay: audits cover the diff only, re-audits are targeted, and Mediums are accepted and tracked.
- **What to do:** apply the cut order in section 6 of the plan **now**, not later (section 8 below).

### 3.3 Commit history

The branch has 160 commits. The latest ones:

```
6d1f1ba contracts/strategy slice 2b: targeted-check Lows (slice 2b cleared)
0f8a6ba contracts/strategy slice 2b: pin the sandbox binary; assert every gate 3 Part F fact
0df60ce contracts/strategy slice 2b: sandbox tests on the real wasm; slice 2 Low fixes
80222b1 contracts/strategy slice 2: re-check needs total >= dcl_storage; null clears only late enough
...
e31b6e6 contracts/strategy: test that the drift bound is the largest safe one; slice 1 cleared
a1880b0 packages/rules: the clock pair must be adjacent heights
```

Nothing has been merged to `main`. A co-lead decides how this branch gets there.

## 4. How to build and test

| What | Command |
|---|---|
| TypeScript lint and tests (`packages/*`, `scripts`) | `pnpm install --frozen-lockfile && pnpm lint && pnpm test` (Node 22, pnpm 10.28.0) |
| Rules cross-check vectors | `python3 -I packages/rules/test/vectors/check_*.py <matching .json>` (as in CI) |
| Contract unit tests | `cargo test -p strategy --locked` and `cargo test -p strategy --features sandbox --locked` |
| Contract lint | `cargo fmt -p strategy -- --check`, `cargo clippy -p strategy --all-targets --locked -- -D warnings` |
| Mainnet wasm | `RUSTFLAGS="--cfg near" cargo build -p strategy --target wasm32-unknown-unknown --release --locked` (Rust 1.97.0). Plain `cargo build` for wasm fails by design in near-sdk 5.x |
| Sandbox tests on the real wasm | `contracts/strategy-sandbox/run.sh` (about 1 minute) |

What `run.sh` does:

- Fetches the mainnet code for DCL, wrap.near and native USDC, plus the near-sandbox 2.14.0 binary, and refuses any file whose hash isn't pinned in `contracts/strategy-sandbox/wasm/README.md`.
- Builds the strategy's sandbox wasm.
- Runs the tests, which check every hash again.

None of the fetched files is committed. The sandbox crate is not a default workspace member, so plain `cargo` commands at the root never build it. CI doesn't run it.

CI (`.github/workflows/ci.yml`) runs:

- the TypeScript lint, tests and coverage;
- the vectors;
- `pnpm audit`;
- the Rust format, clippy, tests and wasm build, plus a check that the mainnet wasm names no `.test.near` account;
- a secret scan over the whole history.

### 4.1 Environment notes for cloud sessions

- `rpc.mainnet.near.org` is deprecated, rate-limited and not archival. Use `https://free.rpc.fastnear.com` for views. Whether it is archival is unverified.
- Node 22's `fetch` ignores this container's HTTPS proxy, so use `curl` or Python `urllib`.
- The container's open-file hard limit is lower than near-sandbox asks for. `run.sh` builds `rlimit_shim.c` and preloads it when needed.
- Disk is a fixed allowance, and Rust `target/` directories fill it fast. Delete old ones when space runs out.

## 5. Contract, as built

### 5.1 Slice 1: `contracts/strategy/src/limits.rs`

Pure `validate` of `new`'s configuration, with a stable `LIMIT:` message for each refusal.

- **Network constants:** the USDC/wNEAR fee-100 pool `17208628…33a1|wrap.near|100`, confirmed on mainnet. Token_x is native USDC.
- **Drift bound (D54):** the largest D with 2·D·W ≤ a(W−a), where a = floor(W/4).
- **Attestation:** `ATTESTATION_ENABLED = false`, so `attested: true` is refused until gate 2 passes.
- **Dust threshold:** at least 1.

### 5.2 Slice 2: `contracts/strategy/src/contract.rs`

near-sdk 5.30.1.

**`new(config, limits)`**

- Callable by the strategy account or its parent, so the parent can sign one deploy batch: create, fund, key, deploy and `new`.
- Checks run in this order: caller, sandbox guard, `MIN_GAS_NEW` (200 Tgas), rules hash, `validate`, then the balance.
- It then starts three registrations: `storage_deposit` on the quote token, the base token and DCL.
- It **never calls `register_tokens`**, which panics E104 (gate 3).

**Callbacks (`on_registered`)**

- Fixed 10 Tgas with no share of unused gas.
- Carry a nonce; a stale callback is ignored with a `registration_ignored` event.
- Refuse anyone but the contract itself (`AUTH: callback only`).

**`retry_registration(target)`**

- Creator only, at `MIN_GAS_RETRY` (80 Tgas) or more.
- Allowed for a `Failed` registration, or a `Pending` one after `stale_after_blocks`.
- **DCL storage is never paid twice.** While a deposit may have landed, a retry only re-checks `storage_balance_of`. It counts as `Ok` only if `total >= dcl_storage`.
- A `null` or low total clears the flag only when the re-check was launched at least 2 × `stale_after_blocks` after the deposit.
- The residual risk is disclosed as T73.

**Other details**

- **Events** (NEP-297, `standard: "poolside"`): `new`, `registration_started`, `registration`, `registration_ignored`.
- **`sandbox` feature** (off by default): uses `.test.near` accounts and refuses to run anywhere else. CI checks that the mainnet wasm contains none.

### 5.3 Measured facts

Gate 3 Part F has the full list, every item asserted by a test:

- DCL `storage_deposit` returns a plain `{available, total}`, and a second deposit is credited, not refunded.
- DCL `storage_balance_of` returns `null` for an unregistered account.
- Native USDC and wrap.near both refund a repeat registration. Both have a storage bound of 0.00125 NEAR.
- A deploy at exactly 200 Tgas succeeds; at 199 it is refused and reverts.
- Every storage call and callback burns under half its fixed gas.

## 6. Next steps, in order

Each step follows `CLAUDE.md`'s loop: plan, failing tests, code. Then the audits:

- always a fresh `security-auditor` and `test-auditor` on the diff;
- `contract-reviewer` for `contracts/`;
- `rules-verifier` for rules or replay;
- `claims-checker` for user-facing text.

Log each audit in `docs/security/AUDIT_LOG.md` and its file under `docs/security/audits/`. Critical and High findings block.

1. **Contract funding:** `ft_on_transfer`, then `cancel` and `withdraw` (ARCHITECTURE 5.5; EC-C03 and its neighbours in `EDGE_CASES.md`).
2. **`start(expected_point)`:** checks every registration is `Ok`, the principal, the balance and the deadline, under the lock.
3. **`agent_swap`, `agent_open`, `agent_close_position`, `agent_heartbeat`, then `close`, `exit_remove`, `exit_withdraw`, `settle`, `claim_platform`, `claim_creator`, `reveal`, `resolve_stale`** (5.5 to 5.10). Several 5.11 items block these and need the DCL 2.4.2 source, the sandbox, or the mainnet round trip:
   - `add_liquidity`'s and `withdraw_asset`'s full signatures;
   - whether `remove_liquidity`'s return includes the fees;
   - gas for the chained stages.
4. **The interface pull request** freezing signatures, `ActionRecord` and event names. It goes in its own small pull request, per `CLAUDE.md`.
5. **`apps/agent`:** the loop, the decision log and a function-call key limited to the agent methods.
6. **`apps/web` and `/check/[strategy]`:** hash check, code-hash check, a verdict per action, missed actions and the split check. **Never cut the check page or the refusal** (plan section 6).
7. **Viewing keys:** `buy_viewing_key`, `deliver_key`, `refund_key` and `rekey`, plus `apps/deliverer` on its own host and account.
8. **`apps/alerter`:** read-only Telegram alerts, with no NEAR keys.
9. **Mainnet:** a deploy script that pins the wasm hash, two full security audits and `/security-review`, then a co-lead runs it.
10. **README, claim table, no-funds path, demo video and submission** (plan, 12 to 14 November). Claims stay within `CLAUDE.md`'s limits.

### 6.1 Tracked items not yet done

- `cargo audit` in CI. It isn't installed here, and it hasn't checked the about 156 crates `near-workspaces` brings in. Those are dev-only and never reach the wasm.
- Read the token storage bounds at deploy, rather than relying on the 0.00125 NEAR constant.
- Count escrowed key-sale NEAR in `require_balance` when key sales land.
- A deploy script that pins the strategy wasm hash.
- `packages/rules`: a two-gap missed-close fixture and a wider property test (T-7).
- EC-W25 and EC-W28 for `apps/web`.
- **Before mainnet:** decide whether `platform_account` becomes a network constant (recommended), or whether the check page verifies it.
- The near-sandbox pin trusts its first download from nearcore's S3 bucket. This is accepted under T16; compare it with an independent checksum if one turns up.

## 7. Waiting on people

| Who | What |
|---|---|
| Erik | Decide `platform_account` (network constant recommended; needs the account id). Run `scripts/mainnet-roundtrip.ts` (gate 3 part D: whether removal returns include fees). Confirm the 1,000-point range width (D39) |
| Vipasana | Sign off D47, D49, D50, D51, D52, D53 and D54. Answer the items still listed as open in ARCHITECTURE 5.11: Q15 (anchor or two-read check), Q16 (swap-step caps), and question 8 (size the swap at the reference or the observed point). Check whether later decisions already settle them, then close them in 5.11 |
| Either co-lead | Sign off gates 2, 3 and 4 in `docs/gates/`. Gate 2 (NEAR private AI) needs a NEAR AI Cloud API key and one live attested decision. Gate 4 confidential quotes need a 1Click API key; until then, make no private-funding claim |

## 8. Risks and the cut order

- **Time:** about four days remain, and most components are not started. The plan's cut order (section 6) is:
  1. pools dashboard and Zap (already out);
  2. mirroring from a follower's own wallet;
  3. NEAR private AI.

  Never cut the check page or the refusal. Co-leads should decide today what else to cut, for example viewing-key rekey or the alerter. The live strategy also needs days on mainnet to show any fees, so the earliest deployable contract matters more than a complete one (plan section 3).
- **Unverified Rhea behaviour:** ARCHITECTURE 5.11 lists what is still unconfirmed. Don't write code against a guess (`CLAUDE.md`, "Mark guesses").
- **Audit load:** each slice takes two to three fresh audits plus a targeted re-check. Keep slices small. D52 applies: if a new High appears in the same mechanism again, a co-lead chooses a simplification instead of another round.

## 9. Hard rules (from `CLAUDE.md`; read the original)

- Never handle private keys that control funds. Any mainnet transaction is a script a person reviews and runs.
- Never push to `main`, publish, post or submit.
- Claim limits:
  - no claims that the agent makes money or beats the market;
  - no hidden positions and no full anonymity;
  - never say viewing keys can't be shared;
  - never call Intents "unstoppable";
  - no agent volume;
  - don't use "harness" in a way that implies a link to NEAR's own work.
- No fee-split number until gate 5 is settled. No Shade Agents.
- Rebuilt from scratch: nothing from before 19 October 2026 and nothing copied from `spikes/`. Spikes carry findings only, through `docs/gates/` and the skills.
- Mark guesses, and check them before relying on them.
- No model identifiers in commits or repository files.

## 10. Map of the repository

| Path | What |
|---|---|
| `CLAUDE.md` | Session rules |
| `docs/ARCHITECTURE.md`, `DECISIONS.md`, `DEVELOPMENT_PLAN.md`, `build-brief.md` | Design, decisions, plan, brief |
| `docs/gates/1` to `5` | Verified facts: existing code, private AI, Rhea and access keys (Parts A to F), Confidential Intents, fee split |
| `docs/security/` | `SECURITY_PROCESS.md`, `THREAT_MODEL.md` (T1 to T73), `EDGE_CASES.md` (EC IDs, each with a test), `AUDIT_LOG.md`, `audits/` (one file per audit round) |
| `docs/questions-for-vipasana.md`, `docs/vipasana/` | Open questions and answer forms |
| `docs/one-pager/` | Product overview (brand reference) |
| `.claude/agents/` | Auditor definitions: `security-auditor`, `test-auditor`, `contract-reviewer`, `rules-verifier`, `claims-checker` |
| `.claude/skills/` | `near-contract`, `rhea-dcl` (confirmed facts only), `poolside-brand` |
| `packages/rules` | Rule schema, canonical JSON, hash, encryption, `evaluate`. Pure: no clock, network or randomness |
| `packages/near` | Typed RPC and Rhea view helpers |
| `contracts/strategy` | Strategy contract: `limits.rs` (slice 1), `contract.rs` (slice 2), tests beside each |
| `contracts/strategy-sandbox` | Real-wasm sandbox tests: `run.sh`, `fetch_wasm.py`, `tests/new.rs` |
| `scripts/` | Quotes, the mainnet round trip (for a person to run), secret scan |
| `spikes/` | Throwaway gate 3 spikes. Never copy from them |
