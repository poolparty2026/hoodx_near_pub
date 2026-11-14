//! Slice 5: `close()`, `settle()` and the rate limit they and `resolve_stale` share
//! (ARCHITECTURE 5.2 principle 5, 5.4, 5.5, 5.8; EC-C25, EC-C49, EC-C50, EC-C128, EC-C168).
//!
//! `close()` moves a `Running` strategy to `Closing`: the creator at any time, anyone from
//! `run_end_ns`. `settle()` moves `Closing` to `Closed` once DCL holds less than the dust
//! threshold of each pool token for the strategy; it reads `list_user_assets` under the lock, and
//! its callback never panics (a refusal there is a `settle_refused` event and releases the lock).
//! Anyone may settle, rate-limited per caller class.
//!
//! The own-position rule (`LIMIT: own position exists`) and the "stuck token" rule (3 failed
//! withdraws, EC-C103) are both checked in the callback (S8). Not in v1: a vanished or stuck
//! position (D55). **Unverified:** the shape of
//! a *non-empty* `list_user_assets` answer (an empty account answers `{}`, asserted in the
//! sandbox); the callback reads it as a map from token id to a decimal string and refuses
//! (`LIMIT: read failed`) anything else.
use near_sdk::json_types::U64;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, Gas, NearToken, Promise};

use super::funding::{callback_only, single_result, GAS_VIEW};
use super::{event, refuse, Lock, Op, Stage, Status, Strategy, StrategyExt};
use crate::limits::{DAY_NS, NANOS_PER_S};

/// Fixed gas of `settle`'s callback, and the prepaid gas `settle` needs: one read (about 14 Tgas of
/// receipt fees on top of the 10 attached), the callback and its own run. **Unmeasured at the low
/// end:** the sandbox test shows both burn well under half and succeeds at this value.
pub const GAS_SETTLE_CALLBACK: Gas = Gas::from_tgas(20);
pub const MIN_GAS_SETTLE: Gas = Gas::from_tgas(80);

/// `get_settle_window()` (proposed shape: an object where ARCHITECTURE 5.2 has a tuple).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SettleWindow {
    pub last_payout_callback_block: U64,
    pub settle_window_class: Class,
    pub settle_until_block: U64,
}

/// The methods that share principle 5's rate limit. Later slices add `ExitWithdraw`, the claims,
/// `CleanupGift`, `Adopt` and the rest.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RateMethod {
    Settle,
    ResolveStale,
    ExitWithdraw,
    ExitRemove,
    ClaimPlatform,
    ClaimCreator,
}

/// Who is calling: the creator, the agent, or anyone else (the platform account and the deliverer
/// included). Each class has its own slot so none can use up another's (principle 5).
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Class {
    Outsider,
    Creator,
    Agent,
}

/// The latest call of one (method, token, class). `token` is 0 for a method with no token
/// argument. At most a few dozen exist, so the list is scanned linearly.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RateStamp {
    pub method: RateMethod,
    pub token: u8,
    pub class: Class,
    pub at_ns: u64,
}

impl Strategy {
    /// The caller's class, by `predecessor_account_id`, never the signer.
    pub(super) fn caller_class(&self) -> Class {
        let caller = env::predecessor_account_id();
        if caller == self.config.creator {
            Class::Creator
        } else if caller == self.config.agent {
            Class::Agent
        } else {
            Class::Outsider
        }
    }

    /// Whether `class` may call `method` for `token` now: no earlier call, or at least
    /// `min_action_interval_s` since it (allowed at the interval, refused one second earlier).
    pub(super) fn rate_ok(&self, method: RateMethod, token: u8, class: Class) -> bool {
        let gap = self
            .limits
            .min_action_interval_s
            .0
            .saturating_mul(NANOS_PER_S);
        self.rate_stamps
            .iter()
            .find(|r| r.method == method && r.token == token && r.class == class)
            .is_none_or(|r| env::block_timestamp() >= r.at_ns.saturating_add(gap))
    }

