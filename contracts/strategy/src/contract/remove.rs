//! Slice 9: `agent_close_position` and `exit_remove` (ARCHITECTURE 5.5, 5.7; the minimal plan,
//! D55). Both remove the strategy's own position, all of its liquidity: one read round
//! (`get_liquidity` and `predict_remove_liquidity`, in parallel, one state), then
//! `remove_liquidity` with minimums `floor(predicted_t * (10_000 - max_slippage_bps) / 10_000)` and
//! `skip_unwrap_near: true`, and a callback that counts `min(unclaimed_fee_t, reported_t)` into
//! `fees_collected` exactly once, clears `own_position` and opens the settle window.
//!
//! `agent_close_position` carries a decision: it runs in `Running`, until `run_end + exit_grace`,
//! after the same first checks as a trade (the interval and 24-hour count, quietness, the payout
//! margin for both observations) and a confirmation span between `confirm_observed` and
//! `observed` (principle 6, EC-R30). `exit_remove` carries none: the agent or creator in
//! `Closing` and `Closed`, anyone after `run_end + exit_grace`.
//!
//! **Simplifications (D55):** no `get_pool` read (the minimums come from DCL's own prediction in
//! the same read round, which bounds the price at the remove); no parking; a lost remove is
//! `Unknown` and the position stays `own_position` until `exit_remove` reads it as gone (`null`),
//! which clears it with no fees counted (a lower bound, so the platform may be paid less than 5%
//! of the true fees: disclosed). **Unverified:** whether a removal's return includes the fees
//! (gate 3 Part D; `min(unclaimed, reported)` is right either way); the gas constants.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, Gas, NearToken, Promise};

use super::funding::{callback_only, single_result, GAS_VIEW};
use super::settle::strict_amount;
use super::start::answer;
use super::trade::{ActionKind, ActionRecord, ActionResult, Meta, Observed, RemoveInfo};
use super::{
    event, refuse, Class, Lock, Op, RateMethod, Stage, Status, Strategy, StrategyExt,
    CONFIRM_MAX_BLOCKS, OFFCHAIN_MARGIN_BLOCKS,
};
use crate::price;

/// Gas: the remove at DCL (two payouts), its result callback, and the read round's callback, which
/// starts the remove and so holds its gas. **Unmeasured at the low end** (the sandbox prints the burns).
pub const GAS_REMOVE: Gas = Gas::from_tgas(90);
pub const GAS_REMOVE_RESULT: Gas = Gas::from_tgas(15);
pub const GAS_REMOVE_READ_CB: Gas = Gas::from_tgas(150);
pub const MIN_GAS_REMOVE: Gas = Gas::from_tgas(250);

impl Strategy {
    fn remove_index(&self, op_id: u64, stage: Stage) -> Option<(u64, Class)> {
        match self.lock_at(op_id, stage) {
            Some(Lock {
                op: Op::Remove { index, class },
                ..
            }) => Some((index.0, class)),
            _ => None,
        }
    }

    /// Ends a removal call: every result of an own payout-producing stage opens the window.
    fn end_remove(&mut self, index: u64, class: Class, result: ActionResult, window: bool) {
        if window {
            self.set_window(class);
        }
        let keep = !matches!(&result, ActionResult::Failed(_))
            && !matches!(&result, ActionResult::Refused(r) if r != "own_position_gone");
        self.finish_action(index, result);
        self.drop_unproductive_exit(index, keep);
    }

    /// A failed or refused exit leaves no record (it only emitted its events), so repeated failing
    /// exits cannot grow the log: the exit holds the lock, so its record is the last one. An exit that
    /// removed the position, found it gone, or whose outcome is unknown keeps its full record
    /// (contract review, round 4a; principle 8).
    pub(super) fn drop_unproductive_exit(&mut self, index: u64, keep: bool) {
        if keep {
            return;
        }
        let is_last_exit = self
            .actions
            .last()
            .is_some_and(|r| r.index.0 == index && r.kind == ActionKind::ExitRemove);
        if is_last_exit {
            self.actions.pop();
        }
    }

    /// An exit's record: no decision, no observation (point 0 at the call's own block).
    fn open_exit_action(&mut self, position: &str) -> u64 {
        let index = self.actions.len() as u64;
        let op_id = self.next_op_id;
        self.next_op_id += 1;
        let (block, ts) = (env::block_height(), env::block_timestamp());
        let caller = env::predecessor_account_id();
        self.actions.push(ActionRecord {
            index: U64(index),
            op_id: U64(op_id),
            kind: ActionKind::ExitRemove,
            caller: caller.clone(),
            left_point: 0,
            right_point: 0,
            observed: Observed {
                block: U64(block),
                point: 0,
            },
            reference: None,
            decision_hash: String::new(),
            chain_head: None,
            call_block: U64(block),
            timestamp_ns: U64(ts),
            result_block: None,
            result_ts_ns: None,
            result: ActionResult::Pending,
            round: None,
            swap: None,
            open: None,
            remove: Some(RemoveInfo {
                position: position.to_string(),
                ..RemoveInfo::default()
            }),
        });
        event(
            "action",
            json!({"index": U64(index), "op_id": U64(op_id), "kind": ActionKind::ExitRemove, "caller": caller}),
        );
        index
    }

