//! Slice 8: `register_tokens` and `agent_open` (ARCHITECTURE 5.5, 5.6 step 5; the minimal plan,
//! D55; gate 3 Part J). `register_tokens` is a creator-called step: DCL refuses a deposit until
//! the tokens are registered with about 0.01 NEAR attached per token (returned). `agent_open`
//! then deposits `add_amounts - internal` of each token, reads DCL again at those amounts, checks
//! them and calls `add_liquidity` with exact amounts and minimums. Four stages, four callbacks,
//! each acting only on its own lock and stage, and none panics after the lock is taken: a refusal
//! finishes the record and releases the lock.
//!
//! **Simplifications of 5.6 (D55):** no parking (`MIN_GAS_OPEN` covers the whole chain, the
//! agent attaches 300 Tgas); no slot read (a full slot makes the add fail, `Failed(add)`); no
//! automatic withdraw after a failed add (the tokens stay in DCL's internal balance, `exit_withdraw`
//! returns them and a retry deposits only the shortfall); a lost add is closed for good, not
//! adopted. **Unverified against DCL:** `add_liquidity` accepting `skip_unwrap_near` for its
//! refund, and what `register_tokens` returns; the sandbox test asserts what it can.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

use super::funding::{callback_only, parse_balance, GAS_VIEW, ONE_YOCTO};
use super::settle::strict_amount;
use super::start::answer;
use super::trade::{ActionKind, ActionResult, Meta, Observed, OpenInfo, RoundInfo};
use super::{
    event, network, refuse, Class, Lock, Op, Stage, Status, Strategy, StrategyExt, GAS_CALLBACK,
};
use crate::limits::NANOS_PER_S;
use crate::price;

/// An `Open` call pairs with the Swap before it within this long after the Swap's result
/// (`packages/rules` `PAIR_WINDOW_S`, EC-C158).
pub const PAIR_WINDOW_S: u64 = 3600;
/// NEAR attached to `register_tokens`: DCL needs about 0.01 per token (gate 3 Part J), returned.
pub const REGISTER_TOKENS_DEPOSIT: NearToken =
    NearToken::from_yoctonear(20_000_000_000_000_000_000_000);
pub const GAS_REGISTER_TOKENS: Gas = Gas::from_tgas(20);
pub const MIN_GAS_REGISTER_TOKENS: Gas = Gas::from_tgas(60);
/// Gas of each stage of `agent_open`. Callbacks have fixed gas (no share of the unused gas) and
/// each holds the gas of everything it starts: the add's callback is the smallest. **Unmeasured at
/// the low end**; the sandbox test prints the burns.
pub const GAS_OPEN_ADDED: Gas = Gas::from_tgas(10);
/// The second round's prediction (DCL burnt 8 Tgas for it in the sandbox).
pub const GAS_PREDICT_ADD: Gas = Gas::from_tgas(15);
pub const GAS_ADD: Gas = Gas::from_tgas(60);
pub const GAS_OPEN_ADD_READ_CB: Gas = Gas::from_tgas(80);
pub const GAS_DEPOSIT: Gas = Gas::from_tgas(40);
pub const GAS_OPEN_DEPOSITED_CB: Gas = Gas::from_tgas(130);
pub const GAS_OPEN_READ_CB: Gas = Gas::from_tgas(220);
pub const MIN_GAS_OPEN: Gas = Gas::from_tgas(300);

impl Strategy {
    fn open_index(&self, op_id: u64, stage: Stage) -> Option<u64> {
        match self.lock_at(op_id, stage) {
            Some(Lock {
                op: Op::Open { index },
                ..
            }) => Some(index.0),
            _ => None,
        }
    }

    fn set_stage(&mut self, op_id: U64, index: u64, stage: Stage) {
        self.lock = Some(Lock {
            op_id,
            op: Op::Open { index: U64(index) },
            stage,
            promise_block: U64(env::block_height()),
        });
    }

    /// A refusal or failure of an `agent_open` callback. `moved`: tokens may have moved at DCL,
    /// so the settle window opens (5.2 principle 6).
    fn end_open(&mut self, index: u64, result: ActionResult, moved: bool) {
        if moved {
            self.set_window(Class::Agent);
        }
        self.finish_action(index, result);
    }

