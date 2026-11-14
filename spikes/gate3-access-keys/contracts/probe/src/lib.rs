//! Spike probe: stands in for the strategy contract calling Rhea DCL cross-contract.
//! `run` makes one call, then its callback records what it was told (the promise
//! result, its block) and immediately issues the given view reads; a second
//! callback records those. The log answers what a strategy callback can know,
//! and when (gate 3 part C). Throwaway code: findings go to docs/gates/.
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PromiseResult};

#[derive(Serialize, Deserialize, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct Read { pub contract: AccountId, pub method: String, pub args: String }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Probe { owner: AccountId, log: Vec<String>, read_gas: u64 }

fn result_text(i: u64) -> String {
    match env::promise_result(i) {
        PromiseResult::Successful(b) => format!("ok:{}", String::from_utf8_lossy(&b)),
        PromiseResult::Failed => "failed".to_string(),
    }
}

#[near]
impl Probe {
    #[init]
    pub fn new(owner: AccountId) -> Self { Self { owner, log: Vec::new(), read_gas: 30 } }

    /// Owner only. Calls `receiver.method(args)` with `deposit` yocto and `gas_tgas`, then records.
    pub fn run(&mut self, tag: String, receiver: AccountId, method: String, args: String, deposit: U128, gas_tgas: u64, reads: Vec<Read>) -> Promise {
        near_sdk::require!(env::predecessor_account_id() == self.owner, "AUTH: owner only");
        self.log.push(format!("{tag} start block={}", env::block_height()));
        Promise::new(receiver)
            .function_call(method, args.into_bytes(), NearToken::from_yoctonear(deposit.0), Gas::from_tgas(gas_tgas))
            .then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(150)).after_call(tag, reads))
    }

    #[private]
    pub fn after_call(&mut self, tag: String, reads: Vec<Read>) -> PromiseOrValue<()> {
        self.log.push(format!("{tag} callback block={} result={} prepaid={} used={}", env::block_height(), result_text(0), env::prepaid_gas().as_tgas(), env::used_gas().as_tgas()));
        let mut it = reads.into_iter();
        let Some(first) = it.next() else { return PromiseOrValue::Value(()) };
        let mk = |r: Read| Promise::new(r.contract).function_call(r.method, r.args.into_bytes(), NearToken::from_yoctonear(0), Gas::from_tgas(self.read_gas));
        let mut p = mk(first);
        let mut n = 1u64;
        for r in it { p = p.and(mk(r)); n += 1; }
        PromiseOrValue::Promise(p.then(Self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(10)).after_reads(tag, n)))
    }

    #[private]
    pub fn after_reads(&mut self, tag: String, n: u64) {
        let rs: Vec<String> = (0..n).map(result_text).collect();
        self.log.push(format!("{tag} reads block={} {}", env::block_height(), serde_json::to_string(&rs).unwrap()));
    }

    /// Accepts any token (the strategy credits its ledger here).
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        self.log.push(format!("ft_on_transfer block={} token={} sender={sender_id} amount={} msg={msg}", env::block_height(), env::predecessor_account_id(), amount.0));
        U128(0)
    }

    /// Gas attached to each view read issued from the callback (default 30 Tgas).
    pub fn set_read_gas(&mut self, tgas: u64) { near_sdk::require!(env::predecessor_account_id() == self.owner, "AUTH: owner only"); self.read_gas = tgas; }
    pub fn get_log(&self) -> Vec<String> { self.log.clone() }
    pub fn clear_log(&mut self) { near_sdk::require!(env::predecessor_account_id() == self.owner, "AUTH: owner only"); self.log.clear(); }
    /// Exposes the native NEAR balance so tests can see an unwrap.
    pub fn native_balance(&self) -> String { json!(env::account_balance().as_yoctonear().to_string()).to_string() }
}
