# Strategy contract interface: v1 FROZEN (12 November 2026)

**Status: frozen for v1 (D55), 12 November 2026, at the commit that adds this text.** Every item marked **Built** below will not change name or shape; later versions add variants and fields only, and clients must accept unknown ones (treat them as "can't check"). Items marked **Planned** or **Proposed** are **not in v1** (the minimal plan, `MINIMAL_PLAN.md` section 2, lists what was cut: viewing keys, the alerter's inputs, pause, `set_agent`, the heartbeat, parked chains, lost-add recovery, gift cleanup); a client must not depend on them, and the check page reads their absence as "not in v1". Where this file and ARCHITECTURE disagree, **this file wins** for v1. The text below was written 11 November 2026 from ARCHITECTURE revision 27 (5.3, 5.5, 5.6, 5.8) and the check page's needs (`docs/BRIEFING-backend.md` section 4 on the front-end branch, and its reply of 11 November). It exists so `apps/web`, `apps/agent` and `apps/alerter` can build against one list of names now. The M1 interface pull request freezes it, in its own small pull request (`CLAUDE.md`), once the blocking items of ARCHITECTURE 5.11 are settled.

Each item is marked:

- **Built**: on the branch now, tested, and will not change name or shape.
- **Built, growing**: built and frozen for v1; later versions add enum variants or fields, so clients must accept unknown variants and fields (and treat them as "can't check").
- **Planned**: named by ARCHITECTURE; the name is stable, the shape may still change.
- **Proposed**: not in ARCHITECTURE yet; needs a design change and its audit before it is built.
- **Open (5.11)**: blocked on an ARCHITECTURE 5.11 item; don't rely on the shape.

## 1. Wire conventions

- JSON in and out. Every u64 and u128 is a decimal string (`U64`, `U128`). **Outputs** always match `0|[1-9][0-9]*`; read them with `readU64` and `readU128`. **Inputs** are read by near-sdk's `U64`/`U128`, which accept `"+5"` and `"007"` (a known v1 limit: the strict newtypes and the parsing test over `number_spellings.json` and `amounts.json`, principle 10, EC-R25, are not built); a client always writes canonical strings. Hashes are 64 lowercase hex characters. Account ids are strings.
- Enums are serialised by serde's default: a unit variant is a string (`"Open"`); a variant with fields is an object with one key (`{"Withdraw": {"token": "…"}}`).
- Refusals by the contract's own checks panic with a stable message that starts with `LIMIT:` or `AUTH:` (`STATE:` is a `packages/rules` prefix, not the contract's). The page shows them as they are, so once frozen a message never changes. A strategy receipt can also fail **without** a known prefix (bad JSON or enum arguments, an attached deposit on a non-payable method, `#[init]` twice, gas exhaustion): clients still report it, and the page treats it as "can't check", never as a refusal by a public limit.
- **Event provenance (T74).** A log line is text any contract can emit. Clients trust a `poolside` event only from a **successful** receipt whose **executor is the strategy account**, read through both RPC providers (EC-W08). Events are triggers and context only: every decision is taken from contract state read by a view at a final block. In particular the deliverer reads the buyer and `buyer_pubkey` from the key-sale view before sealing, never from an event's fields.

## 2. Status

`get_status()` returns one of `"Open"`, `"Cancelled"`, `"Running"`, `"Closing"`, `"Closed"` (all **built**).

## 3. Views

