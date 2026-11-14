//! Slice 2: the on-chain `new` (ARCHITECTURE 5.3, 5.5). It validates the configuration with
//! `limits::validate`, stores it, and starts the three storage registrations: `storage_deposit`
//! with both pool tokens and with DCL. Each callback records its result; `retry_registration`
//! lets the creator retry one that failed, or one still `Pending` after `stale_after_blocks`
//! (a callback lost to gas); a stale DCL storage is only re-checked with `storage_balance_of`,
//! so its NEAR is never deposited twice. Funding, `cancel` and `withdraw` are slice 3
//! (`funding`); `start` and everything after it come in later slices.
//!
//! Confirmed facts this relies on (`docs/gates/3-rhea-and-access-keys.md`): both pool tokens
//! take exactly 0.00125 NEAR of storage (`storage_balance_bounds` min = max, mainnet,
//! 10 November 2026); DCL's minimum is 0.5 NEAR; DCL's `register_tokens` panics `E104` with
//! 1 yoctoNEAR and isn't needed (deposits work without it), so it is never called.
//! **Unverified:** the gas each call needs; the sandbox tests of slice 2b measure it.
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

use crate::limits::{self, Network};

/// Storage on each pool token: their `storage_balance_bounds` min and max (mainnet, 10 November 2026).
pub const TOKEN_STORAGE: NearToken = NearToken::from_yoctonear(1_250_000_000_000_000_000_000);
/// Gas for each registration call, and for each callback (fixed: the callback gets no share of
/// unused gas, so its outcome doesn't depend on what the caller attached). Bounded in the
/// sandbox (slice 2b; gate 3 Part F).
pub const GAS_REGISTER: Gas = Gas::from_tgas(15);
pub const GAS_CALLBACK: Gas = Gas::from_tgas(10);
/// Prepaid gas `new` and `retry_registration` need (principle 8): their calls and callbacks plus
/// their own run. Refused below it at the first check, so no callback can run short. Measured on
/// the real wasm in the sandbox (slice 2b, 10 November 2026; gate 3 Part F): a deploy batch at
/// exactly 200 Tgas succeeds with all three `Ok` and 199 Tgas is refused; each `storage_deposit`
/// (native USDC, wrap.near, DCL) burns under half of its 15 and each callback under half of its
/// fixed 10. Printed only: the whole deploy batch receipt (create, fund, key, deploy and `new`)
/// burnt 34 Tgas, a retry's own receipt 2.4.
pub const MIN_GAS_NEW: Gas = Gas::from_tgas(200);
pub const MIN_GAS_RETRY: Gas = Gas::from_tgas(80);
/// Storage bytes kept free beyond what the contract already uses, for the state `new` writes.
pub const STORAGE_MARGIN_BYTES: u64 = 10_000;

