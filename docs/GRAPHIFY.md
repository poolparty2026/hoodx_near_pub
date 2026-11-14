# Using graphify on this project

graphify builds a knowledge graph of the code and docs that you query instead of grepping. It is a **local developer aid**: nothing in `graphify-out/` is committed (it is in `.gitignore`), and it never replaces the security audits, the tests or reading the source before you change it. A graph edge tagged `INFERRED` is a hint, not a fact: check it in the code.

## Set up (once per session, about a minute)

```bash
uv tool install graphifyy        # CLI; needs network access to PyPI
graphify update .                # code only: local tree-sitter, no LLM, nothing leaves the container
```

`graphify update .` covers `contracts/`, `packages/`, `apps/` and `scripts/`. Re-run it after you change code (a few seconds, incremental).

## Query it

```bash
graphify query "how does the agent reach agent_swap"
graphify path "withinRules" "RulesError"
graphify explain "Strategy"
```

Read `graphify-out/GRAPH_REPORT.md` for the god nodes and communities.

## Docs (optional, costs model tokens)

Code is free and local. A graph of `docs/` needs a semantic pass by the session's own model (`/graphify . --update` with the skill, installed by `graphify install --platform claude`). Do it only if you need doc-to-code links. The docs hold the threat model and edge cases, so never point a graphify run at a hosted or third-party backend (no `GEMINI_API_KEY`, no Graphify Cloud, no `graphify add <url>`) for this repository.

## Rules

- Use it for orientation: who calls X, what touches Y, where an edge case ID is tested. Then open the file.
- Keep it read-only with respect to the repo: do not commit `graphify-out/`, and do not run `graphify install` hooks that modify the repo (git hooks, `CLAUDE.md` edits).
- Audit sessions: a graph answer is never audit evidence. Cite file and line.