| View | Returns | State |
|---|---|---|
| `get_config()` | `ConfigArgs` as given to `new`, except `agent`, which `set_agent` changes while paused (5.3). Clients read `get_config().agent` at each sampled height (the agent at that record's height), never once at deploy | Built (`agent` changes when `set_agent` lands) |
| `get_limits()` | `LimitsArgs` as given to `new` | Built |
| `get_status()` | Status string | Built |
| `get_registrations()` | `{quote_token, base_token, dcl_storage}`, each `{state: "Pending"\|"Ok"\|"Failed", nonce, launched_block, deposit_may_have_landed, deposit_block}` (numbers are plain JSON numbers here, all below 2^53) | Built |
| `get_principal()` | `U128` | Built |
| `get_lock()` | `null` or `{op_id: U64, op, stage, promise_block: U64}`; `op` and `stage` gain variants, and a parked chain adds park and continuation fields | Built, growing |
| `get_last_inbound_block()` | `U64` | Built (not yet in ARCHITECTURE 5.5's view list; added there at the freeze) |
| `get_stale_resolution_block()` | `null` or `U64` | Built (as above) |
| `get_actions(from: U64, limit: u32)` | `ActionRecord[]` (section 5), at most 20 a page, from index `from` | Built |
| `get_actions_len()` | `U64`, the number of records (at most 64) | Built |
| `get_ring(from: U64, limit: u32)` | ring records | Planned |
| `get_last_heartbeat()` | `{chain_head, prev_head, block, timestamp_ns}` | Planned |
| `get_unknown_add()` | `null` or `{left, right, stale_resolution_block, stale_resolution_ts}` | Planned |
| `get_fees_collected()` | `{quote: U128, base: U128}`: per token, the sum over removals of the own position of `min(unclaimed_fee, reported)` (S9); a lower bound | Built |
| `get_platform_owed(token)`, `get_paid_platform(token)` | `U128`, `token` a pool token exactly (`LIMIT: not a pool token` otherwise); owed = `fees_collected / 20 - paid_platform`, at least 0 | Built |
| `get_claim_in_flight()`, `get_withdraw_failures()` | `null` or `{id, token, platform_amount, platform_pending, creator_pending}`; `[{count, first_ns, last_ns}, ...]` per token (quote, base) | Built |
| `get_closed_at()` | `null` or `U64` (ns), the block timestamp at which `settle` moved to `Closed` | Built |
| `is_quiet()` | bool, computed from stored values and the current block | Planned |
| `get_quiet_since_block()` | `U64` | **Not in v1** (the contract's quiet point is `settle_until_block`) |
| `get_last_payout_callback_block()` | `U64` | Built |
| `get_settle_until_block()` | `U64`; 0 until the trading and exit slices set it from payout callbacks | Built |
| `get_settle_window()` | `{last_payout_callback_block, settle_window_class, settle_until_block}` (an object, where ARCHITECTURE 5.2 has a tuple: **proposed** shape, built); class is `"Outsider"`, `"Creator"` or `"Agent"` | Built |
| `get_lost_counts()` | per token `{count, last_block}` | Planned |
| `get_opened()`, `get_swaps_used()`, `get_own_position()` | bool, u8, `null` or the `lpt_id` string | Built |
| `is_paused()`, `get_near_owed(account)` | bool, `U128` | **Proposed** (interface audit L-6: the page and alerter read the pause at each height from state, not events) |
| `get_constants()` | `{payout_settle_blocks, offchain_margin_blocks, confirm_max_blocks, pair_window_s, dense_step_blocks, quiet_inbound_blocks, adopt_window_s, max_swaps_per_run}` (field set **proposed**); the page refuses a run whose values differ from `packages/rules` as "can't check" (5.11, rules-verifier L-4) | Planned |
| `get_deploy_block()` | `U64`, the block of `new`. **A hint only (built):** it is contract state, which code deployed before the audited code could have written (EC-W16). The page establishes the creation block from chain data: the account doesn't exist at the block before on both providers, and the creating transaction is exactly create, transfer, add key, deploy and `new` (ARCHITECTURE 8); if the hint and the chain disagree the result is "not matching" or "can't check", never matching | **Not built in v1**; a hint only, the page establishes creation from chain data (EC-W16) (front end, 11 November) |
| Key sales: `get_key_sale(account)`, `get_key_sales(from, limit)`, `get_sealed_key(buyer)` | sale `{buyer_pubkey, state: "Escrowed"\|"Released"\|"Refunded", bought_at_ns, sealed_key?, rekey_pending}`; price and caps are in `get_config` | **Superseded by section 9 (D57, viewing keys on testnet/sandbox)**: use section 9's shapes |
| `get_revealed()` | `null` or the exact string `reveal` accepted and hashed, byte for byte; `reveal` never re-serialises it (rev 16 contract L6), so the page hashes what it reads | **Built** (S10) |
| `get_tokens_registered()` | bool: `register_tokens` succeeded at DCL for both pool tokens | **Built** (S8) |
| `get_started_at()` | `null` or `U64` (ns), the block timestamp at which `start`'s callback moved to `Running`; also in the `start` event as `started_at_ns` (`MarketState.startedAtS`) | **Built** |
| `get_action(index: U64)` | one `ActionRecord` or `null`, so the page parses each record on its own with `strictParse` (EC-R25), never a whole array | Built |

**Archival reads.** Every view is read by the page at sampled heights through two providers (EC-W08). A height with no block has the state after the latest block below it (EC-W22). That is `packages/near`'s job, not the contract's.

**Account snapshots** come from the chain, not the contract: `view_access_key_list` (each key's public key, its permission as `FullAccess` or function-call `{receiver_id, method_names, allowance}`, and its nonce) and the account's `code_hash` at a height. The nonce alone isn't enough; the permission must be compared too (front-end audit, EC-W07). Planned in `packages/near`.

## 4. Methods (callable)

| Method | Caller | State |
|---|---|---|
| `new(config, limits)` | strategy account or its parent | Built |
| `retry_registration(target)` | creator, `Open` | Built |
| `ft_on_transfer(sender_id, amount, msg)` | a pool token. Only in `Open`, only the creator's USDC with `msg: "fund"` is credited, up to `max_principal`, the excess returned; every other pool-token transfer in `Open` is returned; in every later status pool-token transfers are kept as holdings and **never** raise `principal`; a plain `ft_transfer` never calls it and is never credited (ARCHITECTURE 5.5, EC-C03, EC-C40). A funding flow must use `ft_transfer_call` with `"fund"` in `Open` | Built |
| `cancel()` | creator in `Open`; anyone from `start_deadline` | Built |
| `withdraw(token)` | creator, `Cancelled` | Built |
| `resolve_stale()` | anyone (any lock in flight: a lost swap, open, remove or withdraw is resolved; the `StaleRead`/`StaleConfirm` stages are not in v1) | Built |
| `start(expected_point)` | creator, `Open`, before `start_deadline`. `expected_point` is an integer within ±800,000. Returns a promise; the strategy becomes `Running` only in the callback, so a client waits for the `start` event or polls `get_status` | Built; **not deployable alone**: the only way out of `Running` is built in later slices (`close`, the exits and the claims), so this build must never hold a funded account |
| `on_start_reads(op_id, expected_point)` | the contract itself | Built (callback) |
| `close()` | the creator in `Running`; anyone from `run_end_ns`; refused while an operation holds the lock | Built |
| `settle()` | anyone, `Closing`, rate-limited per caller class; returns a promise (one `list_user_assets` read) and the strategy is `Closed` only in the callback, so a client waits for the `settle` event | Built |
| `on_settle_assets(op_id)` | the contract itself | Built (callback) |
| `agent_swap(left_point: i32, right_point: i32, meta)` | the agent (by predecessor), `Running`; `meta` is `{observed: {block: U64, point: i32}, decision_hash: 64 lower-case hex, chain_head: null or hex}`. Returns a promise; the outcome is the record's `result` and the `action_result` event. Needs `MIN_GAS_SWAP` (280 Tgas) | Built |
| `on_swap_reads(op_id)`, `on_swapped(op_id)` | the contract itself | Built (callbacks) |
| `exit_withdraw(token)` | the agent or the creator in `Running`, `Closing` and `Closed`; anyone from `run_end + exit_grace`; rate-limited per (token, class); a promise, the result is the `exit_withdraw` event | Built |
| `claim_platform(token)` | anyone, `Closed`, rate-limited per (token, class); pays the platform `min(owed, wallet)` | Built |
| `claim_creator(token)` | the creator, `Closed`, from `closed_at + platform_claim_window` or once the platform is owed nothing; pays the platform and the creator from one wallet read | Built (deviation from 5.5, listed in 5.11) |
| `on_exit_assets`, `on_exit_withdrawn`, `on_claim_balance`, `on_claim_leg` | the contract itself | Built (callbacks) |
| `pause()`, `unpause()`, `set_agent(new)` | creator | **Not in v1** (D55) |
| `register_tokens()` | the creator, `Running`, once; no arguments; needs 60 Tgas; attaches 0.02 NEAR of the contract's own balance to DCL (returned); a promise, the outcome is the `tokens_registered` event and `get_tokens_registered()`. Refusals in order: `LIMIT: wrong status`, `AUTH: creator only`, `LIMIT: operation pending`, `LIMIT: tokens already registered`, `LIMIT: gas`, `LIMIT: balance for registration` | **Built** (S8) |
| `agent_open(left_point: i32, right_point: i32, meta)` | the agent, `Running`, after `register_tokens`; `meta` as `agent_swap`; needs 300 Tgas (`LIMIT: gas` below); deposits what the add needs and adds liquidity in four stages (reads, deposits, reads, add); the outcome is the record's `result` and `get_own_position()`. A decision hash equal to the previous `Swap`'s (result `Ok`, `used > 0`, `now - result_ts_ns < 3,600 s`) is a **paired open** and skips only the interval; every other open needs a new hash | **Built** (S8) |
| `agent_close_position(position: string, meta, confirm_observed: {block: U64, point: i32})` | the agent, `Running`, until `run_end + exit_grace`; `position` must equal `get_own_position()`; `confirm_observed.block` at least `OFFCHAIN_MARGIN_BLOCKS` (40) and at most `CONFIRM_MAX_BLOCKS` (400) before `meta.observed.block`; needs 250 Tgas; removes all liquidity | **Built** (S9) |
| `exit_remove(position: string)` | the agent or the creator in `Closing` and `Closed`; anyone from `run_end + exit_grace` in `Running`, `Closing` and `Closed`; rate-limited per caller class; never refused for a full log; needs 250 Tgas; also clears a position DCL no longer holds (`null`, another owner, or no liquidity) with no fees counted | **Built** (S9) |
| `reveal(rules_json: string)` | the creator in `Running`; anyone in `Closing` and `Closed`; once; at most 4,096 bytes; the SHA-256 of the UTF-8 bytes must equal `config.rules_hash`; refusals in order `LIMIT: wrong status`, `AUTH: creator only while running`, `LIMIT: already revealed`, `LIMIT: rules too large`, `LIMIT: rules hash`, `LIMIT: balance for registration`; emits `reveal` | **Built** (S10) |
| `on_tokens_registered`, `on_open_reads`, `on_open_deposited`, `on_open_add_reads`, `on_open_added`, `on_remove_reads`, `on_remove_predicted`, `on_removed` | the contract itself (`AUTH: callback only`) | Built (callbacks) |
| `agent_continue(op_id)`, `agent_heartbeat(chain_head, prev_head)` | agent | **Not in v1** (D55) |
| `abort_pending(op_id)`, `cleanup_gift(lpt_id)`, `adopt(lpt_id)`, `dismiss_unknown_add()`, `expire_unknown_add()`, `withdraw_storage_surplus()` | per ARCHITECTURE 5.5 | **Not in v1** (D55) |
| `buy_viewing_key(buyer_pubkey)`, `deliver_key(buyer, sealed_key)`, `refund_key()`, `rekey(new_pubkey)`, `withdraw_near()` | per ARCHITECTURE 5.5 | **D57 (14 Nov): `buy_viewing_key`, `deliver_key`, `refund_key`, `withdraw_near` are being built for testnet/sandbox, see section 9. `rekey` stays cut.** |

## 5. `ActionRecord`

**Built shape (slice 7), which supersedes the planned table below it where they differ:**

```
{ index: U64, op_id: U64, kind: "Swap"|"Open"|"ClosePosition"|"ExitRemove", caller: account,
  left_point: i32, right_point: i32,
  observed: {block: U64, point: i32},            // from the agent
  reference: null | {block: U64, point: i32},    // the pool's own read in the read round
  decision_hash: hex, chain_head: null|hex,
  call_block: U64, timestamp_ns: U64,            // the call that took the lock
  result_block: null|U64, result_ts_ns: null|U64,
  result: "Pending"|"Ok"|"Unknown"|"SwapRefused"|{"Refused": reason}|{"Failed": stage},
  round: null | {spendable_quote, spendable_base, need_x, need_y: U128},
  swap:  null | {token_in: account, amount_in, min_out, used: U128},
  open:  null | {add_x, add_y, internal_x, internal_y, deposit_x, deposit_y,
                 predict_x, predict_y, min_x, min_y: U128, lpt_id: null|string},
  remove: null | {position: string, liquidity, unclaimed_x, unclaimed_y, predict_x, predict_y,
                  min_x, min_y, reported_x, reported_y, fees_x, fees_y: U128,
                  confirm_observed: null | {block: U64, point: i32}} }
```

x and y are the pool's token_x and token_y (on the live pool x is the quote token, USDC). An `Open` record has `open` set from round one on (`lpt_id` only after a successful add); a `ClosePosition` or `ExitRemove` record has `remove` set from the call on. An `ExitRemove` record has `decision_hash` `""`, `chain_head` null, `observed` `{block: call block, point: 0}`, `left_point`/`right_point` 0 until the read and `confirm_observed` null; a `ClosePosition` record's points are 0 until the position is read. `fees_x`/`fees_y` are `min(unclaimed, reported)` and are what `get_fees_collected()` sums. `result` for an `Open` is `Ok` (a position of this pool was returned), `{"Failed": "deposit"}` (a deposit did not report the whole amount; tokens may have moved), `{"Failed": "add"}` (the tokens stay in DCL's internal balance), `Unknown` (a lost or unreadable add: the open is closed for good, D55) or a refusal; for a removal `Ok`, `{"Failed": "remove"}`, `Unknown` (a lost or unreadable result), `{"Refused": "own_position_gone"}` (DCL no longer holds the position, or it has no liquidity; `own_position` is cleared, no fees counted) or another refusal.

`Refused` reasons (snake_case): `status`, `run_ended`, `pool`, `drift`, `centring`, `predict`, `no_swap_needed`, `swap_step`, `floor` (swap); `nothing_to_add`, `deposit_short`, `predict_over`, `add_ratio` (open); `own_position_gone`, `position` (the position is not this pool's or this id) (removal); `Failed` stages: `read`, `swap`, `deposit`, `add`, `remove`. A client treats an unknown reason or stage as "can't check". A record exists for every call that took the lock, refused or not; a call refused at its first check leaves none.

---

**Planned table (ARCHITECTURE 5.3), kept for the fields later slices add:**

From ARCHITECTURE 5.3. Field names are stable; types are the planned JSON types.

| Field | JSON type | Notes |
|---|---|---|
| `op_id`, `index` | `U64` | |
| `kind` | string | `Swap`, `Open`, `ClosePosition`, `ExitRemove`, `ExitWithdraw`, `CleanupGift`, `Adopt`, `DismissUnknownAdd`, `ExpireUnknownAdd`, `StaleResolution`, `OwnPositionGone`, `ClaimPlatform`, `ClaimCreator`, `Settle`, `Close` |
| `caller` | account | |
| `pool` | string | |
| `position_id` | string or `null` | `lpt_id` |
| `left_point`, `right_point` | i32 number or `null` | Within ±800,000, so a plain number |
| `observed`, `reference`, `confirm_observed` | `{block: U64, point: i32}` or `null` | `confirm_observed` on every close |
| `call_blocks` | `U64[]` | The call and every `agent_continue` |
| `result_ts_ns`, `block_height`, `result_block`, `timestamp_ns` | `U64` | |
| `holdings` | per token `{wallet: {amount, block}, internal: {amount, block}, platform_owed: U128, positions: {amount, block}}`: each read with its own block (5.3; the token's and DCL's shards can differ) | Proposed shape |
| `slots` | `{cur_liquidity, cur_order, max}` numbers | |
| `stages` | array of one-key objects: `removed {reported, minimums, fees}`, `quoted {amount_in, quote_out, min_out}`, `swapped {token_in, amount_in, used, forwarded_gas}`, `deposited {amounts, used}`, `added {amounts, lpt_id}`, `withdrawn {token, result}`, each with `result` | **Open (5.11)**: `removed.fees` waits on whether `remove_liquidity`'s return includes fees |
| `need`, `probe_amounts`, `add_amounts`, `add_predict` | `[U128, U128]` | |
| `need_block` | `U64` | |
| `deploy_cap` | `U128` | |
| `decision_hash`, `chain_head`, `attestation_hash` | hex string or `null` | |
| `result` | `"Pending"`, `"Ok"`, `"Aborted"`, `"Unknown"`, `{"Failed": stage}`, `{"Refused": reason}`, `{"SlotsFull": {cur, max}}`, `{"SwapRefused": {used: "0", forwarded_gas}}` | `reason` is snake_case from a fixed set: the post-lock reasons of 5.6 and 5.2 (`no_swap_needed`, `input_not_in_wallet`, `drift`, `deposit_short`, `predict_over`, `add_ratio`, `nothing_to_add`, `own_position_gone`, `slots_full`) plus the snake_case of any `LIMIT:` name checked after the lock. The page maps an unknown reason to "can't check" |
| `remove_failures`, `withdraw_failures` | `{count, last_blocks: U64[≤3]}` | `Settle` records only |

**Lock time.** `block_height` and `timestamp_ns` are the block and timestamp of the call that took the lock (proposed reading of 5.3); `result_block` and `result_ts_ns` are where the result was recorded. The page's lock times for `missedClose` are `timestamp_ns` of every trading record, refused ones included, with `kind == "ClosePosition"` as the close flag. A call refused at its first check panics and reverts: it writes no record and takes no lock (principle 5, EC-C155), so the page never sees it; a refusal after the lock (`Refused(reason)`) is recorded and counts.

**Holdings at a sampled block** (5.2 principle 6). There is no `get_holdings()` view: holdings need `predict_remove_liquidity`, a cross-contract read the contract makes inside an operation, never in a view. The page computes, per token at the block, from archival views: `spendable = max(0, ft_balance_of(strategy) + internal(list_user_assets) - get_platform_owed(token))` (clamped at 0 **before** adding positions), then `holdings = spendable + predict_remove_liquidity(get_own_position())` for that token (0 when there is no own position; gifts never count). **Open (5.11):** whether `predict_remove_liquidity` includes uncollected fees (no fee counted twice). The contract's records carry each read in `holdings` so the page can compare.

**The close latch (`closedBy`).** The contract can't see which condition fired a close (5.2 principle 6), so it stores no reason and there is no `get_closed_by()`. The page derives the latch from its own `packages/rules` replay (the rules latch after a close, D47): the first `ClosePosition` record with result exactly `"Ok"` latches it, with the reason due at that record's `O2` (`observed`), and it stays latched whatever the condition does later.

**Open (5.11):** whether a full record fits `MAX_JSON_LENGTH` (4,096 code units) for the page's reads, and the record's Borsh size, which sets `storage_reserve`.

**For `missedClose` (EC-W25, EC-W27, EC-W28)** the page derives its `MarketState` (`closedBy`, `confirmFromBlock`, `principal`, `holdings`, `fees`, `startedAtS`) from these records and views; the agent's locks with a close flag are the `ClosePosition` records (only result `Ok` counts as a close), and the clock pair comes from block timestamps read by `packages/near`. The page's guessed shapes in `apps/web/src/lib/missed.ts` (front-end branch) are to be matched to this list at the freeze.

**Decision-record hash (built, 12 November 2026, `packages/rules/src/decision.ts`, EC-R31 to EC-R33).** The agent publishes, for every action it sends, one text: canonical JSON (RFC 8785) of `{"decision": <Decision>, "rules_hash": <64 lowercase hex>, "state": <state>, "strategy": <account id>, "version": 1}`, where `<state>` has exactly the keys `block, closedBy, confirmFromBlock, fees{base,quote}, holdings{base,quote}, nowS, point, position, principal, startedAtS, valuationPoint` (amounts as decimal strings, `position` null or `{left, right}`) and `<Decision>` is `{"kind":"hold"}`, `{"kind":"done"}`, `{"kind":"open","left","right"}` or `{"kind":"close","reason"}`. `decision_hash` is the SHA-256 of that text's UTF-8 bytes. The record names its strategy, so one record cannot be offered for another strategy with the same rules. The chain link is `chain_head = SHA-256("poolside-chain-v1\n" + prev + "\n" + decision_hash)` as 64 lowercase hex, `prev` the previous action record's `chain_head` or 64 zeros for the first record; the agent sends it as `meta.chain_head` and the contract stores it (it checks only that it is 64 lowercase hex). **Every action record has its own head**, a paired open included: its head is `chainHead(the swap's chain_head, the same decision_hash)`, so it differs from the swap's. An agent whose last record has no readable `chain_head` fails closed (sends nothing) rather than restarting from zeros. The agent and the page import `decisionRecordText`, `decisionHash`, `chainHead`, `parseDecisionRecord` and `verifyRecordTextOnly` from `@poolside/rules`. The writer reads its own output back, so the agent cannot publish a record the page cannot read. The page checks a record only with `verifyDecisionRecordAgainstChain(text, expectedHash, rules, strategy, actions, rebuilt)` (`verifyRecordTextOnly`, the former `verifyDecisionRecord`, is **text only**: it ties nothing in the record's state to chain data; a pass is `isMatching(verdict)`, never a truthy verdict). It does, in order:  (1) the SHA-256 of the text is the on-chain `decision_hash`; (2) the text is the canonical form of a valid record (otherwise the shared function returns `cant_check` with `unreadable: true`; **the page shows that as "not matching"** when the text's hash equals the on-chain `decision_hash`, because the agent committed those bytes, and as "can't check" only when the text is missing or its host failed); (3) `strategy` and `rules_hash` are this strategy's and the revealed rules' hash; (4) `evaluate(rules, state)` gives the recorded decision; and **(5) the record is tied to chain data**: `state.block` and `state.point` equal the on-chain `meta.observed` of every unpaired action carrying the hash (at least one must, otherwise "can't check"); an `open` decision's `left` and `right` equal the on-chain `left_point` and `right_point` of every Swap and Open carrying it; the page rebuilds `nowS` (the block timestamp), `startedAtS`, `principal`, `holdings`, `fees`, `position`, `closedBy`, `confirmFromBlock` and `valuationPoint` from chain data at `observed.block` and compares them to the record's. Any mismatch is "not matching"; a field the page cannot rebuild, or a record that is missing or whose host failed is "can't check" (an unreadable text with the right hash is "not matching", see (2)); only a verdict of `matching` is a pass. `hold` and `done` records have no on-chain action carrying their hash and are always "can't check" (context, not actions). A record whose state is invented but self-consistent therefore cannot read "matching" (audit round 5). A successful parse alone is never "matching". The contract does not check the chain link; the page recomputes the whole chain from the first record and shows a **fork** as "not matching" and a **gap** (an action with no `chain_head`, or a missing index) as "can't check"; if no record carries a head at all the page shows no chain row and lists the chain under "Not checked" (an agent may omit `chain_head`). Heads link on-chain actions only, so `hold` and `done` records are covered by no head. The "fails closed" on a missing head is the agent's behaviour, not something the contract requires. The decision is validated by one function (`checkDecision`: exactly the keys of its kind, points integers within ±800,000 with `left < right`, a close reason from the fixed list, EC-R33).

**A paired open** (the contract accepts an `agent_open` under the previous `Swap`'s decision hash when the swap's result is under `PAIR_WINDOW_S` old, and exempts it from the interval; it does not compare the open's range with the swap's: THREAT_MODEL T81) reuses the swap's exact record text, hash and range: its decision is the swap's `open` decision at the swap's observation. Only `meta.observed` is fresh (the contract needs an observation at most `max_observation_age_blocks` old and checks drift and centring itself). The page derives pairing itself: an `Open` is paired only if a `Swap` carrying the same hash is among the actions and the Open's `timestamp_ns` is at or after that swap's `result_ts_ns` and less than `PAIR_WINDOW_S` after it; at most one open is paired with a swap. A paired open is judged at the **swap's** observation (its own `observed` is not compared with the record's state) **and its on-chain range must equal the swap decision's range, otherwise "not matching"**; an open outside the window is judged at its own observation. If the swap's record is not available to the agent it sends no paired open. **Round 6:** `ChainedAction` carries `index`, `result` (`ok`, `refused`, `failed`) and `swapUsed`; only an `ok` Swap with `swapUsed > 0` and a lower index can be the swap an Open pairs with. `point` and `block` are required rebuilt fields (the pool's `current_point` read at `observed.block`): the page must read them, or the verdict is "can't check"; the pool's point at `confirmFromBlock` is still not compared. An out-of-range timestamp or a malformed rebuilt field is "can't check".

**Decision hashes are used once, refused or not.** The contract refuses a reused `decision_hash` (`trade.rs` `seen_decisions`; only the one paired open right after its swap may repeat it). An action that took the lock and was then refused or failed has consumed its hash; a call refused at the first check leaves no record and no hash. So an agent's retry after a refusal that took the lock is a **new decision** (a new observation and a new hash), and the page counts every recorded action, whatever its result, toward a hash's use.

**Publication.** Records are published only after the rules are revealed (from `Closing`): a record served during the run would let anyone read where the stop loss, take profit and time bound lie (THREAT_MODEL T78). Layout: a flat, content-addressed set of files, one per decision, named by the hash: `<base>/<decision_hash>.txt`, containing exactly the record text (UTF-8, **no trailing newline**, 600 to 900 bytes). The agent writes them into a configurable output directory (`records/`); it runs no server. The host is untrusted: the page fetches `<base>/<hash>.txt` and accepts it only if the SHA-256 of the bytes equals the on-chain `decision_hash` (`verifyRecordTextOnly`). A host must serve the files immutably, with no authentication, open CORS, and a 404 for a hash that was never published. Any static host works, including a local directory; a co-lead picks the public one and nothing is deployed from this repository. Until a record is available the page shows "decision record not published".

**Records of exits and unknowns (audit round 5).** A failed or refused `exit_remove` leaves **no** `ActionRecord` (only its `action` and `action_result` events); an exit that clears the position, finds it gone, or whose result is unknown keeps one. **The `ExitRemove` record's empty `decision_hash` (`""`) is the one exception to "64 lowercase hex"** (it carries no decision). An `Open` record whose `result` is `Unknown` means the position is **possibly stranded** (a lost or unreadable add: the contract cannot name it, THREAT_MODEL T77): the page never shows a pass for it. **Removal fees are not checkable from public data:** `fees_x` and `fees_y` are `min(unclaimed, reported)` from reads the page cannot reproduce, and whether `remove_liquidity`'s return already includes the fees is unverified (gate 3 Part D), so the page shows them as "can't check" until a mainnet round trip reconciles them.

## 6. Events

NEP-297, `standard: "poolside"`, `version: "1.0.0"`, one data object per event.

| Event | Data | State |
|---|---|---|
| `new` | `{creator, rules_hash}` | Built |
| `registration_started` | `{target, nonce, check_only}` | Built |
| `registration` | `{target, nonce, check_only, ok}` | Built |
| `registration_ignored` | `{target, nonce}` | Built |
| `inbound` | `{token, sender_id, amount, credited, returned}` (pool tokens only) | Built |
| `cancel` | `{by}` | Built |
| `withdraw_started` | `{op_id, token}` | Built |
| `withdraw` | `{op_id, token, ok, amount?, reason?}`; `reason` is `"nothing to withdraw"` or `"balance read failed"` | Built |
| `callback_ignored` | `{op_id}` | Built |
| `stale_resolution` | `{op_id, op, stage}` | Built (narrow) |
| `close` | `{by, at_ns, after_run_end}` | Built |
| `settle_started` | `{op_id}` | Built |
| `settle` | `{op_id, closed_at_ns}`: the strategy is `Closed` (success only) | Built |
| `settle_refused` | `{op_id, reason}`, reason `LIMIT: internal balance left`, `LIMIT: own position exists`, `LIMIT: read failed` or `LIMIT: wrong status`; an event, not a panic; the strategy stays `Closing`. Treat only `settle` as settled | Built |
| `exit_withdraw_started` | `{op_id, token}` | Built |
| `exit_withdraw` | `{op_id, token, ok, reason?}`; `reason` is `LIMIT: nothing to withdraw`, `withdraw returned false`, `withdraw failed` (a failed receipt or any result but `true`; both count toward the stuck rule), or another `LIMIT:` message (an event, not a panic) | Built |
| `claim_started` | `{op_id, token}` | Built |
| `claim` | `{op_id, token, leg: "platform"\|"creator", amount, ok}`, one per transfer | Built |
| `claim_refused` | `{op_id, token, reason}`; `LIMIT: nothing to pay`, `LIMIT: nothing to claim`, `LIMIT: claim below dust`, `LIMIT: read failed`, `LIMIT: wrong status` | Built |
| `action` | `{index, op_id, kind, caller}`: a trading call took the lock and appended a `Pending` record | Built |
| `action_result` | `{index, result}`: the record's final result (also for `Unknown` after `resolve_stale`) | Built |
| `start_started` | `{op_id, expected_point}` | Built |
| `start` | `{op_id, started_at_ns, point, principal}`: the strategy is `Running` (success only) | Built |
| `start_refused` | `{op_id, reason}`; `reason` is the `LIMIT:` message a panic would have carried: `LIMIT: read failed`, `LIMIT: wrong status`, `LIMIT: start deadline passed`, `LIMIT: pool`, `LIMIT: drift`, `LIMIT: slots`, `LIMIT: payee not registered`, `LIMIT: dust threshold`. A refused start is an **event, not a panic** (a callback can't panic without rolling back its own lock release), and the strategy stays `Open`. A client must treat only `start` as a start (interface audit, security L3) | Built |
| `register_tokens_started` | `{op_id}` | Built |
| `tokens_registered` | `{op_id, ok}` | Built |
| `open_deposit_mismatch` | `{expected: string[], seen: string[]}`: a deposit's result was not the whole amount (diagnostic; the record says `Failed(deposit)`) | Built |
| `reveal` | `{by, bytes}` | Built |
| `pause`, `unpause`, `set_agent`, `ring`, `heartbeat`, `key_sale`, `key_delivered`, `key_refunded`, `rekey`, `near_owed` | | **`pause`, `unpause`, `set_agent`, `ring`, `heartbeat`, `rekey` not in v1 (D55). Superseded by section 9 (D57) for the key events: `key_bought`, `key_delivered`, `key_refunded`, `near_owed`, `near_withdrawn` are built there; `key_sale` is not an event (the name in this row is retired)** |

Nothing reads an event from a failed receipt (T60).

## 7. Refusal messages

Built so far: `AUTH: new only by the strategy account or its parent`, `AUTH: creator only`, `AUTH: creator only before start deadline`, `AUTH: callback only`, `LIMIT: wrong status`, `LIMIT: sandbox build`, `LIMIT: gas`, `LIMIT: rules hash`, every `LIMIT:` of `limits::validate` (EC-C56), `LIMIT: balance for registration`, `LIMIT: registration not failed`, `LIMIT: not a pool token`, `LIMIT: inbound transfer settling`, `LIMIT: operation pending`, `LIMIT: stale cooldown`, `LIMIT: nothing in flight`, `LIMIT: not stale yet`, and for `start` (in order): `LIMIT: start deadline passed`, `LIMIT: point`, `LIMIT: not funded`, `LIMIT: registrations not ok`, `LIMIT: storage reserve`; for `close`: `AUTH: creator only before run end`; for `exit_withdraw`: `LIMIT: exit not open yet`; for the claims: `LIMIT: nothing owed`, `LIMIT: platform window`; for `settle`, `resolve_stale`, `exit_withdraw` and the claims: `LIMIT: rate limited` (each caller class has its own slot, `min_action_interval_s`), and for `settle` `LIMIT: stale cooldown`, `LIMIT: settling`.

Built in S7 to S10 (trading calls; the order is in ARCHITECTURE principle 5): `AUTH: agent only`, `LIMIT: run ended`, `LIMIT: action interval`, `LIMIT: actions per 24h`, `LIMIT: not quiet`, `LIMIT: inside payout margin`, `LIMIT: observation age`, `LIMIT: chain head`, `LIMIT: decision hash`, `LIMIT: points`, `LIMIT: action log full`, `LIMIT: swaps per run`, `LIMIT: already opened`, `LIMIT: position exists`, `LIMIT: tokens not registered`, `LIMIT: tokens already registered`, `LIMIT: confirmation span`, `LIMIT: observation not quiet`, `LIMIT: not the own position`, `LIMIT: exit not open yet`, `LIMIT: already revealed`, `LIMIT: rules too large`, `AUTH: creator only while running`. Not in v1: `LIMIT: paused`, `LIMIT: gift settling`, `LIMIT: settling`, `LIMIT: nothing owed`, `LIMIT: claim below dust`, `LIMIT: storage`, and the rest listed in `EDGE_CASES.md`. The `Refused(reason)` names in `ActionRecord.result` are listed in section 5.

**Recordings (14 November 2026).** Every verdict the check page shows for a `scenario-*` run is over a single recording read twice: one sandbox node, no live provider. It is not a two-provider check and not a live strategy.

## 9. Viewing keys (D57, 14 November 2026; testnet and sandbox only, no real tokens)

Written ahead of the code on branch `contract/viewing-keys`; a name or shape here changes only through a new commit to this section. **`rekey` is cut** (no `rekey`, no `rekey_pending`). Everything else in ARCHITECTURE 5.5 and 6 for the sale holds, with these exact forms. Where this section and the older rows above disagree, this section wins.

**Encodings.** All binary values are **lowercase hex strings** (like `rules_hash`), never base64, no `0x` prefix.
- `buyer_pubkey`: 64 hex characters = 32 bytes, an X25519 public key; the all-zero key is refused.
- `sealed_key`: 160 hex characters = **80 bytes** = `crypto_box_seal(K, buyer_pubkey)` with `K` 32 bytes (32 + 48 bytes of ephemeral key and tag). Hex of other lengths, upper-case or non-hex characters are refused.
- Amounts are `U128` decimal strings in yoctoNEAR; times are `U64` strings in nanoseconds.

**Methods.** Refusals are panics with the exact message, in the order listed (first failing check wins), and change nothing; an attached deposit on a refused call goes back to the caller.

| Method | Caller and deposit | Behaviour and refusals |
|---|---|---|
| `buy_viewing_key(buyer_pubkey: string)` | any account (the deliverer account included: no refusal, pinned by a test); **payable, exactly `key_price`** | Refusals in order: `LIMIT: wrong status` (not `Running`), `LIMIT: already revealed`, `LIMIT: key price` (deposit is not exactly `key_price`; also when `key_price` is 0 and a deposit is attached), `LIMIT: buyer key` (not 64 lowercase hex or all zero), `LIMIT: already bought` (one sale per account, a refunded buyer included), `LIMIT: key sales full` (`sold == max_key_sales`; always the case when `max_key_sales` is 0), `LIMIT: balance for registration` (the sale record's storage is not covered). Stores the sale as `Escrowed` with `bought_at_ns = block timestamp`; `sold` rises by 1 and **never falls** (a refund doesn't free a slot); `escrow_total += key_price`. Emits `key_bought` |
| `deliver_key(buyer: string, sealed_key: string)` | the `deliverer` only; 0 deposit | Refusals in order: `AUTH: deliverer only`, `LIMIT: sealed key` (not exactly 160 lowercase hex), `LIMIT: no such sale`, `LIMIT: not escrowed` (the sale is `Released` or `Refunded`), `LIMIT: delivery window closed` (`now >= bought_at_ns + key_delivery_window_ns`: the exact complement of `refund_key`). Any status of the strategy is fine. Sets the sale `Released`, stores `sealed_key`, `escrow_total -= key_price`, then transfers `key_price` to the creator, **once**. A transfer that bounces (checked in a callback) adds `key_price` to `near_owed[creator]` and `near_owed_total`; the sale stays `Released`. Emits `key_delivered` at the call and `near_owed` if the payout bounces |
| `refund_key()` | the buyer (predecessor); 0 deposit | Refusals in order: `LIMIT: no such sale`, `LIMIT: not escrowed`, `LIMIT: delivery window open` (`now < bought_at_ns + key_delivery_window_ns`). Sets the sale `Refunded`, `escrow_total -= key_price`, transfers `key_price` to the buyer, **once**; a bounce adds it to `near_owed[buyer]`. Emits `key_refunded`, and `near_owed` on a bounce |
| `withdraw_near()` | any account; 0 deposit | `LIMIT: nothing owed` when `near_owed[caller]` is 0. Zeroes the entry (and lowers `near_owed_total`) **before** the transfer; a failed transfer restores both in the callback. Emits `near_withdrawn` and, on failure, `near_owed` |

Not changed: every other method. One fix to `start`: its storage-reserve check (`LIMIT: storage reserve`) now also requires the balance to cover `escrow_total + near_owed_total` on top of the stake and reserve; both are 0 until a key is sold, and keys can only be sold after `start`, so `start` is unchanged in practice.

**Views** (no gas beyond a read):

| View | Returns |
|---|---|
| `get_key_params()` | `{key_price: U128, key_delivery_window_ns: U64, max_key_sales: u32, sold: u32, deliverer: string, escrow_total: U128, near_owed_total: U128}` (the first four and `deliverer` repeat `get_config`) |
| `get_key_sale(buyer: string)` | `null` or `KeySale` |
| `get_key_sales(from_index: u32, limit: u32)` | `KeySale[]` in purchase order, `limit` capped at 50 (so one page holds every sale); `from_index` past the end gives `[]` |
| `get_near_owed(account: string)` | `U128` |

`KeySale = {buyer: string, buyer_pubkey: string (64 hex), state: "Escrowed" | "Released" | "Refunded", bought_at_ns: U64, price: U128, sealed_key: string | null}`; `sealed_key` is 160 hex once `Released`, otherwise `null`. A client (the deliverer above all) reads `buyer` and `buyer_pubkey` from this view at a final block before sealing, never from an event (section 1, T74). The delivery deadline is `bought_at_ns + key_delivery_window_ns`.

**Events** (NEP-297, `standard: "poolside"`, `version: "1.0.0"`, one object in `data`; trusted only from a successful receipt executed by the strategy account):

| `event` | `data` |
|---|---|
| `key_bought` | `{index: u32, buyer, buyer_pubkey, bought_at_ns: U64, price: U128}` |
| `key_delivered` | `{index: u32, buyer, price: U128}` (the sealed key is in the view, not in the log) |
| `key_refunded` | `{index: u32, buyer, price: U128}` |
| `near_owed` | `{account, amount: U128, reason: "key_payout" \| "key_refund" \| "withdraw"}` (a transfer bounced and the NEAR is held for `account`) |
| `near_withdrawn` | `{account, amount: U128}` |

`index` is the sale's position in `get_key_sales`. **Trust, unchanged (D11):** the contract cannot check that a delivered key opens the ciphertext; the buyer's browser checks the hash and shows a failure, but the payment has already gone to the creator. The sealed key is on-chain in the clear (it is sealed to the buyer's key).
