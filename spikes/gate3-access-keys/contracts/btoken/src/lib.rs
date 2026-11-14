//! NEP-141 test token that can refuse transfers to chosen accounts, standing in
//! for a token that pauses or blocklists the strategy (D21). Spike code only.
use near_contract_standards::fungible_token::metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Token {
    token: FungibleToken,
    owner: AccountId,
    blocked: Vec<AccountId>,
}

#[near]
impl Token {
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128) -> Self {
        let mut token = FungibleToken::new(b"t".to_vec());
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        Self { token, owner: owner_id, blocked: Vec::new() }
    }
    /// Owner only: refuse (or allow again) every transfer to `account_id`.
    pub fn set_blocked(&mut self, account_id: AccountId, blocked: bool) {
        near_sdk::require!(env::predecessor_account_id() == self.owner, "AUTH: owner only");
        self.blocked.retain(|a| a != &account_id);
        if blocked { self.blocked.push(account_id); }
    }
    fn check(&self, receiver_id: &AccountId) {
        near_sdk::require!(!self.blocked.contains(receiver_id), "BLOCKED: receiver is blocked");
    }
}

#[near]
impl FungibleTokenCore for Token {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.check(&receiver_id);
        self.token.ft_transfer(receiver_id, amount, memo)
    }
    #[payable]
    fn ft_transfer_call(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>, msg: String) -> PromiseOrValue<U128> {
        self.check(&receiver_id);
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }
    fn ft_total_supply(&self) -> U128 { self.token.ft_total_supply() }
    fn ft_balance_of(&self, account_id: AccountId) -> U128 { self.token.ft_balance_of(account_id) }
}

#[near]
impl FungibleTokenResolver for Token {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for Token {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance { self.token.storage_withdraw(amount) }
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool { self.token.internal_storage_unregister(force).is_some() }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds { self.token.storage_balance_bounds() }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> { self.token.storage_balance_of(account_id) }
}

#[near]
impl FungibleTokenMetadataProvider for Token {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        let _ = env::current_account_id();
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(), name: "Spike".into(), symbol: "BLK".into(),
            icon: None, reference: None, reference_hash: None, decimals: 6,
        }
    }
}
