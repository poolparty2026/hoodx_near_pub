# Code audit: `packages/rules` v1 (be41588..0566765)

Three fresh auditors on the diff only (D52): `security-auditor`, `test-auditor`, `rules-verifier`. The fixes are in the next commit; a targeted re-audit of each follows.

| Finding | Resolution |
|---|---|
| Rules-verifier H-1: with confirmation, `requiredAction` no longer reports an unconfirmed close, and the page's sparse samples can never confirm one, so a missed stop loss can't be found | **Fixed:** `closeDue` (due without confirmation), `missedClose` (the dense-sampling rule over the page's samples, in blocks and in timestamps), `DENSE_STEP_BLOCKS`; `requiredAction` documented as not for missed closes |
| Test H-1: no swap-floor function or EC-R27 floor vectors | **Fixed:** `swapFloor` in `src/floor.ts`, `test/vectors/swap_floor.json` (21 cases: quote-based, reference-based, ties, rounding, slip 11 and 100 with fee 1, other tiers, both directions, 0 and `u128::MAX`), `check_swap_floor.py` in CI, properties |
| Security M-1: `O1` kept across a change of condition and a latched retry | **Fixed:** `nextConfirmRun` carries the reason and restarts on a change except to time; a latched retry is confirmed on the latch (EC-W22 says so) |
| Rules-verifier M-1: no shared function checks the confirmation chain | **Fixed:** `checkConfirmation` replays the agent's observations from `O1` to `O2` |
| Test M-1: the exact-floor property was circular | **Fixed:** property against the exact rational price with bigints, both paths; section 4's excess wording corrected |
| Test M-2: missing conversion vectors and one-path properties | **Fixed:** `baseToQuote` vectors at the live point and `u128::MAX`, round trips of 1 and 500,000,000, properties over both paths and the full point range |
| Security L-1: an `O1` made unsettled by a later payout | **Fixed:** `nextConfirmRun` takes `settledFromBlock` and restarts below it |
| Security L-2: observations further apart than `CONFIRM_MAX_BLOCKS` never confirm | **Fixed in the spec:** ARCHITECTURE 7 requires the agent to observe within it and alert otherwise (EC-A11) |
| Security L-3, test L-4: the section 4 example was refused as written | **Fixed:** `rebalance` removed from the example, a real salt, the test parses the documented example as written |
| Security L-4: as test M-1 and M-2 | Fixed with them |
| Test L-1: `O1` inside the margin untested anywhere | **Logged** as EC-A11 for the agent |
| Test L-2: the saturation boundary mis-stated | **Fixed:** tested at the exact limit and one above |
| Test L-3: partly exercised branches | **Fixed:** an open with a position during confirmation, a latched close waiting, `block` at `MAX_SAFE_INTEGER` and one above |
| Rules-verifier L-1: the schema changed without a version bump | **Accepted:** v1 was pre-release until this commit; nothing is deployed, committed or encrypted under the old form; the only pinned vector (the reference hash) was updated and checked with `sha256sum` |
| Rules-verifier L-2: a restart moves `O1` to the current observation, not a later earlier one | **Accepted and stated:** the restart is at the latest true observation, which is the current one; pinned in `confirmation.json`; costs at most one margin and only when observations are more than about 360 blocks apart |
| Rules-verifier L-3: `isPairedOpen`'s inputs | **Fixed:** the record fields are named in its comment; nanosecond boundary vectors in `confirmation.json` |
| Rules-verifier L-4: the timing constants are proposals | **Tracked** (5.11): the contract exposes them in a view and the page refuses a mismatch as "can't check" |
| Rules-verifier: shared vectors for the Rust port | **Fixed:** `confirmation.json` (ten walks, five pairing cases), `swap_floor.json` |

## Targeted re-audits of the fix (`0566765..dd45871`)

Security: block (H-1, 3 Medium, 4 Low). Test: block (4 Medium, 6 Low). Rules-verifier: 2 Medium, 4 Low. All earlier findings fixed except the missed-close rule, where the security re-audit found a new High in the same mechanism; under D52 Erik chose the simplification (D53).

| Finding | Resolution |
|---|---|
| Security H-1, verifier M-1: one excused sample resets a stretch, so a helper of the agent's hides a missed stop loss | **Fixed by D53:** no excuses; nothing sent ends a stretch |
| Security M-1, verifier M-2: an honest agent waiting out its interval is blamed | **Fixed:** the anchor is when the agent could first act (last lock + interval, 24-hour slot); the allowance is in blocks and in `MISSED_CLOSE_GRACE_S`; honest-agent property with a binding interval at three block rates |
| Security M-2: `checkConfirmation` judged the agent's chosen observations only | **Fixed:** it takes the page's own samples between O1 and O2 |
| Security M-3: a refused close ended the stretch | **Fixed:** only successful closes are passed |
| Test M-1 to M-4: thresholds, gaps, condition change and the latch not tested at the limit | **Fixed:** exact-limit tests in blocks and seconds, gaps, a monotonic-time condition change, the latched stop loss |
| Verifier L-1: expected O1 and O2 not enforced | **Fixed:** `o1Block`, `o2Block` inputs |
| Verifier L-2: a refused close inside the margin threw | **Fixed:** a verdict |
| Verifier L-3: a close needs a sample at its O2 | **Fixed:** required, refused otherwise |
| Verifier L-4: vector gaps and the note | **Fixed:** three more walks; the note corrected; the contract's own span checks stay in EC-C131 |
| Security L-1: stop loss and take profit alternating restart each other | **Accepted:** a stretch ends on such a change too, so the page doesn't blame it; the time condition still closes the run |
| Security L-2: samples between O2 and the result block | **Fixed:** covered by the close |
| Security L-3, test L-6: stale names in the edge cases | **Fixed** |
| Security L-4, test L-4: no `checkConfirmation` test of a latched retry | **Fixed** |
| Test L-1 to L-3, L-5: latch priority, a one-sample landed close, a repeated block, weak properties | **Fixed:** tests and a dishonest-side property; EC-W24 for timestamps |
| Verifier Info: ARCHITECTURE wording | **Fixed:** the span applies to every close; EC-W22's reading stated |

## Targeted check of the D53 fix (`dd45871..c53a8fd`)

Security: fix before merge (3 Medium, 4 Low); the earlier High and Mediums fixed. Test: block (3 Medium, 4 Low). Fixed in the next commit:

| Finding | Resolution |
|---|---|
| Security M-1: stop loss and take profit alternating ended each stretch, hiding a miss for hours | **Fixed:** a change of condition continues both the stretch and the confirmation run (D53); the six-hour alternation is missed |
| Security M-2: page samples the agent can't know | **Fixed:** the grid is fixed by the rule (`confirmGrid`), required, and read by the agent before it closes |
| Security M-3: section 8, 5.11, EC-W20 and EC-W21 still excused closes | **Fixed:** each says a due close is judged by `missedClose` alone |
| Security L-1: `pageSamples` optional | **Fixed:** required |
| Security L-2: a lock in the gap before the stretch moved the anchor | **Fixed:** only locks strictly before the last not-due sample (or the first sample) count |
| Security L-3: the agent's real false readings off the grid | **Fixed:** the page passes the agent's logged observations as samples too |
| Security L-4: D53 sign-off; the 24-hour edge against the contract | **Open:** Vipasana's sign-off before merge; the edge vector goes to EC-C131 with the contract |
| Test M-1: the page-sample window at one block only | **Fixed:** grid blocks next to `O1`, in the middle and next to `O2`, in both orders; a time close with the grid |
| Test M-2: anchors not at the limit | **Fixed:** exact to the block after a lock and after a freed slot |
| Test M-3: a stretch ending before the agent could act | **Fixed** |
| Test L-1: the 24-hour window | **Fixed:** too many locks refused; the 24-hour edge tested |
| Test L-2: loose EC-W23 items | **Fixed:** locks every `T − 20`; the misnamed test renamed; EC-W25 for the page's filtering |
| Test L-3: EC-W24 in `checkConfirmation` | **Fixed** |
| Test L-4: no verdict vectors for the two functions | **Accepted** while both callers are TypeScript (one build) |

## Targeted check of `c53a8fd..93b6440`

Security: fix before merge (1 Medium, 1 unverified Medium, 1 Low). Test: block (3 Medium, 3 Low). Fixed in the next commit:

| Finding | Resolution |
|---|---|
| Security F1, test F3: the lock cutoff ignored an honest agent's own open lock, so it was blamed for waiting out its interval | **Fixed:** locks carry their kind; an `agent_swap` or `agent_open` lock at or before the stretch's first sample counts (in v1 it needs no position held, so it is always before a stretch); a close attempt never moves the anchor; EC-W26 |
| Security F2 (unverified): the grid needs states at exact heights | **Fixed in the rule:** a window's state is taken at the first existing block in it; a window with no block at all can't be checked (disclosed; a mainnet scan for skipped heights is a 5.11 item) |
| Security F3: the agent's choice of logged observations could end stretches | **Fixed:** grid samples only, one per window, for both functions; the agent carries its confirmation over the same grid, so its observations off the grid count for nothing |
| Test F1: the grid check could be weakened to a count | **Fixed:** states before, at the end of and outside a window, doubled and missing windows are refused; the mutant is killed |
| Test F2: the freed-slot anchor not exact | **Fixed:** samples one block either side of the anchor; the `+ 86_399` mutant is killed |
| Test F4: the alternation's reason unchecked | **Fixed:** exact reason, at two end points |
| Test F5: EC-W25 untested | **Tracked** for `apps/web` |
| Test F6: no second-language check of `confirmation.json` | **Accepted** (as before) |

## Targeted check of `93b6440..ec9d27b`

Security: fix before merge (2 Medium, one unverified; 2 Low). Test: block (3 Medium, 5 Low). Fixed in the next commit:

| Finding | Resolution |
|---|---|
| Security 1 (unverified, High if heights are skipped): an agent-chosen O2 next to a skipped grid height turned a forged close into "can't check" | **Fixed:** O1 and O2 are judged first; the grid sits at exactly the window starts, and a height with no block has the state after the latest block below it, so nothing throws. Measured: no skipped height in 2,000 consecutive mainnet heights (`docs/gates/3`, Part E) |
| Security 2: one sample per window against EC-W21's "next settled block", so a payout window could make `missedClose` throw | **Fixed:** `gridPoint` (the start if settled, else the first settled height in the window, else no sample); EC-W21 rewritten; a payout over two windows gives gaps and the stretch is still missed |
| Security 3: "first existing block" not pinned | **Fixed:** `gridPoint` is the one helper; the confirmation grid is exact |
| Security 4: a counterparty failure of a close stamps the interval | **Disclosed** under T71 |
| Test G1: close attempts inside a stretch could fill the 24-hour count | **Fixed:** six refused closes inside a stretch, the mutant killed |
| Test G2: the O2 cap on the last window | **Moot** (exact grid); states at and past O2 refused |
| Test G3: the last of a swap and an open | **Fixed:** tested, the honest property now has a swap before the open |
| Test G4: a lock at the first second filling the count | **Fixed** |
| Test G5: doubled samples around a close's O2 | **Fixed** |
| Test G6: EC-W26 not named | **Fixed** |
| Test G7: the property one-directional | **Fixed:** also refuses from a block where the walk had restarted |
| Test G8: the 24-hour edge comment | **Fixed** (noted where the edge is pinned) |

## Targeted check of `ec9d27b..d32edd7`

Security: **pass** (0 Critical, High or Medium; 2 Low). Test: fix before merge (1 Medium, unverified; 5 Low; 1 Info). All fixed in the next commit:

| Finding | Resolution |
|---|---|
| Test F2 (Medium, unverified), security L-1: `gridPoint` read settled-from at the window start only, so a callback or a lock inside the window could leave the chosen height unsettled | **Fixed:** `gridPoint` takes each height's quiet flag and settled-from block and returns the first height that is quiet and at or after its own; EC-W27 |
| Security L-2: no honest-agent case with a payout window inside a stretch | **Fixed:** a fixed case where the agent restarts after an outsider's payout window and the page has gaps |
| Test F1: the reverse property was vacuous | **Fixed:** its own property, a false grid state at a random window refused at exactly that block; the "replay tolerates a null run" mutant is killed |
| Test F3: EC-W21 not named | **Fixed** |
| Test F4: the payout-window test's assertion weak | **Fixed:** the exact sample list |
| Test F5: `gridPoint` at 0 and the maximum | **Fixed** |
| Test F6: doubled grid states | **Fixed** |
| Test F7: no skipped-height fixture | **Tracked** in EC-W22 for `apps/web` and `packages/near` |

## Targeted check of `d32edd7..3e9e97a`

Security: fix before merge (1 Medium, unverified for High; 1 Low). Test: fix before merge (5 Low, 1 Info). Fixed in the next commit:

| Finding | Resolution |
|---|---|
| Security M-1: the agent's own locks could empty every window after a due condition and leave a one-sample stretch ("can't check") | **Fixed:** `missedClose` takes the end of the judged range; a stretch followed by gaps is measured to the next sample or to that end; an interval ending inside the gap counts seconds from that moment |
| Security L-1, test L-1: the honest payout-window test couldn't fail | **Fixed:** at exactly the allowance nothing, one block past it a late close (gaps count, T71) |
| Test L-2: settled-from bounds | **Fixed:** -1, -0, past the maximum and a string, exact message |
| Test L-3: window start at its maximum | **Fixed:** `MAX_WINDOW_START`, tested at it and one window past |
| Test L-4: wrong length, null reading | **Fixed** |
| Test L-5: later readings unchecked | **Fixed:** every reading validated before one is chosen |
| Test Info: no gridPoint property | **Fixed** |

## Targeted check of `3df214f..b430bd6` (trailing gaps)

Security: fix before merge (1 Medium, unverified for High; 3 Low). Test: block (1 Medium; 3 Low; 1 Info). Both found the same Medium independently. Fixed in the next commit:

| Finding | Resolution |
|---|---|
| Security M-1, test M-1: when the agent could first act inside a trailing gap, blocks were counted from the last due sample, so an honest agent inside its 410-block allowance could be called missed (less evidence gave the harsher verdict) | **Fixed:** `MissedCloseLimits.clock`; the page reads the first block at or after that moment and the allowance counts from it exactly; refused `STATE:` if it is needed and missing; the probe case is "can't check", tests at the block limit and one past it, a property with random trailing gaps; the old fallback as a mutant is killed |
| Test L-2: the one-empty-window boundary | **Fixed:** an empty window, and an off-grid last sample one and two windows before the next |
| Test L-3: the fallback only with one sample | **Fixed:** a multi-sample stretch |
| Test L-4: end-of-range bounds | **Fixed:** full messages for both fields; exactly the last sample accepted |
| Test Info, security L-3: EC IDs on the new tests | **Fixed** (EC-W23, EC-W27) |
| Security L-1: the page's inputs unchecked | **Tracked** as EC-W28 for `apps/web` and `packages/near` |
| Security L-2: a finding's end block can be one where nothing was due | **Disclosed** in T71; the page shows "not observable after" the last due sample |

## Targeted check of `e31b6e6..8e5f637` (the clock point)

Security: fix before merge (1 Medium, 3 Low). Test: block (2 Medium, 2 Low, 3 Info). No Critical or High. Fixed in the next commit:

| Finding | Resolution |
|---|---|
| Test T-1, security M-1: the clock point untested for a gap inside a stretch and a late close (mutants M7, M8 survived; M8 hid a late close) | **Fixed:** both at the allowance and one past it; the missing point refused |
| Test T-2, security M-1: choosing among several clock points untested (M1, M2, M3 survived) | **Fixed:** six points, the first at or after the moment used; a point only past the anchor refused |
| Security L-1: a later clock point was accepted as exact | **Partly fixed** here (any earlier entry sufficed); completed in the next round: the pair must be adjacent heights |
| Security L-2, test T-5: clock points not cross-checked | **Fixed:** clock, samples and the end merged by block; a second timestamp for a block or a decrease refused |
| Test T-3: one empty window for the clock rule (M5 survived) | **Fixed** |
| Test T-4: a sample at the moment, blocks in the same second (M13, M14 survived) | **Fixed** |
| Security L-3, test T-6: docs narrower than the code | **Fixed:** ARCHITECTURE, the comments, EC-W27 and EC-W28 say any gap of more than one window |
| Test T-7: the property narrow | **Partly:** the property now carries the clock pair; the gap-inside-a-stretch and block-rate cases are fixed examples. A wider property is tracked |

All eight surviving mutants (M1, M2, M3, M5, M7, M8, M13, M14) are killed by the new tests.

## Targeted check of `8e5f637..977631e` (the clock cross-check)

Security: **pass** (2 Low). Test: block (1 Medium, 3 Low, 1 Info). Both found that the L-1 fix was incomplete: any earlier clock entry satisfied it, so a later point could still hide a miss. Fixed in the next commit:

| Finding | Resolution |
|---|---|
| Test M-1, security L-1: a later clock point accepted when any earlier entry exists | **Fixed:** the pair must be adjacent heights, the first before the moment; a skipped height between them is refused ("can't check"); the probes `[2000, 4900]`, `[900, 4900]` and `[4588, 4590]` refused, the honest pair gives the exact verdict |
| Test L-1: the `nowS >= from` half was dead | **Resolved:** with adjacency both conditions matter |
| Test L-2: two cross-check branches untested | **Fixed:** a smaller second timestamp, the end block, a clash in the first pair |
| Test L-3: the seconds origin untested | **Fixed:** a slow block after the moment; the docs say blocks from the clock point, seconds from the moment |
| Security L-2, test I-1: no two-gap fixture or wider property | **Tracked** with T-7 |
