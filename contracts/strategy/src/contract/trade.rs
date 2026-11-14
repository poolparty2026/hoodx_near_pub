//! Slice 7: the action log and `agent_swap` (ARCHITECTURE 5.3 `ActionRecord`, 5.5, 5.6; the
//! minimal plan, D55). The agent supplies choices only, never trust: the range points and a
//! decision hash. The contract takes the lock, reads the pool, the wallet balances and DCL's
//! `predict_add_liquidity` in parallel, then in the callback checks the pool (running, our two
//! tokens), the drift of the agent's observed point from its own read, the centring of the range,
//! sizes the swap itself with `price::swap_for_range`, computes the minimum output itself with
//! `price::swap_min_output`, and sends `ft_transfer_call` with a `Swap` message. Every call that
//! takes the lock leaves a record, refused or not, which counts toward the windows.
//!
//! **Simplifications of 5.6 (D55, listed in `MINIMAL_PLAN.md`):** the swap minimum uses the
//! reference-based floor alone (DCL's `quote` signature is not confirmed, gate 3 Part B; with the
//! quote term at 0 the larger of the two terms is the reference one, so a swap whose price moved
//! or whose impact is large fails safely instead of paying out less); no second read round; no
//! parking (the call needs `MIN_GAS_SWAP` up front); the wallet balance less `platform_owed` is
//! the spendable amount (an internal balance exists only after a failed add, which returns it to
//! the wallet); `quiet_since_block` is `settle_until_block`. **Unverified:** the gas constants and
//! the probe scale for `predict_add_liquidity` (measured in the sandbox test).
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

use super::funding::{callback_only, parse_balance, GAS_VIEW, OFFCHAIN_MARGIN_BLOCKS, ONE_YOCTO};
use super::settle::strict_amount;
use super::start::{answer, GAS_READ_STORAGE, MAX_SWAPS_PER_RUN};
use super::{
    event, network, parse_hash, refuse, Class, Lock, Op, Stage, Status, Strategy, StrategyExt,
};
use crate::limits::NANOS_PER_S;
use crate::price;

/// The most trading records kept (they are read with the state): a refusal-heavy agent can't grow
/// the state without bound. A call that would exceed it is refused `LIMIT: action log full`.
pub const MAX_ACTIONS_STORED: usize = 64;
/// Slots only `agent_open`, `agent_close_position` and `exit_remove` may use.
pub const RESERVED_SLOTS: usize = 4;
/// The probe `predict_add_liquidity` is asked about: large in both tokens so the returned `need`
/// carries the range's token ratio at full precision (it only gives the ratio). Scaled for the
/// USDC (6 decimals) / wNEAR (24 decimals) pool: 10^18 of token_x and 10^36 of token_y.
pub const PROBE_X: u128 = 1_000_000_000_000_000_000;
pub const PROBE_Y: u128 = 1_000_000_000_000_000_000_000_000_000_000_000_000;
/// Gas: the predict read, the swap itself (`ft_transfer_call` to DCL), its result callback, and the
/// read round's callback, which starts the swap and so holds its gas. The prepaid minimum adds the
/// reads' receipt fees. **Unmeasured at the low end** (the sandbox test shows the burns).
pub const GAS_PREDICT: Gas = Gas::from_tgas(25);
pub const GAS_SWAP: Gas = Gas::from_tgas(90);
pub const GAS_SWAP_RESULT: Gas = Gas::from_tgas(10);
pub const GAS_SWAP_READ_CB: Gas = Gas::from_tgas(150);
pub const MIN_GAS_SWAP: Gas = Gas::from_tgas(280);

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ActionKind {
    Swap,
    Open,
    ClosePosition,
    ExitRemove,
}

/// A point the agent (or the contract) observed: the block it was read at and the pool's point.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Observed {
    pub block: U64,
    pub point: i32,
}

/// What the agent sends with every trading call. `chain_head` is the head of the agent's decision
/// log chain, recorded for the check page (no heartbeat checks it on chain in v1).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Meta {
    pub observed: Observed,
    pub decision_hash: String,
    pub chain_head: Option<String>,
}