    /// Round one of both removals: the position as DCL holds it. DCL's prediction needs the
    /// liquidity amount, so it is read in a second round, from this callback.
    fn start_remove_reads(&mut self, op_id: U64, position: &str) -> Promise {
        let me = env::current_account_id();
        Promise::new(self.config.dcl_contract.clone())
            .function_call(
                "get_liquidity".to_string(),
                json!({"lpt_id": position}).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_VIEW,
            )
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_REMOVE_READ_CB)
                    .with_unused_gas_weight(0)
                    .on_remove_reads(op_id),
            )
    }
}

#[near]
impl Strategy {
    /// Closes the strategy's position (5.7): the agent's decision, `Running` only. Checks in
    /// principle 5's order: status, caller, the windows (to `run_end + exit_grace`), quietness and
    /// the payout margin for both observations, the confirmation span, the position, gas, the
    /// observation and the hash, the log capacity.
    pub fn agent_close_position(
        &mut self,
        position: String,
        meta: Meta,
        confirm_observed: Observed,
    ) -> Promise {
        if self.status != Status::Running {
            refuse("LIMIT: wrong status");
        }
        if env::predecessor_account_id() != self.config.agent {
            refuse("AUTH: agent only");
        }
        self.trading_windows_until(
            false,
            self.config
                .run_end_ns
                .0
                .saturating_add(self.config.exit_grace_ns.0),
        );
        self.trading_quiet(meta.observed.block.0);
        if confirm_observed.block.0
            < self
                .last_payout_callback_block
                .saturating_add(OFFCHAIN_MARGIN_BLOCKS)
        {
            refuse("LIMIT: inside payout margin");
        }
        // The confirmation span, every close, time included: the first confirming observation is
        // at least the margin before the closing one, and at most `CONFIRM_MAX_BLOCKS` (EC-R30).
        // The first confirming observation is after the quiet point too (5.6 step 1). In v1 the
        // quiet point is `settle_until_block`, which the payout-margin check above already implies.
        if confirm_observed.block.0 < self.settle_until_block {
            refuse("LIMIT: observation not quiet");
        }
        let span = meta
            .observed
            .block
            .0
            .checked_sub(confirm_observed.block.0)
            .filter(|s| (OFFCHAIN_MARGIN_BLOCKS..=CONFIRM_MAX_BLOCKS).contains(s));
        if span.is_none() {
            refuse("LIMIT: confirmation span");
        }
        let ok = |p: i32| (price::MIN_POINT..=price::MAX_POINT).contains(&p);
        if !ok(meta.observed.point) || !ok(confirm_observed.point) {
            refuse("LIMIT: points");
        }
        match self.own_position.as_deref() {
            Some(p) if p == position => {}
            _ => refuse("LIMIT: not the own position"),
        }
        if env::prepaid_gas() < MIN_GAS_REMOVE {
            refuse("LIMIT: gas");
        }
        let hash = self.trading_meta(&meta, false);
        // The last slots are for the exits that clear the position (security audit H1).
        if self.actions.len() >= super::MAX_ACTIONS_STORED - super::RESERVED_SLOTS {
            refuse("LIMIT: action log full");
        }
        let class = Class::Agent;
        let index = self.open_action(
            ActionKind::ClosePosition,
            |index| Op::Remove { index, class },
            0,
            0,
            &meta,
            hash,
            Stage::ReadRound,
        );
        if let Some(r) = self.record_mut(index) {
            r.remove = Some(RemoveInfo {
                position: position.clone(),
                confirm_observed: Some(confirm_observed),
                ..RemoveInfo::default()
            });
        }
        let op_id = self.actions[index as usize].op_id;
        self.start_remove_reads(op_id, &position)
    }

