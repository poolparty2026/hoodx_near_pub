# How the Claude Code sessions are coordinated (handover)

Written 14 November 2026 by the lead session. This is the setup that built Poolside on NEAR from 12 to 14 November: one lead session that coordinates, several worker sessions that each own one area, an independent audit session, and a small set of rules that keep token use and risk down. `CLAUDE.md` and `docs/security/SECURITY_PROCESS.md` still win where this file disagrees. Update this file when you change the setup.

## 1. Roles

| Session | Owns | Branch | Never does |
|---|---|---|---|
| **Lead (coordinator)** | Routing, decisions that are not co-lead decisions, merges into the consolidated branch, the status board, deploys (D56) | `claude/<id>` consolidated branch | Writes feature code, pushes to `main`, submits or posts (a co-lead does) |
| **Backend / contract** | `contracts/`, `packages/rules`, `packages/near`, `apps/agent`, scenario recordings | `backend/<task>`, `rules/<task>`, `contract/<task>` | Touches `apps/web` |
| **Frontend** | `apps/web`, README and demo script drafts, `docs/DEPLOY.md` | `web/<task>` | Edits contracts or `packages/rules` |
| **Deliverer / testnet** | `packages/seal`, `apps/deliverer`, testnet scripts | `deliverer/<task>` | Edits contracts or `apps/web` |
| **Audit** | `docs/security/audits/`, `AUDIT_LOG.md` rows | `audit/rolling` | Edits code. Launches fresh auditor agents with scope only (CLAUDE.md) |

Co-leads (Erik, Vipasana; D22) decide design questions, merge to `main`, publish, post and submit. The lead session decides everything below that, records it in `docs/DECISIONS.md` and tells the user what it decided and why.

## 2. Starting the sessions

Use `create_session` (claude-code-remote MCP) with `source_url`, `source_revision` = the consolidated branch, `outcome_branch` = the worker's branch. A prompt must stand alone. Always include:
1. "Read `CLAUDE.md` first and obey it", the decisions that apply (`docs/DECISIONS.md` D-numbers), `docs/GRAPHIFY.md`, and only the docs the task needs.
2. The goal, the owner of each piece, the order of work, the hard cut time and the deadline.
3. The coordinator rule and the token rules (section 3), and "push only to your own branch, no pull requests".
4. What the session must NOT touch.

Prefer **fresh sessions over old ones** for a new task: an old session that has used 400 to 700 thousand tokens of context makes every turn expensive. Reuse an old session only for work that needs its history.

## 3. Message protocol and token rules (send these to every session)

- All cross-session traffic goes through the lead via `send_message`. Workers do not message each other.
- One short message per event: branch, commit, tests passing, what is needed. No narration, no repeated context.
- No polling and no sleep loops. Long waits: start a detached process and use `Monitor` with an `until` loop on a completion marker. A session that ends its turn while waiting is not woken by anything: the lead must wake it (the backend sat idle for 8 hours this way).
- Orient with graphify before opening files (section 4). Use ranged reads, never whole large files.
- No exploratory work and no extra audits beyond the assigned list. Audits run in the audit session.
- Push when a task is done, not per edit. Run only the relevant tests while working; run the full suite once before reporting.
- Priorities: `priority: "now"` interrupts a turn, `"next"` joins the running turn, `"later"` waits. Use `now` only to wake or hold.
- To pause everything: send "HOLD: finish the step in flight, push, go idle". To resume: send the plan again; a session that hit its limit may not have processed earlier messages.
- Usage limits: a worker can stop on the 5-hour limit with no report. Check `get_session` (`status_bucket` FAILED, `post_turn_summary`) and the branch commit times; wake it when the limit resets.

## 4. graphify

`docs/GRAPHIFY.md` has the steps: `uv tool install graphifyy`, `graphify update .` (code only, local, no LLM), then `graphify query "<question>"`, `graphify explain "<symbol>"`, `graphify path "A" "B"`. The doc graph needs a model pass; do it only if needed and never with a hosted backend. A graph answer is a pointer, never audit evidence: cite file and line from the source. `graphify-out/` is not committed.