/// The outcome of a trading call. A refusal after the lock names its reason (snake_case); a
/// swap the pool refused (`used == 0`) is its own result, never shown as `Ok`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum ActionResult {
    Pending,
    Ok,
    Refused(String),
    Failed(String),
    SwapRefused,
    Unknown,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct SwapInfo {
    pub token_in: AccountId,
    pub amount_in: U128,
    pub min_out: U128,
    /// What the pool used, from the token's `ft_transfer_call` result; 0 until the callback.
    pub used: U128,
}

/// What a trading call computed from its read round: spendable per token (quote, base) and the
/// `need` of `predict_add_liquidity` (token_x, token_y).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct RoundInfo {
    pub spendable_quote: U128,
    pub spendable_base: U128,
    pub need_x: U128,
    pub need_y: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ActionRecord {
    pub index: U64,
    pub op_id: U64,
    pub kind: ActionKind,
    pub caller: AccountId,
    pub left_point: i32,
    pub right_point: i32,
    pub observed: Observed,
    /// The pool's own point at the read round, with the block it was read at.
    pub reference: Option<Observed>,
    pub decision_hash: String,
    pub chain_head: Option<String>,
    /// The block and time of the call that took the lock.
    pub call_block: U64,
    pub timestamp_ns: U64,
    pub result_block: Option<U64>,
    pub result_ts_ns: Option<U64>,
    pub result: ActionResult,
    pub round: Option<RoundInfo>,
    pub swap: Option<SwapInfo>,
    /// The deposit and add of an `Open` record (S8); `None` for every other kind.
    pub open: Option<OpenInfo>,
    /// The removal of a `ClosePosition` or `ExitRemove` record (S9); `None` for every other kind.
    pub remove: Option<RemoveInfo>,
}

/// What a removal read, sent and got: the liquidity removed, DCL's own prediction and unclaimed
/// fees from the read round, the minimums sent, what the remove reported, and the fees counted
/// (`min(unclaimed_fee_t, reported_t)`, EC-C115). `confirm_observed` is the close's first
/// confirming observation (`None` for an exit).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RemoveInfo {
    pub position: String,
    pub liquidity: U128,
    pub unclaimed_x: U128,
    pub unclaimed_y: U128,
    pub predict_x: U128,
    pub predict_y: U128,
    pub min_x: U128,
    pub min_y: U128,
    pub reported_x: U128,
    pub reported_y: U128,
    pub fees_x: U128,
    pub fees_y: U128,
    pub confirm_observed: Option<Observed>,
}

/// What an `agent_open` computed and did: the amounts it sized from its read round, the deposits
/// it sent, the add's predicted use and minimums, and the position id the add returned.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct OpenInfo {
    /// `add_amounts` (token_x, token_y) and what was already in DCL's internal balance.
    pub add_x: U128,
    pub add_y: U128,
    pub internal_x: U128,
    pub internal_y: U128,
    /// The deposits sent: `add - internal` where positive.
    pub deposit_x: U128,
    pub deposit_y: U128,
    /// `predict_add_liquidity(add_amounts)` and the minimums sent with the add.
    pub predict_x: U128,
    pub predict_y: U128,
    pub min_x: U128,
    pub min_y: U128,
    pub lpt_id: Option<String>,
}

/// The point spacing of a DCL fee tier (gate 3, the same table as `FEE_TIER_POINT_DELTA`).
pub fn point_delta(fee_tier: u32) -> Option<i32> {
    Some(match fee_tier {
        100 => 1,
        400 => 8,
        1000 => 20,
        2000 => 40,
        10000 => 200,
        _ => return None,
    })
}

impl Strategy {
    /// The pool's fee tier, the last part of `limits.pool` (`a|b|100`).
    pub(super) fn fee_tier(&self) -> u32 {
        self.limits
            .pool
            .rsplit('|')
            .next()
            .and_then(|t| t.parse().ok())
            .unwrap_or(0)
    }

