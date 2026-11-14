# Design re-audit 2, 5 November 2026

- **Scope:** revision 3 (commit `7bfcf5a`). Checked: the status of N1 to N19 and the open first-audit items, a fresh audit, and consistency across documents.
- **Auditor:** `security-auditor`, a third fresh instance. Read-only. No tests run, because there is no production code.
- **Verdict:** **block.** New findings: Critical 1, High 5, Medium 7, Low 4.

## Status of earlier findings

| Status | Findings |
|---|---|
| Resolved | N1, N2 (with a caveat, see R12), N5 (in design), N6, N8, N9, N10, N13, N15, N16, N18, N19, H1 and H5 (in design), M2, M9, L2 (documented), L6, L8 (in design) |
| Partly resolved | N3, N4, N7, N11, N12, N14, N17, C1, C2, M1 |
| Not resolved | M10 (USDC freeze powers) |

## New findings

All of these are addressed in revision 4 (commit after `ce92029`), with lead decisions D13 (payouts in held tokens) and D14 (outbound-only alerts). Awaiting re-audit.

| ID | Severity | Finding |
|---|---|---|
| R1 | Critical | Settlement can't happen without the agent or creator. Settling in kind needs failed exit swaps, which only they can make, and outsiders can keep adding non-quote balances |
| R2 | High | The anchor freezes after a price move larger than the allowed deviation, so a stop loss and every exit swap are refused for good |
| R3 | High | A patient attacker can walk the anchor with tiny successful actions, so it doesn't bound manipulation |
| R4 | High | Settlement in kind values fees at the stale anchor, so cuts can come out of principal |
| R5 | High | `sweep` racing with `claim` double-counts tokens |
| R6 | High | `sweep` of arbitrary tokens can make every claim run out of gas |
| R7 | Medium | `deliver_key` after a refund gives the buyer the key for free; the statuses for delivery and refund aren't stated |
| R8 | Medium | One anchor for up to two pools; a pool without the quote token has no way back |
| R9 | Medium | `start` can race with `cancel` |
| R10 | Medium | `ActionRecord` lacks amounts out, position id, result block and operation id, so the check page needs the indexer |
| R11 | Medium | Several config fields and limits have no bounds |
| R12 | Medium | What refusal and `resolve_stale` do to the interval, the counts and the reservations is undefined |
| R13 | Medium | Two rounding rules and two close rules across the documents |
| L1 | Low | Stale section references and wording (line 55 "same process", gate 3, D9, the plan, EC-C30, SECURITY_PROCESS line 8, section 13) |
| L2 | Low | Swap output returned to DCL after `resolve_stale` could be lost |
| L3 | Low | The demo refusal may arrive as a callback event, not a `LIMIT:` panic |
| L4 | Low | The creator's exit swaps can't carry an attestation |

## Unverified

- Whether a third party can credit the strategy's Rhea internal balance.
- How swap output arrives.
- `get_pool` in a callback.
- How points convert to price.
- Whether Rhea has a time-weighted price.
- How liquidity calls and their minimums work.
- Which archival providers and indexers exist.
- The worst-case receipt delay.
- USDC freeze powers.
- Whether an allowance can be raised in place.
- NRAS expiry.
