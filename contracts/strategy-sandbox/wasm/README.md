# Mainnet contract code for the sandbox tests

Fetched with `view_code` from `https://free.rpc.fastnear.com` on 10 November 2026; each file's
base58 SHA-256 matches the account's on-chain `code_hash`:

| File | Account | Block | code_hash |
|---|---|---|---|
| `dclv2.wasm` | `dclv2.ref-labs.near` | 223,878,678 | `3G34Nhjmir5JPYPtijaA9iCNnHDPR7h3wfC9H77woEGo` |
| `wrap.wasm` | `wrap.near` | 223,878,679 | `DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1` |
| `usdc.wasm` | `17208628…33a1` (native USDC) | 223,878,680 | `DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q` |

The near-sandbox 2.14.0 binary (Linux x86_64) is pinned by its SHA-256,
`797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13`. It comes from
`s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/2.14.0/near-sandbox.tar.gz`, and
matches the copy near-workspaces downloaded on 26 October 2026. It is saved to `target/near-sandbox/`.
near-workspaces' own download, which has no check, is switched off (`default-features = false`), and
run.sh points `NEAR_SANDBOX_BIN_PATH` at the pinned copy. **Residual (security check of `0f8a6ba`, Low-1):** both copies came from the same S3 bucket; no checksum published by nearcore has been compared (unverified whether one exists), so the pin guards against later changes, not against a bad first download. Accepted under T16.

Third-party code, used only in the local sandbox, and not committed: `fetch_wasm.py` (run by `run.sh`) fetches each file and refuses one whose hash isn't pinned here, and the tests check every hash again before they start, refusing a strategy wasm older than its source.
