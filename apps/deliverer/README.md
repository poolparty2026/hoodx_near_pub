# Deliverer (D57, testnet and sandbox only)

Polls the strategy contract's views at final finality; for each `Escrowed` sale inside its delivery window it seals the rules key K to the `buyer_pubkey` read from `get_key_sale` (never from an event, T74/EC-K06) and calls `deliver_key`. Stateless: a restart re-reads the sales, and `Released`/`Refunded` sales are skipped. It never calls `refund_key` (the buyer does, after the window).

Env: `DELIVERER_RPC` (testnet https URL), `STRATEGY`, `DELIVERER_ACCOUNT`, `DELIVERER_KEY` (function-call key limited to `deliver_key`; testnet only), `RULES_KEY_HEX` (32-byte K), `DELIVERER_POLL_MS`.
Run: `pnpm --filter @poolside/deliverer start`.

Gas: `DELIVER_GAS` is 50 Tgas (measured in the sandbox on the real wasm: buy 2.2 Tgas, deliver 2.8 + 2.1, callback fixed at 10; sends are serialised so one key never signs a nonce twice); K is supplied by env rather than received sealed from the creator; the guard is an exact-host allowlist (testnet RPCs, localhost for the sandbox). Marked guesses: not yet run against the real contract end to end.
The deliverer sees K: buyers trust it (D11).

Startup refuses to run if `DELIVERER_KEY` is not a function-call key to the strategy with exactly `deliver_key`, or if `RULES_KEY_HEX` does not open the on-chain ciphertext (EC-K03). Deadlines are judged on the latest final block time, never the host clock.
