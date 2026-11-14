//! Slice 4: `start(expected_point)` (ARCHITECTURE 5.5, EC-C136, EC-C146, EC-C167). The creator
//! moves an `Open`, funded, registered strategy to `Running`. The call checks what the contract
//! itself knows (status, caller, deadline, lock, funding, registrations, NEAR reserve), takes the
//! lock and reads six views in parallel: DCL's `get_pool` and `get_user_storage_detail`, and
//! `storage_balance_of` for the platform and the creator at both pool tokens. The callback then
//! re-checks status and deadline and moves to `Running` only if the pool is running and its
//! point is within `max_observation_drift_bps` of `expected_point`, the free slots are at least
//! `MIN_FREE_SLOTS`, both payees are registered at both tokens and each `dust_threshold` is at
//! most 10^-3 of `max_principal` valued at the pool's point. A callback never panics (a panic
//! would roll back its release of the lock), so it records a refusal as a `start_refused` event
//! whose reason is the `LIMIT:` message a panic would have carried, and releases the lock.
//!
//! Confirmed in the sandbox on the pinned DCL (gate 3 Part H): `get_pool` and
//! `get_user_storage_detail` shapes, `storage_balance_of` answering an object or `null`, and the
//! gas of each read and of the callback (`tests/start.rs`); mainnet's `get_pool` answer is 849
//! bytes. **Unverified:** `RECORD_BYTES`, which stands in for the measured largest `ActionRecord`
//! until it exists, and the lowest prepaid gas that works (200 Tgas is the tested value).
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise, PromiseError};

use super::funding::{callback_only, GAS_VIEW};
use super::{event, network, refuse, Lock, Op, RegState, Stage, Status, Strategy, StrategyExt};
use crate::limits::DAY_NS;
use crate::price;

/// Free DCL slots `start` requires: `max_slots - cur_liquidity_slots - cur_order_slots`.
pub const MIN_FREE_SLOTS: u64 = 30;
/// Trading locks that may exceed the 24-hour count (paired opens), and the fixed non-trading and
/// status records the reserve covers (5.3).
pub const MAX_SWAPS_PER_RUN: u64 = 2;
pub const FIXED_RECORDS: u64 = 48 + 8;
/// The ring, allocated in full at `new` in the design (slice 5 builds it); the reserve counts it.
/// **Settle before slice 5:** once `new` allocates the ring its stake is in `storage_usage`, and
/// counting it here too would reserve it twice (about 3.8 NEAR; safe, but wasteful).
pub const RING_SIZE: u64 = 256;
/// **Assumed** largest stored record size in bytes (5.3: "about 1.5 KB, to be measured in M1");
/// replaced by the measured `ActionRecord` size, asserted by a test, when the record exists.
pub const RECORD_BYTES: u64 = 1_500;
/// Fixed gas of the six reads' common callback; the sandbox measures it under half
/// (`tests/start.rs`, Part H, also at points +-786,431 for the longest price loop).
pub const GAS_START_CALLBACK: Gas = Gas::from_tgas(30);
/// Gas for each of the four token `storage_balance_of` reads (light: a lookup).
pub const GAS_READ_STORAGE: Gas = Gas::from_tgas(5);
/// Six parallel reads cost about 14 Tgas each in receipt fees on top of the gas attached (six
/// data dependencies; mock `used_gas` after `start` is about 160 Tgas at these constants), so
/// the minimum is well above the attached total. A start at exactly this value succeeds in the
/// sandbox; the lowest working value was not searched.
pub const MIN_GAS_START: Gas = Gas::from_tgas(200);

/// NEAR the contract must hold, beyond its storage stake, to write its records until the end of
/// the run and the grace period (5.3): `((D + 1) * min(max_actions_per_24h,
/// floor(86_400 / min_action_interval_s) + 1) + MAX_SWAPS_PER_RUN + 48 + 8 + RING_SIZE)` records,
/// `D` the whole days from `deploy_ns` to `run_end + exit_grace`, rounded up. `byte_cost` is
/// the price of one stored byte in yoctoNEAR.
pub fn storage_reserve(
    deploy_ns: u64,
    run_end_ns: u64,
    exit_grace_ns: u64,
    max_actions_per_24h: u32,
    min_action_interval_s: u64,
    byte_cost: u128,
) -> u128 {
    let span = run_end_ns
        .saturating_add(exit_grace_ns)
        .saturating_sub(deploy_ns);
    let d = span.div_ceil(DAY_NS) as u128;
    let per_day =
        (max_actions_per_24h as u128).min((86_400 / min_action_interval_s.max(1)) as u128 + 1);
    let trading = (d + 1).saturating_mul(per_day);
    let records = trading
        .saturating_add(MAX_SWAPS_PER_RUN as u128)
        .saturating_add(FIXED_RECORDS as u128)
        .saturating_add(RING_SIZE as u128);
    records
        .saturating_mul(RECORD_BYTES as u128)
        .saturating_mul(byte_cost)
}

