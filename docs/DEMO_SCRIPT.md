# Demo script (draft for the claims-checker and a co-lead)

About three minutes. It shows only what exists. Everything on screen is hand-made or a sandbox recording, and the narration says so. No mainnet strategy, no viewing keys shown, no fee numbers, no profit claim.

## Before you start

```sh
pnpm install && pnpm --filter web exec next typegen && pnpm --filter web dev
```

Open `http://localhost:3000`. No wallet, no tokens.

## 1. The idea (20 s)

On the home page. Say: "hoodx on NEAR is an autonomous LP agent on Rhea. The creator commits to the rules by hash. The agent is meant to manage one position inside limits the contract enforces; trading is still being finished. After close, the rules are revealed, and the check is built so that anyone can check, within the limits listed on the page, whether the agent followed them. Today that works on hand-made runs and sandbox recordings only." Do not say the agent makes money. Do not say positions are hidden.

## 2. A run that matches (40 s)

Open `/check/fixture-good`. Point at the sample banner: "This run is made by hand, not read from a chain." Show the rows: status, rules match the commitment, each action, no missed close at the sampled blocks, the account's keys and code, the code hash, the pinned counterparties. Say: "Matching means every one of these checks passed on this data, and nothing more." Show the "Not checked in this version" list, including the valuation line: "Stop loss and take profit value positions at the pool's spot point, the page cannot check that value, and a price moved across the whole confirmation window would pass."

## 3. Runs that do not match (60 s)

- `/check/fixture-tampered-rules`: "The revealed rules do not hash to the commitment. Not matching, and nothing is judged against them."
- `/check/fixture-missed-close`: "A close was due and not sent. The page names the blocks."
- `/check/fixture-code-changed`: "The account's code changed between two blocks."
- `/check/fixture-not-revealed`: "No reveal means Unverifiable, never Matching."

## 4. The backend's sandbox recordings (40 s)

Open `/check/scenario-good`. Point at the label: "Recorded sandbox run on one node, read twice. Not two independent providers, not a mainnet strategy." Say plainly: "This run was made by a real agent process against a local sandbox. The page rebuilt each action's state from the chain's views and checked the agent's published records: the swap, its paired open and the time close all match, and so does the chain of decision hashes and the sampling for a missed close. The run still reads Unverifiable because the recording cannot show when the account was created." Then `/check/scenario-bad-tampered-rules`: "Same run with the rules text changed after the commitment: Not matching on the rules." Then `/check/scenario-no-agent-close`: "The agent stopped after opening and never sent the close that came due. The page sampled the run itself every 20 blocks, found the time close due for about 15 minutes with none sent, and says: a close was missed. Everything else in that run that the page can establish still matches; the agent was not caught by anything but the missed close."

## 5. Close (20 s)

"Rules are committed by hash. Decision records are meant to be published after the reveal. The page accepts a file only if its hash equals the one the contract recorded, so the host need not be trusted. No host is set up yet, and one host alone could not convict. The creation block and the pinned constants on these runs are stand-ins. Viewing keys are written for testnet and tested in a local sandbox by script, not run on testnet or mainnet, and not shown in this demo. No live strategy has run. Positions are public on Rhea, so privacy depends on what links the strategy wallet to a person; public positions leak part of the rules once a wallet is linked; and anyone who holds a viewing key could copy the rules."

## Do not say

- That the agent makes money or beats the market.
- That positions are hidden, or anything about anonymity.
- Any agent volume figure, or any fee split number.
- That a viewing key cannot be shared, or that viewing keys have run on testnet or mainnet.
- That a mainnet strategy has run.
