//! Slice 6b: `claim_platform(token)` and `claim_creator(token)` (ARCHITECTURE 5.5, 5.10; EC-C14,
//! EC-C15, EC-C61, EC-C114, EC-C117, EC-C118, EC-C169). In `Closed`, the platform's cut of the fees
//! collected (`fees / 20`, per pool token) and everything else in the wallet go out, each by an
//! `ft_transfer` of 1 yoctoNEAR, from one `ft_balance_of` read taken under the lock.
//!
//! **Deviation from ARCHITECTURE 5.5, for the audits to judge:** the design has `claim_creator` pay
//! the platform, wait for that transfer's callback, read the wallet again and then pay the creator.
//! Here both legs go out from the *same* read: the platform's leg pays `min(owed, wallet)` and the
//! creator's `wallet - owed` (0 if the wallet is short), so the two sum to exactly the wallet read,
//! the platform's share is reserved whether or not its transfer succeeds (a failed platform
//! transfer restores `paid_platform` and the creator never receives that share), and no callback
//! has to start a new read. The outcome of the design's sequence is the same in every case in
//! EC-C114; the difference is that a deposit landing between the two reads is paid by the next
//! claim, not this one.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, Gas, NearToken, Promise};

use super::funding::{
    callback_only, parse_balance, single_result, GAS_FT_TRANSFER, GAS_VIEW, ONE_YOCTO,
};
use super::{
    event, refuse, Class, Lock, Op, RateMethod, Stage, Status, Strategy, StrategyExt, GAS_CALLBACK,
};

/// The balance read's callback starts up to two transfers and their callbacks, so it holds their
/// gas; the prepaid minimum adds the read's fees. **Unmeasured at the low end** (sandbox).
pub const GAS_CLAIM_READ_CB: Gas = Gas::from_tgas(100);
pub const MIN_GAS_CLAIM: Gas = Gas::from_tgas(180);

/// The claim whose transfers are out: which legs are still pending, and what the platform's leg
/// raised `paid_platform` by (restored if its transfer fails). A callback acts only on its own id.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ClaimInFlight {
    pub id: U64,
    pub token: AccountId,
    pub platform_amount: U128,
    pub platform_pending: bool,
    pub creator_pending: bool,
}

/// `get_fees_collected()`: per pool token (quote, base).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenAmounts {
    pub quote: U128,
    pub base: U128,
}

impl Strategy {
    fn claim_refused(&mut self, op_id: U64, token: &AccountId, reason: &str) {
        self.release();
        event(
            "claim_refused",
            json!({"op_id": op_id, "token": token, "reason": reason}),
        );
    }

    /// The pool token a claim names, and its index.
    fn claim_token(&self, token: &str) -> (AccountId, usize) {
        let token = self
            .pool_token(token)
            .unwrap_or_else(|| refuse("LIMIT: not a pool token"));
        let idx = self
            .token_index(&token)
            .unwrap_or_else(|| refuse("LIMIT: not a pool token"));
        (token, idx)
    }

    /// The lock and the rate limit, after the status, caller, token and time checks.
    fn claim_gates(&self, idx: usize, class: Class, role: RateMethod) {
        if self.lock.is_some() {
            refuse("LIMIT: operation pending");
        }
        if !self.rate_ok(role, idx as u8 + 1, class) {
            refuse("LIMIT: rate limited");
        }
    }

    /// Takes the lock, stamps the rate limit and sends the wallet read.
    fn claim_read(
        &mut self,
        role: RateMethod,
        class: Class,
        idx: usize,
        op: Op,
        token: &AccountId,
    ) -> Promise {
        let block = env::block_height();
        if let Some(b) = self.stale_resolution_block {
            if block < b.saturating_add(self.config.stale_cooldown_blocks.0) {
                refuse("LIMIT: stale cooldown");
            }
        }
        if env::prepaid_gas() < MIN_GAS_CLAIM {
            refuse("LIMIT: gas");
        }
        self.rate_stamp(role, idx as u8 + 1, class);
        let op_id = self.next_op_id;
        self.next_op_id += 1;
        self.lock = Some(Lock {
            op_id: U64(op_id),
            op,
            stage: Stage::ReadWallet,
            promise_block: U64(block),
        });
        event(
            "claim_started",
            json!({"op_id": U64(op_id), "token": token}),
        );
        let me = env::current_account_id();
        Promise::new(token.clone())
            .function_call(
                "ft_balance_of".to_string(),
                json!({ "account_id": me }).to_string().into_bytes(),
                NearToken::from_yoctonear(0),
                GAS_VIEW,
            )
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_CLAIM_READ_CB)
                    .with_unused_gas_weight(0)
                    .on_claim_balance(U64(op_id)),
            )
    }
}