    /// Removes the strategy's position without a decision (5.7): the agent or the creator in
    /// `Closing` and `Closed`; anyone else only from `run_end + exit_grace`, in `Running`,
    /// `Closing` and `Closed`. Rate-limited per caller class (principle 5). Also the way to clear
    /// a position that vanished or whose remove was lost: the read answers `null`.
    pub fn exit_remove(&mut self, position: String) -> Promise {
        let class = self.caller_class();
        let after_grace = env::block_timestamp()
            >= self
                .config
                .run_end_ns
                .0
                .saturating_add(self.config.exit_grace_ns.0);
        let allowed = match self.status {
            Status::Closing | Status::Closed => class != Class::Outsider || after_grace,
            Status::Running => class == Class::Outsider && after_grace,
            _ => false,
        };
        if !allowed {
            refuse(if matches!(self.status, Status::Open | Status::Cancelled) {
                "LIMIT: wrong status"
            } else {
                "LIMIT: exit not open yet"
            });
        }
        if self.lock.is_some() {
            refuse("LIMIT: operation pending");
        }
        match self.own_position.as_deref() {
            Some(p) if p == position => {}
            _ => refuse("LIMIT: not the own position"),
        }
        if !self.rate_ok(RateMethod::ExitRemove, 0, class) {
            refuse("LIMIT: rate limited");
        }
        let block = env::block_height();
        if let Some(b) = self.stale_resolution_block {
            if block < b.saturating_add(self.config.stale_cooldown_blocks.0) {
                refuse("LIMIT: stale cooldown");
            }
        }
        if env::prepaid_gas() < MIN_GAS_REMOVE {
            refuse("LIMIT: gas");
        }
        // An exit is never refused for a full log (security audit H1, contract review F1): it is
        // the only way to clear the position, so it may write one record past
        // `MAX_ACTIONS_STORED`. Their number is bounded by the rate limit (one per caller class per
        // interval), and the storage reserve counts records beyond the trading cap.
        self.rate_stamp(RateMethod::ExitRemove, 0, class);
        let index = self.open_exit_action(&position);
        let op_id = self.actions[index as usize].op_id;
        self.lock = Some(Lock {
            op_id,
            op: Op::Remove {
                index: U64(index),
                class,
            },
            stage: Stage::ReadRound,
            promise_block: U64(block),
        });
        self.start_remove_reads(op_id, &position)
    }

