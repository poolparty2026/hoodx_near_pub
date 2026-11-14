//! Slice 6a: `exit_withdraw(token)` (ARCHITECTURE 5.5, 5.8; EC-C73, EC-C74, EC-C103, EC-C133,
//! EC-C152, EC-C169). Moves a pool token's DCL internal balance to the wallet with
//! `withdraw_asset`. The agent and the creator may call it in `Running`, `Closing` and `Closed`;
//! anyone else only from `run_end + exit_grace`. It reads `list_user_assets` under the lock, and
//! calls `withdraw_asset` only if the balance is at least the token's dust threshold.
//!
//! A `true` result resets the token's failure count; a `false`, a failed receipt or any other result
//! counts as a failure only if at least
//! `min_action_interval_s` after the last counted one (EC-C103), and three counted failures over at
//! least 24 hours make the token *stuck*, which stops it blocking `settle`. Every result opens the
//! settle window (5.2 principle 6). Callbacks never panic: a refusal is an event.
//!
//! Confirmed on the pinned DCL (gate 3 Part J, with an ordinary account): `withdraw_asset` takes
//! `{"token_id", "amount"?: decimal string or null, "skip_unwrap_near"?}`, no deposit, and returns
//! `true`. **Unverified for the strategy account** until `agent_open` can create an internal
//! balance for it: the committed sandbox test covers the nothing-to-withdraw path only.
//! The paused flag (EC-C130) is not in this build: `pause()` has not landed.
use near_sdk::json_types::U64;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, Gas, NearToken, Promise};

use super::funding::{callback_only, single_result, GAS_VIEW};
use super::settle::strict_amount;
use super::{event, refuse, Class, Lock, Op, RateMethod, Stage, Status, Strategy, StrategyExt};

/// Fixed gas of `withdraw_asset`, of its callback, and of the read's callback (which starts the
/// withdraw and its callback, so it holds their gas). The prepaid minimum adds the read's receipt
/// fees. **Unmeasured:** the strategy account has no internal balance to withdraw in this build.
pub const GAS_WITHDRAW_ASSET: Gas = Gas::from_tgas(60);
pub const GAS_EXIT_RESULT: Gas = Gas::from_tgas(10);
pub const GAS_EXIT_READ_CB: Gas = Gas::from_tgas(90);
pub const MIN_GAS_EXIT: Gas = Gas::from_tgas(180);

/// The failed withdraws of one token: how many were counted, and when the first and the latest
/// were (a failure closer than `min_action_interval_s` to the latest is not counted).
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WithdrawFailures {
    pub count: u8,
    pub first_ns: u64,
    pub last_ns: u64,
}

impl WithdrawFailures {
    /// Three counted failures spanning at least `span_ns` (24 hours), with no `true` between.
    pub fn stuck(&self, span_ns: u64) -> bool {
        self.count >= 3 && self.last_ns.saturating_sub(self.first_ns) >= span_ns
    }

    /// Counts a `false` at `now` unless it is within `gap_ns` of the latest counted one.
    pub fn record(&mut self, now: u64, gap_ns: u64) {
        if self.count == 0 {
            *self = Self {
                count: 1,
                first_ns: now,
                last_ns: now,
            };
        } else if now >= self.last_ns.saturating_add(gap_ns) {
            self.count = self.count.saturating_add(1);
            self.last_ns = now;
        }
    }
}

impl Strategy {
    fn exit_refused(&mut self, op_id: U64, token: &near_sdk::AccountId, reason: &str) {
        self.release();
        event(
            "exit_withdraw",
            json!({"op_id": op_id, "token": token, "ok": false, "reason": reason}),
        );
    }
}