    /// The agent's previous record is a Swap that moved tokens, finished less than
    /// `PAIR_WINDOW_S` ago, under this decision hash (EC-C158).
    fn is_paired_open(&self, meta: &Meta) -> bool {
        let Some(last) = self.actions.last() else {
            return false;
        };
        let (Some(result_ts), Some(swap)) = (last.result_ts_ns, last.swap.as_ref()) else {
            return false;
        };
        let now = env::block_timestamp();
        last.kind == ActionKind::Swap
            && last.result == ActionResult::Ok
            && swap.used.0 > 0
            && last.decision_hash == meta.decision_hash
            && now >= result_ts.0
            && now - result_ts.0 < PAIR_WINDOW_S * NANOS_PER_S
    }
}

/// `list_user_assets` as (quote, base) internal balances: every entry must be a strict amount.
fn internal_balances(v: &Value, quote: &str, base: &str) -> Option<(u128, u128)> {
    let obj = v.as_object()?;
    let (mut q, mut b) = (0, 0);
    for (t, a) in obj {
        let a = strict_amount(a)?;
        if t == quote {
            q = a;
        } else if t == base {
            b = a;
        }
    }
    Some((q, b))
}

fn read(to: AccountId, method: &str, args: Value, gas: Gas) -> Promise {
    Promise::new(to).function_call(
        method.to_string(),
        args.to_string().into_bytes(),
        NearToken::from_yoctonear(0),
        gas,
    )
}

