# Gate 3 spike, part B: Rhea DCL in a local sandbox

Runs the **exact DCL WASM deployed on mainnet** (`dclv2.ref-labs.near`, version 2.4.2, fetched with `view_code` on 6 November 2026, sha256 prefix `219169c5daf8ea3a`) and the **real `wrap.near` WASM**, in `near-sandbox`, with test tokens from `spikes/gate3-access-keys`. Throwaway code: findings go to `docs/gates/3-rhea-and-access-keys.md` and the `rhea-dcl` skill.

Run (after building the part A contracts with `../gate3-access-keys/build.sh`):

```bash
cargo test --test dcl -- --nocapture --test-threads=1
```

In containers with a low open-file limit, preload the rlimit shim described in `spikes/gate3-access-keys/README.md`.

Results are in the gate 3 document, section "Part B, sandbox run".

## Part C (7 November 2026)

`tests/partc.rs` calls DCL cross-contract through the probe contract in `../gate3-access-keys/contracts/probe`, with a USDC stand-in that can block a receiver (`contracts/btoken`). Build the part A contracts first, then:

```bash
LD_PRELOAD=/tmp/rlimit_shim.so cargo test --release --test partc -- --nocapture --test-threads=1
```

The test prints every receipt with its block and logs, the probe callback's view of each call, and the reads issued from it. Results are in the gate 3 document, section "Part C".
