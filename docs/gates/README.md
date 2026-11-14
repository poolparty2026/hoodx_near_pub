# Gates (M0)

The build brief says to stop other work until gates 1 to 4 have answers, due 7 November 2026. Each gate has a file with the question, the evidence, the answer so far and what is left. An owner signs off by filling in the **Sign-off** line.

Status on 5 November 2026:

| Gate | Question | Status | What's left |
|---|---|---|---|
| [1](1-existing-code.md) | What does the code do today, and what predates 19 October? | **Answered.** Rebuilt from scratch, and no earlier code is reused | Check the hackathon rules on naming other entries before submission (D8) |
| [2](2-private-ai.md) | Does NEAR's private AI fit this agent? | **Promising, not passed** | One live attested decision. Needs a NEAR AI Cloud API key and network access |
| [3](3-rhea-and-access-keys.md) | Can the access key design work with Rhea? | **Keys: passed in sandbox. Rhea: partly confirmed** | Exact Rhea DCL liquidity calls, fee reporting and position valuation. Needs mainnet RPC |
| [4](4-confidential-intents.md) | Which Confidential Intents operations are live for this flow? | **Answered and live-tested (6 Nov).** Public dry quotes work without a key; confidential quotes need a 1Click API key | Decide whether to get a key; until then no private-funding claim |
| [5](5-fee-split.md) | How is the fee split defined? | **Accepted for now** (D2) | Can be adjusted per strategy later |

## What blocked the research on 5 November

This cloud session's network policy blocks the hosts below, so live calls and the official docs pages couldn't be read here. The research used web search, the official SDK packages on npm (which include generated API types and NEAR AI's verification guide), and a local NEAR sandbox.

| Host | Needed for |
|---|---|
| `rpc.mainnet.near.org` (or another mainnet RPC, such as FastNEAR) | Gate 3: read Rhea state, import Rhea into the sandbox |
| `archival-rpc.mainnet.near.org` | Check page work later (historical view calls) |
| `cloud-api.near.ai`, `docs.near.ai` | Gate 2 |
| `1click.chaindefuser.com`, `docs.near-intents.org` | Gate 4 |
| `guide.rhea.finance`, `guide.ref.finance` | Gate 3 |
| `github.com` (public repos, unauthenticated) | Reading Rhea's contract source |

Either allow these hosts in the cloud environment's network settings, or run the remaining steps on a team member's machine.