fn transfer(token: &AccountId, to: &AccountId, amount: u128) -> Promise {
    Promise::new(token.clone()).function_call(
        "ft_transfer".to_string(),
        json!({"receiver_id": to, "amount": U128(amount)})
            .to_string()
            .into_bytes(),
        ONE_YOCTO,
        GAS_FT_TRANSFER,
    )
}

#[near]
impl Strategy {
    /// Pays the platform what it is owed of `token`, at most the wallet balance. Anyone, in
    /// `Closed`, rate-limited per (token, caller class). Refused `LIMIT: nothing owed` from cached
    /// state when the platform is owed nothing.
    pub fn claim_platform(&mut self, token: String) -> Promise {
        if self.status != Status::Closed {
            refuse("LIMIT: wrong status");
        }
        let class = self.caller_class();
        let (token, idx) = self.claim_token(&token);
        self.claim_gates(idx, class, RateMethod::ClaimPlatform);
        if self.platform_owed(idx) == 0 {
            refuse("LIMIT: nothing owed");
        }
        self.claim_read(
            RateMethod::ClaimPlatform,
            class,
            idx,
            Op::ClaimPlatform {
                token: token.clone(),
                class,
            },
            &token,
        )
    }

    /// Pays the platform its owed amount first and the creator everything else of `token`. The
    /// creator only, in `Closed`, from `closed_at + platform_claim_window` or earlier once the
    /// platform is owed nothing of this token.
    pub fn claim_creator(&mut self, token: String) -> Promise {
        if self.status != Status::Closed {
            refuse("LIMIT: wrong status");
        }
        let class = self.caller_class();
        if class != Class::Creator {
            refuse("AUTH: creator only");
        }
        let (token, idx) = self.claim_token(&token);
        // Time: the platform's window, before the lock and the rate limit (principle 5's order).
        let opens = self
            .closed_at_ns
            .unwrap_or(u64::MAX)
            .saturating_add(self.config.platform_claim_window_ns.0);
        if self.platform_owed(idx) > 0 && env::block_timestamp() < opens {
            refuse("LIMIT: platform window");
        }
        self.claim_gates(idx, class, RateMethod::ClaimCreator);
        self.claim_read(
            RateMethod::ClaimCreator,
            class,
            idx,
            Op::ClaimCreator {
                token: token.clone(),
            },
            &token,
        )
    }