#[near]
impl Strategy {
    /// Withdraws a pool token's internal balance. Checks in principle 5's order: status, caller and
    /// time, token, no lock, the rate limit, the stale cooldown, the gas.
    pub fn exit_withdraw(&mut self, token: String) -> Promise {
        if !matches!(
            self.status,
            Status::Running | Status::Closing | Status::Closed
        ) {
            refuse("LIMIT: wrong status");
        }
        let class = self.caller_class();
        let token = self
            .pool_token(&token)
            .unwrap_or_else(|| refuse("LIMIT: not a pool token"));
        let idx = self
            .token_index(&token)
            .unwrap_or_else(|| refuse("LIMIT: not a pool token"));
        if class == Class::Outsider
            && env::block_timestamp()
                < self
                    .config
                    .run_end_ns
                    .0
                    .saturating_add(self.config.exit_grace_ns.0)
        {
            refuse("LIMIT: exit not open yet");
        }
        if self.lock.is_some() {
            refuse("LIMIT: operation pending");
        }
        if !self.rate_ok(RateMethod::ExitWithdraw, idx as u8 + 1, class) {
            refuse("LIMIT: rate limited");
        }
        let block = env::block_height();
        if let Some(b) = self.stale_resolution_block {
            if block < b.saturating_add(self.config.stale_cooldown_blocks.0) {
                refuse("LIMIT: stale cooldown");
            }
        }
        if env::prepaid_gas() < MIN_GAS_EXIT {
            refuse("LIMIT: gas");
        }
        self.rate_stamp(RateMethod::ExitWithdraw, idx as u8 + 1, class);
        let op_id = self.next_op_id;
        self.next_op_id += 1;
        self.lock = Some(Lock {
            op_id: U64(op_id),
            op: Op::ExitWithdraw {
                token: token.clone(),
                class,
            },
            stage: Stage::ReadAssets,
            promise_block: U64(block),
        });
        event(
            "exit_withdraw_started",
            json!({"op_id": U64(op_id), "token": token}),
        );
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
                    .with_static_gas(GAS_EXIT_READ_CB)
                    .with_unused_gas_weight(0)
                    .on_exit_assets(U64(op_id)),
            )
    }

    /// The read's callback: withdraws if the token's balance is at least its dust threshold.
    pub fn on_exit_assets(&mut self, op_id: U64) {
        callback_only();
        let Some(Lock {
            op: Op::ExitWithdraw { token, class },
            ..
        }) = self.lock_at(op_id.0, Stage::ReadAssets)
        else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        if !matches!(
            self.status,
            Status::Running | Status::Closing | Status::Closed
        ) {
            return self.exit_refused(op_id, &token, "LIMIT: wrong status");
        }
        let answer: Option<Value> = single_result()
            .ok()
            .and_then(|b| near_sdk::serde_json::from_slice(&b).ok());
        let Some(Value::Object(assets)) = answer else {
            return self.exit_refused(op_id, &token, "LIMIT: read failed");
        };
        // Every entry must be a strict amount (as in `settle`); then this token's balance.
        let mut balance = 0u128;
        for (t, v) in &assets {
            match strict_amount(v) {
                Some(a) if t.as_str() == token.as_str() => balance = a,
                Some(_) => {}
                None => return self.exit_refused(op_id, &token, "LIMIT: read failed"),
            }
        }
        let dust = self
            .limits
            .dust_threshold
            .iter()
            .find(|(t, _)| *t == token)
            .map_or(u128::MAX, |(_, d)| d.0);
        if balance < dust {
            return self.exit_refused(op_id, &token, "LIMIT: nothing to withdraw");
        }
        self.lock = Some(Lock {
            op_id,
            op: Op::ExitWithdraw {
                token: token.clone(),
                class,
            },
            stage: Stage::Withdraw,
            promise_block: U64(env::block_height()),
        });
        let me = env::current_account_id();
        Promise::new(self.config.dcl_contract.clone())
            .function_call(
                "withdraw_asset".to_string(),
                json!({"token_id": token, "skip_unwrap_near": true})
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_WITHDRAW_ASSET,
            )
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_EXIT_RESULT)
                    .with_unused_gas_weight(0)
                    .on_exit_withdrawn(op_id),
            )
            .detach();
    }

    /// `withdraw_asset`'s result: `true` resets the failures, an exact `false` counts one, any
    /// other result or a failed receipt is recorded without counting. Every result opens the
    /// settle window and releases the lock.
    pub fn on_exit_withdrawn(&mut self, op_id: U64) {
        callback_only();
        let Some(Lock {
            op: Op::ExitWithdraw { token, class },
            ..
        }) = self.lock_at(op_id.0, Stage::Withdraw)
        else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let idx = self.token_index(&token).unwrap_or(0);
        let gap = self
            .limits
            .min_action_interval_s
            .0
            .saturating_mul(crate::limits::NANOS_PER_S);
        let reason = match single_result() {
            Ok(b) if b == b"true" => {
                self.withdraw_failures[idx] = WithdrawFailures::default();
                None
            }
            // Anything but an exact `true` is a failure and counts (same interval gap): a call that
            // reverts every time (out of its fixed gas, a paused DCL) must make the token stuck
            // too, or `settle` would refuse for ever. The caller cannot starve the fixed gas.
            Ok(b) if b == b"false" => {
                self.withdraw_failures[idx].record(env::block_timestamp(), gap);
                Some("withdraw returned false")
            }
            _ => {
                self.withdraw_failures[idx].record(env::block_timestamp(), gap);
                Some("withdraw failed")
            }
        };
        self.set_window(class);
        self.release();
        event(
            "exit_withdraw",
            json!({"op_id": op_id, "token": token, "ok": reason.is_none(), "reason": reason}),
        );
    }

    pub fn get_withdraw_failures(&self) -> [WithdrawFailures; 2] {
        self.withdraw_failures
    }
}
