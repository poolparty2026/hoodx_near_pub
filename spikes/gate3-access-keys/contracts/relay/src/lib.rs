//! Stand-in for the strategy contract. The agent calls it with no deposit;
//! it checks a public limit and then calls `ft_transfer_call` on a token,
//! paying the required 1 yoctoNEAR from its own balance.
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Relay {
    agent: AccountId,
    /// Public limit: the only contract tokens may be sent to (stands in for Rhea).
    allowed_receiver: AccountId,
    /// Public limit: largest amount per action.
    max_amount: u128,
}

#[near]
impl Relay {
    #[init]
    pub fn new(agent: AccountId, allowed_receiver: AccountId, max_amount: U128) -> Self {
        Self { agent, allowed_receiver, max_amount: max_amount.0 }
    }

    /// Called by the agent through a function-call key, with no deposit.
    pub fn agent_transfer_call(
        &mut self,
        token: AccountId,
        receiver_id: AccountId,
        amount: U128,
        msg: String,
    ) -> Promise {
        require!(env::predecessor_account_id() == self.agent, "AUTH: caller is not the agent");
        require!(receiver_id == self.allowed_receiver, "LIMIT: receiver not allowed");
        require!(amount.0 <= self.max_amount, "LIMIT: amount over cap");
        Promise::new(token).function_call(
            "ft_transfer_call".to_string(),
            json!({ "receiver_id": receiver_id, "amount": amount, "msg": msg })
                .to_string()
                .into_bytes(),
            NearToken::from_yoctonear(1),
            Gas::from_tgas(60),
        )
    }

    /// Lets the relay register itself with the token's storage, paid from its own balance.
    pub fn agent_register(&mut self, token: AccountId) -> Promise {
        require!(env::predecessor_account_id() == self.agent, "AUTH: caller is not the agent");
        Promise::new(token).function_call(
            "storage_deposit".to_string(),
            json!({ "account_id": env::current_account_id() }).to_string().into_bytes(),
            NearToken::from_millinear(10),
            Gas::from_tgas(10),
        )
    }
}
