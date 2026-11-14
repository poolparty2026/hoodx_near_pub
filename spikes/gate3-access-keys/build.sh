#!/usr/bin/env bash
# Build the spike contracts to wasm.
# `--cfg near` is required with near-sdk 5.30: without it, require!/panic_str
# compile to a bare wasm trap and the refusal message is lost.
# `cargo near build` sets this flag itself.
set -euo pipefail
cd "$(dirname "$0")"
RUSTFLAGS="--cfg near" cargo build --target wasm32-unknown-unknown --release -p relay -p token -p sink -p probe -p btoken