    pub(super) fn record_mut(&mut self, index: u64) -> Option<&mut ActionRecord> {
        self.actions.get_mut(index as usize)
    }

    /// Ends a trading call: the record's result and time, the lock released, an event.
    pub(super) fn finish_action(&mut self, index: u64, result: ActionResult) {
        let (block, ts) = (env::block_height(), env::block_timestamp());
        if let Some(r) = self.record_mut(index) {
            r.result_block = Some(U64(block));
            r.result_ts_ns = Some(U64(ts));
            r.result = result.clone();
        }
        self.release();
        event(
            "action_result",
            json!({"index": U64(index), "result": result}),
        );
    }

    /// A lost operation: the record's result is `Unknown` (the lock is released by the caller).
    pub(super) fn finish_unknown(&mut self, index: u64) {
        let (block, ts) = (env::block_height(), env::block_timestamp());
        if let Some(r) = self.record_mut(index) {
            r.result_block = Some(U64(block));
            r.result_ts_ns = Some(U64(ts));
            r.result = ActionResult::Unknown;
        }
        event(
            "action_result",
            json!({"index": U64(index), "result": ActionResult::Unknown}),
        );
    }

    /// The first checks every trading call shares, in principle 5's order after the status and the
    /// caller: the run not ended, no lock, the interval and the 24-hour count, then quietness.
    /// `paired` exempts only the interval (a paired open). Panics with a `LIMIT:` message.
    pub(super) fn trading_windows(&self, paired: bool) {
        self.trading_windows_until(paired, self.config.run_end_ns.0);
    }

    /// The same checks with another end: a close may run until `run_end + exit_grace`.
    pub(super) fn trading_windows_until(&self, paired: bool, end_ns: u64) {
        let now = env::block_timestamp();
        if now >= end_ns {
            refuse("LIMIT: run ended");
        }
        if self.lock.is_some() {
            refuse("LIMIT: operation pending");
        }
        let interval = self
            .limits
            .min_action_interval_s
            .0
            .saturating_mul(NANOS_PER_S);
        if !paired {
            if let Some(last) = self.actions.last() {
                if now < last.timestamp_ns.0.saturating_add(interval) {
                    refuse("LIMIT: action interval");
                }
            }
        }
        let day = 86_400 * NANOS_PER_S;
        let in_window = self
            .actions
            .iter()
            .filter(|r| r.timestamp_ns.0.saturating_add(day) > now)
            .count();
        if in_window >= self.limits.max_actions_per_24h as usize {
            refuse("LIMIT: actions per 24h");
        }
    }

    /// Quietness for an agent trade: the settle window passed and the observation is at least the
    /// payout margin after the last own payout-producing callback (EC-C126, 5.2 principle 6).
    pub(super) fn trading_quiet(&self, observed_block: u64) {
        if env::block_height() < self.settle_until_block {
            refuse("LIMIT: not quiet");
        }
        if observed_block
            < self
                .last_payout_callback_block
                .saturating_add(OFFCHAIN_MARGIN_BLOCKS)
        {
            refuse("LIMIT: inside payout margin");
        }
    }

    /// The observation and the decision hash (EC-C126, EC-C155).
    /// `paired`: the hash must be (and is checked by the caller to be) the previous Swap's, so it
    /// is not required to be new.
    pub(super) fn trading_meta(&self, meta: &Meta, paired: bool) -> [u8; 32] {
        let (now, ob) = (env::block_height(), meta.observed.block.0);
        if ob > now || now - ob > self.limits.max_observation_age_blocks.0 {
            refuse("LIMIT: observation age");
        }
        // The agent's free text is bounded: a head is 64 lowercase hex or absent, so a record can't
        // outgrow `RECORD_BYTES` (contract review H1, security M1).
        if meta
            .chain_head
            .as_ref()
            .is_some_and(|h| parse_hash(h).is_none())
        {
            refuse("LIMIT: chain head");
        }
        match parse_hash(&meta.decision_hash) {
            Some(h) if paired || !self.seen_decisions.contains(&h) => h,
            _ => refuse("LIMIT: decision hash"),
        }
    }