#[near]
impl Strategy {
    /// Registers both pool tokens at DCL (gate 3 Part J): creator only, `Running`, once. Checks in
    /// principle 5's order: status, caller, no lock, already done, gas, balance.
    pub fn register_tokens(&mut self) -> Promise {
        if self.status != Status::Running {
            refuse("LIMIT: wrong status");
        }
        if env::predecessor_account_id() != self.config.creator {
            refuse("AUTH: creator only");
        }
        if self.lock.is_some() {
            refuse("LIMIT: operation pending");
        }
        if self.tokens_registered {
            refuse("LIMIT: tokens already registered");
        }
        if env::prepaid_gas() < MIN_GAS_REGISTER_TOKENS {
            refuse("LIMIT: gas");
        }
        self.require_free(REGISTER_TOKENS_DEPOSIT.as_yoctonear());
        let base: AccountId = network()
            .base_token
            .parse()
            .unwrap_or_else(|_| refuse("LIMIT: not the network constant"));
        let op_id = self.next_op_id;
        self.next_op_id += 1;
        self.lock = Some(Lock {
            op_id: U64(op_id),
            op: Op::RegisterTokens,
            stage: Stage::Register,
            promise_block: U64(env::block_height()),
        });
        event("register_tokens_started", json!({"op_id": U64(op_id)}));
        let me = env::current_account_id();
        Promise::new(self.config.dcl_contract.clone())
            .function_call(
                "register_tokens".to_string(),
                json!({"token_ids": [self.config.quote_token, base]})
                    .to_string()
                    .into_bytes(),
                REGISTER_TOKENS_DEPOSIT,
                GAS_REGISTER_TOKENS,
            )
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_tokens_registered(U64(op_id)),
            )
    }

    /// `register_tokens`' result: a successful receipt sets the flag; anything else leaves it
    /// unset so the creator can call again. Never panics after the lock check.
    pub fn on_tokens_registered(&mut self, op_id: U64) {
        callback_only();
        if !matches!(
            self.lock_at(op_id.0, Stage::Register),
            Some(Lock {
                op: Op::RegisterTokens,
                ..
            })
        ) {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        }
        let ok = super::funding::single_result().is_ok();
        self.tokens_registered = ok;
        self.release();
        event("tokens_registered", json!({"op_id": op_id, "ok": ok}));
    }

    /// Deposit and add (5.6 step 5). The agent names the range and its observation; the contract
    /// sizes everything. First checks in principle 5's order: status, caller, the windows (a
    /// paired open is exempt from the interval only), registration, `opened`, `own_position`,
    /// quietness, gas, the observation and hash, the points, the log capacity.
    pub fn agent_open(&mut self, left_point: i32, right_point: i32, meta: Meta) -> Promise {
        if self.status != Status::Running {
            refuse("LIMIT: wrong status");
        }
        if env::predecessor_account_id() != self.config.agent {
            refuse("AUTH: agent only");
        }
        let paired = self.is_paired_open(&meta);
        self.trading_windows(paired);
        if !self.tokens_registered {
            refuse("LIMIT: tokens not registered");
        }
        if self.opened {
            refuse("LIMIT: already opened");
        }
        if self.own_position.is_some() {
            refuse("LIMIT: position exists");
        }
        self.trading_quiet(meta.observed.block.0);
        if env::prepaid_gas() < MIN_GAS_OPEN {
            refuse("LIMIT: gas");
        }
        let hash = self.trading_meta(&meta, paired);
        self.trading_points(left_point, right_point, meta.observed.point);
        // The last slots are for the exits that clear the position (security audit H1).
        if self.actions.len() >= super::MAX_ACTIONS_STORED - super::RESERVED_SLOTS {
            refuse("LIMIT: action log full");
        }
        let net = network();
        let base: AccountId = net
            .base_token
            .parse()
            .unwrap_or_else(|_| refuse("LIMIT: not the network constant"));
        let index = self.open_action(
            ActionKind::Open,
            |index| Op::Open { index },
            left_point,
            right_point,
            &meta,
            hash,
            Stage::ReadRound,
        );
        let op_id = self.actions[index as usize].op_id;
        let me = env::current_account_id();
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
            super::GAS_READ_STORAGE,
        ))
        .and(read(
            base,
            "ft_balance_of",
            json!({"account_id": me}),
            super::GAS_READ_STORAGE,
        ))
        .and(read(
            dcl.clone(),
            "list_user_assets",
            json!({"account_id": me}),
            GAS_VIEW,
        ))
        .and(read(
            dcl,
            "predict_add_liquidity",
            json!({
                "pool_id": self.limits.pool,
                "left_point": left_point,
                "right_point": right_point,
                "amount_x": U128(super::PROBE_X),
                "amount_y": U128(super::PROBE_Y),
            }),
            super::GAS_PREDICT,
        ))
        .then(
            Self::ext(me)
                .with_static_gas(GAS_OPEN_READ_CB)
                .with_unused_gas_weight(0)
                .on_open_reads(op_id),
        )
    }

    /// Round one: the pool, both wallet balances, DCL's internal balances and the probe. Sizes
    /// `add_amounts`, then sends the deposits (or goes straight to round two when the internal
    /// balance already covers them).
    pub fn on_open_reads(&mut self, op_id: U64) {
        callback_only();
        let Some(index) = self.open_index(op_id.0, Stage::ReadRound) else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        match self.plan_open(index) {
            Err(result) => self.end_open(index, result, false),
            Ok((reference, round, info)) => {
                let (dep_x, dep_y) = (info.deposit_x.0, info.deposit_y.0);
                if let Some(r) = self.record_mut(index) {
                    r.reference = Some(reference);
                    r.round = Some(round);
                    r.open = Some(info);
                }
                if dep_x == 0 && dep_y == 0 {
                    self.start_add_reads(op_id, index);
                    return;
                }
                self.set_stage(op_id, index, Stage::Depositing);
                let (tx, ty) = self.pool_order();
                let me = env::current_account_id();
                let dcl = self.config.dcl_contract.clone();
                let deposit = |token: AccountId, amount: u128| {
                    Promise::new(token).function_call(
                        "ft_transfer_call".to_string(),
                        json!({
                            "receiver_id": dcl,
                            "amount": U128(amount),
                            "msg": "\"Deposit\"",
                        })
                        .to_string()
                        .into_bytes(),
                        ONE_YOCTO,
                        GAS_DEPOSIT,
                    )
                };
                let first = match (dep_x > 0, dep_y > 0) {
                    (true, true) => deposit(tx, dep_x).and(deposit(ty, dep_y)),
                    (true, false) => deposit(tx, dep_x),
                    _ => deposit(ty, dep_y),
                };
                first
                    .then(
                        Self::ext(me)
                            .with_static_gas(GAS_OPEN_DEPOSITED_CB)
                            .with_unused_gas_weight(0)
                            .on_open_deposited(op_id),
                    )
                    .detach();
            }
        }
    }

    /// The deposits' results: each `ft_transfer_call` must report the whole amount used. Anything
    /// else is `Failed(deposit)` (tokens may have moved, so the window opens).
    pub fn on_open_deposited(&mut self, op_id: U64) {
        callback_only();
        let Some(index) = self.open_index(op_id.0, Stage::Depositing) else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let Some(info) = self
            .actions
            .get(index as usize)
            .and_then(|r| r.open.clone())
        else {
            return self.end_open(index, ActionResult::Failed("deposit".into()), true);
        };
        let expected: Vec<u128> = [info.deposit_x.0, info.deposit_y.0]
            .into_iter()
            .filter(|a| *a > 0)
            .collect();
        let ok = env::promise_results_count() as usize == expected.len()
            && expected.iter().enumerate().all(|(i, want)| {
                matches!(
                    env::promise_result_checked(i as u64, 128),
                    Ok(b) if parse_balance(&b) == Some(*want)
                )
            });
        if !ok {
            let seen: Vec<String> = (0..env::promise_results_count())
                .map(|i| match env::promise_result_checked(i, 128) {
                    Ok(b) => String::from_utf8_lossy(&b).into_owned(),
                    Err(_) => "<failed>".to_string(),
                })
                .collect();
            event(
                "open_deposit_mismatch",
                json!({"expected": expected.iter().map(|a| a.to_string()).collect::<Vec<_>>(), "seen": seen}),
            );
            return self.end_open(index, ActionResult::Failed("deposit".into()), true);
        }
        // A risk-adding stage re-checks the status and the run's end (principle 2).
        if self.status != Status::Running {
            return self.end_open(index, ActionResult::Refused("status".into()), true);
        }
        if env::block_timestamp() >= self.config.run_end_ns.0 {
            return self.end_open(index, ActionResult::Refused("run_ended".into()), true);
        }
        self.start_add_reads(op_id, index);
    }

    /// Round two: the pool, DCL's internal balances and `predict_add_liquidity(add_amounts)`.
    pub fn on_open_add_reads(&mut self, op_id: U64) {
        callback_only();
        let Some(index) = self.open_index(op_id.0, Stage::ReadAdd) else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        match self.plan_add(index) {
            Err(result) => self.end_open(index, result, true),
            Ok((min_x, min_y, predict_x, predict_y)) => {
                let Some(rec) = self.actions.get(index as usize) else {
                    return self.end_open(index, ActionResult::Failed("read".into()), true);
                };
                let (left, right) = (rec.left_point, rec.right_point);
                let info = rec.open.clone().unwrap_or_default();
                if let Some(o) = self.record_mut(index).and_then(|r| r.open.as_mut()) {
                    o.predict_x = U128(predict_x);
                    o.predict_y = U128(predict_y);
                    o.min_x = U128(min_x);
                    o.min_y = U128(min_y);
                }
                self.set_stage(op_id, index, Stage::Adding);
                let me = env::current_account_id();
                Promise::new(self.config.dcl_contract.clone())
                    .function_call(
                        "add_liquidity".to_string(),
                        json!({
                            "pool_id": self.limits.pool,
                            "left_point": left,
                            "right_point": right,
                            "amount_x": info.add_x,
                            "amount_y": info.add_y,
                            "min_amount_x": U128(min_x),
                            "min_amount_y": U128(min_y),
                            "skip_unwrap_near": true,
                        })
                        .to_string()
                        .into_bytes(),
                        NearToken::from_yoctonear(0),
                        GAS_ADD,
                    )
                    .then(
                        Self::ext(me)
                            .with_static_gas(GAS_OPEN_ADDED)
                            .with_unused_gas_weight(0)
                            .on_open_added(op_id),
                    )
                    .detach();
            }
        }
    }

    /// The add's result: a position id of this pool becomes `own_position` and `opened`; a failed
    /// receipt is `Failed(add)` (the deposited tokens stay in DCL's internal balance); a success
    /// whose id can't be read is `Unknown` and closes the open (the position can't be named,
    /// D55). Every result opens the settle window.
    pub fn on_open_added(&mut self, op_id: U64) {
        callback_only();
        let Some(index) = self.open_index(op_id.0, Stage::Adding) else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let result = super::funding::single_result();
        self.set_window(Class::Agent);
        let Ok(body) = result else {
            return self.finish_action(index, ActionResult::Failed("add".into()));
        };
        let prefix = format!("{}#", self.limits.pool);
        let id = near_sdk::serde_json::from_slice::<String>(&body)
            .ok()
            .filter(|id| id.len() <= 128 && id.starts_with(&prefix) && id.len() > prefix.len());
        self.opened = true;
        match id {
            Some(id) => {
                if let Some(o) = self.record_mut(index).and_then(|r| r.open.as_mut()) {
                    o.lpt_id = Some(id.clone());
                }
                self.own_position = Some(id);
                self.finish_action(index, ActionResult::Ok);
            }
            None => self.finish_action(index, ActionResult::Unknown),
        }
    }
}