/// One of the six answers: a JSON value, or `None` for a failed, over-long or non-JSON result.
pub(super) fn answer(i: u64) -> Option<Value> {
    match env::promise_result_checked(i, 4_096) {
        Ok(b) => serde_json::from_slice(&b).ok(),
        Err(PromiseError::Failed | PromiseError::TooLong(_)) => None,
        Err(_) => None,
    }
}

/// A registered account has a `storage_balance_of` object; an unregistered one answers `null`.
fn registered(v: &Option<Value>) -> bool {
    matches!(v, Some(x) if x.is_object())
}

pub(super) fn count(v: &Value, k: &str) -> Option<u64> {
    v.get(k)?.as_u64()
}

impl Strategy {
    /// The refusal of a start whose callback ran: recorded as an event, lock released.
    fn start_refused(&mut self, op_id: U64, reason: &str) {
        self.release();
        event("start_refused", json!({"op_id": op_id, "reason": reason}));
    }
}

#[near]
impl Strategy {
    /// Starts the strategy (5.5). Checks in principle 5's order: status, caller, time, no lock,
    /// then its own: gas, the point, funding, registrations, the NEAR reserve.
    pub fn start(&mut self, expected_point: i32) -> Promise {
        if self.status != Status::Open {
            refuse("LIMIT: wrong status");
        }
        if env::predecessor_account_id() != self.config.creator {
            refuse("AUTH: creator only");
        }
        if env::block_timestamp() >= self.config.start_deadline_ns.0 {
            refuse("LIMIT: start deadline passed");
        }
        if self.lock.is_some() {
            refuse("LIMIT: operation pending");
        }
        if env::prepaid_gas() < MIN_GAS_START {
            refuse("LIMIT: gas");
        }
        if !(price::MIN_POINT..=price::MAX_POINT).contains(&expected_point) {
            refuse("LIMIT: point");
        }
        if self.principal == 0 {
            refuse("LIMIT: not funded");
        }
        if [
            self.registrations.quote_token,
            self.registrations.base_token,
            self.registrations.dcl_storage,
        ]
        .iter()
        .any(|r| r.state != RegState::Ok)
        {
            refuse("LIMIT: registrations not ok");
        }
        let byte_cost = env::storage_byte_cost().as_yoctonear();
        let stake = byte_cost.saturating_mul(env::storage_usage() as u128);
        let reserve = storage_reserve(
            self.deploy_ns,
            self.config.run_end_ns.0,
            self.config.exit_grace_ns.0,
            self.limits.max_actions_per_24h,
            self.limits.min_action_interval_s.0,
            byte_cost,
        );
        // Escrowed key NEAR and NEAR owed are never spendable (D57); both are 0 here in practice,
        // since keys are sold only after `start`.
        if env::account_balance().as_yoctonear()
            < stake
                .saturating_add(reserve)
                .saturating_add(self.escrow_total)
                .saturating_add(self.near_owed_total)
        {
            refuse("LIMIT: storage reserve");
        }

        let base: AccountId = network()
            .base_token
            .parse()
            .unwrap_or_else(|_| refuse("LIMIT: not the network constant"));
        let op_id = self.next_op_id;
        self.next_op_id += 1;
        self.lock = Some(Lock {
            op_id: U64(op_id),
            op: Op::Start,
            stage: Stage::ReadStart,
            promise_block: U64(env::block_height()),
        });
        event(
            "start_started",
            json!({"op_id": U64(op_id), "expected_point": expected_point}),
        );

        let me = env::current_account_id();
        let view = |to: AccountId, method: &str, args: Value, gas: Gas| {
            Promise::new(to).function_call(
                method.to_string(),
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                gas,
            )
        };
        let platform = &self.config.platform_account;
        let creator = &self.config.creator;
        let reads = view(
            self.config.dcl_contract.clone(),
            "get_pool",
            json!({"pool_id": self.limits.pool}),
            GAS_VIEW,
        )
        .and(view(
            self.config.dcl_contract.clone(),
            "get_user_storage_detail",
            json!({"user_id": me}),
            GAS_VIEW,
        ))
        .and(view(
            self.config.quote_token.clone(),
            "storage_balance_of",
            json!({"account_id": platform}),
            GAS_READ_STORAGE,
        ))
        .and(view(
            self.config.quote_token.clone(),
            "storage_balance_of",
            json!({"account_id": creator}),
            GAS_READ_STORAGE,
        ))
        .and(view(
            base.clone(),
            "storage_balance_of",
            json!({"account_id": platform}),
            GAS_READ_STORAGE,
        ))
        .and(view(
            base,
            "storage_balance_of",
            json!({"account_id": creator}),
            GAS_READ_STORAGE,
        ));
        reads.then(
            Self::ext(me)
                .with_static_gas(GAS_START_CALLBACK)
                .with_unused_gas_weight(0)
                .on_start_reads(U64(op_id), expected_point),
        )
    }

