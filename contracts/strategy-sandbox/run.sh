#!/usr/bin/env bash
# Builds the strategy's sandbox wasm, then runs the slice 2b tests against it.
set -euo pipefail
cd "$(dirname "$0")/../.."
# The mainnet DCL, wrap.near and native USDC code and the near-sandbox binary, fetched once and
# checked against the pinned hashes. The tests check them again before they start.
python3 -I contracts/strategy-sandbox/fetch_wasm.py
export NEAR_SANDBOX_BIN_PATH="$PWD/target/near-sandbox/near-sandbox"
unset SANDBOX_ARTIFACT_URL
RUSTFLAGS="--cfg near" cargo build -p strategy --features sandbox --target wasm32-unknown-unknown --release --locked --target-dir target/sandbox
# Only where the container's open-file hard limit is below what near-sandbox asks for.
if [ "$(ulimit -Hn)" != "unlimited" ] && [ "$(ulimit -Hn)" -lt 65535 ]; then
  gcc -shared -fPIC -O2 -o target/rlimit_shim.so contracts/strategy-sandbox/rlimit_shim.c -ldl
  export LD_PRELOAD="$PWD/target/rlimit_shim.so"
fi
cargo test -p strategy-sandbox --release --locked -- --test-threads=1 --nocapture "$@"
