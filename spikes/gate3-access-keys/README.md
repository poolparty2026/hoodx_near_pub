# Gate 3 spike: agent access keys

Answers the access-key half of gate 3 in [`docs/gates/3-rhea-and-access-keys.md`](../../docs/gates/3-rhea-and-access-keys.md): can an agent holding only a function-call key drive token transfers through our contract, and is everything else refused?

- `contracts/relay`: stand-in for the strategy contract. Only the agent may call `agent_*`, it checks two public limits, then calls `ft_transfer_call` with 1 yoctoNEAR paid from its own balance.
- `contracts/token`: minimal NEP-141 token.
- `contracts/sink`: stand-in for Rhea. Records what `ft_on_transfer` receives.
- `tests-sandbox/tests/access_keys.rs`: five sandbox tests.

## Run

```bash
./build.sh
```

```bash
cargo test -p tests-sandbox -- --nocapture --test-threads=1
```

Needs Rust 1.95 or later (near-sdk 5.30.1) with the `wasm32-unknown-unknown` target. The first test run downloads `near-sandbox` 2.14.0.

In a container whose open-file hard limit is below 65535, `near-sandbox` refuses to start ("couldn't set the file descriptor limit to (65535, 65535)"). On a laptop this doesn't happen. In such a container, preload a small shim that caps the request at the hard limit. The 5 November run used one. It affects only the local test chain.

The shim is `rlimit_shim.c` in this folder (it overrides `setrlimit`, `setrlimit64`, `prlimit` and `prlimit64` for `RLIMIT_NOFILE` only, capping the request at the hard limit):

```bash
gcc -shared -fPIC -O2 -o /tmp/rlimit_shim.so rlimit_shim.c
LD_PRELOAD=/tmp/rlimit_shim.so cargo test --release --test dcl -- --test-threads=1
```

The `setrlimit64` override is needed: `near-sandbox` 2.14.0 imports both names.

## Result, 5 November 2026

All five tests pass:

| Test | Result |
|---|---|
| A function-call key calls `agent_transfer_call` on the relay with no deposit, and the relay's `ft_transfer_call` reaches the sink with the msg intact | Pass. The sink sees the relay as sender, and the balances move |
| An amount over the cap and a receiver outside the allowed list are refused | Pass. `Smart contract panicked: LIMIT: amount over cap` and `LIMIT: receiver not allowed` |
| The function-call key attaches 1 yoctoNEAR | Rejected by the protocol with `DepositWithFunctionCall` |
| The key calls the token directly, calls an unlisted method, or sends NEAR | Rejected with `ReceiverMismatch`, `MethodNameMismatch` and `RequiresFullAccess` |
| Another account calls `agent_transfer_call` | Refused by the contract, `AUTH: caller is not the agent` |