    pub(super) fn rate_stamp(&mut self, method: RateMethod, token: u8, class: Class) {
        let at_ns = env::block_timestamp();
        match self
            .rate_stamps
            .iter_mut()
            .find(|r| r.method == method && r.token == token && r.class == class)
        {
            Some(r) => r.at_ns = at_ns,
            None => self.rate_stamps.push(RateStamp {
                method,
                token,
                class,
                at_ns,
            }),
        }
    }

    /// 0 for the quote token, 1 for the base token; `None` for any other account.
    pub(super) fn token_index(&self, t: &near_sdk::AccountId) -> Option<usize> {
        if *t == self.config.quote_token {
            Some(0)
        } else if t.as_str() == super::network().base_token {
            Some(1)
        } else {
            None
        }
    }

    /// The platform's owed amount: its 5% cut of the fees collected, less what it has been paid.
    pub(super) fn platform_owed(&self, i: usize) -> u128 {
        (self.fees_collected[i] / 20).saturating_sub(self.paid_platform[i])
    }

    /// Starts the settle window after an own payout-producing callback (5.2 principle 6): every
    /// update is a `max()`, and all three values are set together so they cannot diverge.
    pub(super) fn set_window(&mut self, class: Class) {
        let block = env::block_height();
        self.settle_until_block = self
            .settle_until_block
            .max(block.saturating_add(super::PAYOUT_SETTLE_BLOCKS));
        self.last_payout_callback_block = block;
        self.settle_window_class = class;
    }

    fn settle_refused(&mut self, op_id: U64, reason: &str) {
        self.release();
        event("settle_refused", json!({"op_id": op_id, "reason": reason}));
    }
}

/// A strict decimal amount: `0|[1-9][0-9]*` fitting in `u128` (principle 10).
pub(super) fn strict_amount(v: &Value) -> Option<u128> {
    let s = v.as_str()?;
    if s.is_empty() || s.len() > 39 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if s.len() > 1 && s.starts_with('0') {
        return None;
    }
    s.parse().ok()
}

#[near]
impl Strategy {
    /// Ends the run (5.4): `Running` to `Closing`. The creator at any time, anyone from
    /// `run_end_ns`. Refused while an operation holds the lock (EC-C50). No state is fixed: exits
    /// read the positions live. (After `run_end` this will also abort a parked chain, which
    /// cannot exist before the trading slice.)
    pub fn close(&mut self) {
        if self.status != Status::Running {
            refuse("LIMIT: wrong status");
        }
        let caller = env::predecessor_account_id();
        let after_end = env::block_timestamp() >= self.config.run_end_ns.0;
        if caller != self.config.creator && !after_end {
            refuse("AUTH: creator only before run end");
        }
        if self.lock.is_some() {
            refuse("LIMIT: operation pending");
        }
        self.status = Status::Closing;
        event(
            "close",
            json!({"by": caller, "at_ns": U64(env::block_timestamp()), "after_run_end": after_end}),
        );
    }

    /// Moves `Closing` to `Closed` once each pool token's DCL internal balance is below its dust
    /// threshold (5.8). Anyone, rate-limited per caller class. Checks in principle 5's order:
    /// status, no lock, the rate limit, then the stale cooldown, the settle window and the gas.
    pub fn settle(&mut self) -> Promise {
        if self.status != Status::Closing {
            refuse("LIMIT: wrong status");
        }
        if self.lock.is_some() {
            refuse("LIMIT: operation pending");
        }
        let class = self.caller_class();
        if !self.rate_ok(RateMethod::Settle, 0, class) {
            refuse("LIMIT: rate limited");
        }
        let block = env::block_height();
        if let Some(b) = self.stale_resolution_block {
            if block < b.saturating_add(self.config.stale_cooldown_blocks.0) {
                refuse("LIMIT: stale cooldown");
            }
        }
        if block < self.settle_until_block {
            refuse("LIMIT: settling");
        }
        if env::prepaid_gas() < MIN_GAS_SETTLE {
            refuse("LIMIT: gas");
        }
        self.rate_stamp(RateMethod::Settle, 0, class);
        let op_id = self.next_op_id;
        self.next_op_id += 1;
        self.lock = Some(Lock {
            op_id: U64(op_id),
            op: Op::Settle,
            stage: Stage::ReadAssets,
            promise_block: U64(block),
        });
        event("settle_started", json!({"op_id": U64(op_id)}));
        let me = env::current_account_id();
        Promise::new(self.config.dcl_contract.clone())
            .function_call(
                "list_user_assets".to_string(),
                json!({ "account_id": me }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_VIEW,
            )
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_SETTLE_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_settle_assets(U64(op_id)),
            )
    }

