# Last audit round, 14 Nov 2026, 871fe8d..eddcad5. No Critical or High.

## Agent, INTERFACE.md, THREAT_MODEL, AUDIT_LOG (security-auditor)
Agent tests 54 pass. 0 Critical, 0 High, 4 Medium, 5 Low.
- agent: redact drops decision.kind (safety.ts:12-15, T78 test safety.test.ts:24-31); chain-count test (chain.test.ts:137) catches the four mutants. Low: no case for a refused non-open kind; MAX_OPEN_TRIES boundary untested through round(); paging past 20 records untested; residual log signal while Running (loop.ts:86,100,104: "outside the rules: <reason>" naming a close, sent.method agent_close_position) - narrow T78 text to normal paths or withhold reason while Running. Medium carried over: main.ts wiring untested (agent M3), ROUND-6 style test names.
- INTERFACE.md:160 Medium: "no head -> unverifiable chain row" false; run.ts:439-441 adds the row only when chained.length>0 (NotChecked.tsx:10). A compromised agent sending no chain_head gets no chain row. records-host.test.ts:136 asserts no row.
- INTERFACE.md Medium: no statement that verdicts are over a recording (README:5 has it). Low: `unreadable: true` is on verifyRecordTextOnly (decision.ts:125) not ChainVerdict; :158 clock source still a guess; EDGE_CASES.md:213 EC-R31 names removed verifyDecisionRecord.
- THREAT_MODEL Low: no rows for web M1 (pins from recording), web M2, recording provenance, no-heads; T78 still "Mitigated" with residual log signals; T76-T85 column mismatch.
- AUDIT_LOG Medium (fixed in this commit): counts 9/28 understated (real 14/32); duplicates of three rows; not newest first. Dispositions: agent M1 fixed, agent M3 and INTERFACE M-1..M-3 not yet accepted or routed.

## Web (security-auditor, apps/web fixtures contracts/strategy-sandbox)
web tests 288 pass. 0 Critical, 0 High, 2 Medium, 3 Low.
- Confirmed: missing record file -> Unverifiable (scenario.ts readRecordFile, run.ts actionRow ~210); wrong-hash body still Not matching; no-agent-close verdict from generic path checkRun -> windowsFromViews -> checkMissedClose -> rules missedClose (windowViews:true for every recording, no per-scenario branch); sha256 of records/7fd0dca4...096e.txt equals filename and the decision_hash in both sandbox-a and -b recordings; creationOk gate run.ts:375 unchanged.
- M1: the only test of the run-ended-inside-allowance downgrade (run.ts:485-491) was removed with the old EC-W23 test. M2: windows.test.ts has no equality/+1 cases for windowsFromViews (floor/ceil on 20, last<first, settledFrom>w, k===0, 16-window batching, failed ExitRemove endOf).
- Low: EC IDs only at describe level; pins from the recording's own pins.json still read matching (pinsNote discloses); dead statements and tmp dirs in tests.

## Claims (claims-checker)
0 High. Medium: docs/MINIMAL_PLAN.md:110 (and :111, :113) still says the end-to-end run is not done, contradicting README:18-19 (fixed), fixtures/scenario/README.md:23-26, DEMO_SCRIPT.md:30. Low: README:21 and :59 run numbering (no-agent-close is run 5); README:19 should disclose that agent change 302e7dd was not in the recorded runs. Optional: strategies.ts:30,33 sample "Heartbeat". All claim limits otherwise clear (no profit, anonymity, key-sharing, unstoppable, volume, fee split number, Shade Agents, prove/proof; viewing keys and following marked not built; spot valuation and one-host/recorded limits disclosed). README:101 old tagline note must not be public.