    /// The range: within +-800,000, `left < right`, both on the spacing, the width within the
    /// public bounds, the observed point inside `[left, right)`.
    pub(super) fn trading_points(&self, left: i32, right: i32, observed: i32) {
        let ok = |p: i32| (price::MIN_POINT..=price::MAX_POINT).contains(&p);
        let delta = point_delta(self.fee_tier());
        let width = (right as i64) - (left as i64);
        let valid = ok(left)
            && ok(right)
            && left < right
            && delta.is_some_and(|d| left % d == 0 && right % d == 0)
            && width >= self.limits.min_range_width_bps as i64
            && width <= self.limits.max_range_width_bps as i64
            && left <= observed
            && observed < right;
        if !valid {
            refuse("LIMIT: points");
        }
    }

    /// Takes the lock for a trading call and appends its record (counted from here).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn open_action(
        &mut self,
        kind: ActionKind,
        op: impl FnOnce(U64) -> Op,
        left: i32,
        right: i32,
        meta: &Meta,
        hash: [u8; 32],
        stage: Stage,
    ) -> u64 {
        let index = self.actions.len() as u64;
        let op_id = self.next_op_id;
        self.next_op_id += 1;
        if !self.seen_decisions.contains(&hash) {
            self.seen_decisions.push(hash);
        }
        self.actions.push(ActionRecord {
            index: U64(index),
            op_id: U64(op_id),
            kind,
            caller: env::predecessor_account_id(),
            left_point: left,
            right_point: right,
            observed: meta.observed,
            reference: None,
            decision_hash: meta.decision_hash.clone(),
            chain_head: meta.chain_head.clone(),
            call_block: U64(env::block_height()),
            timestamp_ns: U64(env::block_timestamp()),
            result_block: None,
            result_ts_ns: None,
            result: ActionResult::Pending,
            round: None,
            swap: None,
            open: None,
            remove: None,
        });
        self.lock = Some(Lock {
            op_id: U64(op_id),
            op: op(U64(index)),
            stage,
            promise_block: U64(env::block_height()),
        });
        event(
            "action",
            json!({"index": U64(index), "op_id": U64(op_id), "kind": kind, "caller": env::predecessor_account_id()}),
        );
        index
    }
}

#[near]
impl Strategy {
    /// The swap before an open (5.6): the agent names the range and its observation; the contract
    /// sizes and bounds the swap itself. Checks in principle 5's order: status, caller, then the
    /// windows, quietness, the position and swap counters, gas, the observation and hash, the
    /// points, the log capacity; then the lock and a record.
    pub fn agent_swap(&mut self, left_point: i32, right_point: i32, meta: Meta) -> Promise {
        if self.status != Status::Running {
            refuse("LIMIT: wrong status");
        }
        if env::predecessor_account_id() != self.config.agent {
            refuse("AUTH: agent only");
        }
        self.trading_windows(false);
        if self.opened {
            refuse("LIMIT: already opened");
        }
        if self.own_position.is_some() {
            refuse("LIMIT: position exists");
        }
        if self.swaps_used as u64 >= MAX_SWAPS_PER_RUN {
            refuse("LIMIT: swaps per run");
        }
        self.trading_quiet(meta.observed.block.0);
        if env::prepaid_gas() < MIN_GAS_SWAP {
            refuse("LIMIT: gas");
        }
        let hash = self.trading_meta(&meta, false);
        self.trading_points(left_point, right_point, meta.observed.point);
        // Slots stay free for the open, the close and the exits, which must not be blocked by
        // swaps (contract review M1, security L4).
        if self.actions.len() >= MAX_ACTIONS_STORED - RESERVED_SLOTS {
            refuse("LIMIT: action log full");
        }
        let base: AccountId = network()
            .base_token
            .parse()
            .unwrap_or_else(|_| refuse("LIMIT: not the network constant"));
        let index = self.open_action(
            ActionKind::Swap,
            |index| Op::Swap { index },
            left_point,
            right_point,
            &meta,
            hash,
            Stage::ReadRound,
        );
        let op_id = self.actions[index as usize].op_id;
        let me = env::current_account_id();
        let read = |to: AccountId, method: &str, args: Value, gas: Gas| {
            Promise::new(to).function_call(
                method.to_string(),
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                gas,
            )
        };
        let dcl = self.config.dcl_contract.clone();
        read(
            dcl.clone(),
            "get_pool",
            json!({"pool_id": self.limits.pool}),
            GAS_VIEW,
        )
        .and(read(
            self.config.quote_token.clone(),
            "ft_balance_of",
            json!({"account_id": me}),
            GAS_READ_STORAGE,
        ))
        .and(read(
            base,
            "ft_balance_of",
            json!({"account_id": me}),
            GAS_READ_STORAGE,
        ))
        .and(read(
            dcl,
            "predict_add_liquidity",
            json!({
                "pool_id": self.limits.pool,
                "left_point": left_point,
                "right_point": right_point,
                "amount_x": U128(PROBE_X),
                "amount_y": U128(PROBE_Y),
            }),
            GAS_PREDICT,
        ))
        .then(
            Self::ext(me)
                .with_static_gas(GAS_SWAP_READ_CB)
                .with_unused_gas_weight(0)
                .on_swap_reads(op_id),
        )
    }

