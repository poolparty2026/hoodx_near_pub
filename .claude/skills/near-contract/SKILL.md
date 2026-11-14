---
name: near-contract
description: How hoodx builds, tests and calls NEAR contracts — near-sdk version and toolchain, the required --cfg near build flag, sandbox tests with near-workspaces, function-call access keys (allowance, deposits, receiver and method limits), 1 yoctoNEAR deposits and storage. Use when writing or testing anything under contracts/, the agent's signer, or deploy and key scripts.
---

# NEAR contracts in hoodx

Everything here was confirmed in the gate 3 sandbox spike on 5 November 2026 (`spikes/gate3-access-keys`, `docs/gates/3-rhea-and-access-keys.md`), unless marked otherwise. Rhea-specific calls are in the `rhea-dcl` skill.

## Versions and toolchain

- `near-sdk` and `near-contract-standards` 5.30.1, which need **Rust 1.95 or later**. `near-workspaces` 0.24.0 for tests, with `default-features = false, features = ["rustls"]` so its build script downloads nothing; the pinned `near-sandbox` 2.14.0 binary comes from `contracts/strategy-sandbox/fetch_wasm.py` (SHA-256 checked) through `NEAR_SANDBOX_BIN_PATH` (run `contracts/strategy-sandbox/run.sh`).
- Target: `wasm32-unknown-unknown`.

## Building: always set `--cfg near`

```bash
RUSTFLAGS="--cfg near" cargo build --target wasm32-unknown-unknown --release -p <crate>
```

`cargo near build` sets this flag for you. **Without it, `require!` and `env::panic_str` compile to a bare WebAssembly trap** ("An `unreachable` opcode was executed"), and the panic message never reaches the transaction. Our refusal messages (`LIMIT: ...`, `AUTH: ...`) are a demo step, so a build without the flag is a broken build. Release profile: `opt-level = "z"`, `lto = true`, `codegen-units = 1`, `panic = "abort"`, `overflow-checks = true`.

## Sandbox tests

- Use `near_workspaces::sandbox()`, `root_account().create_subaccount(..)`, `.deploy(&wasm)`, `.call(..).args_json(..).gas(Gas::from_tgas(100)).transact()`.
- A refused call returns `Ok(outcome)` with a failure inside. Use `.into_result()` and match the error text, for example `Smart contract panicked: LIMIT: amount over cap`.
- A transaction the protocol rejects (bad key, deposit with a function-call key) fails at broadcast: `transact()` returns `Err` with `InvalidAccessKeyError(..)` inside.
- In a container where the open-file hard limit is below 65535, `near-sandbox` exits with "couldn't set the file descriptor limit". Preload a shim that caps the request at the hard limit. See the spike README. Not needed on a normal laptop.

## Function-call access keys

Create with `AccessKey::function_call_access(receiver, &["agent_..."], Some(allowance))`, then act as that key with `Account::from_secret_key(account_id, secret_key, &worker)`.

| Behaviour | Confirmed error when violated |
|---|---|
| Works for one receiver contract only | `ReceiverMismatch` |
| Works for the listed methods only | `MethodNameMismatch` |
| Can't attach any deposit, not even 1 yoctoNEAR | `DepositWithFunctionCall` |
| Can't send NEAR | `RequiresFullAccess` |
| Allowance is charged on **prepaid** gas up front | `NotEnoughAllowance` |

Consequences:

- **Never use `max_gas()` with a function-call key.** 1 PGas of prepaid gas costs about 1 NEAR of allowance and is rejected with a smaller allowance. Attach explicit gas per method (100 TGas was enough for one cross-contract `ft_transfer_call`).
- Size the allowance to the number of agent actions you expect. Whether an allowance can be raised in place is not confirmed; until it is, replace the key (delete and add) with the full-access key.
- One function-call key per strategy contract, because a key has exactly one receiver.
- Keep a full-access key on the agent account, held offline by the lead, so the account can never lock itself out.

## Calling tokens and Rhea from a contract

- The agent calls our contract with **no deposit**. Our contract calls `ft_transfer_call` and other methods that need 1 yoctoNEAR, paying from its own balance: `Promise::new(token).function_call("ft_transfer_call".into(), args, NearToken::from_yoctonear(1), Gas::from_tgas(60))`.
- The receiver's `ft_on_transfer` sees **our contract** as `sender_id`.
- Before a contract can hold a token, it needs `storage_deposit` on that token. The contract can pay this from its own balance.
- Fund each strategy account with enough NEAR for storage and these deposits.

## Not yet confirmed in this repo

Callback patterns (`#[private]` callbacks, `PromiseResult` handling) and NEP-297 events are standard near-sdk features, but no spike here has run them yet. Test them in the sandbox before relying on them, and add what you learn to this skill.