## 5. Merging into the consolidated branch (lead only)

Order: backend, rules, interface, web, audit. Known conflicts and the rule for each:
- `docs/INTERFACE.md`: take the interface branch's text (`git checkout --theirs`).
- `docs/security/AUDIT_LOG.md`: keep both sides (delete the conflict markers), then run the audit session's tidy.
- `pnpm-lock.yaml`: take ours, then `pnpm install --lockfile-only`.
Then `pnpm install --frozen-lockfile`, `pnpm -r test`, `pnpm lint`, `cargo test -p strategy`, push. `pnpm --filter web exec next typegen` is needed once on a fresh checkout. **Git identity:** set `git config user.email noreply@anthropic.com` and `user.name Claude` before committing; a scratch worktree with another identity changes the shared config. Amend only unpushed commits.

## 6. Audit routine (as run here)

One audit round per area after the build, scope as git ranges: security + test (+ contract-reviewer for `contracts/`, rules-verifier for rules and replay, claims-checker for user-facing text). Critical and High block; Mediums are fixed or accepted as open items under D52 with a threat-model row. The audit session writes full text to `docs/security/audits/` and sends the lead one short message. A graph answer is never evidence.

## 7. Long runs (the scenario recording)

- Anything over a few minutes runs detached (`setsid`), writes to disk incrementally and has a completion marker. Container or worker restarts kill attached processes (runs 2 and 3 were lost this way).
- The sandbox drops old blocks: sample while the run goes.
- Real time matters: a time-based close needs the real wait (about an hour). Do not fake it.

## 8. Deploying the web app (D56, Erik asks in the session)

1. Read `docs/DEPLOY.md`. Preconditions: web tests and build pass, claims-checker passed, the branch and commit are named by Erik.
2. Token: ask for it with `request_credential` (host `api.vercel.com`, bearer). It is saved on the shared environment and injected by the proxy; revoke it in Vercel afterwards. A token in an environment variable is not visible to a running session.
3. The Vercel CLI refuses a token containing a dash: pass `--token proxyinjected`.
4. Create the project through the API (`rootDirectory: apps/web`, Next.js, then PATCH `nodeVersion` to `22.x`), deploy from a clean worktree of the exact commit with `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` set, with a `.vercelignore` for duplicate fixtures, build output and `spikes`.
5. The first deployment of a project becomes production and public. Previews are behind Vercel login. Do not create a protection-bypass secret (it weakens protection; the permission check refuses it). Smoke-test the public URL, or ask Erik to check the preview.
6. Roll back on any failed smoke item: pause the project (`POST /v1/projects/{id}/pause`).

## 9. Hard rules that shaped the work

No mainnet transaction by a session; no keys that control funds; testnet and sandbox only; never push to `main`, publish, post or submit except the D23 Telegram questions and the D56 deploy; claim limits in `CLAUDE.md`; mark every guess. Telegram (D23): plain-text questions to Vipasana only, using `TG_BOT_TOKEN` and `CHAT_ID`; replies cannot be read by a session, so the user relays them.

## 10. Rhythm and decisions

- The lead keeps a short status board (`docs/MINIMAL_PLAN.md` section 8) and gives the user one overview when asked: state per area, risks, a plan with hours, and the decisions needed.
- Decisions the lead made in this run (all in `docs/DECISIONS.md` or the audit log): spot valuation disclosed (Q15 provisional), records host untrusted and content-addressed, one host cannot convict, a close is judged by the missed-close check (D53), tagline changed, contract Mediums accepted under D52.
- Keep a fallback: tag or note the last complete, audited commit; build new scope on separate branches; set a hard cut time; merge only if it works end to end and passes audit.

## 11. Updating this file

When a rule here proves wrong or a new failure mode appears, change it in the same commit that fixes the process and add one line to `docs/DECISIONS.md` if it is a decision.
