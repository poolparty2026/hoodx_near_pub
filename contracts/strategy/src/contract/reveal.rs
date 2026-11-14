//! Slice 10: `reveal(rules_json)` (ARCHITECTURE 5.5; EC-C17, EC-C37, EC-C146). Accepted once, only
//! if the SHA-256 of the string's UTF-8 bytes equals `rules_hash`, at most 4,096 bytes, and stored
//! exactly as sent (never re-serialised, so the check page hashes what it reads). The creator may
//! reveal in any status after `Open`; anyone may in `Closing` and `Closed`. The viewing-key sale
//! that `reveal` would end is not in v1 (D55).
use near_sdk::serde_json::json;
use near_sdk::{env, near};

use super::{event, parse_hash, refuse, Status, Strategy, StrategyExt};

/// The most bytes of rules `reveal` accepts (D12).
pub const MAX_REVEAL_BYTES: usize = 4_096;

#[near]
impl Strategy {
    /// Checks in principle 5's order: status, caller, already revealed, size, hash, storage.
    pub fn reveal(&mut self, rules_json: String) {
        let creator = env::predecessor_account_id() == self.config.creator;
        match self.status {
            Status::Open | Status::Cancelled => refuse("LIMIT: wrong status"),
            Status::Running if !creator => refuse("AUTH: creator only while running"),
            _ => {}
        }
        if self.revealed.is_some() {
            refuse("LIMIT: already revealed");
        }
        if rules_json.len() > MAX_REVEAL_BYTES {
            refuse("LIMIT: rules too large");
        }
        let hash = env::sha256_array(rules_json.as_bytes());
        if parse_hash(&self.config.rules_hash) != Some(hash) {
            refuse("LIMIT: rules hash");
        }
        self.require_free(
            env::storage_byte_cost()
                .as_yoctonear()
                .saturating_mul(rules_json.len() as u128 + 64),
        );
        event(
            "reveal",
            json!({"by": env::predecessor_account_id(), "bytes": rules_json.len()}),
        );
        self.revealed = Some(rules_json);
    }

    /// `null`, or the exact string `reveal` accepted.
    pub fn get_revealed(&self) -> Option<String> {
        self.revealed.clone()
    }
}