    /// Round one's callback: the position as DCL holds it. `null` or another owner: it is gone
    /// (cleared, no fees counted); otherwise asks for the prediction of removing all of it.
    pub fn on_remove_reads(&mut self, op_id: U64) {
        callback_only();
        let Some((index, class)) = self.remove_index(op_id.0, Stage::ReadRound) else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let (position, liq) = {
            let rec = self.actions.get(index as usize);
            (
                rec.and_then(|r| r.remove.as_ref())
                    .map(|r| r.position.clone()),
                answer(0),
            )
        };
        let (Some(position), true) = (position, env::promise_results_count() == 1) else {
            return self.end_remove(index, class, ActionResult::Failed("read".into()), false);
        };
        let refused = |r: &str| ActionResult::Refused(r.to_string());
        let Some(liq) = liq else {
            return self.end_remove(index, class, ActionResult::Failed("read".into()), false);
        };
        // Gone: removed, or owned by another account now. Cleared, nothing counted (5.2 principle 7).
        let me = env::current_account_id();
        let ours = liq.get("owner_id").and_then(Value::as_str) == Some(me.as_str());
        if liq.is_null() || !ours {
            if self.own_position.as_deref() == Some(position.as_str()) {
                self.own_position = None;
            }
            return self.end_remove(index, class, refused("own_position_gone"), true);
        }
        let amount = |k: &str| liq.get(k).and_then(strict_amount);
        let (Some(liquidity), Some(ux), Some(uy)) = (
            amount("amount"),
            amount("unclaimed_fee_x"),
            amount("unclaimed_fee_y"),
        ) else {
            return self.end_remove(index, class, ActionResult::Failed("read".into()), false);
        };
        let points = (
            liq.get("left_point").and_then(Value::as_i64),
            liq.get("right_point").and_then(Value::as_i64),
        );
        if liq.get("pool_id").and_then(Value::as_str) != Some(self.limits.pool.as_str())
            || liq.get("lpt_id").and_then(Value::as_str) != Some(position.as_str())
        {
            return self.end_remove(index, class, refused("position"), false);
        }
        // A position with no liquidity holds nothing and cannot be removed: it is cleared, so it
        // can't block settlement for ever (security audit L2).
        if liquidity == 0 {
            if self.own_position.as_deref() == Some(position.as_str()) {
                self.own_position = None;
            }
            return self.end_remove(index, class, refused("own_position_gone"), true);
        }
        if let Some(r) = self.record_mut(index) {
            if let (Some(l), Some(rt)) = points {
                r.left_point = l as i32;
                r.right_point = rt as i32;
            }
            if let Some(o) = r.remove.as_mut() {
                o.liquidity = U128(liquidity);
                o.unclaimed_x = U128(ux);
                o.unclaimed_y = U128(uy);
            }
        }
        self.lock = Some(Lock {
            op_id,
            op: Op::Remove {
                index: U64(index),
                class,
            },
            stage: Stage::Predicting,
            promise_block: U64(env::block_height()),
        });
        Promise::new(self.config.dcl_contract.clone())
            .function_call(
                "predict_remove_liquidity".to_string(),
                json!({"lpt_id": position, "amount": U128(liquidity)})
                    .to_string()
                    .into_bytes(),
                NearToken::from_yoctonear(0),
                super::GAS_PREDICT,
            )
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_PREDICTED_CB)
                    .with_unused_gas_weight(0)
                    .on_remove_predicted(op_id),
            )
            .detach();
    }

    /// The prediction's callback: sizes the minimums and sends the remove.
    pub fn on_remove_predicted(&mut self, op_id: U64) {
        callback_only();
        let Some((index, class)) = self.remove_index(op_id.0, Stage::Predicting) else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let pred = if env::promise_results_count() == 1 {
            answer(0).and_then(|v| match v {
                Value::Array(a) if a.len() == 2 => {
                    Some((strict_amount(&a[0])?, strict_amount(&a[1])?))
                }
                _ => None,
            })
        } else {
            None
        };
        let Some((px, py)) = pred else {
            return self.end_remove(index, class, ActionResult::Failed("read".into()), false);
        };
        let Some(info) = self
            .actions
            .get(index as usize)
            .and_then(|r| r.remove.clone())
        else {
            return self.end_remove(index, class, ActionResult::Failed("read".into()), false);
        };
        let slip = self.limits.max_slippage_bps as u128;
        let floor_bps =
            |v: u128| (v / 10_000) * (10_000 - slip) + (v % 10_000) * (10_000 - slip) / 10_000;
        let (mx, my) = (floor_bps(px), floor_bps(py));
        if let Some(o) = self.record_mut(index).and_then(|r| r.remove.as_mut()) {
            o.predict_x = U128(px);
            o.predict_y = U128(py);
            o.min_x = U128(mx);
            o.min_y = U128(my);
        }
        self.lock = Some(Lock {
            op_id,
            op: Op::Remove {
                index: U64(index),
                class,
            },
            stage: Stage::Removing,
            promise_block: U64(env::block_height()),
        });
        let me = env::current_account_id();
        Promise::new(self.config.dcl_contract.clone())
            .function_call(
                "remove_liquidity".to_string(),
                json!({
                    "lpt_id": info.position,
                    "amount": info.liquidity,
                    "min_amount_x": U128(mx),
                    "min_amount_y": U128(my),
                    "skip_unwrap_near": true,
                })
                .to_string()
                .into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_REMOVE,
            )
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_REMOVE_RESULT)
                    .with_unused_gas_weight(0)
                    .on_removed(op_id),
            )
            .detach();
    }

    /// The remove's result `[x, y]`: counts `min(unclaimed_fee_t, reported_t)` once, clears the
    /// position and opens the window. A failed receipt changed nothing at DCL (`Failed(remove)`,
    /// the window still opens: tokens might have moved).
    pub fn on_removed(&mut self, op_id: U64) {
        callback_only();
        let Some((index, class)) = self.remove_index(op_id.0, Stage::Removing) else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let Ok(body) = single_result() else {
            return self.end_remove(index, class, ActionResult::Failed("remove".into()), true);
        };
        let reported = near_sdk::serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|v| match v {
                Value::Array(a) if a.len() == 2 => {
                    Some((strict_amount(&a[0])?, strict_amount(&a[1])?))
                }
                _ => None,
            });
        // The receipt succeeded: the position is gone either way.
        self.own_position = None;
        let Some((rx, ry)) = reported else {
            return self.end_remove(index, class, ActionResult::Unknown, true);
        };
        let Some(o) = self.record_mut(index).and_then(|r| r.remove.as_mut()) else {
            return self.end_remove(index, class, ActionResult::Unknown, true);
        };
        let (fx, fy) = (o.unclaimed_x.0.min(rx), o.unclaimed_y.0.min(ry));
        o.reported_x = U128(rx);
        o.reported_y = U128(ry);
        o.fees_x = U128(fx);
        o.fees_y = U128(fy);
        // x is the quote token if the pool id starts with it.
        let quote_is_x = self
            .limits
            .pool
            .starts_with(self.config.quote_token.as_str());
        let (fq, fb) = if quote_is_x { (fx, fy) } else { (fy, fx) };
        self.fees_collected[0] = self.fees_collected[0].saturating_add(fq);
        self.fees_collected[1] = self.fees_collected[1].saturating_add(fb);
        self.end_remove(index, class, ActionResult::Ok, true);
    }
}

/// The prediction's callback holds the remove's gas and its result callback's.
pub const GAS_PREDICTED_CB: Gas = Gas::from_tgas(115);