impl Strategy {
    /// (token_x, token_y) account ids of the pool.
    fn pool_order(&self) -> (AccountId, AccountId) {
        let quote = self.config.quote_token.clone();
        let base: AccountId = network().base_token.parse().expect("network constant");
        // The pool id is `token_x|token_y|fee`.
        if self.limits.pool.starts_with(quote.as_str()) {
            (quote, base)
        } else {
            (base, quote)
        }
    }

    fn start_add_reads(&mut self, op_id: U64, index: u64) {
        let Some(rec) = self.actions.get(index as usize) else {
            return self.end_open(index, ActionResult::Failed("read".into()), true);
        };
        let (left, right) = (rec.left_point, rec.right_point);
        let info = rec.open.clone().unwrap_or_default();
        self.set_stage(op_id, index, Stage::ReadAdd);
        let me = env::current_account_id();
        let dcl = self.config.dcl_contract.clone();
        read(
            dcl.clone(),
            "get_pool",
            json!({"pool_id": self.limits.pool}),
            GAS_VIEW,
        )
        .and(read(
            dcl.clone(),
            "list_user_assets",
            json!({"account_id": me}),
            GAS_VIEW,
        ))
        .and(read(
            dcl,
            "predict_add_liquidity",
            json!({
                "pool_id": self.limits.pool,
                "left_point": left,
                "right_point": right,
                "amount_x": info.add_x,
                "amount_y": info.add_y,
            }),
            GAS_PREDICT_ADD,
        ))
        .then(
            Self::ext(me)
                .with_static_gas(GAS_OPEN_ADD_READ_CB)
                .with_unused_gas_weight(0)
                .on_open_add_reads(op_id),
        )
        .detach();
    }

