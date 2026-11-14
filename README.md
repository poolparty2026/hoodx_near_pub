# hoodx on NEAR

**Commit an LP strategy's rules by hash, and check at close whether the agent kept to them.**

(What exists today: a check, within the limits listed below, of whether an agent kept to rules committed by hash (private until revealed), on hand-made runs and sandbox recordings only. Viewing keys are written for testnet and tested end to end in a local sandbox by script; they have not been run on testnet or mainnet.)

hoodx on NEAR is an autonomous LP agent on Rhea (NEAR). A creator commits to a set of rules by posting only their hash and an encrypted copy. An agent is meant to manage one liquidity position inside limits the contract enforces (trading is still being finished). After the strategy closes, the creator, or anyone once it is closing, can call the contract's `reveal`, which accepts the rules only if they hash to the commitment (built and unit-tested; no live strategy has used it). The check page is built to compare each action with the revealed rules from public data. Today it does that on hand-made runs and on sandbox recordings only, and it does not read a live strategy.

This is an entry for the NEAR hackathon (Build Beyond Boundaries). It is a hackathon build, not a finished product.

## Status

What the repository contains, and what each part has been run against. This list is the source for any public text; if a line here is not true, the text is wrong.

| Part | State |
|---|---|
| Strategy contract (`contracts/strategy`) | Built in slices; unit tests run with `cargo test -p strategy`; the sandbox tests live in the separate crate `contracts/strategy-sandbox` and run through `contracts/strategy-sandbox/run.sh`. Trading, exits and claims are still being finished; see `docs/MINIMAL_PLAN.md` section 8 for the board. |
| Rules library (`packages/rules`) | Built and tested. The agent (`apps/agent/src/loop.ts`) and the check page (`apps/web/src/lib/run.ts`) both import the rules package and share one decision-record format and chain link. The agent's own records have been through the page once, in the recorded sandbox runs below (run 4, a real agent process against a local sandbox); never against mainnet. |
| Agent (`apps/agent`) | Decision loop, decision log and a chain adapter, tested against fake reads, and run once as a real process against a local sandbox for the recorded runs (run 4, commit `cba9411`); the swap and its paired open and the close it sent were checked by the page. Never run against mainnet. |
| Check page (`apps/web`, `/check/[strategy]`) | Built and tested on **hand-made sample runs** and on the backend's **recorded sandbox runs** (one node, read twice). It does not read a live strategy; any other id shows "Unverifiable" and says nothing was checked. |
| Recorded sandbox runs (`fixtures/scenario/`) | Runs 4 and 5 (run 5 re-recorded only the run without an agent close): a good run, a tampered-rules run and a run without an agent close, recorded from the contract on a local sandbox with the real Rhea DCL code and a real agent process, with the agent's decision texts (`records/`), block headers, account snapshots (`view_account`, `view_access_key_list`) and `pins.json`, sampled every 20 blocks. The recordings do not show the creation block, so the account row stays Unverifiable. |
| Viewing keys (`contracts/strategy`, `apps/deliverer`, `packages/seal`, `/follow/[strategy]`) | Written for testnet and tested end to end in a local sandbox by script (buy, delivery by the deliverer, open, hash match; and refund). The follow page is built and unit-tested; it has not been run end to end on testnet or mainnet, and no strategy with key sales exists on either. The deliverer is a single account the buyer has to trust (see the limits below). |
| Mainnet | **No strategy has run on mainnet.** Any mainnet transaction is a script a person reviews and runs. |

## What the check page checks

For a strategy that has closed, the page is built to read each view from two independent providers. If they disagree, or one fails, the row is "Unverifiable", never "Matching". The recorded sandbox runs come from one node read twice, and the page says that on the run.

1. The strategy's status, and whether the rules were revealed. Not revealed shows "Unverifiable: not revealed".
2. The revealed rules hash to the commitment made at creation.
3. Each action the agent took, refused ones included. The published decision record must hash to the value the agent committed on chain, be made for this strategy under these rules, and give the decision the rules give for its state. The page rebuilds that state itself from the chain's views at the observed block (a close's confirmation too, and the 20-block grid between) and requires the record's state to equal it; the action must be within the rules. A refused action that was never retried is not matching (a refused close is judged by the missed-close check), and a decision hash may be used by one recorded action only (a swap and its paired open excepted). Where views or texts are missing, the row is Unverifiable.
4. No close was missed at the sampled blocks: the page reads the run at the first height of every 20-block window (the recordings carry those heights) and runs the rules on each sample. It cannot see a condition that comes and goes between two samples, and it reads one height per window where the rules' `gridPoint` would look at all twenty. A close still due when the run ended before the late-close allowance ran out reads Unverifiable, never "no close was missed"; one due for longer than the allowance is a missed close.
5. No change to the account's keys or code at the sampled blocks, the code hash equals a pinned hash when one is published, and the DCL contract, quote token and pool equal pinned constants.

The verdict for a run is its worst row: Not matching, then Unverifiable, then Matching.

**Valuation.** Stop loss and take profit value the strategy's holdings at the pool's spot point at each observed block, with no anchor or average. A close also needs the condition to hold at two observations and at the grid blocks between them. The page cannot check that spot is a fair price: a price moved across the whole confirmation span would pass. The confirmation rule is built provisionally, not settled (`docs/MINIMAL_PLAN.md` section 3).

**Not checked in this version** (also shown on the page): that the deployed code is a reproducible build of the audited commit, that the account was created in a single creating transaction, that principal equals the sum of the funding events, that the fee split followed the stated percentages, refusals by public limits beyond showing them as context, the decision-log chain when records carry no chain heads, the creation block and the agent's history (the recorded runs supply a stand-in creation block and stand-in pins), and anything that happens between two samples.

## Try it with no funds

