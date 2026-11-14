# Gate 6: testnet readiness (D57)

**Checked:** 14 November 2026, from the Claude cloud container, view calls and one throwaway account only. No funds, no mainnet.

## Verified

| Question | Answer |
|---|---|
| Testnet RPC reachable? | Yes. `https://rpc.testnet.near.org` and `https://rpc.testnet.fastnear.com` answer (protocol 88). `testnet.rpc.near.org` does not resolve. |
| Faucet host | `faucet.paas.testnet.near.org` and `api.faucet.near.org` are **unreachable** from the container (egress proxy cannot connect, not a policy block). `near-faucet.io` is a web page only (needs a browser). |
| Create a funded throwaway testnet account? | **Yes, no faucet needed.** `POST https://helper.nearprotocol.com/account` with `{"newAccountId":"<name>.testnet","newAccountPublicKey":"ed25519:..."}` creates the account with **10 NEAR** (checked: balance `10000000000000000000000000`). Top-level `*.testnet` ids only. The account is funded once per call; make a few (creator, agent, deliverer, follower). |
| Rhea DCL on testnet | `dclv2.ref-dev.testnet`, version 2.3.14, state `Running`, `wnear_id` `wrap.testnet`, 11690 pools. |
| Wrap and USDC-like tokens | `wrap.testnet` exists. `usdc.fakes.testnet` exists. `usdc.testnet` exists (not checked as a pool token). |
| Pool with wrap and a USDC-like token | Yes: `usdc.fakes.testnet|wrap.testnet|100`, `|400` and `|2000` exist (`token_x` is `usdc.fakes.testnet`, `token_y` is `wrap.testnet`; the reverse order returns null). The 100 and 400 tiers have liquidity. |
| `v2.ref-finance.testnet` | Does not exist. Do not use it. |

## Marked guesses (not verified)

- GUESS: the strategy contract can register and start against `dclv2.ref-dev.testnet` with `usdc.fakes.testnet`/`wrap.testnet`. Nothing was called on it; the `docs/gates/3-rhea-and-access-keys.md` swap and storage-deposit steps are untested on testnet. Fee tiers 100/400/2000 only; the strategy's fee-tier bound must include the one used.
- GUESS: `usdc.fakes.testnet` has a public faucet-style mint; not checked. A follower for the key flow needs only NEAR, not the token.
- GUESS: the helper's 10 NEAR grant and rate limits may change; keep accounts few.
- Not checked: gas costs, `list_pools` (runs out of gas on 11690 pools; use `get_pool` by id).

## Proposal (smallest honest setup)

For the viewing-key flow, only NEAR is needed: deploy the real strategy contract to a testnet account, create rules and K, start the deliverer, a follower buys with testnet NEAR, the deliverer delivers, the follower decrypts. Trading is not required for this and is not claimed. If the strategy can register on `dclv2.ref-dev.testnet` with the pools above it may also run on testnet, but that is not needed for the key flow and is unverified.

## Sandbox result: a bounced NEAR transfer (14 November 2026, backend, `strategy-sandbox/tests/keys.rs`)

Checked on the real wasm in the near-sandbox 2.14.0 node, not on testnet. A `deliver_key` whose payout `Transfer` goes to a **deleted** creator account: the transfer receipt fails, the NEAR returns to the strategy account, and the callback `on_near_paid` sees a **Failed** result. The contract then holds the amount in `near_owed[creator]` (`get_near_owed` = `key_price`, `near_owed_total` = `key_price`), the sale stays `Released`, and the strategy's balance still holds the NEAR (nothing stranded). When an account with the same id exists again, `withdraw_near` paid out the entry and set it to 0; a second call was refused `LIMIT: nothing owed`. Gas observed: buy 2.2 Tgas, deliver 2.8 + 2.1, refund 2.8 + 2.1, withdraw 2.8 + 2.1 (callback fixed at 10). Block time in the sandbox: 13,000 blocks advanced 3,869 s (about 0.3 s a block), so a 3,600 s window needs about 12,100 blocks. Not checked: testnet behaviour, or a bounce caused by anything other than a missing account.
