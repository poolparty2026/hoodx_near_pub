# Gate 3: can the access key design work with Rhea?

**Owner:** Contract. **Due:** 7 November 2026.

## Question

Can the agent hold only a function-call key that calls our strategy contract, while the contract makes the Rhea calls (which need attached deposits)? The brief's track 06 note warns that an account with only function-call keys cannot transfer NEAR and can lock itself out.

The question has two halves: the **access keys** (NEAR protocol behaviour) and **Rhea** (the exact calls our contract must make).

## Part A: access keys. Passed in the sandbox

Spike: [`spikes/gate3-access-keys`](../../spikes/gate3-access-keys/README.md), run on 5 November 2026 against `near-sandbox` 2.14.0 with near-sdk 5.30.1. All five tests pass.

| Claim in the architecture | Result |
|---|---|
| A function-call key can drive our contract, which then calls `ft_transfer_call` with 1 yoctoNEAR from its own balance | **Confirmed.** Tokens and the msg reach the receiver, and the receiver sees our contract as sender |
| A function-call key cannot attach a deposit | **Confirmed.** `InvalidAccessKeyError(DepositWithFunctionCall)` |
| The key works only for its one receiver contract and its listed methods | **Confirmed.** `ReceiverMismatch` and `MethodNameMismatch` |
| The key cannot send NEAR | **Confirmed.** `RequiresFullAccess` |
| The contract refuses actions outside public limits, with a readable reason | **Confirmed.** `Smart contract panicked: LIMIT: amount over cap` |
| Only the agent can call `agent_*` | **Confirmed.** `AUTH: caller is not the agent` |

Two findings change how we build:

1. **The key's allowance must cover the full prepaid gas, not the gas actually used.** A call with `max_gas` (1 PGas) costs about 1 NEAR of allowance up front and was rejected (`NotEnoughAllowance`) with a 0.5 NEAR allowance. The agent must attach explicit gas per method (100 TGas worked), and the allowance must be sized to the number of actions it should be able to take.
2. **near-sdk 5.30 must be built with `--cfg near`** (which `cargo near build` sets). With a plain `cargo build`, `require!` compiles to a bare WebAssembly trap and the refusal message is lost. The refusal is a demo step, so this matters. near-sdk 5.30.1 also needs Rust 1.95 or later.

**The lockout risk is handled by the key layout in the architecture (section 5.8).** The agent account keeps a full-access key held offline by the lead, and only function-call keys go on the server. The sandbox confirms the server key can't move NEAR, can't touch other contracts, and can't call anything but the listed methods.

## Part B: Rhea. Partly confirmed

Primary source: `@ref-finance/ref-sdk` 1.5.0 on npm (published 1 February 2026). Rhea's guides and GitHub were blocked from this session.

Confirmed from the SDK code:

| Fact | Value |
|---|---|
| Mainnet concentrated liquidity (DCL) contract | `dclv2.ref-labs.near` |
| Testnet DCL contract | `dclv2.ref-dev.testnet` (an older `dcl.ref-dev.testnet` also appears) |
| Pool id format | The two token account ids sorted alphabetically, joined with `\|`, then `\|<fee>`, for example `a.near\|b.near\|2000` |
| Fee tiers | `100`, `400`, `2000`, `10000`. Most likely hundredths of a basis point (0.01%, 0.04%, 0.2%, 1%), but the SDK doesn't show the DCL fee unit, so confirm it |
| Pool fields | `pool_id`, `token_x`, `token_y`, `fee`, `point_delta`, `current_point`, `state`, `liquidity`, `liquidity_x`, `max_liquidity_per_point`, `total_x`, `total_y` |
| Swaps | `ft_transfer_call` on the input token to the DCL contract, with msg `{"Swap":{"pool_ids":[...],"output_token":...,"min_output_amount":...,"referral_id":"","client_id":""}}` |
| View methods used by the SDK | `list_pools`, `get_pool`, `quote`, `quote_by_output`, `list_user_assets`, `get_pointorder_range` |
| Storage | The SDK checks `storage_balance_of` and calls `storage_deposit` before first use |

Secondary sources (web search, not verified):

- Rhea's contracts page reportedly lists `dclv2.ref-labs.near` as current and `dcl.ref-labs.near` as obsolete.
- A developer issue lists DCL liquidity methods including `add_liquidity`, `append_liquidity`, `batch_add_liquidity`, `batch_remove_liquidity` and `batch_update_liquidity`, plus views such as `get_liquidity` and `list_liquidities`. The SDK doesn't include liquidity calls, so their arguments are still unknown.
- Rhea's April 2026 exploit (reported $18.4M) was in margin trading. Reports say the DEX reopened after fake pools were removed, margin trading was discontinued, and lending reopened in phases from May. No source found says whether DCL itself was affected.

## Part B, live checks on 6 November 2026 (read-only mainnet view calls)

Network access to mainnet RPC was opened on 5 November. These were confirmed with view calls only; no transaction was sent.

| Fact | Value | How confirmed |
|---|---|---|
| DCL contract version | 2.4.2, owner `ref-finance.sputnik-dao.near` (a DAO), operators `doublerose.near` and `bim.near`, state Running | `get_metadata` |
| Rhea admin powers | The contract exposes `pause_contract`, `pause_pool`, blacklists and frozen tokens | Exported methods of the deployed WASM |
| Protocol fee | `protocol_fee_rate` 2000, so 20% of swap fees go to the protocol and LPs keep 80% | `get_metadata` |
| Fee tiers and point spacing | 100 → 1, 400 → 8, 1000 → 20, 2000 → 40, 10000 → 200 (and higher). This matches 100 = 0.01% and 2000 = 0.2% | `get_fee_tiers` |
| **Positions are NFTs and can be transferred** | `nft_transfer`, `nft_transfer_call`, `nft_tokens_for_owner` exist. Third parties can send positions to the strategy, which confirms the premise of audit findings H1 and N2 | Exported methods |
| `add_liquidity` arguments | `pool_id`, `left_point`, `right_point`, `amount_x`, `amount_y`, `min_amount_x`, `min_amount_y` (amounts as strings) | Deserializer errors from view calls |
| `remove_liquidity` arguments | `lpt_id`, `amount`, `min_amount_x`, `min_amount_y` | Same |
| `append_liquidity` arguments | `lpt_id`, `amount_x`, `amount_y`, `min_amount_x`, `min_amount_y` | Same |
| `withdraw_asset` arguments | `token_id` first (further fields not yet probed) | Same |
| Views | `list_liquidities(account_id)`, `get_liquidity(lpt_id)`, `predict_add_liquidity`, `predict_remove_liquidity(lpt_id, amount)`, `list_user_assets(account_id)`, `get_pool(pool_id)` | Same |
| Native USDC/wNEAR pools | All four tiers exist and are Running. Tier 100: ~224k USDC + 82k wNEAR, ~2.19M USDC and 596k wNEAR traded in 12.8 hours. Tier 2000: ~2.9k USDC + 85k wNEAR, ~150 USDC traded in 12.8 hours | `get_pool` now and at a block 80,000 earlier (archival RPC) |