    /// Round one's decisions. `Err(result)` ends the record; never panics.
    fn plan_open(&self, index: u64) -> Result<(Observed, RoundInfo, OpenInfo), ActionResult> {
        let Some(rec) = self.actions.get(index as usize) else {
            return Err(ActionResult::Failed("read".into()));
        };
        let refused = |r: &str| ActionResult::Refused(r.to_string());
        if self.status != Status::Running {
            return Err(refused("status"));
        }
        if env::block_timestamp() >= self.config.run_end_ns.0 {
            return Err(refused("run_ended"));
        }
        if env::promise_results_count() != 5 {
            return Err(ActionResult::Failed("read".into()));
        }
        let amount = |i: u64| answer(i).and_then(|v| strict_amount(&v));
        let (Some(pool), Some(quote_bal), Some(base_bal), Some(assets), Some(predict)) =
            (answer(0), amount(1), amount(2), answer(3), answer(4))
        else {
            return Err(ActionResult::Failed("read".into()));
        };
        let net = network();
        let (quote_is_x, point) = self.check_pool(&pool)?;
        let reference = Observed {
            block: U64(env::block_height()),
            point,
        };
        self.check_drift_and_centring(point, rec.observed.point, rec.left_point, rec.right_point)?;
        let Some((int_q, int_b)) =
            internal_balances(&assets, self.config.quote_token.as_str(), &net.base_token)
        else {
            return Err(ActionResult::Failed("read".into()));
        };
        let need = |k: &str| predict.get(k).and_then(strict_amount);
        let (Some(need_x), Some(need_y)) = (need("need_x"), need("need_y")) else {
            return Err(ActionResult::Failed("read".into()));
        };
        // Spendable: the wallet less the platform's held-back share, plus what DCL already holds.
        let spend = |wallet: u128, internal: u128, i: usize| {
            wallet
                .saturating_sub(self.platform_owed(i).min(wallet))
                .saturating_add(internal)
        };
        let (sq, sb) = (spend(quote_bal, int_q, 0), spend(base_bal, int_b, 1));
        let round = RoundInfo {
            spendable_quote: U128(sq),
            spendable_base: U128(sb),
            need_x: U128(need_x),
            need_y: U128(need_y),
        };
        let (spend_x, spend_y) = if quote_is_x { (sq, sb) } else { (sb, sq) };
        let Some((add_x, add_y)) = price::scale_need(
            need_x,
            need_y,
            spend_x,
            spend_y,
            point,
            quote_is_x,
            self.limits.max_principal.0,
        ) else {
            return Err(refused("nothing_to_add"));
        };
        // Either side below its dust while the range needs it: nothing worth adding.
        let (dust_x, dust_y) = {
            let d = |t: &str| {
                self.limits
                    .dust_threshold
                    .iter()
                    .find(|(a, _)| a.as_str() == t)
                    .map_or(u128::MAX, |(_, v)| v.0)
            };
            let (tx, ty) = self.pool_order();
            (d(tx.as_str()), d(ty.as_str()))
        };
        if (need_x > 0 && add_x < dust_x) || (need_y > 0 && add_y < dust_y) {
            return Err(refused("nothing_to_add"));
        }
        let (int_x, int_y) = if quote_is_x {
            (int_q, int_b)
        } else {
            (int_b, int_q)
        };
        let info = OpenInfo {
            add_x: U128(add_x),
            add_y: U128(add_y),
            internal_x: U128(int_x),
            internal_y: U128(int_y),
            deposit_x: U128(add_x.saturating_sub(int_x)),
            deposit_y: U128(add_y.saturating_sub(int_y)),
            ..OpenInfo::default()
        };
        Ok((reference, round, info))
    }

