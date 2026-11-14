---
name: rhea-dcl
description: Confirmed facts about Rhea Finance's concentrated liquidity (DCL) contract on NEAR — contract ids, pool id format, fee tiers, swap message and view methods — and the list of calls not yet confirmed. Use before writing any code that calls or reads Rhea, in contracts/, packages/near or apps/agent.
---

# Rhea DCL

Source of truth for how hoodx talks to Rhea. Only add a fact here once it has been confirmed from Rhea's code, a sandbox run or a mainnet transaction, and say which. Gate 3 tracks what is still open: `docs/gates/3-rhea-and-access-keys.md`.

## Confirmed (from `@ref-finance/ref-sdk` 1.5.0 code, 5 November 2026)

| Fact | Value |
|---|---|
| Mainnet DCL contract | `dclv2.ref-labs.near` |
| Testnet DCL contract | `dclv2.ref-dev.testnet` |
| Pool id | `[tokenA, tokenB].sort().join("\|") + "\|" + fee`, for example `usdc.example.near\|wrap.near\|2000` |
| Fee tiers | `100`, `400`, `2000`, `10000` and others (unit confirmed 6 November: 100 = 0.01%, 2000 = 0.2%) |
| Pool view fields | `pool_id`, `token_x`, `token_y`, `fee`, `point_delta`, `current_point`, `state`, `liquidity`, `liquidity_x`, `max_liquidity_per_point`, `total_x`, `total_y` |
| View methods | `list_pools`, `get_pool({pool_id})`, `quote`, `quote_by_output`, `list_user_assets`, `get_pointorder_range` |
| Swap | `ft_transfer_call` on the input token, receiver `dclv2.ref-labs.near`, 1 yoctoNEAR, msg `{"Swap":{"pool_ids":[...],"output_token":"...","min_output_amount":"...","referral_id":"","client_id":""}}` |
| Storage | Check `storage_balance_of` and call `storage_deposit` on the DCL contract and on each token before first use |

## Confirmed on mainnet, 6 November 2026 (view calls and the deployed WASM)