    /// The read round's callback. Never panics after the lock check: every refusal finishes the
    /// record (`Refused(reason)` or `Failed("read")`) and releases the lock.
    pub fn on_swap_reads(&mut self, op_id: U64) {
        callback_only();
        let Some(Lock {
            op: Op::Swap { index },
            ..
        }) = self.lock_at(op_id.0, Stage::ReadRound)
        else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let index = index.0;
        match self.plan_swap(index) {
            Err(result) => self.finish_action(index, result),
            Ok(plan) => {
                let (token_in, amount_in, min_out, out_token, round, reference) = plan;
                if let Some(r) = self.record_mut(index) {
                    r.reference = Some(reference);
                    r.round = Some(round);
                    r.swap = Some(SwapInfo {
                        token_in: token_in.clone(),
                        amount_in: U128(amount_in),
                        min_out: U128(min_out),
                        used: U128(0),
                    });
                }
                self.lock = Some(Lock {
                    op_id,
                    op: Op::Swap { index: U64(index) },
                    stage: Stage::Swapping,
                    promise_block: U64(env::block_height()),
                });
                let msg = json!({"Swap": {
                    "pool_ids": [self.limits.pool],
                    "output_token": out_token,
                    "min_output_amount": U128(min_out),
                    "skip_unwrap_near": true,
                }});
                let me = env::current_account_id();
                Promise::new(token_in)
                    .function_call(
                        "ft_transfer_call".to_string(),
                        json!({
                            "receiver_id": self.config.dcl_contract,
                            "amount": U128(amount_in),
                            "msg": msg.to_string(),
                        })
                        .to_string()
                        .into_bytes(),
                        ONE_YOCTO,
                        GAS_SWAP,
                    )
                    .then(
                        Self::ext(me)
                            .with_static_gas(GAS_SWAP_RESULT)
                            .with_unused_gas_weight(0)
                            .on_swapped(op_id),
                    )
                    .detach();
            }
        }
    }