You do not need a wallet, tokens or a NEAR account.

Needs Node 22 or newer (tested on Node 22.23) and pnpm 10 (`corepack enable` picks the version in `package.json`).

```sh
pnpm install --frozen-lockfile
pnpm --filter web exec next typegen     # once, on a fresh checkout
pnpm --filter web dev                   # development, http://localhost:3000
# or a production build:
pnpm --filter web build
pnpm --filter web start                 # http://localhost:3000
```

Run `pnpm --filter web start` from the repository (it runs inside `apps/web`); the sandbox recordings are read from `fixtures/scenario/` two folders up, or from the folder in `SCENARIO_DIR`.

Then open:

- `/check/scenario-good`, `/check/scenario-bad-tampered-rules`, `/check/scenario-no-agent-close`: the backend's recorded sandbox runs (runs 4 and 5, made by the real agent against a local sandbox; one node, read twice, ~1 hour each). The good run reads **Unverifiable** overall and only because the creation block cannot be established from chain data: its status, rules, the agent's three actions (a swap, its paired open, and a genuine time close), the decision-log chain, the missed-close sampling, the code hash and the pinned counterparties all read Matching. The tampered-rules run is **Not matching** on the rules row. The run without an agent close (run 5) reads **Not matching** on the missed-close row, from the page's own sampling: the time close came due at block 28,940, the agent never sent it, and the creator's exit removal ended the run about 15 minutes later (block 36,240); every other row that can be established reads Matching. Pins (`pins.json`) are the sandbox's own constants, written by the same recording: the code-hash and counterparty rows say so, and are not an independent pin. A missing record file in a recording reads Unverifiable, because one source cannot show that something was never published.

- `/check/fixture-good`: a hand-made run (not a recording) where every row matches.
- `/check/fixture-tampered-rules`, `/check/fixture-missed-close`, `/check/fixture-code-changed`, `/check/fixture-tampered-decision`: runs that do not match.
- `/check/fixture-not-revealed`, `/check/fixture-providers-disagree`: runs that are unverifiable.
- `/sample`: the same kind of screens with Hoody's moods.

The `fixture-*` runs are **made by hand**: not recordings of a chain and not a real strategy; each page says so. The `scenario-*` runs are recordings of a local sandbox, not of a live network. Run the tests with `pnpm -r test`, `cargo test -p strategy` (unit tests) and `contracts/strategy-sandbox/run.sh` (sandbox tests).

## Claims we make, and the evidence

| Claim | Evidence |
|---|---|
| Rules are committed by hash; the contract stores only the hash and the encrypted rules (`reveal` checks the hash: `contracts/strategy/src/contract/reveal.rs`, `tests_reveal.rs`) | Contract `new`; `docs/ARCHITECTURE.md` sections 4 and 5.3; `cargo test -p strategy`. No transactions have been run on mainnet |
| The contract refuses actions outside its public limits | Refusal tests in `contracts/strategy/src/contract/tests*.rs` and `src/limits/tests.rs`, most naming an edge-case ID from `docs/security/EDGE_CASES.md` |
| The check page and the agent share the rules, the decision-record format and the chain link | `packages/rules/src/decision.ts` is imported by `apps/agent/src/loop.ts` and `apps/web/src/lib/run.ts`; vectors in `packages/rules/test/vectors/decision-record.json` |
| The check page never shows "Matching" when providers disagree or data is missing | `apps/web/test/run.test.ts` (EC-W05 missing records, EC-W08 providers, EC-W09 not revealed, EC-W28 unreadable samples) |

## Claims we do not make

- We do not say the agent makes money or beats the market. A run can lose money and still match its rules.
- We do not say positions are hidden. Rhea positions are public; what is private is the rules, until they are revealed.
- We do not say anything about anonymity. Public positions leak part of the rules once a wallet is linked, and the strategy wallet is visible on Rhea, so privacy depends on what links it to a person.
- Anyone who holds a viewing key can copy or pass on the rules; a key cannot be restricted. (Viewing keys are written for testnet and tested in a local sandbox only.)
- We do not say anything about agent volume.
- Telegram alerts are **not in this version** (`docs/MINIMAL_PLAN.md` section 2). Viewing keys: written for testnet and tested end to end in a local sandbox by script; not run on testnet or mainnet. The contract holds the buyer's payment in escrow and pays the creator when the deliverer sends a key. The deliverer is a single account the buyer has to trust: it can send a well-formed key that does not open the committed rules, and after delivery there is no refund. We make no claim about either beyond that.
- No fee percentage is stated here or shown on any page (`docs/gates/5-fee-split.md` is accepted for now; this README does not rely on it).

## What a real run needs

Decision records are published only after the reveal (from the strategy's closing), so while a run is live the page shows them as "not published yet" and that is no verdict against the agent. A real run needs **published hosts for the agent's decision records**: plain files at `<base>/<decision_hash>.txt`, each holding exactly the decision record, with the base URLs set in `RECORDS_BASE_URLS` (comma-separated). The hosts are not trusted: the check page accepts a file only if its SHA-256 equals the hash the contract recorded. **One host cannot convict.** A record counts as "not published" (not matching) only when at least two configured hosts agree that it is missing, or serve the same wrong file. With no host, one host, or hosts that disagree, the row is "Unverifiable", so the creator should publish to two hosts. A host that can't be reached is also "Unverifiable". No host is configured by default and no hostname has been chosen yet, so today the page can only show recorded runs.

## Name

"hoodx on NEAR" has not been cleared as a name; no trademark check has been done.

## Layout and process

See `CLAUDE.md` for the layout, commands and rules, `docs/ARCHITECTURE.md` for the design, and `docs/security/` for the threat model, edge cases and audit log. This code was rebuilt from scratch for the hackathon.
