//! Stand-in for Rhea: accepts tokens through `ft_on_transfer` and records the msg.
use near_sdk::json_types::U128;
use near_sdk::{near, AccountId, PromiseOrValue};

#[near(contract_state)]
#[derive(Default)]
pub struct Sink {
    last_msg: String,
    last_sender: Option<AccountId>,
    total: u128,
}

#[near]
impl Sink {
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        self.last_msg = msg;
        self.last_sender = Some(sender_id);
        self.total += amount.0;
        PromiseOrValue::Value(U128(0))
    }

    pub fn last(&self) -> (String, Option<AccountId>, U128) {
        (self.last_msg.clone(), self.last_sender.clone(), U128(self.total))
    }
}