    /// The swap's result: `ft_transfer_call` returns the amount the pool used as a JSON string.
    /// 0 is `SwapRefused` (nothing moved); more is `Ok`, counted and opening the settle window;
    /// a failed receipt is `Failed("swap")`.
    pub fn on_swapped(&mut self, op_id: U64) {
        callback_only();
        let Some(Lock {
            op: Op::Swap { index },
            ..
        }) = self.lock_at(op_id.0, Stage::Swapping)
        else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let index = index.0;
        // Any failed or unreadable result counts toward `MAX_SWAPS_PER_RUN`, as a lost swap does: a failed
        // receipt, an oversized result (`single_result` is `Err` above 4,096 bytes) or a result this code can't
        // read may all follow a transfer that moved tokens (security audit M1, round 5 C; EC-C97, EC-C172).
        // Only `SwapRefused` (the pool used 0) does not count.
        let used = match super::funding::single_result() {
            Ok(b) => parse_balance(&b),
            Err(_) => None,
        };
        let result = match used {
            None => {
                self.swaps_used = self.swaps_used.saturating_add(1);
                self.set_window(Class::Agent);
                ActionResult::Failed("swap".into())
            }
            Some(0) => ActionResult::SwapRefused,
            Some(u) => {
                if let Some(s) = self.record_mut(index).and_then(|r| r.swap.as_mut()) {
                    s.used = U128(u);
                }
                self.swaps_used = self.swaps_used.saturating_add(1);
                self.set_window(Class::Agent);
                ActionResult::Ok
            }
        };
        self.finish_action(index, result);
    }

    pub fn get_actions(&self, from: U64, limit: u32) -> Vec<ActionRecord> {
        self.actions
            .iter()
            .skip(from.0 as usize)
            .take(limit.min(20) as usize)
            .cloned()
            .collect()
    }
    pub fn get_action(&self, index: U64) -> Option<ActionRecord> {
        self.actions.get(index.0 as usize).cloned()
    }
    pub fn get_actions_len(&self) -> U64 {
        U64(self.actions.len() as u64)
    }
    pub fn get_swaps_used(&self) -> u8 {
        self.swaps_used
    }
    pub fn get_opened(&self) -> bool {
        self.opened
    }
    pub fn get_own_position(&self) -> Option<String> {
        self.own_position.clone()
    }
}

impl Strategy {
    /// The pool read: running, exactly our two tokens and our pool id, a point within bounds.
    /// Returns whether the quote token is token_x, and the pool's point.
    pub(super) fn check_pool(&self, pool: &Value) -> Result<(bool, i32), ActionResult> {
        let refused = || ActionResult::Refused("pool".to_string());
        let net = network();
        let quote = self.config.quote_token.as_str();
        let (token_x, token_y) = (
            pool.get("token_x").and_then(Value::as_str),
            pool.get("token_y").and_then(Value::as_str),
        );
        let quote_is_x = match (token_x, token_y) {
            (Some(x), Some(y)) if x == quote && y == net.base_token => true,
            (Some(x), Some(y)) if y == quote && x == net.base_token => false,
            _ => return Err(refused()),
        };
        if pool.get("pool_id").and_then(Value::as_str) != Some(self.limits.pool.as_str())
            || pool.get("state").and_then(Value::as_str) != Some("Running")
        {
            return Err(refused());
        }
        let Some(point) = pool
            .get("current_point")
            .and_then(Value::as_i64)
            .filter(|p| (price::MIN_POINT as i64..=price::MAX_POINT as i64).contains(p))
        else {
            return Err(refused());
        };
        Ok((quote_is_x, point as i32))
    }

    /// The agent's observation against the contract's own read, then the centring of the
    /// range around it (EC-C95, EC-C96, EC-C148).
    pub(super) fn check_drift_and_centring(
        &self,
        point: i32,
        observed_point: i32,
        left: i32,
        right: i32,
    ) -> Result<(), ActionResult> {
        let refused = |r: &str| ActionResult::Refused(r.to_string());
        if (point as i64 - observed_point as i64).unsigned_abs()
            > self.limits.max_observation_drift_bps as u64
        {
            return Err(refused("drift"));
        }
        let (left, right) = (left as i64, right as i64);
        let quarter = (right - left) / 4;
        if !(left..right).contains(&(point as i64))
            || (point as i64) - left < quarter
            || right - (point as i64) < quarter
        {
            return Err(refused("centring"));
        }
        Ok(())
    }
}

type SwapPlan = (AccountId, u128, u128, AccountId, RoundInfo, Observed);

