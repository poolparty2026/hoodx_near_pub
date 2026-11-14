# Gate 1: what exists, and what predates 19 October

**Owner:** Lead. **Due:** 7 November 2026.

## Question

What does the code do today, and what predates 19 October 2026? The hackathon counts only work from 19 October, so older work must be kept separate.

## Evidence

- On 5 November 2026 this repository (`poolparty2026/poolside-near`) had no commits on any branch that was cloned. The first commit is the build brief.
- Every file in it was written on or after 5 November 2026:

| Commit date | What was added |
|---|---|
| 5 Nov | `docs/build-brief.md` |
| 5 Nov | `.claude/skills/poolside-brand/` (derived from the October product overview, which is a design document, not code) |
| 5 Nov | `docs/one-pager/` |
| 5 Nov | `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT_PLAN.md`, `CLAUDE.md`, `AGENTS.md`, `.claude/agents/` |
| 5 Nov | `docs/gates/`, `spikes/gate3-access-keys/` |

`git log --format='%ad %s' --date=short` reproduces this list.

## Answer

**The entry is rebuilt from scratch. No earlier Poolside code is reused.** The team confirmed this on 5 November 2026.

- All code in this repo is new hackathon work, written from 5 November 2026. Nothing predates 19 October.
- Any earlier Poolside code (the front end, indexer and agent wallet described in the October overview) stays outside this repo and is not copied, adapted or imported.
- The October product overview and the build brief are design documents, not code. Using them as input is fine.
- `spikes/` holds throwaway experiments that answer gates. Production code under `contracts/`, `packages/` and `apps/` is written fresh and doesn't copy from spikes either. The findings carry over through `docs/gates/` and the skills, not the code.

The README states this in one line, so judges can see what is new: "Everything in this repository was written for the NEAR hackathon from 5 November 2026. No earlier code is reused."

## Still open

- A team member may work on another entry. The decision is not to name it in either README (D8 in `docs/DECISIONS.md`). Before submission, check the hackathon rules on disclosure and revisit D8 if needed.

**Sign-off:** Rebuild from scratch confirmed by the team, 5 November 2026. Other entries: see D8.