    /// The read's callback. Never panics after the lock check: every refusal is a
    /// `settle_refused` event and releases the lock.
    pub fn on_settle_assets(&mut self, op_id: U64) {
        callback_only();
        if self.lock_at(op_id.0, Stage::ReadAssets).is_none() {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        }
        if self.status != Status::Closing {
            return self.settle_refused(op_id, "LIMIT: wrong status");
        }
        // The strategy's own position must be removed first (`exit_remove` clears it): a live
        // position holds value that settlement and the claims would otherwise strand (5.8).
        if self.own_position.is_some() {
            return self.settle_refused(op_id, "LIMIT: own position exists");
        }
        let answer: Option<Value> = single_result()
            .ok()
            .and_then(|b| near_sdk::serde_json::from_slice(&b).ok());
        let Some(Value::Object(assets)) = answer else {
            return self.settle_refused(op_id, "LIMIT: read failed");
        };
        // Every entry must be a strict amount, whatever its token: an answer in a shape this code
        // does not understand (a nested object, a number, a renamed key) must never read as "no
        // balance" (security audit M-1). Then each pool token's balance comes from its own entry
        // (`dust_threshold` holds exactly the two pool tokens, `new` checks it); an absent entry is
        // 0. The answer is capped at 4 KB by `single_result`, which bounds the parse and the entries
        // (a longer one is `LIMIT: read failed`, an event, never a panic).
        let mut amounts: Vec<(&str, u128)> = Vec::with_capacity(assets.len());
        for (token, v) in &assets {
            match strict_amount(v) {
                Some(a) => amounts.push((token.as_str(), a)),
                None => return self.settle_refused(op_id, "LIMIT: read failed"),
            }
        }
        for (token, dust) in &self.limits.dust_threshold {
            let amount = amounts
                .iter()
                .find(|(t, _)| *t == token.as_str())
                .map_or(0, |(_, a)| *a);
            // A token whose withdraws keep failing (EC-C103) never blocks settlement.
            let stuck = self
                .token_index(token)
                .is_some_and(|i| self.withdraw_failures[i].stuck(DAY_NS));
            if amount >= dust.0 && !stuck {
                return self.settle_refused(op_id, "LIMIT: internal balance left");
            }
        }
        self.release();
        self.status = Status::Closed;
        self.closed_at_ns = Some(env::block_timestamp());
        event(
            "settle",
            json!({"op_id": op_id, "closed_at_ns": U64(env::block_timestamp())}),
        );
    }

    pub fn get_settle_window(&self) -> SettleWindow {
        SettleWindow {
            last_payout_callback_block: U64(self.last_payout_callback_block),
            settle_window_class: self.settle_window_class,
            settle_until_block: U64(self.settle_until_block),
        }
    }
    pub fn get_last_payout_callback_block(&self) -> U64 {
        U64(self.last_payout_callback_block)
    }
    pub fn get_closed_at(&self) -> Option<U64> {
        self.closed_at_ns.map(U64)
    }
    pub fn get_settle_until_block(&self) -> U64 {
        U64(self.settle_until_block)
    }
}