/// The network this build is for: mainnet unless built with the `sandbox` feature. A sandbox
/// build refuses `new` outside `.test.near`; that is only a backstop (`test.near` exists on
/// mainnet, so its owner could create accounts under it). The protection is CI's check that the
/// release wasm holds no `test.near`, and a deploy that pins the release wasm's hash.
pub fn network() -> Network {
    #[cfg(feature = "sandbox")]
    {
        Network {
            quote_token: "usdc.test.near".into(),
            base_token: "wrap.test.near".into(),
            dcl_contract: "dcl.test.near".into(),
            pool: "usdc.test.near|wrap.test.near|100".into(),
        }
    }
    #[cfg(not(feature = "sandbox"))]
    {
        Network::mainnet()
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigArgs {
    pub creator: AccountId,
    pub agent: AccountId,
    pub deliverer: AccountId,
    pub platform_account: AccountId,
    pub quote_token: AccountId,
    pub dcl_contract: AccountId,
    /// SHA-256 of the canonical rules, 64 lowercase hex characters.
    pub rules_hash: String,
    pub rules_ciphertext: Base64VecU8,
    pub platform_bps: u16,
    pub key_price: U128,
    pub max_key_sales: u32,
    pub key_delivery_window_ns: U64,
    pub start_deadline_ns: U64,
    pub run_end_ns: U64,
    pub exit_grace_ns: U64,
    pub platform_claim_window_ns: U64,
    pub stale_after_blocks: U64,
    pub stale_cooldown_blocks: U64,
    pub dcl_storage: U128,
    pub attested: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct LimitsArgs {
    pub max_principal: U128,
    pub pool: String,
    pub max_slippage_bps: u16,
    pub max_swap_slippage_bps: u16,
    pub max_swap_step_bps: u16,
    pub max_observation_drift_bps: u16,
    pub max_observation_age_blocks: U64,
    pub min_range_width_bps: u32,
    pub max_range_width_bps: u32,
    pub min_action_interval_s: U64,
    pub max_actions_per_24h: u32,
    pub dust_threshold: Vec<(AccountId, U128)>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Status {
    Open,
    /// Ended by `cancel` before `start` (slice 3). Only `withdraw` moves tokens from here.
    Cancelled,
    /// Started (slice 4): `start`'s callback found the pool, the slots and the payees in order.
    /// Appended last so the Borsh discriminants of earlier variants never move. Slice 4 alone
    /// has no way out of `Running`: never deploy a build without `close`, the exits and the claims
    /// on a funded account.
    Running,
    /// `close()` was called (slice 5): no new trading; exits, `settle`, the claims and `reveal`
    /// follow. Appended after `Running` so no discriminant moves.
    Closing,
    /// `settle` found the internal balances below dust (slice 5); exits and claims continue.
    Closed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum RegState {
    Pending,
    Ok,
    Failed,
}

/// The three registrations `start` will require all `Ok` (5.5).
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Target {
    QuoteToken,
    BaseToken,
    DclStorage,
}
pub const TARGETS: [Target; 3] = [Target::QuoteToken, Target::BaseToken, Target::DclStorage];

/// One registration: its state, the nonce of its latest launch (a callback with another nonce is
/// ignored, so a late one can't overwrite a newer result), the block it was launched at, and, for
/// DCL storage, whether a deposit may have landed: set when a deposit goes out, cleared only by a
/// deposit that definitely failed or a re-check that read `null`. While it is set a retry only
/// re-checks, so DCL's storage NEAR is never paid twice (contract re-review L-2).
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Registration {
    pub state: RegState,
    pub nonce: u32,
    pub launched_block: u64,
    pub deposit_may_have_landed: bool,
    /// The block the latest DCL storage deposit went out (0 for the tokens).
    pub deposit_block: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Registrations {
    pub quote_token: Registration,
    pub base_token: Registration,
    pub dcl_storage: Registration,
}

impl Registrations {
    fn get(&self, t: Target) -> Registration {
        match t {
            Target::QuoteToken => self.quote_token,
            Target::BaseToken => self.base_token,
            Target::DclStorage => self.dcl_storage,
        }
    }
    fn get_mut(&mut self, t: Target) -> &mut Registration {
        match t {
            Target::QuoteToken => &mut self.quote_token,
            Target::BaseToken => &mut self.base_token,
            Target::DclStorage => &mut self.dcl_storage,
        }
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Strategy {
    config: ConfigArgs,
    limits: LimitsArgs,
    status: Status,
    /// The timestamp and block of `new` (the storage reserve's `D`, the proposed `get_deploy_block`).
    deploy_ns: u64,
    deploy_block: u64,
    registrations: Registrations,
    /// Funding received from the creator in `Open` (slice 3), at most `max_principal`.
    principal: u128,
    /// The last block `ft_on_transfer` returned a non-zero amount (a refund in flight).
    last_inbound_block: u64,
    /// The operation lock (principle 2): one external operation at a time.
    lock: Option<funding::Lock>,
    next_op_id: u64,
    /// The block of the latest `resolve_stale`; token-moving calls wait `stale_cooldown_blocks`.
    stale_resolution_block: Option<u64>,
    /// The block timestamp at which `start`'s callback moved to `Running` (proposed view).
    started_at_ns: Option<u64>,
    /// Every trading call's record, in order, refused ones included (slice 7); at most
    /// `MAX_ACTIONS_STORED`. The check page's input.
    actions: Vec<trade::ActionRecord>,
    /// Decision hashes already used (each trading call needs a new one, except a paired open).
    seen_decisions: Vec<[u8; 32]>,
    /// The `lpt_id` of the position this strategy created, if any (slice 8 sets it).
    own_position: Option<String>,
    /// Set when an add has returned a position; a second open is then refused (slice 8).
    opened: bool,
    /// `register_tokens` succeeded at DCL for both pool tokens (S8; gate 3 Part J).
    tokens_registered: bool,
    /// The exact rules string `reveal` accepted (S10); `None` until then.
    revealed: Option<String>,
    /// Swaps with `used > 0` (at most `MAX_SWAPS_PER_RUN`).
    swaps_used: u8,
    /// The block timestamp at which `settle` moved to `Closed` (slice 5).
    closed_at_ns: Option<u64>,
    /// No settle before this block (a payout landing late is visible first). Always 0 until the
    /// trading and exit slices set it from their payout callbacks (5.2 principle 6).
    settle_until_block: u64,
    /// The block of the last own payout-producing callback and the class of the caller that
    /// caused it (5.2 principle 6); set together with `settle_until_block` by `set_window`.
    last_payout_callback_block: u64,
    settle_window_class: settle::Class,
    /// Fees realised at removals of the strategy's own position, per pool token (quote, base);
    /// raised by the trading slices, so 0 until then. The platform's cut is `fees / 20`.
    fees_collected: [u128; 2],
    /// What the platform has been paid, per pool token (raised before its transfer, restored if
    /// the transfer fails).
    paid_platform: [u128; 2],
    /// Failed `withdraw_asset` calls per pool token, for the stuck-token rule (EC-C103).
    withdraw_failures: [exit::WithdrawFailures; 2],
    /// The claim whose transfers are out, if any (slice 6).
    claim_in_flight: Option<claims::ClaimInFlight>,
    /// The latest call of each rate-limited (method, token, caller class) (principle 5).
    rate_stamps: Vec<settle::RateStamp>,
    /// Viewing-key sales in purchase order (D57; INTERFACE 9). Never shrinks: `sold` is its length.
    key_sales: Vec<keys::KeySale>,
    /// NEAR held for accounts whose transfer bounced (pull payment, `withdraw_near`).
    near_owed: Vec<(AccountId, u128)>,
    /// Escrowed key payments not yet released or refunded, and the sum of `near_owed`.
    escrow_total: u128,
    near_owed_total: u128,
}

fn refuse(msg: &str) -> ! {
    env::panic_str(msg)
}

/// Parses 64 lowercase hex characters into 32 bytes.
pub fn parse_hash(h: &str) -> Option<[u8; 32]> {
    if h.len() != 64
        || !h
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

/// The pure configuration `limits::validate` checks, from the JSON arguments.
pub fn to_pure(
    c: &ConfigArgs,
    l: &LimitsArgs,
    hash: [u8; 32],
) -> (limits::Config, limits::PublicLimits) {
    (
        limits::Config {
            creator: c.creator.to_string(),
            agent: c.agent.to_string(),
            deliverer: c.deliverer.to_string(),
            platform_account: c.platform_account.to_string(),
            quote_token: c.quote_token.to_string(),
            dcl_contract: c.dcl_contract.to_string(),
            rules_hash: hash,
            rules_ciphertext: c.rules_ciphertext.0.clone(),
            platform_bps: c.platform_bps,
            key_price: c.key_price.0,
            max_key_sales: c.max_key_sales,
            key_delivery_window_ns: c.key_delivery_window_ns.0,
            start_deadline_ns: c.start_deadline_ns.0,
            run_end_ns: c.run_end_ns.0,
            exit_grace_ns: c.exit_grace_ns.0,
            platform_claim_window_ns: c.platform_claim_window_ns.0,
            stale_after_blocks: c.stale_after_blocks.0,
            stale_cooldown_blocks: c.stale_cooldown_blocks.0,
            dcl_storage: c.dcl_storage.0,
            attested: c.attested,
        },
        limits::PublicLimits {
            max_principal: l.max_principal.0,
            pool: l.pool.clone(),
            max_slippage_bps: l.max_slippage_bps,
            max_swap_slippage_bps: l.max_swap_slippage_bps,
            max_swap_step_bps: l.max_swap_step_bps,
            max_observation_drift_bps: l.max_observation_drift_bps,
            max_observation_age_blocks: l.max_observation_age_blocks.0,
            min_range_width_bps: l.min_range_width_bps,
            max_range_width_bps: l.max_range_width_bps,
            min_action_interval_s: l.min_action_interval_s.0,
            max_actions_per_24h: l.max_actions_per_24h,
            dust_threshold: l
                .dust_threshold
                .iter()
                .map(|(t, v)| (t.to_string(), v.0))
                .collect(),
        },
    )
}

/// NEAR a launch of `t` spends from the contract's own balance (a DCL storage re-check spends none).
pub fn launch_cost(t: Target, dcl_storage: u128, check_only: bool) -> u128 {
    match t {
        Target::QuoteToken | Target::BaseToken => TOKEN_STORAGE.as_yoctonear(),
        Target::DclStorage if check_only => 0,
        Target::DclStorage => dcl_storage,
    }
}

/// NEAR the three registrations of `new` spend: both tokens' storage and DCL's.
pub fn registration_cost(dcl_storage: u128) -> u128 {
    2 * TOKEN_STORAGE.as_yoctonear() + dcl_storage
}

/// Refuses unless the account keeps its storage stake (what it already uses plus a margin)
/// after spending `cost` (M1, 5.3). Escrowed key NEAR and NEAR owed are added here when the
/// slices that hold them land.
fn require_balance(cost: u128) {
    let stake = env::storage_byte_cost()
        .as_yoctonear()
        .saturating_mul((env::storage_usage() + STORAGE_MARGIN_BYTES) as u128);
    if env::account_balance().as_yoctonear() < cost.saturating_add(stake) {
        refuse("LIMIT: balance for registration");
    }
}

impl Strategy {
    /// `require_balance` for a spend from a live strategy: the escrowed key NEAR and the NEAR
    /// owed to accounts are never spendable (5.3, 5.5).
    pub(crate) fn require_free(&self, cost: u128) {
        require_balance(
            cost.saturating_add(self.escrow_total)
                .saturating_add(self.near_owed_total),
        );
    }
}

fn event(name: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "poolside", "version": "1.0.0", "event": name, "data": [data]})
    ));
}

#[near]
impl Strategy {
    /// Validates and stores the configuration, then starts the three registrations. Callable only
    /// by the strategy account itself or its parent: the deploy is one batch, signed by the parent
    /// (the only account that can create it), that creates, funds, deploys and calls `new` (N4), so
    /// nobody else can initialise it first, and if `new` refuses the whole batch reverts
    /// (contract re-review H-1, T72). Refused with a `LIMIT:` or `AUTH:` message, nothing stored,
    /// if any check fails (EC-C56, EC-C165).
    #[init]
    pub fn new(config: ConfigArgs, limits: LimitsArgs) -> Self {
        let me = env::current_account_id();
        let caller = env::predecessor_account_id();
        let parent = me.as_str().split_once('.').map(|(_, p)| p);
        if caller != me && Some(caller.as_str()) != parent {
            refuse("AUTH: new only by the strategy account or its parent");
        }
        #[cfg(feature = "sandbox")]
        if !env::current_account_id().as_str().ends_with(".test.near") {
            refuse("LIMIT: sandbox build");
        }
        if env::prepaid_gas() < MIN_GAS_NEW {
            refuse("LIMIT: gas");
        }
        let hash = parse_hash(&config.rules_hash).unwrap_or_else(|| refuse("LIMIT: rules hash"));
        let (c, l) = to_pure(&config, &limits, hash);
        if let Err(m) = limits::validate(
            &c,
            &l,
            &network(),
            env::block_timestamp(),
            env::current_account_id().as_str(),
        ) {
            refuse(&m);
        }
        require_balance(registration_cost(config.dcl_storage.0));
        let blank = Registration {
            state: RegState::Pending,
            nonce: 0,
            launched_block: 0,
            deposit_may_have_landed: false,
            deposit_block: 0,
        };
        let mut s = Self {
            config,
            limits,
            status: Status::Open,
            deploy_ns: env::block_timestamp(),
            deploy_block: env::block_height(),
            registrations: Registrations {
                quote_token: blank,
                base_token: blank,
                dcl_storage: blank,
            },
            principal: 0,
            last_inbound_block: 0,
            lock: None,
            next_op_id: 0,
            stale_resolution_block: None,
            started_at_ns: None,
            actions: Vec::new(),
            seen_decisions: Vec::new(),
            own_position: None,
            opened: false,
            tokens_registered: false,
            revealed: None,
            swaps_used: 0,
            closed_at_ns: None,
            settle_until_block: 0,
            last_payout_callback_block: 0,
            settle_window_class: settle::Class::Outsider,
            fees_collected: [0; 2],
            paid_platform: [0; 2],
            withdraw_failures: [exit::WithdrawFailures::default(); 2],
            claim_in_flight: None,
            rate_stamps: Vec::new(),
            key_sales: Vec::new(),
            near_owed: Vec::new(),
            escrow_total: 0,
            near_owed_total: 0,
        };
        event(
            "new",
            json!({"creator": s.config.creator, "rules_hash": s.config.rules_hash}),
        );
        for t in TARGETS {
            s.launch(t, false);
        }
        s
    }

    /// The creator retries one registration (5.5): one that `Failed`, or one still `Pending`
    /// `stale_after_blocks` after its launch, whose callback was lost. A stale DCL storage is only
    /// re-checked with `storage_balance_of`, never deposited again. Checks in principle 5's
    /// order: status, caller, gas, then the registration.
    pub fn retry_registration(&mut self, target: Target) {
        if self.status != Status::Open {
            refuse("LIMIT: wrong status");
        }
        if env::predecessor_account_id() != self.config.creator {
            refuse("AUTH: creator only");
        }
        if env::prepaid_gas() < MIN_GAS_RETRY {
            refuse("LIMIT: gas");
        }
        let r = self.registrations.get(target);
        let stale = r.state == RegState::Pending
            && env::block_height()
                >= r.launched_block
                    .saturating_add(self.config.stale_after_blocks.0);
        if r.state != RegState::Failed && !stale {
            refuse("LIMIT: registration not failed");
        }
        // DCL storage is only re-checked while a deposit may have landed: when stale, and when a
        // failure didn't show the NEAR stayed here (contract re-review L-2).
        // `stale` implies the flag for DCL storage (every DCL deposit sets it), kept as defence in depth.
        debug_assert!(!(stale && target == Target::DclStorage) || r.deposit_may_have_landed);
        let check_only = target == Target::DclStorage && (stale || r.deposit_may_have_landed);
        self.require_free(launch_cost(target, self.config.dcl_storage.0, check_only));
        self.launch(target, check_only);
    }

    /// Records one registration's result. Ignores a callback whose nonce isn't the latest launch's
    /// (a late one after a retry). For a DCL storage re-check, `Ok` means `storage_balance_of`
    /// returned an object whose `total` is at least `dcl_storage`. Starts no promise, so it needs only its fixed gas. Not
    /// `#[private]`: the explicit check below is the same rule and keeps the `AUTH:` message on
    /// chain (contract re-review L-1).
    pub fn on_registered(&mut self, target: Target, nonce: u32, check_only: bool) {
        if env::predecessor_account_id() != env::current_account_id() {
            refuse("AUTH: callback only");
        }
        let r = self.registrations.get(target);
        if r.state != RegState::Pending || r.nonce != nonce {
            event(
                "registration_ignored",
                json!({"target": target, "nonce": nonce}),
            );
            return;
        }
        // The answers are small JSON (a balance, or `null`); 4 KB is ample.
        let res: Result<Vec<u8>, PromiseError> = if env::promise_results_count() == 1 {
            env::promise_result_checked(0, 4_096)
        } else {
            Err(PromiseError::TooLong(0))
        };
        // (recorded as Ok, the NEAR definitely didn't land at DCL)
        let (ok, not_landed) = match (&res, check_only) {
            (Ok(_), false) => (true, false),
            // The deposit's receipt failed: its NEAR came back.
            (Err(PromiseError::Failed), false) => (false, true),
            (Err(_), false) => (false, false),
            // A re-check is `Ok` only if DCL holds at least `dcl_storage` for us: an outsider can
            // register the strategy with DCL's 0.5 NEAR minimum (contract re-review L-1). A `null`,
            // or a balance below `dcl_storage`, shows our deposit isn't there, but only proves it
            // never will be once the re-check runs 2 x `stale_after_blocks` after the deposit went
            // out; earlier, the deposit may still be in flight (security re-review L-1).
            (Ok(b), true) => {
                let late = self.registrations.get(target).launched_block
                    >= self
                        .registrations
                        .get(target)
                        .deposit_block
                        .saturating_add(2 * self.config.stale_after_blocks.0);
                match near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(b) {
                    Ok(v) if v.is_object() => {
                        let total = v
                            .get("total")
                            .and_then(|t| t.as_str())
                            .and_then(|t| t.parse::<u128>().ok());
                        match total {
                            Some(t) if t >= self.config.dcl_storage.0 => (true, false),
                            Some(_) => (false, late),
                            None => (false, false),
                        }
                    }
                    Ok(v) if v.is_null() => (false, late),
                    _ => (false, false),
                }
            }
            (Err(_), true) => (false, false),
        };
        let r = self.registrations.get_mut(target);
        r.state = if ok { RegState::Ok } else { RegState::Failed };
        if not_landed {
            r.deposit_may_have_landed = false;
        }
        event(
            "registration",
            json!({"target": target, "nonce": nonce, "check_only": check_only, "ok": ok}),
        );
    }

    pub fn get_config(&self) -> &ConfigArgs {
        &self.config
    }
    pub fn get_limits(&self) -> &LimitsArgs {
        &self.limits
    }
    pub fn get_status(&self) -> Status {
        self.status
    }
    pub fn get_registrations(&self) -> Registrations {
        self.registrations
    }
}

impl Strategy {
    fn launch(&mut self, t: Target, check_only: bool) {
        let me = env::current_account_id();
        let r = self.registrations.get_mut(t);
        r.state = RegState::Pending;
        r.nonce = r.nonce.wrapping_add(1);
        r.launched_block = env::block_height();
        if t == Target::DclStorage && !check_only {
            r.deposit_may_have_landed = true;
            r.deposit_block = r.launched_block;
        }
        let nonce = r.nonce;
        let (receiver, method, args, deposit): (AccountId, &str, String, NearToken) =
            match (t, check_only) {
                (Target::QuoteToken, _) => (
                    self.config.quote_token.clone(),
                    "storage_deposit",
                    json!({"account_id": me, "registration_only": true}).to_string(),
                    TOKEN_STORAGE,
                ),
                (Target::BaseToken, _) => (
                    network()
                        .base_token
                        .parse()
                        .unwrap_or_else(|_| refuse("LIMIT: not the network constant")),
                    "storage_deposit",
                    json!({"account_id": me, "registration_only": true}).to_string(),
                    TOKEN_STORAGE,
                ),
                (Target::DclStorage, false) => (
                    self.config.dcl_contract.clone(),
                    "storage_deposit",
                    json!({"account_id": me}).to_string(),
                    NearToken::from_yoctonear(self.config.dcl_storage.0),
                ),
                (Target::DclStorage, true) => (
                    self.config.dcl_contract.clone(),
                    "storage_balance_of",
                    json!({"account_id": me}).to_string(),
                    NearToken::from_yoctonear(0),
                ),
            };
        event(
            "registration_started",
            json!({"target": t, "nonce": nonce, "check_only": check_only}),
        );
        Promise::new(receiver)
            .function_call(method.to_string(), args.into_bytes(), deposit, GAS_REGISTER)
            .then(
                Self::ext(me)
                    .with_static_gas(GAS_CALLBACK)
                    .with_unused_gas_weight(0)
                    .on_registered(t, nonce, check_only),
            )
            .detach();
    }
}

mod keys;
pub use keys::*;
mod funding;
pub use funding::*;
mod claims;
pub use claims::*;
mod exit;
pub use exit::*;
mod settle;
pub use settle::*;
mod trade;
pub use trade::*;
mod open;
pub use open::*;
mod remove;
pub use remove::*;
mod reveal;
pub use reveal::*;
mod start;
pub use start::*;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_claims;
#[cfg(test)]
mod tests_exit;
#[cfg(test)]
mod tests_funding;
#[cfg(test)]
mod tests_keys;
#[cfg(test)]
mod tests_open;
#[cfg(test)]
mod tests_remove;
#[cfg(test)]
mod tests_reveal;
#[cfg(test)]
mod tests_settle;
#[cfg(test)]
mod tests_start;
#[cfg(test)]
mod tests_trade;
