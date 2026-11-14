//! Slice 3: funding (ARCHITECTURE 5.5). `ft_on_transfer` credits the creator's funding in
//! `Open`; `cancel` ends a strategy that never started; `withdraw` pays the creator the whole
//! wallet balance of a pool token in `Cancelled`, read under the operation lock; a narrow
//! `resolve_stale` releases a lock whose callback was lost, so a withdraw can never hold the
//! tokens for ever (principle 7: a lock is never held for ever).
//!
//! What is not here yet: `start` and every later status; the general `resolve_stale` (its
//! `StaleRead` stage, the ring and principle 5's rate limit). In this slice the only lock is a
//! withdraw's, which has no state to reconcile, and a `resolve_stale` with no stale lock is
//! refused from cached state, so nobody can use it to hold the strategy.
//!
//! **Unverified constants** (marked, measured in the sandbox tests of this slice or later):
//! `PAYOUT_SETTLE_BLOCKS` is the proposed 20 (ARCHITECTURE 5.11, open); the gas constants are
//! bounded by `contracts/strategy-sandbox` against the pinned native USDC and wrap.near code.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise, PromiseError};

use super::settle::{Class, RateMethod};
use super::trade::ActionResult;
use super::{event, network, refuse, Status, Strategy, StrategyExt, GAS_CALLBACK};

/// Blocks between an own callback and its payout landing. **Proposed, not yet measured**
/// (ARCHITECTURE 5.2 principle 6 and 5.11): gate 3 part C saw one block.
pub const PAYOUT_SETTLE_BLOCKS: u64 = 20;
/// The off-chain margin (D49, D50): twice `PAYOUT_SETTLE_BLOCKS`.
pub const OFFCHAIN_MARGIN_BLOCKS: u64 = 2 * PAYOUT_SETTLE_BLOCKS;
/// The longest span between a close's first confirming observation and the close
/// (`packages/rules` `CONFIRM_MAX_BLOCKS`).
pub const CONFIRM_MAX_BLOCKS: u64 = 10 * OFFCHAIN_MARGIN_BLOCKS;
/// `withdraw` waits this long after a refund made in `Open` (5.5; rev 24 contract L-2).
pub const QUIET_INBOUND_BLOCKS: u64 = OFFCHAIN_MARGIN_BLOCKS;
/// The only `msg` that funds the strategy.
pub const FUND_MSG: &str = "fund";
/// Gas for `ft_balance_of`, for `ft_transfer`, and the fixed gas of the balance callback, which
/// starts the transfer and its callback. Bounded in the sandbox (slice 3b).
pub const GAS_VIEW: Gas = Gas::from_tgas(10);
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(20);
pub const GAS_ON_BALANCE: Gas = Gas::from_tgas(50);
/// Prepaid gas `withdraw` needs: its read, both callbacks and the transfer, plus its own run.
pub const MIN_GAS_WITHDRAW: Gas = Gas::from_tgas(100);
/// One yoctoNEAR, attached to every `ft_transfer` (NEP-141).
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

/// The operation a lock belongs to. Later slices add the trading and exit operations.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Withdraw {
        token: AccountId,
    },
    /// `start`'s parallel reads (slice 4).
    Start,
    /// `settle`'s read of the DCL internal balances (slice 5).
    Settle,
    /// `exit_withdraw` of one pool token; `class` is the caller's, for the settle window (slice 6).
    ExitWithdraw {
        token: AccountId,
        class: Class,
    },
    /// `claim_platform` and `claim_creator` of one pool token (slice 6).
    ClaimPlatform {
        token: AccountId,
        class: Class,
    },
    ClaimCreator {
        token: AccountId,
    },
    /// `agent_swap`; `index` is its record in `actions` (slice 7).
    Swap {
        index: U64,
    },
    /// `register_tokens` at DCL for both pool tokens (S8).
    RegisterTokens,
    /// `agent_open`: reads, deposits, reads, add; `index` is its record (S8).
    Open {
        index: U64,
    },
    /// `agent_close_position` and `exit_remove`; `class` is the caller's, for the settle window (S9).
    Remove {
        index: U64,
        class: Class,
    },
}

/// Where the operation is: the promise in flight is the balance read, or the transfer.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Stage {
    ReadBalance,
    Transfer,
    ReadStart,
    ReadAssets,
    /// `exit_withdraw`'s `withdraw_asset` is in flight.
    Withdraw,
    /// A trading call's parallel reads, then its `ft_transfer_call` (slice 7).
    ReadRound,
    Swapping,
    /// A claim's wallet read, then its transfers.
    ReadWallet,
    Transfers,
    /// `register_tokens` is in flight (S8).
    Register,
    /// `agent_open`'s deposits are in flight, then its second read round, then the add.
    Depositing,
    ReadAdd,
    Adding,
    /// A removal's prediction read, then the remove itself (S9).
    Predicting,
    Removing,
}

