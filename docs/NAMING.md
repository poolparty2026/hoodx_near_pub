# Naming: hoodx (formerly Poolside)

The product is called **hoodx** (lowercase, one word, even at the start of a sentence; "hoodx on NEAR" or "the hoodx LP agent" the first time it appears in public material). The mascot is **Hoody** (was Pooly). Decided by the session owner on 14 November 2026 (D60). The name is cleared (the session owner, 14 November 2026: cleared for a long time; D62).

## Renamed

All prose, UI copy, docs, the brand skill (`.claude/skills/hoodx-brand`), agent prompts, `CLAUDE.md`, the README, the demo script, the video and posts, and the mascot art and wordmarks. CSS tokens move from `--ps-*` to `--hx-*`.

## Kept for now, and why (technical identifiers, not shown to people)

| Identifier | Why it stays |
|---|---|
| NEP-297 event standard `"poolside"` in `contracts/strategy` (`contract.rs`) and the tests that assert it | A shared interface (CLAUDE.md: own small PR) and part of the audited contract and the recorded scenario fixtures. Changing it needs an audit and a re-record. |
| Domain-separation strings `poolside-chain-v1`, `poolside-viewing-key-v1` | Part of the record hash chain and key sealing. Changing them changes every recorded hash in `fixtures/scenario/`, which took an hour of real time per run. |
| Test account ids `*.poolside.near`, `poolside-demo.near` | Fixtures only. |
| Repository `poolside-near` and the GitHub organisation | A co-lead's decision. |
| `@poolside/*` package scope, `POOLSIDE_*` environment variable names | Mechanical rename of about 100 imports plus the lockfile; done after the last worker merge if wanted (D60). |

A co-lead may overrule any row. A row that changes goes in its own small pull request with a re-audit if it touches `contracts/` or `packages/rules`.