## Part B, sandbox run on 6 November 2026

Spike: [`spikes/gate3-rhea-dcl`](../../spikes/gate3-rhea-dcl/README.md). It runs the exact mainnet DCL WASM (v2.4.2) and the real `wrap.near` WASM in `near-sandbox`.

| Question | Answer |
|---|---|
| How are tokens deposited? | `ft_transfer_call` to DCL with `msg` = `"Deposit"` (a JSON string). An empty or unknown msg is refunded. `register_tokens` isn't needed |
| Attached deposit on liquidity calls? | **None.** `add_liquidity`, `remove_liquidity` and `withdraw_asset` panic ("doesn't accept deposit") if anything is attached. `nft_transfer` and `withdraw_lostfound` need exactly 1 yoctoNEAR |
| What does `add_liquidity` return? | The new position id (`lpt_id`), for example `pool|...|2000#1`. Unused amounts are **paid straight back to the owner** |
| How are removed tokens paid? | `remove_liquidity` **pays both tokens straight to the position owner by plain `ft_transfer`**. Nothing stays as an internal balance. The owner's `ft_on_transfer` is **never** called. It returns `[amount_x, amount_y]` |
| What happens to wNEAR? | **By default DCL unwraps wNEAR and sends native NEAR** ("Withdraw … NEAR from dcl" on `wrap.near`). `remove_liquidity`, `withdraw_asset` and the `Swap` message accept `skip_unwrap_near: true`, which pays wNEAR as a token instead |
| Are fees reported separately? | Yes. The `liquidity_removed` event carries `claim_fee_token_x` and `claim_fee_token_y` alongside `refund_token_x` and `refund_token_y`, and positions report `unclaimed_fee_x` and `unclaimed_fee_y` |
| What if a payout transfer fails? | DCL **doesn't fail the call**. It logs a `lostfound` event, keeps the amount for that user, and `withdraw_asset` returns `false`. The owner recovers it with `withdraw_lostfound(token_id)` (1 yoctoNEAR); `get_lostfound(account_id, token_id)` reads it. **Corrected by part C (7 November):** for an account registered at DCL, a failed payout goes back to its internal balance (`"locked": false`), not to `get_lostfound`, and `withdraw_lostfound` panicked `E002` |
| Removing a position twice, or an empty one? | A fully removed position is deleted. Any further remove fails with `E207: liquidity not found` |
| Can positions be transferred? | **Yes.** `nft_transfer` moves a position to any account, and it appears in that account's `list_liquidities` |
| `list_liquidities` | Takes `account_id` only and returns every position with `amount`, points, `unclaimed_fee_x`, `unclaimed_fee_y` |
| Swap output | `ft_transfer_call` with msg `{"Swap":{"pool_ids":[..],"output_token":..,"min_output_amount":..,"skip_unwrap_near":true}}`. Output is paid to the swapper by plain `ft_transfer`. The `swap` event reports `amount_out`, `total_fee` and `protocol_fee` |

**Point semantics, confirmed in the sandbox (`point_semantics` test):**

| Question | Answer |
|---|---|
| Price direction | **price = token_y per token_x = 1.0001^point** (raw units). A range symmetric around point 6932 (1.0001^6932 ≈ 2) took ≈498M x and ≈1,000M y |
| Range edges | **Half-open `[left_point, right_point)`.** A range starting at the current point takes both tokens; a range ending at the current point takes only token_y; ranges wholly above take only token_x |
| Point bounds | **±800,000.** `create_pool` with 800,000 or −800,000 succeeds; 800,001 fails with `E202: illegal point` |
| Amounts per range | **DCL is discretized: its token amounts don't follow the continuous concentrated-liquidity formula.** For range [6432, 7432) at point 6932 the continuous formula gives y/x = 2.00004; DCL took y/x = 2.00805 (0.4% apart). Code must use DCL's own `predict_add_liquidity` for ratios, never a reimplementation |
| Tiny swaps | **Not confirmed:** whether a swap of 1 to 2 raw units (output 0 after fees) is accepted with `min_output_amount` 0 or panics. Needed for the swap step (swap audit L2) |
| Fee tier 1000 | Not enabled on a freshly deployed DCL (`E402: illegal fee`); mainnet enabled it with `add_fee_tier` |

**What this means for the design (audit findings N1 and N2):**

- **No inflow from DCL ever reaches our `ft_on_transfer`.** Every payout is a plain `ft_transfer`, so the ledger can only be credited from our own callbacks, using DCL's return values and events.
- **DCL reports success even when its payout failed.** The amount goes to lost and found. A callback must not credit a reported amount blindly: it has to subtract any lost-and-found increase, read with `get_lostfound`, and the exit path needs `withdraw_lostfound`. **[Superseded by part C below: for a registered account a failed payout goes to its DCL internal balance, not lost and found; `withdraw_lostfound` is DCL-owner only; the credit rule is open for revision 11.]**
- **Every DCL call must pass `skip_unwrap_near: true`,** or wNEAR arrives as native NEAR and mixes with the contract's storage and escrow NEAR. Whether `add_liquidity` refunds accept it too isn't tested yet; until then, add only exact amounts so there's no refund, or treat any refund as above.
- **Positions can be sent to the strategy by anyone,** so the close snapshot must not trust unknown positions.

## Part C, cross-contract sandbox run on 7 November 2026

Mainnet DCL 2.4.2 WASM and real `wrap.near` WASM in `near-sandbox`, called by a probe contract that stands in for the strategy (`spikes/gate3-access-keys/contracts/probe`, test `spikes/gate3-rhea-dcl/tests/partc.rs`). The USDC stand-in can block one receiver (`contracts/btoken`), standing in for a token that pauses or blocklists the strategy. The probe's callback records what it was told and at which block, then issues view reads; a second callback records them. Pool fee 100 (`create_pool` with fee 100 works in a fresh sandbox DCL). Single-shard sandbox, so block orders below are what happened there, not a mainnet guarantee.