/// The operation lock (principle 2). Every callback acts only if the lock is its `op_id` at its
/// stage; otherwise it does nothing but log `callback_ignored`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Lock {
    pub op_id: U64,
    pub op: Op,
    pub stage: Stage,
    /// The block the promise now in flight was launched at (`resolve_stale` counts from here).
    pub promise_block: U64,
}

/// A strict NEP-141 balance answer: a JSON string of `0|[1-9][0-9]*` that fits in u128
/// (principle 10). Anything else is `None`.
pub fn parse_balance(body: &[u8]) -> Option<u128> {
    let digits = body.strip_prefix(b"\"")?.strip_suffix(b"\"")?;
    if digits.is_empty()
        || digits.len() > 39
        || !digits.iter().all(u8::is_ascii_digit)
        || (digits.len() > 1 && digits[0] == b'0')
    {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse::<u128>().ok()
}

/// The one promise result of a callback, at most 4 KB; anything else is an error.
pub(super) fn single_result() -> Result<Vec<u8>, PromiseError> {
    if env::promise_results_count() == 1 {
        env::promise_result_checked(0, 4_096)
    } else {
        Err(PromiseError::TooLong(0))
    }
}

pub(super) fn callback_only() {
    if env::predecessor_account_id() != env::current_account_id() {
        refuse("AUTH: callback only");
    }
}

impl Strategy {
    /// The pool token named exactly `t` (the quote token or the network's base token).
    pub(super) fn pool_token(&self, t: &str) -> Option<AccountId> {
        if t == self.config.quote_token.as_str() {
            Some(self.config.quote_token.clone())
        } else if t == network().base_token {
            t.parse().ok()
        } else {
            None
        }
    }

    /// The lock, if it is `op_id`'s at `stage`.
    pub(super) fn lock_at(&self, op_id: u64, stage: Stage) -> Option<Lock> {
        self.lock
            .clone()
            .filter(|l| l.op_id.0 == op_id && l.stage == stage)
    }

    pub(super) fn release(&mut self) {
        self.lock = None;
    }
}

#[near]
impl Strategy {
    /// NEP-141 receiver (5.5, EC-C03, EC-C134). Never panics on the token's call, constant cost.
    /// A predecessor other than the two pool tokens: returned in full, nothing written. `Open`:
    /// the creator's `fund` in the quote token is credited up to `max_principal`, the excess
    /// returned; every other transfer is returned in full; a non-zero return sets
    /// `last_inbound_block`. Every other status: kept (returns 0); it becomes holdings, or in
    /// `Cancelled` is paid out by `withdraw`.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let token = env::predecessor_account_id();
        if self.pool_token(token.as_str()).is_none() {
            return amount;
        }
        let (credited, returned) = if self.status == Status::Open {
            let credited = if token == self.config.quote_token
                && sender_id == self.config.creator
                && msg == FUND_MSG
            {
                amount
                    .0
                    .min(self.limits.max_principal.0.saturating_sub(self.principal))
            } else {
                0
            };
            self.principal = self.principal.saturating_add(credited);
            let returned = amount.0 - credited;
            if returned > 0 {
                self.last_inbound_block = env::block_height();
            }
            (credited, returned)
        } else {
            (0, 0)
        };
        event(
            "inbound",
            json!({
                "token": token,
                "sender_id": sender_id,
                "amount": amount,
                "credited": U128(credited),
                "returned": U128(returned),
            }),
        );
        U128(returned)
    }

    /// Ends a strategy that never started (5.4, 5.5): the creator in `Open`, or anyone from
    /// `start_deadline`. Refused while locked (EC-C63).
    pub fn cancel(&mut self) {
        if self.status != Status::Open {
            refuse("LIMIT: wrong status");
        }
        let caller = env::predecessor_account_id();
        if caller != self.config.creator && env::block_timestamp() < self.config.start_deadline_ns.0
        {
            refuse("AUTH: creator only before start deadline");
        }
        if self.lock.is_some() {
            refuse("LIMIT: operation pending");
        }
        self.status = Status::Cancelled;
        event("cancel", json!({"by": caller}));
    }

    /// Pays the creator the whole wallet balance of `token`, read under the lock (5.5, EC-C46,
    /// EC-C124). Checks in principle 5's order: status, caller, token, time, lock, then its own.
    /// Repeatable: tokens that arrive later are paid by the next call.
    pub fn withdraw(&mut self, token: String) -> Promise {
        if self.status != Status::Cancelled {
            refuse("LIMIT: wrong status");
        }
        if env::predecessor_account_id() != self.config.creator {
            refuse("AUTH: creator only");
        }
        let token = self
            .pool_token(&token)
            .unwrap_or_else(|| refuse("LIMIT: not a pool token"));
        let block = env::block_height();
        if block < self.last_inbound_block.saturating_add(QUIET_INBOUND_BLOCKS) {
            refuse("LIMIT: inbound transfer settling");
        }
        if self.lock.is_some() {
            refuse("LIMIT: operation pending");
        }
        if let Some(b) = self.stale_resolution_block {
            if block < b.saturating_add(self.config.stale_cooldown_blocks.0) {
                refuse("LIMIT: stale cooldown");
            }
        }
        if env::prepaid_gas() < MIN_GAS_WITHDRAW {
            refuse("LIMIT: gas");
        }
        let op_id = self.next_op_id;
        self.next_op_id += 1;
        self.lock = Some(Lock {
            op_id: U64(op_id),
            op: Op::Withdraw {
                token: token.clone(),
            },
            stage: Stage::ReadBalance,
            promise_block: U64(block),
        });
        event(
            "withdraw_started",
            json!({"op_id": U64(op_id), "token": token}),
        );
        let me = env::current_account_id();
        Promise::new(token)
            .function_call(
                "ft_balance_of".to_string(),
                json!({ "account_id": me }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_VIEW,
            )
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_ON_BALANCE)
                    .with_unused_gas_weight(0)
                    .on_withdraw_balance(U64(op_id)),
            )
    }

    /// The balance read's callback: a zero or unreadable balance releases the lock (an event, no
    /// stored record); otherwise it sends `ft_transfer` of the whole balance to the creator.
    pub fn on_withdraw_balance(&mut self, op_id: U64) {
        callback_only();
        let Some(l) = self.lock_at(op_id.0, Stage::ReadBalance) else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let Op::Withdraw { token } = l.op.clone() else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let balance = single_result().ok().and_then(|b| parse_balance(&b));
        let amount = match balance {
            Some(a) if a > 0 => a,
            other => {
                self.release();
                let reason = if other.is_some() {
                    "nothing to withdraw"
                } else {
                    "balance read failed"
                };
                event(
                    "withdraw",
                    json!({"op_id": op_id, "token": token, "ok": false, "reason": reason}),
                );
                return;
            }
        };
        let me = env::current_account_id();
        self.lock = Some(Lock {
            stage: Stage::Transfer,
            promise_block: U64(env::block_height()),
            ..l
        });
        Promise::new(token)
            .function_call(
                "ft_transfer".to_string(),
                json!({"receiver_id": self.config.creator, "amount": U128(amount)})
                    .to_string()
                    .into_bytes(),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_withdrawn(op_id, U128(amount)),
            )
            .detach();
    }

    /// The transfer's callback: releases the lock and records the result in an event. A failed
    /// transfer leaves the tokens in the wallet for the next `withdraw`.
    pub fn on_withdrawn(&mut self, op_id: U64, amount: U128) {
        callback_only();
        let Some(l) = self.lock_at(op_id.0, Stage::Transfer) else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let Op::Withdraw { token } = l.op else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let ok = single_result().is_ok();
        self.release();
        event(
            "withdraw",
            json!({"op_id": op_id, "token": token, "amount": amount, "ok": ok}),
        );
    }

    /// Releases a lock whose promise was launched at least `stale_after_blocks` ago (its callback
    /// was lost), and starts the stale cooldown. Anyone. In this slice only a withdraw can hold
    /// the lock, and it has nothing to reconcile: a late transfer pays the creator, and a second
    /// one of more than the wallet holds fails at the token.
    pub fn resolve_stale(&mut self) {
        // Principle 5: a call with nothing to do is refused at its first check, from cached state,
        // with no stamp; then the rate limit, which is checked before the staleness (5.5), and a
        // refusal after it leaves the stamp unchanged (only a resolution stamps).
        let Some(l) = self.lock.clone() else {
            refuse("LIMIT: nothing in flight");
        };
        let class = self.caller_class();
        if !self.rate_ok(RateMethod::ResolveStale, 0, class) {
            refuse("LIMIT: rate limited");
        }
        let block = env::block_height();
        if block
            < l.promise_block
                .0
                .saturating_add(self.config.stale_after_blocks.0)
        {
            refuse("LIMIT: not stale yet");
        }
        // No wildcard arm: every later `Op` must decide here how it is resolved. A trading or exit
        // operation needs `StaleRead`/`StaleConfirm` (principle 7), which come with the general
        // `resolve_stale`, before any trading or exit `Op` (security L-1, contract review L2).
        match &l.op {
            // A withdraw has nothing to reconcile: a late transfer pays the creator, and a
            // second one fails at the token if the balance isn't there.
            Op::Withdraw { .. } => {
                self.release();
                self.stale_resolution_block = Some(block);
            }
            // `start` changes no state until its callback runs, so a lost callback leaves the
            // strategy `Open`: release the lock, and the creator can call `start` again.
            Op::Start => {
                self.release();
                self.stale_resolution_block = Some(block);
            }
            // `settle` only reads; a lost callback leaves the strategy `Closing`, and the next
            // `settle` reads again.
            Op::Settle => {
                self.release();
                self.stale_resolution_block = Some(block);
            }
            // An exit read or withdraw: a late `withdraw_asset` only moves the strategy's own
            // tokens from DCL to its wallet, so nothing needs reconciling; the window opens so the
            // late payout is visible before `settle` (principle 6).
            Op::ExitWithdraw { class, .. } => {
                let class = *class;
                self.release();
                self.stale_resolution_block = Some(block);
                self.set_window(class);
            }
            // A lost claim keeps `paid_platform` raised (treated as paid; a bounded platform loss,
            // disclosed, 5.5): only the lock and the in-flight record are cleared.
            // A lost swap: its record becomes `Unknown` and the window opens, because tokens may
            // have moved either way; the next trading call waits the payout margin.
            Op::Swap { index } => {
                let index = index.0;
                let swapping = l.stage == Stage::Swapping;
                self.release();
                self.stale_resolution_block = Some(block);
                if swapping {
                    // Tokens may have moved: the swap counts toward the cap and the window opens.
                    self.finish_unknown(index);
                    self.swaps_used = self.swaps_used.saturating_add(1);
                    self.set_window(Class::Agent);
                } else {
                    // The reads never produced a swap: nothing moved, no window.
                    self.finish_action(index, ActionResult::Failed("read".into()));
                }
            }
            // A lost registration changes nothing the contract relies on until its flag is set:
            // the creator calls `register_tokens` again (DCL's registration is idempotent: UNVERIFIED).
            Op::RegisterTokens => {
                self.release();
                self.stale_resolution_block = Some(block);
            }
            // A lost open: before the deposits nothing moved; a lost deposit may have moved
            // tokens (they sit in DCL's internal balance, which `exit_withdraw` returns); a lost
            // add may have created a position the contract can't name (v1 cannot adopt it, D55),
            // so the open is closed for good (`opened`) and the window opens.
            Op::Open { index } => {
                let index = index.0;
                let stage = l.stage;
                self.release();
                self.stale_resolution_block = Some(block);
                match stage {
                    Stage::ReadRound => {
                        self.finish_action(index, ActionResult::Failed("read".into()));
                    }
                    // The deposits have landed by now: the window opens (security audit L1).
                    Stage::ReadAdd => {
                        self.finish_action(index, ActionResult::Failed("read".into()));
                        self.set_window(Class::Agent);
                    }
                    Stage::Depositing => {
                        self.finish_unknown(index);
                        self.set_window(Class::Agent);
                    }
                    _ => {
                        self.finish_unknown(index);
                        self.opened = true;
                        self.set_window(Class::Agent);
                    }
                }
            }
            // A lost removal: before the remove goes out nothing moved; a lost remove may have paid
            // out, so the record is `Unknown` and the window opens. The position stays
            // `own_position` until `exit_remove` reads it as gone (it clears it, no fees counted).
            Op::Remove { index, class } => {
                let (index, class, stage) = (index.0, *class, l.stage);
                self.release();
                self.stale_resolution_block = Some(block);
                if stage == Stage::Removing {
                    self.finish_unknown(index);
                    self.set_window(class);
                } else {
                    self.finish_action(index, ActionResult::Failed("read".into()));
                    self.drop_unproductive_exit(index, false);
                }
            }
            Op::ClaimPlatform { .. } | Op::ClaimCreator { .. } => {
                self.release();
                self.claim_in_flight = None;
                self.stale_resolution_block = Some(block);
            }
        }
        self.rate_stamp(RateMethod::ResolveStale, 0, class);
        event(
            "stale_resolution",
            json!({"op_id": l.op_id, "op": l.op, "stage": l.stage}),
        );
    }

    pub fn get_principal(&self) -> U128 {
        U128(self.principal)
    }
    pub fn get_lock(&self) -> Option<Lock> {
        self.lock.clone()
    }
    pub fn get_last_inbound_block(&self) -> U64 {
        U64(self.last_inbound_block)
    }
    pub fn get_stale_resolution_block(&self) -> Option<U64> {
        self.stale_resolution_block.map(U64)
    }
}