impl Strategy {
    /// Everything the read round decides: `Err(result)` ends the record, `Ok` is the swap to send.
    /// Pure of promises and never panics.
    fn plan_swap(&self, index: u64) -> Result<SwapPlan, ActionResult> {
        let Some(rec) = self.actions.get(index as usize) else {
            return Err(ActionResult::Failed("read".into()));
        };
        let refused = |r: &str| ActionResult::Refused(r.to_string());
        // The risk-adding stage re-checks the status and the run's end (principle 2).
        if self.status != Status::Running {
            return Err(refused("status"));
        }
        if env::block_timestamp() >= self.config.run_end_ns.0 {
            return Err(refused("run_ended"));
        }
        if env::promise_results_count() != 4 {
            return Err(ActionResult::Failed("read".into()));
        }
        let amount = |i: u64| answer(i).and_then(|v| strict_amount(&v));
        let (Some(pool), Some(quote_bal), Some(base_bal), Some(predict)) =
            (answer(0), amount(1), amount(2), answer(3))
        else {
            return Err(ActionResult::Failed("read".into()));
        };
        let net = network();
        let quote = self.config.quote_token.clone();
        let (quote_is_x, point) = self.check_pool(&pool)?;
        let reference = Observed {
            block: U64(env::block_height()),
            point,
        };
        self.check_drift_and_centring(point, rec.observed.point, rec.left_point, rec.right_point)?;
        // Spendable: the wallet less what is held back for the platform (0 before any fees).
        let spendable = |bal: u128, i: usize| bal.saturating_sub(self.platform_owed(i).min(bal));
        let (sq, sb) = (spendable(quote_bal, 0), spendable(base_bal, 1));
        let need = |k: &str| predict.get(k).and_then(strict_amount);
        let (Some(need_x), Some(need_y)) = (need("need_x"), need("need_y")) else {
            return Err(ActionResult::Failed("read".into()));
        };
        let round = RoundInfo {
            spendable_quote: U128(sq),
            spendable_base: U128(sb),
            need_x: U128(need_x),
            need_y: U128(need_y),
        };
        let (hold_x, hold_y) = if quote_is_x { (sq, sb) } else { (sb, sq) };
        let step = match price::swap_for_range(hold_x, hold_y, need_x, need_y, point) {
            None => return Err(refused("predict")),
            Some(None) => return Err(refused("no_swap_needed")),
            Some(Some(step)) => step,
        };
        let (sell_x, amount_in) = match step {
            price::SwapStep::SellX(a) => (true, a),
            price::SwapStep::SellY(a) => (false, a),
        };
        let input_is_quote = sell_x == quote_is_x;
        // The step cap and the deploy cap, in quote units at the reference (Q16, EC-C97, EC-C116).
        let value = |amount: u128, is_quote: bool| {
            if is_quote {
                Some(amount)
            } else {
                price::base_to_quote(amount, point, quote_is_x)
            }
        };
        let (Some(step_value), Some(base_value)) =
            (value(amount_in, input_is_quote), value(sb, false))
        else {
            return Err(refused("swap_step"));
        };
        let total = sq.saturating_add(base_value);
        if step_value > self.limits.max_principal.0
            || !price::within_bps(step_value, total, self.limits.max_swap_step_bps)
        {
            return Err(refused("swap_step"));
        }
        let Some(min_out) = price::swap_min_output(
            0,
            amount_in,
            input_is_quote,
            point,
            quote_is_x,
            self.fee_tier(),
            self.limits.max_swap_slippage_bps as u32,
        ) else {
            return Err(refused("floor"));
        };
        // A zero floor would send the swap with no price protection.
        if min_out == 0 {
            return Err(refused("floor"));
        }
        let (token_in, out_token): (AccountId, AccountId) = if input_is_quote {
            (quote, net.base_token.parse().map_err(|_| refused("pool"))?)
        } else {
            (net.base_token.parse().map_err(|_| refused("pool"))?, quote)
        };
        Ok((token_in, amount_in, min_out, out_token, round, reference))
    }
}
