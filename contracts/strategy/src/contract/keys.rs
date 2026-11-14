//! Viewing-key sales (D57; INTERFACE section 9; ARCHITECTURE 5.5, 6). A buyer pays exactly
//! `key_price`, escrowed in the contract; the `deliverer` (own account, own host) sets the
//! sealed key and the payment goes to the creator once; if no key arrives in
//! `key_delivery_window_ns` the buyer takes the payment back once. A transfer that bounces is
//! held in `near_owed` and pulled with `withdraw_near`. There is no `rekey`.
//!
//! Money moves exactly once: the sale's state changes and `escrow_total` falls *before* the
//! transfer is sent, a refused call panics and changes nothing, and a bounce only credits
//! `near_owed`, never the sale. **Unverified until the sandbox test says so:** that a `Transfer`
//! to a missing account shows as `Failed` in the callback and its NEAR returns here.
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, NearToken, Promise};

use super::funding::callback_only;
use super::{event, refuse, Status, Strategy, StrategyExt, GAS_CALLBACK};

/// Most sales one page of `get_key_sales` returns (`max_key_sales` is at most 50).
pub const MAX_KEY_PAGE: u32 = 50;
/// Storage bytes reserved per sale at purchase: the record with its sealed key, and the
/// `near_owed` entry a bounce could add. Checked with the buyer's deposit still counted as held.
pub const KEY_SALE_BYTES: u128 = 640;
const SEALED_HEX: usize = 160;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum KeyState {
    Escrowed,
    Released,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct KeySale {
    pub buyer: AccountId,
    pub buyer_pubkey: String,
    pub state: KeyState,
    pub bought_at_ns: U64,
    pub price: U128,
    pub sealed_key: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct KeyParams {
    pub key_price: U128,
    pub key_delivery_window_ns: U64,
    pub max_key_sales: u32,
    pub sold: u32,
    pub deliverer: AccountId,
    pub escrow_total: U128,
    pub near_owed_total: U128,
}

/// Why a transfer's NEAR is held for an account (the `near_owed` event's `reason`).
#[derive(Clone, Copy)]
pub enum Reason {
    KeyPayout,
    KeyRefund,
    Withdraw,
}
impl Reason {
    fn as_str(self) -> &'static str {
        match self {
            Reason::KeyPayout => "key_payout",
            Reason::KeyRefund => "key_refund",
            Reason::Withdraw => "withdraw",
        }
    }
    fn parse(s: &str) -> Reason {
        match s {
            "key_payout" => Reason::KeyPayout,
            "key_refund" => Reason::KeyRefund,
            _ => Reason::Withdraw,
        }
    }
}

fn lower_hex(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Strategy {
    fn sale_index(&self, buyer: &AccountId) -> Option<usize> {
        self.key_sales.iter().position(|s| &s.buyer == buyer)
    }

    pub(crate) fn owed(&self, who: &AccountId) -> u128 {
        self.near_owed
            .iter()
            .find(|(a, _)| a == who)
            .map_or(0, |(_, v)| *v)
    }

    fn credit_owed(&mut self, who: &AccountId, amount: u128) {
        match self.near_owed.iter_mut().find(|(a, _)| a == who) {
            Some((_, v)) => *v += amount,
            None => self.near_owed.push((who.clone(), amount)),
        }
        self.near_owed_total += amount;
    }

    /// Sends `amount` to `to` with a callback that holds it in `near_owed` if the transfer bounces.
    fn pay_out(&self, to: &AccountId, amount: u128, reason: Reason) -> Promise {
        Promise::new(to.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_near_paid(to.clone(), U128(amount), reason.as_str().to_string()),
            )
    }
}

#[near]
impl Strategy {
    /// Buys a viewing key for `buyer_pubkey` (X25519, 64 lowercase hex). Payable: exactly
    /// `key_price`, held in escrow until `deliver_key` or `refund_key`.
    #[payable]
    pub fn buy_viewing_key(&mut self, buyer_pubkey: String) {
        if self.status != Status::Running {
            refuse("LIMIT: wrong status");
        }
        if self.revealed.is_some() {
            refuse("LIMIT: already revealed");
        }
        let price = self.config.key_price.0;
        if env::attached_deposit().as_yoctonear() != price {
            refuse("LIMIT: key price");
        }
        if !lower_hex(&buyer_pubkey, 64) || buyer_pubkey.bytes().all(|b| b == b'0') {
            refuse("LIMIT: buyer key");
        }
        let buyer = env::predecessor_account_id();
        if self.sale_index(&buyer).is_some() {
            refuse("LIMIT: already bought");
        }
        if self.key_sales.len() as u64 >= self.config.max_key_sales as u64 {
            refuse("LIMIT: key sales full");
        }
        // The deposit is already in the balance: it, the NEAR held before and the record's
        // storage must all stay covered.
        self.require_free(
            price.saturating_add(
                env::storage_byte_cost()
                    .as_yoctonear()
                    .saturating_mul(KEY_SALE_BYTES),
            ),
        );
        let index = self.key_sales.len() as u32;
        let now = env::block_timestamp();
        self.key_sales.push(KeySale {
            buyer: buyer.clone(),
            buyer_pubkey: buyer_pubkey.clone(),
            state: KeyState::Escrowed,
            bought_at_ns: U64(now),
            price: U128(price),
            sealed_key: None,
        });
        self.escrow_total += price;
        event(
            "key_bought",
            json!({"index": index, "buyer": buyer, "buyer_pubkey": buyer_pubkey,
                   "bought_at_ns": U64(now), "price": U128(price)}),
        );
    }

    /// The deliverer sets `buyer`'s sealed key and the payment goes to the creator, once.
    pub fn deliver_key(&mut self, buyer: String, sealed_key: String) -> Promise {
        if env::predecessor_account_id() != self.config.deliverer {
            refuse("AUTH: deliverer only");
        }
        if !lower_hex(&sealed_key, SEALED_HEX) {
            refuse("LIMIT: sealed key");
        }
        let i = buyer
            .parse::<AccountId>()
            .ok()
            .and_then(|b| self.sale_index(&b))
            .unwrap_or_else(|| refuse("LIMIT: no such sale"));
        if self.key_sales[i].state != KeyState::Escrowed {
            refuse("LIMIT: not escrowed");
        }
        let deadline = self.key_sales[i]
            .bought_at_ns
            .0
            .saturating_add(self.config.key_delivery_window_ns.0);
        if env::block_timestamp() >= deadline {
            refuse("LIMIT: delivery window closed");
        }
        let price = self.key_sales[i].price.0;
        let buyer = self.key_sales[i].buyer.clone();
        self.key_sales[i].state = KeyState::Released;
        self.key_sales[i].sealed_key = Some(sealed_key);
        self.escrow_total -= price;
        event(
            "key_delivered",
            json!({"index": i as u32, "buyer": buyer, "price": U128(price)}),
        );
        let creator = self.config.creator.clone();
        self.pay_out(&creator, price, Reason::KeyPayout)
    }

    /// The buyer takes the payment back once the delivery window has passed without a key.
    pub fn refund_key(&mut self) -> Promise {
        let buyer = env::predecessor_account_id();
        let i = self
            .sale_index(&buyer)
            .unwrap_or_else(|| refuse("LIMIT: no such sale"));
        if self.key_sales[i].state != KeyState::Escrowed {
            refuse("LIMIT: not escrowed");
        }
        let deadline = self.key_sales[i]
            .bought_at_ns
            .0
            .saturating_add(self.config.key_delivery_window_ns.0);
        if env::block_timestamp() < deadline {
            refuse("LIMIT: delivery window open");
        }
        let price = self.key_sales[i].price.0;
        self.key_sales[i].state = KeyState::Refunded;
        self.escrow_total -= price;
        event(
            "key_refunded",
            json!({"index": i as u32, "buyer": buyer, "price": U128(price)}),
        );
        self.pay_out(&buyer, price, Reason::KeyRefund)
    }

    /// Pays out what is held for the caller after a bounced transfer.
    pub fn withdraw_near(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.owed(&who);
        if amount == 0 {
            refuse("LIMIT: nothing owed");
        }
        // Zero before the transfer; a failed transfer restores it in the callback.
        self.near_owed.retain(|(a, _)| a != &who);
        self.near_owed_total -= amount;
        event(
            "near_withdrawn",
            json!({"account": who, "amount": U128(amount)}),
        );
        self.pay_out(&who, amount, Reason::Withdraw)
    }

    /// Callback of every key payment: a bounced transfer is held for `to`.
    pub fn on_near_paid(&mut self, to: AccountId, amount: U128, reason: String) {
        callback_only();
        if env::promise_results_count() == 1 && env::promise_result_checked(0, 16).is_ok() {
            return;
        }
        self.credit_owed(&to, amount.0);
        event(
            "near_owed",
            json!({"account": to, "amount": amount, "reason": Reason::parse(&reason).as_str()}),
        );
    }

    pub fn get_key_params(&self) -> KeyParams {
        KeyParams {
            key_price: self.config.key_price,
            key_delivery_window_ns: self.config.key_delivery_window_ns,
            max_key_sales: self.config.max_key_sales,
            sold: self.key_sales.len() as u32,
            deliverer: self.config.deliverer.clone(),
            escrow_total: U128(self.escrow_total),
            near_owed_total: U128(self.near_owed_total),
        }
    }

    pub fn get_key_sale(&self, buyer: String) -> Option<KeySale> {
        let b: AccountId = buyer.parse().ok()?;
        self.sale_index(&b).map(|i| self.key_sales[i].clone())
    }

    pub fn get_key_sales(&self, from_index: u32, limit: u32) -> Vec<KeySale> {
        self.key_sales
            .iter()
            .skip(from_index as usize)
            .take(limit.min(MAX_KEY_PAGE) as usize)
            .cloned()
            .collect()
    }

    pub fn get_near_owed(&self, account: String) -> U128 {
        U128(account.parse::<AccountId>().map_or(0, |a| self.owed(&a)))
    }
}
