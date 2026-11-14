# Scenario recordings

What a replay of the check page can be run against: **a local NEAR sandbox, not mainnet**. Pinned
constants (network accounts, pool, strategy code hash) are in `pins.json`; every recorded response is
a real answer from that sandbox at the block named in the entry.

Recorded by `contracts/strategy-sandbox/tests/scenario.rs` (`SCENARIO=1 ./contracts/strategy-sandbox/run.sh record_both`),
which runs two real worlds for about an hour each with the real agent process, and samples **while the run
goes** (the sandbox keeps only recent blocks).

## Files

| File | What it is |
|---|---|
| `good.sandbox-a.json`, `good.sandbox-b.json` | The good run: the agent swapped, opened and sent a genuine `agent_close_position` when the rules' `close_after_s` (3,600 s of real time) had passed; then `close`, `settle`, `reveal` and the creator's claims. Two providers with the same content, so the page can show two independent reads. |
| `bad-tampered-rules.sandbox-*.json` | The good run with the **revealed rules text altered** (`close_after_s` 3600 → 3601), so its hash no longer matches the chain's `rules_hash`: the page must refuse the reveal, not replay it. |
| `no-agent-close.sandbox-*.json` | The bad run: the same rules, the agent **stopped after the open**, so the due close was never sent. The sandbox and the sampler ran on past the due time, and the creator ended the run (`close`, `exit_remove`, `settle`, `reveal`). The missed close is genuine, not engineered. |
| `records/<decision_hash>.txt` | The agent's own decision records, exactly as it published them (UTF-8, no trailing newline). The good run's were published by the agent after the reveal; the bad run's are its held records, published by the operator after the reveal. |
| `pins.json` | The sandbox's accounts, pool and the strategy's code hash as recorded. |

## Which code made them

- Contract and sandbox recorder: commit `0f6fd99` on `backend/s8-open-position` (run 4, 14 Nov 00:52 to 01:55 UTC).
- Agent: the entry point and loop at commit `cba9411` (record text is never logged, publication after
  `released()`, `rules_hash` checked against `RULES_FILE`, held store 0700/0600).
- **Not in the recorded run:** `302e7dd` (the agent stalls instead of retrying for ever). It changes only
  what the agent does after a *refused or failed* swap or open; neither run had one.

The sandbox's `agent.log` and the agent's `stdout` are **not** part of the fixtures and are never
committed: during a run they would show when decisions were made. The rules used here are throwaway.

## Size and gaps

About 18 MB per file (1,697 sampled blocks, 49,174 responses; the two providers hold the same content, git packs the set to a few MB). The last sampled blocks of the run (6 checkpoints from 29,240 to 29,920) could not be read because the sandbox had already dropped them; the good run's samples end at block 29,391 (after `close`, `settle`, `reveal` and the claims) and the no-agent-close run's at 29,948. Records: `1096118c...` is the open decision (the swap and its paired open share it; both runs, same state), `3eece1c9...` is the good run's genuine time close.

## Re-recorded: no-agent-close (run 5, 14 Nov 02:15 to 03:20 UTC)

The no-agent-close world was recorded again alone (`ONLY_BAD=1 BAD_WAIT_S=4500`), so the stretch after the due close is about 15 minutes (the creator's `exit_remove` came 4,490 s after the swap) instead of about 2. Its decision hash is `7fd0dca4...` (its own swap observation), in `records/`; the good run's records are unchanged. 1,814 sampled blocks (170 to 36,330); three late checkpoints (36,260 to 36,320) were unreadable.

## Open items (not done, carried to the pre-mainnet list)

- One hardened RPC path for `head()`/`blockTimeNs` in `apps/agent/src/real.ts` (timeout, `redirect: "error"`,
  size cap, BigInt timestamps); `localdeps.ts` is a second, simpler copy.
- EC-A06: a test that scans the agent's logs for key material.
- The agent mutant sweep (36 of 60 survivors), including `real.ts` coverage.
- T80: gas margins measured with the action log at 60 records.
- Contract (accepted under D52, THREAT_MODEL T82, T83): an event index can be reused after a failed exit's record is dropped; a failed remove that opens the settle window leaves no record.
- Rules (THREAT_MODEL T84, T85): pairing is implemented in four places; hash-used-once is not in the shared verifier function.