    /// The six reads' callback. Acts only on its own lock; re-checks status and deadline; never
    /// panics (it records a refusal and releases the lock instead).
    pub fn on_start_reads(&mut self, op_id: U64, expected_point: i32) {
        callback_only();
        if self.lock_at(op_id.0, Stage::ReadStart).is_none() {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        }
        if env::promise_results_count() != 6 {
            return self.start_refused(op_id, "LIMIT: read failed");
        }
        if self.status != Status::Open {
            return self.start_refused(op_id, "LIMIT: wrong status");
        }
        if env::block_timestamp() >= self.config.start_deadline_ns.0 {
            return self.start_refused(op_id, "LIMIT: start deadline passed");
        }
        let (pool, slots) = (answer(0), answer(1));
        let payees: Vec<Option<Value>> = (2..6).map(answer).collect();
        let (Some(pool), Some(slots)) = (pool, slots) else {
            return self.start_refused(op_id, "LIMIT: read failed");
        };

        // The pool: running, exactly our two tokens, its point within the drift bound.
        let net = network();
        let (token_x, token_y) = (
            pool.get("token_x").and_then(Value::as_str),
            pool.get("token_y").and_then(Value::as_str),
        );
        let quote = self.config.quote_token.as_str();
        let quote_is_x = match (token_x, token_y) {
            (Some(x), Some(y)) if x == quote && y == net.base_token => true,
            (Some(x), Some(y)) if y == quote && x == net.base_token => false,
            _ => return self.start_refused(op_id, "LIMIT: pool"),
        };
        if pool.get("pool_id").and_then(Value::as_str) != Some(self.limits.pool.as_str())
            || pool.get("state").and_then(Value::as_str) != Some("Running")
        {
            return self.start_refused(op_id, "LIMIT: pool");
        }
        let Some(point) = pool
            .get("current_point")
            .and_then(Value::as_i64)
            .filter(|p| (price::MIN_POINT as i64..=price::MAX_POINT as i64).contains(p))
        else {
            return self.start_refused(op_id, "LIMIT: pool");
        };
        if (point - expected_point as i64).unsigned_abs()
            > self.limits.max_observation_drift_bps as u64
        {
            return self.start_refused(op_id, "LIMIT: drift");
        }

        // Free slots.
        let (Some(max), Some(liq), Some(ord)) = (
            count(&slots, "max_slots"),
            count(&slots, "cur_liquidity_slots"),
            count(&slots, "cur_order_slots"),
        ) else {
            return self.start_refused(op_id, "LIMIT: read failed");
        };
        if max.saturating_sub(liq).saturating_sub(ord) < MIN_FREE_SLOTS {
            return self.start_refused(op_id, "LIMIT: slots");
        }

        // Both payees registered at both tokens, so claims can pay.
        if !payees.iter().all(registered) {
            return self.start_refused(op_id, "LIMIT: payee not registered");
        }

        // Each dust threshold at most 10^-3 of `max_principal`, valued in the quote token at the
        // pool's point (within the drift bound of `expected_point`, checked above) with the base
        // token's floored conversion, so a base dust worth a fraction of a quote unit above the
        // exact line can pass (disclosed, EC-C136).
        for (token, dust) in &self.limits.dust_threshold {
            let value = if token.as_str() == quote {
                Some(dust.0)
            } else {
                price::base_to_quote(dust.0, point as i32, quote_is_x)
            };
            let ok = value
                .and_then(|v| v.checked_mul(1_000))
                .is_some_and(|v| v <= self.limits.max_principal.0);
            if !ok {
                return self.start_refused(op_id, "LIMIT: dust threshold");
            }
        }

        self.release();
        self.status = Status::Running;
        self.started_at_ns = Some(env::block_timestamp());
        event(
            "start",
            json!({
                "op_id": op_id,
                "started_at_ns": U64(env::block_timestamp()),
                "point": point,
                "principal": U128(self.principal),
            }),
        );
    }

    pub fn get_started_at(&self) -> Option<U64> {
        self.started_at_ns.map(U64)
    }
    pub fn get_deploy_block(&self) -> U64 {
        U64(self.deploy_block)
    }
}