| Question | Result |
|---|---|
| Do views work cross-contract? | **Yes**, with enough gas: `get_pool`, `quote`, `predict_add_liquidity`, `get_lostfound`, `get_liquidity`, `list_liquidities`, `list_user_assets`, `storage_balance_of`. Test `view_gas`: at 5 Tgas both `quote` and `predict_add_liquidity` fail; at 10 Tgas `predict_add_liquidity` works and `quote` still fails; at 15 Tgas both work (small pool, one hop; a busier pool may need more) |
| What does a deposit callback get? | `ft_transfer_call`'s result is the amount **used** as a JSON string (`"1000000000"`) |
| A swap DCL refuses (`min_output_amount` not met) | DCL panics `E204: slippage error`; the token's resolver refunds the whole input (memo `refund`) and our callback is told **`"0"` used**. Nothing is paid out. The refund behaviour is the test token's (near-contract-standards), not checked against native USDC. The failed receipt **still carries a `swap` event** with an `amount_out`: anything reading DCL events must ignore logs from failed receipts |
| A swap whose output payout fails | Our callback is told the **whole input used** (`"1000000"`). The output transfer fails a block later and DCL then **credits the output to our DCL internal balance** (`list_user_assets`), with a `lostfound` event marked `"locked": false`. `get_lostfound` stays 0 |
| `remove_liquidity` whose payout fails | Our callback runs **in the same block as the payout `ft_transfer`** and is told the full `[x, y]`. DCL's own bookkeeping of the failure runs a block later. The failed token goes to our **DCL internal balance**, `"locked": false`, not to `get_lostfound`. The token that didn't fail arrives in the wallet as normal |
| `withdraw_asset` whose payout fails | Returns `false` to our callback; the amount goes back to our internal balance (`"locked": false`). After the block lifts, `withdraw_asset` returns `true` and the tokens arrive |
| Lost and found, `"locked": true` (test `locked_lostfound`, found by the audit) | A payee with **no DCL storage registration** whose payout fails gets a `lostfound` event with `"locked": true`, and the amount shows in `get_lostfound(account, token)`. The payee's own `withdraw_lostfound` panics `E002: not allowed for the caller` (an owner check). DCL's owner can call it; the test asserts that the payout goes to the owner (`recipient_id`) and that the owner's balance rises by the amount. Only one argument shape (`token_id` plus `account_id`) was tried. For a strategy, treat it as a permanent loss |
| `withdraw_lostfound` for a registered account | Panics `E002` (owner only). In every registered case tested, failed payouts went to the internal balance and nothing reached lost and found; the cases not tested (storage used up, DCL's real lock condition) are listed below |
| `add_liquidity` with more of one token than the range needs | DCL takes the **full** `amount_x` and `amount_y` from the internal balance, uses what it needs, and pays the rest **straight to the wallet by `ft_transfer`**, not back to the internal balance. Without `skip_unwrap_near` the unused wNEAR is **unwrapped to native NEAR** (a `near_withdraw` by DCL); with `skip_unwrap_near: true` on `add_liquidity` it arrives as wNEAR. The refund transfers run in the same block as our callback, which is told only the `lpt_id` |
| Are `unclaimed_fee_x/y` current in a view? | **Yes.** After swaps through the range, `get_liquidity` showed `unclaimed_fee_x` 5257 and `unclaimed_fee_y` 6025 without the position being touched, and the remove's `liquidity_removed` event reported exactly `claim_fee_token_x` 5257 and `claim_fee_token_y` 6025 |
| Does the remove's return include fees? | **Probably** (not confirmed). The return `[79509995, 120505042]` equals the event's `refund_token_x/y`. The wNEAR wallet delta equalled `refund_token_y`; the USDC payout was blocked, and the internal balance rose by exactly `refund_token_x`. No separate fee credit appeared anywhere. Confirm from the DCL source before the split depends on it |
| A gifted position (`nft_transfer` to the probe) | Accepted with no call to the probe, and it **takes one of the receiver's liquidity slots**. DCL's `storage_balance_of` shows `available: "0"` always and can't show this; `get_user_storage_detail({"user_id"})` can: at 0.5 NEAR (`storage_balance_bounds` min) it shows `max_slots` 40, `slot_price` 0.01 NEAR and `storage_for_asset` 0.1 NEAR (both asserted), so `max_slots = (deposit - 0.1) / 0.01`. Test `storage_exhausted` (asserted): after 40 gifts `cur_liquidity_slots` is 40, the 41st gift is refused, and the probe's own `add_liquidity` fails with `E107: not enough storage for slots`; control `min_storage_control`: the same add at minimum storage with no gifts succeeds. At exactly 40 of 40 slots (asserted; the slot count is checked before and after the full-slot steps, not between every one): a deposit works; a blocked-output swap's failed payout is `"locked": false` with the output landing in the internal balance exactly; `withdraw_asset` returns `false` while blocked and `true` once unblocked, paying exactly the internal amount; then `remove_liquidity` of a gifted position works and frees a slot, with its proceeds landing exactly where the event says (wallet, or internal balance for a blocked token; in the committed run the gift held only wNEAR, so the internal-balance case is shown only by the earlier failed payouts), and the probe's own `add_liquidity` succeeds again (back to 40). (Seen once in an uncommitted run, not asserted: DCL logged `liquidity_added` in a receipt that then failed with `E101: insufficient balance`, another case of T60.) The 41st gift is refused with `E107`. Test `slot_formula`: 1 NEAR gives 90 slots. DCL's owner has `modify_storage_params`; its effect on existing users is unverified |
| Many small positions in the range | Raise swap gas with no upper bound: after 40 small positions a 1000000 swap burnt about 65 Tgas at DCL (14 before). Asserted in `storage_exhausted`: with 100 Tgas attached the swap fails with "Exceeded the prepaid gas", the input is refunded in full, internal balances and `get_lostfound` are unchanged, and our callback is told `"0"`; with 280 Tgas it succeeds |
| `register_tokens` | Panics `E104: insufficient deposit` when called with 1 yoctoNEAR (probably the attached deposit, not storage). Not needed: deposits work without it |
| Gas | Per receipt at DCL: deposit 3 Tgas, `add_liquidity` 12, `remove_liquidity` 9, swap 8 to 14, `withdraw_asset` 4, failed-payout bookkeeping 3. Every token transfer 1 to 2 Tgas. Measured burnt gas, not the gas a chain must attach |

**What this means for the design (revision 10 audits: contract H1, H2, M3, M4, M8; security H4, M3, M6):**

- **A reported amount is never proof of arrival.** For removes and swaps, our callback is told the full amounts while the payout is still in flight, and DCL records a failure only afterwards. A single balance read isn't safe either: it counts anything donated in the window (T51), and on a multi-shard chain the read may run before a successful payout lands (unverified; the sandbox has one shard). In that case the payout arrives in the wallet, not the internal balance, so `withdraw_asset` wouldn't recover it, and `min(reported, observed delta)` would leave it uncredited. **The credit rule is a design decision for revision 11**, not settled here.
- **Where a failed payout goes depends on registration.** While the strategy is registered at DCL, a failed payout lands in its **DCL internal balance** (`locked: false`), visible in `list_user_assets` and recoverable with `withdraw_asset`. If it isn't registered, the payout becomes **`locked: true` lost and found, which only DCL's owner can withdraw, to itself**. So the strategy must confirm its DCL registration before any DCL call and never unregister; `exit_lostfound` can't work and settle must not wait on lost and found. **Only partly verified:** the cases tested are a registered account whose failed token already had an internal entry, a registered account with **no** entry for the failed token (test `registered_no_entry`: still `"locked": false`, and DCL creates the entry), and an account that never touched DCL. Tested since: a registered account at minimum storage with all 40 slots filled by gifts (`storage_exhausted`, still unlocked). Not tested: the asset-storage side (`storage_for_asset`, a failed payout needing a new asset entry when that is full); DCL's actual lock condition (source not read). Until then, treat "registered means unlocked" as a working assumption.
- **A refused swap reports `"0"` used**, so a swap credit must depend on the used amount.
- **Add refunds go to the wallet**, so `held` must be credited for them (or only exact amounts deposited), and every `add_liquidity` must pass `skip_unwrap_near: true`.
- **The fee source probably works** (the equality is printed, not asserted): `get_liquidity`'s `unclaimed_fee_x/y` read just before the remove matches what the remove pays as fees.
- Confirmed: DCL 2.4.2 has no `storage_unregister` or `storage_withdraw` (`MethodNotFound`, test `storage_not_recoverable`), and its export list (139 exports, read by two auditors) has no other way to take storage back; only an `upgrade` by DCL's owner could change that. `modify_storage_params` (owner only) is unverified for existing users.
- Still to check: whether a non-owner can `append_liquidity` or `merge_liquidity` into the strategy's position; `mint_v_liquidity` and `burn_v_liquidity` (E218 farming locks); `mft_transfer`, `nft_transfer_call` and `nft_approve` gifts; `batch_add_liquidity` and `batch_remove_liquidity`; whether the strategy can `nft_transfer` a foreign-pool gift away and free its slot; whether `nft_transfer` frees the sender's slot; whether E107 counts order slots; who `sponsor_id` is when a third party registers the strategy first; whether a gifted position can be farming-locked (E218) and so unremovable; removing a gift from another pool, then a failed payout at minimum asset storage (T63); mainnet DCL's slot parameters (`get_user_storage_detail`, `get_contract_storage_report`); payout ordering on a multi-shard chain under congestion (the sandbox has one shard); whether the remove's return includes fees (DCL source); native USDC's behaviour on a refused swap's refund and with a blocklisted strategy (fetch its WASM with `view_code`); the gas a full chain must attach.
- The tests assert: the refused swap's `"0"`; the blocked remove leaving the USDC wallet unchanged with nothing in `get_lostfound`; the `locked: true` case, `E002` for the payee and the owner receiving the amount; the `view_gas` pattern (5 Tgas both fail, 10 only `predict_add_liquidity` works, 15 both work). Also asserted: the blocked remove's callback told `["79509995","120505042"]`, the internal USDC rising by exactly 79509995 and the wNEAR wallet by exactly 120505042; a blocked `withdraw_asset` returning `false` and leaving the internal balance unchanged, then `true` once unblocked with the wallet gaining exactly the internal amount and the entry emptied; in `registered_no_entry`, the new internal entry equal to the swap's `amount_out` and `get_lostfound` staying 0; in `locked_lostfound`, lost and found equal to the swap's `amount_out` and empty after the owner's withdrawal. Reproduce by building the part A contracts first (`spikes/gate3-access-keys/build.sh`); the run on 7 November used `probe.wasm` sha256 `68310a3fd1497a54…` and `btoken.wasm` `e0abf3e384a0bb07…`. Also asserted: the blocked-output swap's callback told `"1000000"` with the output landing in the internal balance exactly and `get_lostfound` 0; `withdraw_lostfound` refused for a registered account; `withdraw_asset` `false` with `locked: false` when unregistered at the token; the `storage_exhausted` result. Still printed only: the block order of callback and payout, the deposit callback's value, the `swap` event in a failed receipt, the `register_tokens` E104, the gas figures, the add refunds, `skip_unwrap_near` on add, and the fee equality.

## Part D, a person-signed mainnet round trip (ready to run, 9 November: reviewed at 20d9e2b; waiting for a co-lead to read the reports and run it)

`scripts/mainnet-roundtrip.ts` answers what the sandbox couldn't, on the real fee-100 USDC/wNEAR pool: whether `remove_liquidity`'s return includes the fees (it prints the position's unclaimed fees before the remove, the `liquidity_removed` event's `claim_fee_token_x/y` and `refund_token_x/y`, and the amounts the call returned). A person reviews it and runs it from their own test account; signing is done by the NEAR CLI from their keychain, and the script never sees a key. Only nine (receiver, method) pairs on `dclv2.ref-labs.near`, native USDC and `wrap.near` can be built; amounts are capped at 5 USDC and 1 NEAR wrapped (test money counts toward the 500 USDC cap, D4); the RPC must report `chain_id` mainnet; a preflight refuses to start without enough USDC and NEAR or if the pool isn't the Running USDC/wNEAR fee-100 pool; each transaction is confirmed one at a time, its outcome is checked, and the script stops at the first failure. `recover` mode withdraws what a stopped run left in DCL.

**Before anyone runs `run` on mainnet** (SECURITY_PROCESS section 4): two independent `security-auditor` reports on the script, `/security-review`, and a co-lead reading both reports. The audits so far are logged in `docs/security/AUDIT_LOG.md`.

Confirmed by the dry run of 4b46c45 on 8 November (view calls only): mainnet DCL's `storage_balance_bounds` minimum is **0.5 NEAR** (500000000000000000000000 yoctoNEAR), the same as in the sandbox; `predict_add_liquidity` works on the live pool. The dry mode of the reworked script also calls `predict_add_liquidity` for the planned range and refuses when it asks for more than the amounts given.

**near-cli-rs, from its 0.31.1 source (read by a script audit on 8 November, not yet run here):** `json-args` is parsed and re-encoded with serde_json without `preserve_order`, so object keys reach the chain sorted (the script compares arguments with keys sorted); `Transaction ID:` is printed through `tracing` on stderr, not stdout (the script leaves stderr on the terminal and asks for the hash, accepting it only once and only if its receipts ran after the send started); `N yoctoNEAR` and `N NEAR` deposits parse. `run` and `recover` refuse any other `near` than near-cli-rs 0.31.x. Its exit codes are unverified. The script starts near with no terminal input, so a prompt fails the call instead of being answerable; never answer a near prompt or paste a key (script audits H L-3 and the diff audit L-1). **Unverified:** that near-cli-rs 0.31.x signs from the keychain with no terminal input; if it doesn't, the first send fails before anything is broadcast, and that is the first thing a run shows.

**Mainnet `tx` result shape** (read-only lookups by two script audits on 8 November): `status.SuccessValue` at the top level; `transaction.actions[0].FunctionCall.gas` is a JSON number and `deposit` a decimal string; every `receipts_outcome` entry has a string `block_hash`, and the receipts of one transaction can be in different blocks. The script's transaction match and its freshness check rely on these.

**`get_liquidity` of a removed position** (sandbox, DCL 2.4.2, `partc.rs` `removed_position_view`, asserted, 9 November): after a full `remove_liquidity`, `get_liquidity(lpt_id)` returns `null`, both as a direct view and as a cross-contract read from a callback (`ok:null`); an id that never existed also returns `null`. It does not panic.

Confirmed in the sandbox against DCL 2.4.2 (`partc.rs` `cross_contract`, 8 November): `get_liquidity(lpt_id)` returns `{ lpt_id, owner_id, pool_id, left_point, right_point, amount, unclaimed_fee_x, unclaimed_fee_y, v_liquidity, mft_id }`, so the owner field exists; `predict_remove_liquidity(lpt_id, amount)` returns a two-element array of decimal strings `[x, y]`, and in that run it equalled the remove event's `refund_token_x/y` exactly (79509995, 120505042). **Unsettled:** the event also reported `claim_fee_token_x/y` 5257 and 6025, yet part C saw the balances rise by exactly `refund_token` with no separate fee credit anywhere. So either `refund_token` (and the predict) already include the fees, or the fees went somewhere not read. Which one is not known; the DCL 2.4.2 source and the mainnet round trip decide it, and until then no design rule may assume either (an M1 blocker in ARCHITECTURE 5.11). On mainnet the script now also prints the change in wallet plus internal balance across the remove, which shows whether the fees were paid with the refund.

Run:

```bash
cd scripts
node mainnet-roundtrip.ts dry --account <your-test-account>.near --usdc 1 --wrap-near 0.2
```

with Node 22.18 or later (add `NODE_USE_ENV_PROXY=1` behind an HTTPS proxy, as in the cloud sessions); then, after the reviews above and reading the printed commands, the same with `run` and `--i-have-reviewed-this-script`. It needs the NEAR CLI (`near`, near-cli-rs) with the test account's key in its keychain, about 1 NEAR for storage and gas plus the amounts, and a few native USDC. The DCL storage deposit stays at DCL.

## Answer so far

The **key design works**, and is confirmed. **Rhea is mostly confirmed**: the contract id, pool ids, fee tiers, swap, add, remove, withdraw and the position and fee views are known (parts B and C). Open items are listed under part C. Contract work waits for revision 11 of the architecture, which replaces the parts gate 3 part C disproved (crediting, lost and found, settlement).

**Pinned reads (confirmed 7 November 2026).** A `call_function` query with `"block_id": 223429540` instead of `finality` returns `block_height` 223429540 and `block_hash` `Bd1imqBfPT9wg8zzPuAj19BC8tMUfb6PL6n1PfpQbiKx` (44 base58 characters), on both `archival-rpc.mainnet.near.org` and `rpc.mainnet.near.org`, with the same 847-byte `get_pool` result as the fixture. A block older than a non-archival node keeps is expected to be a node error, which `packages/near` refuses (`RPC: error from the node`); not yet seen.

## Still open

Needs mainnet RPC views (reachable from the cloud session since 7 November), the sandbox, or a team member's machine:

- [ ] Read `dclv2.ref-labs.near`'s contract metadata or source and record the exact arguments for `add_liquidity`, `remove_liquidity` (or the batch versions), fee claiming, and `get_liquidity` / `list_liquidities`.
- [ ] Confirm how a position's earned fees are reported per position. Also confirm that claiming fees and removing a position report the fee amounts separately. This decides whether the split uses fees collected per token, or the quote-only fallback (architecture 5.9).
- [ ] Confirm the views can value a position in the quote token, for the public profit and loss display. (Mid-run joins were dropped, D10.)
- [ ] Import `dclv2.ref-labs.near` and two tokens into the sandbox with `near-workspaces`' import from mainnet, and run add liquidity, swap through the range, collect fees and remove liquidity from our relay contract.
- [ ] Repeat with tiny amounts on mainnet, signed by a person.
- [ ] Choose the live pool (fee tier, token pair, recent volume) and record it here.
- [ ] Write the confirmed calls into `.claude/skills/rhea-dcl/SKILL.md`.

**Sign-off:** _pending_

## Mainnet view shapes, 7 November 2026

Read-only `call_function` views on `dclv2.ref-labs.near` at final finality (block 223429540), saved as fixtures in `packages/near/test/fixtures/`:

- `get_pool` for the USDC/wNEAR fee-100 pool: amounts are decimal strings; `fee` (100), `point_delta` (1) and `current_point` (401312) are JSON numbers; `state` "Running"; token_x USDC, token_y wrap.near.
- `predict_add_liquidity` takes `pool_id`, `left_point`, `right_point`, `amount_x`, `amount_y` (decimal strings) and returns `need_x`, `need_y`, `liquidity_amount` (decimal strings). Still to check in the sandbox: whether it can be called cross-contract inside `agent_rebalance` (ARCHITECTURE 5.10).

## Part E: block heights (9 November 2026)

**Confirmed (sample, read-only):** heights 223,775,091 to 223,777,090 on mainnet, 2,000 consecutive final heights, all returned a block from `block` with `block_id` on `https://free.rpc.fastnear.com`; none returned `UNKNOWN_BLOCK` (34 first hit the free tier's rate limit and all succeeded on retry). `https://rpc.mainnet.near.org` still answers single requests (a `status` at 14:15 UTC was normal), but under load it returns `-429` with "THIS ENDPOINT IS DEPRECATED", and it isn't archival (`earliest_block_height` 223,660,337, about 1.5 days back), so the check page needs an archival provider; the round-trip script's few calls are fine on it, and moving the scripts to another provider is a follow-up. `near.lava.build` is discontinued. Whether `free.rpc.fastnear.com` is archival is unverified. A sample isn't proof, so `packages/rules` doesn't depend on it: the state at a height with no block is the state after the latest block below it (EC-W22). Node 22's `fetch` doesn't use this container's HTTPS proxy; `curl` does.

**Confirmed (view call, block 223,847,461, 10 November 2026):** `get_pool` on `dclv2.ref-labs.near` for `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|wrap.near|100` returns that exact `pool_id`, `token_x` `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (native USDC), `token_y` `wrap.near`, `fee` 100, `point_delta` 1, `state` Running, `current_point` 401,620. These are the network constants in `contracts/strategy/src/limits.rs`.

**Confirmed (view calls, blocks 223,849,962 to 223,849,964, 10 November 2026):** `storage_balance_bounds` is `{"min":"1250000000000000000000","max":"1250000000000000000000"}` (exactly 0.00125 NEAR) on both native USDC and `wrap.near`, and `{"min":"500000000000000000000000","max":null}` (0.5 NEAR) on `dclv2.ref-labs.near`. Registration at DCL is `storage_deposit` alone: `register_tokens` panics `E104` with 1 yoctoNEAR and isn't needed (line 127 above, `spikes/gate3-rhea-dcl/tests/partc.rs`), so `new` never calls it. (Corrected 10 November 2026: an earlier version of this paragraph misread the part B spike as calling it successfully; the security audit of slice 2 caught it.)

**Settled in Part F below (slice 2b sandbox, asserted); kept as the list slice 2 needed:** that DCL's `storage_deposit` returns a plain value, not a promise (a failed receipt then means the NEAR came back); that a second `storage_deposit` from an already-registered account is credited, not refunded; that `storage_balance_of` returns `null` for an account that isn't registered; that native USDC and `wrap.near` refund a `registration_only` deposit from an account already registered. A third party can register the strategy at DCL with the 0.5 NEAR minimum (line 138's open item), so a re-check requires `total >= dcl_storage`.

## Part F: strategy slice 2b in the sandbox (10 November 2026)

**Confirmed and asserted (local sandbox, `contracts/strategy-sandbox/tests/new.rs`, against the mainnet DCL 2.4.2, native USDC and wrap.near code fetched by `view_code`, and the near-sandbox 2.14.0 binary, all checked against the hashes pinned in `contracts/strategy-sandbox/wasm/README.md`; the tests refuse to start otherwise).** The quote token runs native USDC's code and the base token wrap.near's, as on mainnet. Each item below fails a test if it stops being true:

- DCL `storage_balance_of` returns `null` for an account that isn't registered.
- DCL `storage_deposit` succeeds and returns exactly `{"available":"0","total":"<deposited>"}` as a plain value (its receipt's status is a value, not a promise); so a failed receipt means the NEAR came back.
- A second DCL `storage_deposit` for a registered account succeeds and is **credited** (total exactly 1 → 2 NEAR), not refunded: paying it twice loses NEAR, which is why the strategy never does.
- Native USDC's code and wrap.near's both report `storage_balance_bounds` min 0.00125 NEAR, and both accept a `registration_only` `storage_deposit` from an account already registered and refund it: the call succeeds, a 1 NEAR call costs the same as a bound-only call to within 0.001 NEAR and each costs under half the bound, and the account's total stays 0.00125 NEAR.
- The parent-signed deploy batch (create, fund, key, deploy, `new`) at exactly `MIN_GAS_NEW` (200 Tgas) succeeds: the full event list is exact (`new`, three starts, three `Ok` results), each registration at nonce 1; each token holds exactly 0.00125 NEAR and DCL exactly `dcl_storage` for the strategy; the strategy paid those deposits and no more (its balance is within its gas rewards, under 0.002 NEAR, above funding minus them). At 199 Tgas the batch is refused (`LIMIT: gas`) and reverts.
- A refused `new` reverts the whole batch, deploy included: no account, no events, no storage at DCL or either token. A second `new` is refused (`already been initialized`) and an outsider's direct callback is refused with `AUTH: callback only` on chain; neither changes registrations, status or any storage.
- A registration whose token has no contract ends `Failed` with an `ok: false` event, its 0.00125 NEAR comes back to the strategy, and the other two stay `Ok`; the creator's retry at `MIN_GAS_RETRY` then ends `Ok` at nonce 2.
- A DCL registration left `Pending` (set by patching the state, as a lost callback would leave it) is refused before `stale_after_blocks` have passed, with nothing changed; once stale, the retry is a re-check only (`check_only: true`): no deposit, DCL's real `storage_balance_of` answer is parsed, its total equals `dcl_storage`, and it ends `Ok`.
- Gas, asserted as bounds: each token's and DCL's `storage_deposit` burns under half of `GAS_REGISTER` (15 Tgas); each callback under half of its fixed 10 Tgas; the retry's own receipt under 10 Tgas.

**Printed only (not asserted), from the run on 10 November 2026:** the deploy batch's strategy receipt (create, fund, key, deploy and `new` together) burnt 34.4 Tgas; each callback about 1.7 Tgas; each token `storage_deposit` about 1.5 Tgas and DCL's about 3.2; a retry's own receipt about 2.4 Tgas.

**Not covered here:** behaviour under real mainnet congestion or sharding (the sandbox is one shard), and DCL or token code newer than the pinned hashes: refresh the hashes and rerun `run.sh` whenever one changes.

## Part G: funding and withdraw on the real tokens, sandbox (11 November 2026)

**Confirmed and asserted** unless marked (local sandbox, `contracts/strategy-sandbox/tests/funding.rs` and the helpers in `tests/common/mod.rs`, against the same pinned native USDC and wrap.near code and near-sandbox binary as Part F):

- **Minting with native USDC's code** (needed by every sandbox test that moves USDC): `init` with two accounts in `admin_ids` and `master_minter_ids`. Every privileged change is a multisig request (`create_multisig_request({action})`, then `approve_multisig_request({request_id})` by **two** approvers, then `execute_multisig_request({request_id})`; one approval fails `InsufficientApprovals { current: 1, required: 2 }`). `ConfigureController {controller_id, minter_id}` is approved by master minters (observed: a non-master-minter's approval failed `caller is not a MasterMinter`; not asserted); `ConfigureMinterAllowance {controller_id, minter_allowance}` by **two controllers of the same minter**, so a second `ConfigureController` for that minter comes first (observed in the probe, where one controller's second approval failed `caller is not a Controller`; not asserted). Then the minter calls `mint({to, amount})`, with `to` registered (asserted by use; that `account_id` is refused, `missing field to`, was observed only). Helpers: `enable_usdc_minting` and `mint_usdc` in `contracts/strategy-sandbox/tests/common/mod.rs`. This is test setup only: on mainnet nobody on the team can mint.
- Native USDC's `ft_transfer_call` to the strategy calls `ft_on_transfer` and refunds exactly the returned amount: a fund one above `max_principal` leaves exactly the cap with the strategy and refunds 1; a returned 4 KB `msg` transfer and an outsider's wNEAR (wrap.near's code) in `Open` are refunded in full.
- `ft_on_transfer` burns under 5 Tgas (printed: 1.78 Tgas for a fund, 1.82 for a 4 KB `msg`).
- `ft_balance_of` on native USDC answers a string the contract's strict parser accepts; `withdraw` at `MIN_GAS_WITHDRAW` (100 Tgas) pays the creator exactly the balance read; one gas unit below is refused `LIMIT: gas`. Native USDC's `ft_balance_of` and `ft_transfer` (1 yoctoNEAR) each burn under half their fixed 10 and 20 Tgas, and the balance callback under half its fixed 50 (printed: 1.4, 2.1 and 2.4 Tgas).
- Native USDC with the creator **blocklisted** (`blocklist({account_id})` by the blocklister): the strategy's `ft_transfer` receipt fails, the USDC stays with the strategy, the `withdraw` event says `ok: false` and the lock is released; after `unblocklist`, the next `withdraw` pays the creator in full (T27, M10 for `withdraw`).
- An `ft_transfer` on wrap.near's code to an account not registered there fails the receipt, the tokens stay with the sender, and the strategy's callback sees the failure; after the payee registers, the next transfer succeeds.

**Not covered here:** how many blocks a token's `ft_resolve_transfer` refund can land after `ft_on_transfer` under congestion (the sandbox is one shard; `QUIET_INBOUND_BLOCKS` stays tied to the unmeasured `PAYOUT_SETTLE_BLOCKS`, ARCHITECTURE 5.11), a gas-starved `ft_transfer_call` (EC-C134), and native USDC's `ft_transfer` to an unregistered payee.

## Part H: `start` on the real pool, sandbox (11 November 2026)

**Confirmed and asserted** (local sandbox, `contracts/strategy-sandbox/tests/start.rs`, same pinned DCL 2.4.2, native USDC and wrap.near code as Parts F and G):

- `create_pool({token_a, token_b, fee, init_point})` with 1 NEAR attached, called by DCL's owner, returns the pool id; `get_pool` then reads back `token_x` = the lower account id, `token_y`, `fee` 100, `point_delta` 1 and `current_point` 401312 as a JSON number, `state` `"Running"`, every amount a decimal string.
- `get_user_storage_detail({"user_id"})` for a strategy registered with 2 NEAR returns `{sponsor_id, locked_near, storage_for_asset, slot_price, max_slots, cur_order_slots, cur_liquidity_slots}`: `max_slots` 190 (`(2 - 0.1) / 0.01`), the other two counts 0, all three **JSON numbers**. `cur_order_slots` is the confirmed name (ARCHITECTURE 5.11).
- `storage_balance_of` on native USDC, wrap.near and DCL answers `{"total", "available"}` for a registered account and `null` for an unregistered one (including an account that doesn't exist yet).
- `start` as built: the six reads (DCL `get_pool` and `get_user_storage_detail` at 10 Tgas; the four `storage_balance_of` at 5 Tgas) run in parallel and one callback reads them in order. Each read burns under half its budget (DCL 2.5 Tgas, tokens 1.2 to 1.4), the callback 3.1 Tgas of its fixed 30, and the strategy's own `start` receipt 4.6 Tgas. A start with the platform account missing is refused in the callback (`payee not registered`), releases the lock and leaves the strategy `Open`; with the platform registered, a point 31 past the expected one is refused (`drift`) and one exactly 30 away starts it.
- **Gas for the call:** `MIN_GAS_START` is 200 Tgas and a start at exactly 200 Tgas succeeds; one unit below is refused `LIMIT: gas`. Six receipts that each feed a callback cost about 14 Tgas each in fees on top of the gas attached (the unit-test mock's `used_gas` after `start` is about 160 Tgas against 70 attached), which is why the call needs far more prepaid gas than the 70 it forwards. The lowest working prepaid gas was **not** searched for.

**Not covered here:** a pool in the `Paused` or `Locked` state (only `Running` is seen), a DCL whose `get_pool` answer is over 4 KB, and the mainnet pool's real slot parameters (5.11).

## Part I: `close` and `settle` on the real DCL, sandbox (11 November 2026)

**Confirmed and asserted** (`contracts/strategy-sandbox/tests/settle.rs`, same pinned code as Parts F to H):

- `list_user_assets({"account_id"})` answers `{}` (an empty JSON object) for a registered account with no internal balance, and for an account DCL has never seen.
- `settle` (status `Closing`) reads it under the lock and closes: with the answer `{}` the callback moves the strategy to `Closed` and sets `closed_at_ns`. The read burns under half of its 10 Tgas, the callback 1.8 Tgas of its fixed 20, and `settle` at exactly `MIN_GAS_SETTLE` (80 Tgas) succeeds; one unit below is refused `LIMIT: gas` with nothing stamped.
- An outsider can't `close` a `Running` strategy before `run_end_ns` (`AUTH: creator only before run end`); the creator can; once `Closed`, a second `settle` and a second `close` are refused.

**Not covered here:** the shape of a **non-empty** `list_user_assets` answer. `settle`'s callback reads it as a map from token id to a decimal string and refuses (`LIMIT: read failed`) anything else, so a different real shape fails closed, but it is a guess until confirmed. A normal account's `ft_transfer_call` with msg `"Deposit"` to the sandbox DCL failed `E016: token not registered` even after `create_pool`, with DCL registered at USDC and the account registered at DCL; what DCL needs besides (a whitelist, `extend_whitelisted_tokens`, `register_tokens`) was **not** found (one `extend_whitelisted_tokens` attempt with `{"tokens": [...]}` and 1 yoctoNEAR failed). The trading slices must settle it before `agent_open`. Also not covered: a block-timestamp past `run_end` (the sandbox clock can't be moved), where anyone may `close`; that is a unit test.

## Part J: `register_tokens`, deposits and `withdraw_asset`, sandbox (11 November 2026)

Local sandbox, the pinned DCL 2.4.2 code, native USDC's code at `usdc.test.near` and a normal account (the creator) with 1 NEAR of DCL storage. Findings from a scratch probe (not committed; the figures below were printed, not yet asserted by a committed test):

- **A deposit needs `register_tokens` first.** `ft_transfer_call` of 5 USDC with msg `"Deposit"` failed `E016: token not registered`, with DCL registered at the token, the account registered at DCL (1 NEAR) and the pool created. After `register_tokens({"token_ids": ["usdc.test.near"]})` the same deposit succeeded and `list_user_assets` answered `{"usdc.test.near":"5000000"}`. **This contradicts the earlier note that `register_tokens` "isn't needed"** (Part B and the skill): that note came from a 1 yoctoNEAR call that failed `E104`.
- **`register_tokens` takes about 0.01 NEAR per token as an attached deposit and it comes back.** One token: 0.001 and 0.005 NEAR failed `E104: insufficient deposit`, 0.0099 and 0.01 succeeded. Two tokens: 0.0099 failed, 0.0199 and 0.02 succeeded. The account's balance did not fall by the attached amount (only gas), so the deposit is checked and returned, or paid from the account's DCL storage; the probe cannot tell which. A second registration of the same token succeeds. A failed call costs only gas.
- **`list_user_assets`, non-empty:** a flat JSON object from token id to a decimal string, as `settle`'s callback reads it. `{}` when empty (Part I).
- **`withdraw_asset`** (no deposit; a call with 1 yoctoNEAR attached is refused): `{"token_id"}` alone withdraws the whole internal balance, returns the JSON value `true`, and the wallet gets it back (internal balance `{}`, wallet 10,000,000 of 10,000,000). `"amount"` as a **decimal string** withdraws that part (1,000,000 of 5,000,000 left 4,000,000 inside); `"amount": null` or no amount withdraws all; `"skip_unwrap_near": true` is accepted. `"amount"` as a JSON **number** fails to deserialise. An explicit amount above the balance failed (the call returned a failed receipt); a call with `"amount": null` on an empty balance returned `true`.

**Consequence, not yet in the design:** a strategy must call `register_tokens` at DCL for both pool tokens (with at least 0.01 NEAR per token attached) before its first deposit, whereas ARCHITECTURE and `new` say it never calls it. Whether a *payout* to an account that hasn't registered the token still lands in its internal balance (Part C saw it for registered accounts) is **not** known. This is an ARCHITECTURE 5.11 item; the registration belongs before `agent_open`'s deposit stage and needs its own design audit.

**Not covered:** whether the same holds from a contract account (the probe used an ordinary account), the exact minimum below 0.0099 NEAR for one token, and `withdraw_asset`'s behaviour for a failed payout to an unregistered or blocklisted account (Part C saw `false`).

## Part K: claims and `exit_withdraw` on native USDC and the pinned DCL, sandbox (11 November 2026)

**Confirmed and asserted** (`contracts/strategy-sandbox/tests/claims.rs`; `fees_collected` set by patching the state of a `Running` strategy, as nothing in this build raises it):

- `claim_platform` on native USDC: the callback reads `ft_balance_of`, raises `paid_platform` and sends one `ft_transfer` of 1 yoctoNEAR to the platform account; the platform receives exactly its twentieth of the fees (1,000,000 of 20,000,000), the strategy's USDC falls by the same, the lock is released and each receipt burns under half its budget (USDC read 1.4 Tgas, transfer 2.1, the leg callback 1.9). A second platform claim by the same class is `rate limited`, by another class `nothing owed`.
- `claim_creator` with nothing owed (before the platform window): the creator receives the whole wallet (499,000,000), the strategy ends at 0; the same class again is `rate limited`. While the platform is owed anything the creator is `LIMIT: platform window` until `closed_at + platform_claim_window`, and only the creator may call it (`AUTH: creator only`).
- **A blocklisted platform** (native USDC's `blocklist` on `platform.test.near`): the platform leg's `ft_transfer` fails on the real token, the claim event says `ok: false`, `paid_platform` is restored to 0, no USDC leaves the strategy and the lock and in-flight record are cleared. After `unblocklist`, the creator's own `claim_platform` pays the 1,000,000 (T66).
- `exit_withdraw` on the real DCL with an empty account: the creator may call it while `Running`, an outsider is `LIMIT: exit not open yet`, one gas unit below `MIN_GAS_EXIT` is `LIMIT: gas`, the read answers `{}`, the call writes only an event (`nothing to withdraw`), opens no settle window and leaves the lock free; a repeat inside the interval is `rate limited`.

**Not covered here:** `withdraw_asset` called by the *strategy* account (it has no internal balance to withdraw in this build; the call shape was confirmed for an ordinary account in Part J), a `false` result and the stuck-token count against the real DCL (unit-tested), and the claim windows at `closed_at + platform_claim_window` (the sandbox clock can't be moved; unit-tested at the nanosecond). Observed burn: the claim's balance callback burnt about 2.6 Tgas of its fixed 100 and the exit's read callback 1.9 of its 90, so those budgets are generous; the lowest prepaid gas that works was not searched.

## Part L: `agent_swap` on the real pool, sandbox (11 November 2026)

**Confirmed and asserted** (`contracts/strategy-sandbox/tests/trade.rs`; the pool is seeded by an LP account, which needs DCL registered at both tokens with `storage_deposit`, its own DCL `storage_deposit` and `register_tokens`, `ft_transfer_call` of `"Deposit"` for each token and `add_liquidity({pool_id, left_point, right_point, amount_x, amount_y, min_amount_x, min_amount_y})` with no deposit):

- `predict_add_liquidity` over a 1,000-point range at the live point with a probe of 10^18 token_x and 10^36 token_y returned `need_x` = 10^18 and `need_y` = 2.689 x 10^35, whose ratio is the pool's price at the point (1.0001^401312 = 2.689 x 10^17): the probe is large enough that the returned `need` carries the range's ratio. It burnt 8.25 Tgas (budget now 25).
- A swap of about half of 500 USDC: the strategy sent `ft_transfer_call` on native USDC to DCL with msg `{"Swap":{"pool_ids":[...],"output_token":"wrap.test.near","min_output_amount":"...","skip_unwrap_near":true}}` and 1 yoctoNEAR; DCL used the whole amount, the result callback received the used amount as a JSON string, the wNEAR arrived in the wallet and was at least the contract's own reference-based minimum. The swap burnt 14.8 Tgas at DCL of the 90 forwarded; the read round's callback 6.8 Tgas of its fixed 150 and the result callback 2.0 of its 10.
- The agent account named in the config is the only caller (`AUTH: agent only`); one gas unit below `MIN_GAS_SWAP` is refused; a second call inside `min_action_interval_s` is `LIMIT: action interval`; an observation 31 points from the pool's own read is recorded `Refused("drift")` with no token moved, no window opened and the lock free.

**Not covered here:** DCL's `quote` (its arguments are still unconfirmed: the contract uses the reference-based floor alone, which can only fail a swap, never accept a worse price than the floor); a swap in a pool with many small positions in range (T62: gas grows without bound with small gifted positions); the lowest prepaid gas that works (280 Tgas is the tested value).

## Part M: `register_tokens`, `agent_open`, `agent_close_position` and `exit_remove` by the strategy, sandbox (12 November 2026)

**Confirmed and asserted** (`contracts/strategy-sandbox/tests/open.rs`, `remove.rs`; the pinned DCL 2.4.2 and native USDC; a contract account, not an ordinary one):

- `register_tokens({"token_ids": [usdc, wnear]})` with 0.02 NEAR attached works from the strategy; the account's balance fell by about 0.011 NEAR (gas), not by the deposit.
- A deposit is `ft_transfer_call` with `msg` `"\"Deposit\""` (a JSON string) and **needs well over 30 Tgas attached**: at 20 Tgas both receipts failed. At 40 both returned the whole amount. DCL's deposit burnt about 3 Tgas.
- `add_liquidity({pool_id, left_point, right_point, amount_x, amount_y, min_amount_x, min_amount_y, "skip_unwrap_near": true})` is accepted (the extra field does not fail it) and returns the position id `usdc.test.near|wrap.test.near|100#2`. It **failed at 25 Tgas with the position event already logged ("Exceeded the prepaid gas")**, so the whole call reverted: the refund payouts need gas. 60 Tgas works; DCL's own burn was 12 Tgas.
- `get_liquidity` of the new position: `owner_id` is the strategy, the points are the ones sent. After the add the wallet kept only the unused part of the swap's output.
- `predict_remove_liquidity(lpt_id, amount)` and `remove_liquidity({lpt_id, amount, min_amount_x, min_amount_y, skip_unwrap_near: true})` work from the strategy at 90 Tgas (DCL burnt about 10); the tokens land in the wallet and `get_liquidity` then returns `null`. `fees_x` and `fees_y` were 0 in the test (no swap crossed the range afterwards).
- Strategy receipts burnt 2 to 5 Tgas each against fixed budgets of 10 to 220.
- A callback called directly by any other account is refused `AUTH: callback only`.
- `settle` refuses (`settle_refused`, `LIMIT: own position exists`) while the position exists and closes once it is removed.

**Not covered:** whether a removal's return includes the fees (Part D); a second `register_tokens` after a first that succeeded; the minimum gas below 300 Tgas for `agent_open` (300 is the tested value and the ceiling); a gifted position; slots.