| Fact | Value |
|---|---|
| Version and owner | DCL 2.4.2, owned by `ref-finance.sputnik-dao.near`; operators can pause the contract or a pool |
| Fee tier to point spacing | 100 → 1, 400 → 8, 1000 → 20, 2000 → 40, 10000 → 200 (100 = 0.01%) |
| Protocol fee | 20% of swap fees (`protocol_fee_rate` 2000) |
| Positions | NFTs (`nft_transfer`, `nft_tokens_for_owner`): they can be sent to any account |
| `add_liquidity` | `pool_id, left_point, right_point, amount_x, amount_y, min_amount_x, min_amount_y` (amounts are strings) |
| `remove_liquidity` | `lpt_id, amount, min_amount_x, min_amount_y` |
| `append_liquidity` | `lpt_id, amount_x, amount_y, min_amount_x, min_amount_y` |
| `withdraw_asset` | `token_id`, further fields not yet known |
| Views | `list_liquidities(account_id)`, `get_liquidity(lpt_id)`, `predict_add_liquidity`, `predict_remove_liquidity(lpt_id, amount)`, `list_user_assets(account_id)` |
| Native USDC | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`; has pause and blocklist powers |

## Confirmed in the sandbox with the mainnet WASM, 6 November 2026 (`spikes/gate3-rhea-dcl`)

- Deposit: `ft_transfer_call` to DCL with msg `"Deposit"`. Empty or unknown msg is refunded.
- `add_liquidity`, `remove_liquidity`, `withdraw_asset`: attach **no** deposit (they panic otherwise). `nft_transfer`, `withdraw_lostfound`: exactly 1 yoctoNEAR.
- `add_liquidity` returns the `lpt_id`; unused amounts are paid back to the owner.
- `remove_liquidity(lpt_id, amount, min_amount_x, min_amount_y, skip_unwrap_near?)` pays both tokens straight to the owner by plain `ft_transfer` and returns `[x, y]`. The `liquidity_removed` event reports `claim_fee_token_x/y` and `refund_token_x/y`. A fully removed position is deleted (`E207` afterwards).
- **wNEAR is unwrapped to native NEAR unless `skip_unwrap_near: true`** (works on `remove_liquidity`, `withdraw_asset` and the `Swap` msg).
- Payout failures don't fail the call. **Where the amount goes depends on registration** (gate 3 part C, 7 November, sandbox):
  - Registered at DCL (`storage_deposit` done), in every case tested (including at minimum storage with 40 gifted positions; DCL's lock condition is unread): back to the account's **DCL internal balance** (`list_user_assets`), event `lostfound` with `"locked": false`; recover with `withdraw_asset` once the token pays. `get_lostfound` stays 0.
  - Not registered: **`"locked": true` lost and found**, shown by `get_lostfound`. `withdraw_lostfound` is **DCL-owner only** (`E002: not allowed for the caller` for anyone else) and pays the **owner**, not the account (one argument shape tried: `token_id` plus `account_id`). Treat it as lost. So: confirm DCL registration before any DCL call, and never unregister.
  - `withdraw_asset` returns `false` on a failed payout and `true` once it succeeds.
- Cross-contract (part C, single-shard sandbox; ordering on mainnet unverified): a callback after `remove_liquidity` or a swap is told the full amounts **before** the payout's fate is known. Never credit the report alone. A single balance read is not enough either: it counts donations, and on mainnet the read may run before a successful payout lands. The crediting rule is decided in ARCHITECTURE revision 11.
- A refused swap (`E204: slippage error`) reports `"0"` used and the input is refunded (seen with a near-contract-standards token; native USDC unchecked). Its failed receipt still logs a `swap` event: ignore logs from failed receipts.
- DCL storage is in **slots**: `get_user_storage_detail({"user_id"})` gives `max_slots` (`(deposit - 0.1 NEAR) / 0.01 NEAR`: 40 at the 0.5 NEAR minimum, 90 at 1 NEAR, both asserted; DCL's owner can change the parameters with `modify_storage_params`) and `cur_liquidity_slots`. **Each gifted position takes one of the receiver's slots**; at full slots the 41st gift is refused and the account's own `add_liquidity` fails with `E107: not enough storage for slots`, while deposits, removes, `withdraw_asset` and failed payouts (`locked: false`) still work at 40 of 40 slots (asserted). `storage_balance_of` always shows `available: "0"`: never use it as a signal. There is no `storage_unregister` or `storage_withdraw`: DCL storage NEAR never comes back. Many small positions in a range raise swap gas (65 Tgas at DCL after 40); no gas floor is enough (anyone can add more positions); a swap that runs out of gas is refunded in full and reports `"0"` (seen with wNEAR input; USDC input unverified).
- `add_liquidity` takes the full amounts and pays unused tokens to the wallet by `ft_transfer`; pass `skip_unwrap_near: true` or unused wNEAR arrives as native NEAR.
- `get_liquidity`'s `unclaimed_fee_x/y` is current in a view and matches the remove event's `claim_fee_token_x/y`.
- `get_liquidity` of a fully removed position, or of an id that never existed, returns `null` (direct and cross-contract, asserted); it doesn't panic.
- `get_liquidity` returns `{ lpt_id, owner_id, pool_id, left_point, right_point, amount, unclaimed_fee_x, unclaimed_fee_y, v_liquidity, mft_id }` (sandbox, 2.4.2). `predict_remove_liquidity` returns `[x, y]` as decimal strings, equal to the remove event's `refund_token_x/y`. **Unverified:** whether `refund_token` includes the claimed fees (no separate fee credit was seen in the sandbox); don't assume either way until gate 3 part D settles it.
- Cross-contract views: `predict_add_liquidity` needs about 10 Tgas and `quote` about 15 on a small pool; give margin. `register_tokens` panics `E104` with 1 yoctoNEAR attached; **correction (11 November, gate 3 Part J): it IS needed before a deposit** (`E016: token not registered` otherwise) and works with about 0.01 NEAR attached per token, which comes back.
- Swap: msg `{"Swap":{"pool_ids":[...],"output_token":"...","min_output_amount":"...","skip_unwrap_near":true}}`; output by plain `ft_transfer` to the swapper; the `swap` event reports `amount_out` and fees.
- **Ratios:** DCL is discretized; the amounts a range needs differ from the continuous concentrated-liquidity formula (0.4% in a sandbox case). Get ratios from `predict_add_liquidity`, never from your own formula.
- **Points:** price = token_y per token_x = 1.0001^point; ranges are half-open `[left_point, right_point)`; points are bounded to ±800,000 (`E202: illegal point` beyond).
- Positions are NFTs and `nft_transfer` works; `list_liquidities(account_id)` returns all of an account's positions with unclaimed fees.

## Confirmed on mainnet by view call, 7 November 2026 (`packages/near` fixtures)

- `get_pool({pool_id})` for `<USDC>|wrap.near|100` at block 223429540: amounts are **decimal strings** (`liquidity`, `liquidity_x`, `total_x`, `total_y`, fee and volume totals); `fee`, `point_delta` and `current_point` are **JSON numbers**; `state` is `"Running"` (the only state confirmed; `packages/near` also accepts `"Paused"` and `"Locked"` as a guess at the others, unchecked against the DCL source, and callers act only on `"Running"`). Pinned reads work: pass `"block_id": <height>` instead of `finality`, and the answer carries that `block_height` and a base58 `block_hash` (confirmed at 223429540 on the archival and regular RPC). `packages/near` reads these responses with `strictParse` and refuses fee tiers above 10000 on purpose. token_x is USDC, token_y is wrap.near; `current_point` was 401312.
- `predict_add_liquidity({pool_id, left_point, right_point, amount_x, amount_y})` (amounts as decimal strings) returns `{need_x, need_y, liquidity_amount}`, all decimal strings. A range wholly below the current point needed only token_y (`need_x: "0"`).

## Not confirmed: don't write code against these yet

- ~~Whether `add_liquidity`'s refund of unused wNEAR honours `skip_unwrap_near`.~~ It does (part C).

- The `batch_*` versions and `claim` of fees without removing liquidity.
- How to value a position in one token.

When these are confirmed, move them to the confirmed table with the source.

- **Storage amounts (mainnet view, 10 November 2026):** both pool tokens take exactly 0.00125 NEAR (`storage_balance_bounds` min = max); DCL's minimum is 0.5 NEAR. Register at DCL with `storage_deposit` only; never call `register_tokens` (it panics `E104` and isn't needed).
- **Storage behaviour (sandbox, mainnet DCL code, 10 November 2026):** `storage_balance_of` is `null` for an unregistered account; `storage_deposit` returns a plain `{available, total}`; a second deposit is credited, not refunded (never pay DCL storage twice). Asserted in `contracts/strategy-sandbox/tests/new.rs`; gate 3 Part F.
- **`start`'s reads (sandbox, mainnet DCL code, 11 November 2026; gate 3 Part H):** `create_pool({token_a, token_b, fee, init_point})` with 1 NEAR, owner only; `get_user_storage_detail({"user_id"})` returns `max_slots`, `cur_order_slots` and `cur_liquidity_slots` as JSON numbers (190 at 2 NEAR); `storage_balance_of` is `{total, available}` or `null` at DCL and at both tokens. Asserted in `contracts/strategy-sandbox/tests/start.rs`.
- **`list_user_assets` (sandbox, mainnet DCL code, 11 November 2026; gate 3 Part I):** `{}` for an account with no internal balance. The non-empty shape is **not confirmed**; a plain `ft_transfer_call` of `"Deposit"` failed `E016: token not registered` in the sandbox even after `create_pool`, so what makes DCL accept a token for deposit is open.
- **Deposits and `withdraw_asset` (sandbox, 11 November 2026; gate 3 Part J):** call `register_tokens({"token_ids": [...]})` with at least 0.01 NEAR per token first, then `ft_transfer_call` with msg `"Deposit"` credits the sender; `list_user_assets` then answers `{token: "decimal string"}`. `withdraw_asset({"token_id", "amount"?: decimal string or null, "skip_unwrap_near"?: bool})` takes no deposit, returns `true` and moves the amount (all if absent or null) to the wallet; a numeric `amount` fails to deserialise and an explicit amount above the balance fails.