    /// Round two's decisions, in the order `deposit_short`, drift, centring, `predict_over`,
    /// `add_ratio` (5.6 step 5). Returns the add's minimums and the predicted use.
    fn plan_add(&self, index: u64) -> Result<(u128, u128, u128, u128), ActionResult> {
        let Some(rec) = self.actions.get(index as usize) else {
            return Err(ActionResult::Failed("read".into()));
        };
        let (Some(info), Some(reference)) = (rec.open.as_ref(), rec.reference) else {
            return Err(ActionResult::Failed("read".into()));
        };
        let refused = |r: &str| ActionResult::Refused(r.to_string());
        if self.status != Status::Running {
            return Err(refused("status"));
        }
        if env::block_timestamp() >= self.config.run_end_ns.0 {
            return Err(refused("run_ended"));
        }
        if env::promise_results_count() != 3 {
            return Err(ActionResult::Failed("read".into()));
        }
        let (Some(pool), Some(assets), Some(predict)) = (answer(0), answer(1), answer(2)) else {
            return Err(ActionResult::Failed("read".into()));
        };
        let net = network();
        let (quote_is_x, point) = self.check_pool(&pool)?;
        let Some((int_q, int_b)) =
            internal_balances(&assets, self.config.quote_token.as_str(), &net.base_token)
        else {
            return Err(ActionResult::Failed("read".into()));
        };
        let (int_x, int_y) = if quote_is_x {
            (int_q, int_b)
        } else {
            (int_b, int_q)
        };
        let need = |k: &str| predict.get(k).and_then(strict_amount);
        let (Some(pred_x), Some(pred_y)) = (need("need_x"), need("need_y")) else {
            return Err(ActionResult::Failed("read".into()));
        };
        if int_x < info.add_x.0 || int_y < info.add_y.0 {
            return Err(refused("deposit_short"));
        }
        // The point within drift of this operation's reference and of the agent's observation.
        if (point as i64 - reference.point as i64).unsigned_abs()
            > self.limits.max_observation_drift_bps as u64
        {
            return Err(refused("drift"));
        }
        self.check_drift_and_centring(point, rec.observed.point, rec.left_point, rec.right_point)?;
        if pred_x > info.add_x.0 || pred_y > info.add_y.0 {
            return Err(refused("predict_over"));
        }
        // ADD_RATIO_BPS = max(max_slippage_bps, ceil(10_000 * D * W / ((ref - left) * (right - ref)))).
        let (l, r, p) = (
            rec.left_point as i128,
            rec.right_point as i128,
            point as i128,
        );
        let (width, below, above) = (r - l, p - l, r - p);
        let d = self.limits.max_observation_drift_bps as i128;
        let denom = below * above;
        if denom <= 0 {
            return Err(refused("centring"));
        }
        let ratio =
            ((10_000 * d * width + denom - 1) / denom).max(self.limits.max_slippage_bps as i128);
        if ratio >= 10_000 {
            return Err(refused("add_ratio"));
        }
        let floor_bps = |v: u128, bps: i128| -> u128 {
            // v * (10_000 - bps) / 10_000 with no overflow: split v.
            let k = (10_000 - bps) as u128;
            (v / 10_000) * k + (v % 10_000) * k / 10_000
        };
        let (rx, ry) = (
            floor_bps(info.add_x.0, ratio),
            floor_bps(info.add_y.0, ratio),
        );
        if pred_x < rx || pred_y < ry {
            return Err(refused("add_ratio"));
        }
        let slip = self.limits.max_slippage_bps as i128;
        let (min_x, min_y) = (floor_bps(pred_x, slip), floor_bps(pred_y, slip));
        if min_x == 0 && min_y == 0 {
            return Err(refused("nothing_to_add"));
        }
        Ok((min_x, min_y, pred_x, pred_y))
    }
}

#[near]
impl Strategy {
    pub fn get_tokens_registered(&self) -> bool {
        self.tokens_registered
    }
}