    /// The wallet read's callback: decides both legs from the one read and sends the transfers.
    /// Never panics: a refusal is a `claim_refused` event and releases the lock.
    pub fn on_claim_balance(&mut self, op_id: U64) {
        callback_only();
        let Some(lock) = self.lock_at(op_id.0, Stage::ReadWallet) else {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        };
        let (token, is_creator, class) = match &lock.op {
            Op::ClaimPlatform { token, class } => (token.clone(), false, *class),
            Op::ClaimCreator { token } => (token.clone(), true, Class::Creator),
            _ => {
                event("callback_ignored", json!({"op_id": op_id}));
                return;
            }
        };
        if self.status != Status::Closed {
            return self.claim_refused(op_id, &token, "LIMIT: wrong status");
        }
        let Some(wallet) = single_result().ok().and_then(|b| parse_balance(&b)) else {
            return self.claim_refused(op_id, &token, "LIMIT: read failed");
        };
        let idx = self.token_index(&token).unwrap_or(0);
        let owed = self.platform_owed(idx);
        let platform_pay = owed.min(wallet);
        let creator_pay = if is_creator {
            wallet.saturating_sub(owed)
        } else {
            0
        };
        if platform_pay == 0 && creator_pay == 0 {
            let r = if is_creator {
                "LIMIT: nothing to claim"
            } else {
                "LIMIT: nothing to pay"
            };
            return self.claim_refused(op_id, &token, r);
        }
        // An outsider's platform claim must pay at least the token's dust or the whole owed amount.
        if !is_creator && class == Class::Outsider {
            let dust = self
                .limits
                .dust_threshold
                .iter()
                .find(|(t, _)| *t == token)
                .map_or(u128::MAX, |(_, d)| d.0);
            if platform_pay < dust && platform_pay < owed {
                return self.claim_refused(op_id, &token, "LIMIT: claim below dust");
            }
        }
        // Raise `paid_platform` before the transfer (restored by a failed leg's callback).
        self.paid_platform[idx] = self.paid_platform[idx].saturating_add(platform_pay);
        self.claim_in_flight = Some(ClaimInFlight {
            id: op_id,
            token: token.clone(),
            platform_amount: U128(platform_pay),
            platform_pending: platform_pay > 0,
            creator_pending: creator_pay > 0,
        });
        self.lock = Some(Lock {
            stage: Stage::Transfers,
            promise_block: U64(env::block_height()),
            ..lock
        });
        let me = env::current_account_id();
        if platform_pay > 0 {
            transfer(&token, &self.config.platform_account, platform_pay)
                .then(
                    Self::ext(me.clone())
                        .with_static_gas(GAS_CALLBACK)
                        .with_unused_gas_weight(0)
                        .on_claim_leg(op_id, true, U128(platform_pay)),
                )
                .detach();
        }
        if creator_pay > 0 {
            transfer(&token, &self.config.creator, creator_pay)
                .then(
                    Self::ext(me)
                        .with_static_gas(GAS_CALLBACK)
                        .with_unused_gas_weight(0)
                        .on_claim_leg(op_id, false, U128(creator_pay)),
                )
                .detach();
        }
    }

    /// One transfer's callback: acts only on its own claim. A failed platform leg restores
    /// `paid_platform`; a failed creator leg changes nothing (its tokens stay in the wallet). The
    /// lock is released when both legs have reported.
    pub fn on_claim_leg(&mut self, op_id: U64, platform: bool, amount: U128) {
        callback_only();
        let live = self.lock_at(op_id.0, Stage::Transfers).is_some()
            && self.claim_in_flight.as_ref().is_some_and(|c| c.id == op_id);
        if !live {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        }
        // Each leg reports once: a leg that is not pending (a duplicate callback) is ignored, so
        // `paid_platform` can never be restored twice.
        let pending = self.claim_in_flight.as_ref().is_some_and(|c| {
            if platform {
                c.platform_pending
            } else {
                c.creator_pending
            }
        });
        if !pending {
            event("callback_ignored", json!({"op_id": op_id}));
            return;
        }
        let ok = single_result().is_ok();
        let mut c = self.claim_in_flight.take().expect("checked above");
        let idx = self.token_index(&c.token).unwrap_or(0);
        if platform {
            c.platform_pending = false;
            if !ok {
                self.paid_platform[idx] =
                    self.paid_platform[idx].saturating_sub(c.platform_amount.0);
            }
        } else {
            c.creator_pending = false;
        }
        event(
            "claim",
            json!({
                "op_id": op_id,
                "token": c.token,
                "leg": if platform { "platform" } else { "creator" },
                "amount": amount,
                "ok": ok,
            }),
        );
        if c.platform_pending || c.creator_pending {
            self.claim_in_flight = Some(c);
        } else {
            self.release();
        }
    }

    pub fn get_fees_collected(&self) -> TokenAmounts {
        TokenAmounts {
            quote: U128(self.fees_collected[0]),
            base: U128(self.fees_collected[1]),
        }
    }
    pub fn get_paid_platform(&self, token: String) -> U128 {
        let idx = self.pool_token(&token).and_then(|t| self.token_index(&t));
        U128(idx.map_or_else(
            || refuse("LIMIT: not a pool token"),
            |i| self.paid_platform[i],
        ))
    }
    pub fn get_platform_owed(&self, token: String) -> U128 {
        let idx = self.pool_token(&token).and_then(|t| self.token_index(&t));
        U128(idx.map_or_else(
            || refuse("LIMIT: not a pool token"),
            |i| self.platform_owed(i),
        ))
    }
    pub fn get_claim_in_flight(&self) -> Option<ClaimInFlight> {
        self.claim_in_flight.clone()
    }
}
