# Gate 4: which Confidential Intents operations are live for this flow?

**Owner:** Payments. **Due:** 7 November 2026.

## Question

Which Confidential Intents operations can Poolside use for funding (deposits and exits), and what can we honestly claim? The overview listed this as an open question.

## Evidence

Primary source: `@defuse-protocol/one-click-sdk-typescript` 0.1.26 on npm (published 22 September 2026). Its types are generated from the 1Click API's OpenAPI spec. The 1Click API (`https://1click.chaindefuser.com`) and `docs.near-intents.org` were blocked from this session, so no live quote was made. Secondary sources: NEAR's announcements and news coverage via web search.

### What the 1Click API spec says

`POST /v0/quote` takes a `QuoteRequest`. The fields that matter for us:

| Field | Values and meaning |
|---|---|
| `dry` | `true` returns a quote without a deposit address, deadline or swap. This is the no-funds path in the README |
| `swapType` | `EXACT_INPUT`, `EXACT_OUTPUT` (and others) |
| `originAsset`, `destinationAsset`, `amount` | Asset ids and amount in the smallest unit |
| `depositType` | `ORIGIN_CHAIN`, `INTENTS`, `CONFIDENTIAL_INTENTS` |
| `recipientType` | `DESTINATION_CHAIN`, `INTENTS`, `CONFIDENTIAL_INTENTS`. For confidential, "1Click settles swap output via signed transfer intent rather than direct token transfer" |
| `refundType` | `ORIGIN_CHAIN`, `INTENTS`, `CONFIDENTIAL_INTENTS` |
| `confidentiality` | `public` (default), `basic`, `advanced`: "BASIC or ADVANCED request Confidential Intents handling" |
| `customRecipientMsg` | "**HIGHLY EXPERIMENTAL**": a msg for `ft_transfer_call` when withdrawing to NEAR. "Funds will be lost if used with non NEP-141 tokens, in case of insufficient `storage_deposit` or if the recipient does not implement `ft_on_transfer` method" |
| `slippageTolerance`, `refundTo`, `recipient`, `deadline` | As named |

The spec doesn't say what an outside observer can and can't see for each `confidentiality` level.

### What NEAR has announced (secondary)

- **February 2026:** Confidential Intents launched on near.com, with confidential deposits, transfers and withdrawals first, and confidential swaps by late May.
- **7 to 8 July 2026:** general availability through the 1Click Swap API, enabled with one parameter.
- **13 and 18 July 2026:** live on the Aurora Intents Swap API and in Infinex.
- **1 October 2026:** NEAR Intents paused after a reported $3.8M exploit linked to its Omni deposit and withdrawal infrastructure. Reports say service resumed within about a day, with some routes back about 12 hours later, and that the funds were returned. Accounts of how they were returned differ.

## Answer so far

**Confidential swaps, deposits, transfers and withdrawals are documented and announced as live.** For our flow:

1. **Joining from another chain:** a 1Click quote with `recipientType: INTENTS` or `DESTINATION_CHAIN` delivers the quote token to the joiner's NEAR account, and the joiner then calls `ft_transfer_call` on the strategy. This is the two-step join from architecture section 9.
2. **Confidential funding:** the same quote with `confidentiality: basic` or `advanced` (and the matching `CONFIDENTIAL_INTENTS` types) should hide where the money came from. The leg into the strategy contract is still public, as the overview already says.
3. **One-step joins with `customRecipientMsg`: don't use them.** The spec marks the field highly experimental and warns that funds can be lost. A failed join would lose team money in front of judges.

## Live dry-run quotes, 6 November 2026

`scripts/quote.ts` sends only `dry: true` requests (it refuses anything else) for USDC on Base → native USDC on NEAR. No API key was used.

| Request | Result |
|---|---|
| `confidentiality: public`, `recipientType: DESTINATION_CHAIN`, recipient an existing NEAR account | **201.** 25 USDC in, 24.992357 USDC out (minimum 24.742433), about 35 seconds, no deposit address (dry run) |
| Same, recipient an account that doesn't exist | 400, "Internal server error" |
| `recipientType: INTENTS` | 201. 25 USDC in, 24.99696 USDC out, about 35 seconds |
| `confidentiality: basic` or `advanced` | **401: "User authentication is required for confidential intent quotes"** |

**So:** public quotes work without a key. **Confidential quotes need an authenticated 1Click account (a JWT).** Until the team has one and records a confidential transaction, the README claims no private funding. Node's `fetch` needs `NODE_USE_ENV_PROXY=1` behind an HTTPS proxy.

## Still open

- [x] Run `dry: true` quotes with `confidentiality` `public`, `basic` and `advanced`. Done 6 November: public works without a key; confidential needs one.
- [ ] Decide whether to get a 1Click API key (JWT) for confidential quotes.
- [ ] Find out from NEAR's docs, or ask NEAR, what `basic` and `advanced` each hide, and from whom.
- [ ] Do one tiny confidential deposit with team money, record the transactions, and look at what a block explorer shows. Only claim what that shows.
- [ ] Recheck the status page before the demo, given the 1 October incident.

Until the recorded transaction exists, the README and demo claim **no** private funding, as the brief says.

**Sign-off:** _pending_
