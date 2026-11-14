//! Validation of the configuration and public limits `new` accepts (ARCHITECTURE 5.3,
//! EC-C56). Pure: no chain access, so every bound is unit-tested at the limit and one past
//! it. The `new` method calls `validate` and stores the result unchanged.
//!
//! Not here yet, by design: the swap-step caps (`max_swap_step_bps`, `max_swap_step_24h_bps`)
//! wait for Q16, and the size of `dust_threshold` against `max_principal` is checked at
//! `start` (EC-C136), where the start price is known.

pub const NANOS_PER_S: u64 = 1_000_000_000;
pub const DAY_NS: u64 = 86_400 * NANOS_PER_S;
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// 500 USDC in raw units (6 decimals), D4.
pub const MAX_PRINCIPAL_CAP: u128 = 500_000_000;
/// The encrypted rules: at most 4 KB of rules plus 41 bytes of envelope (D12).
pub const MAX_CIPHERTEXT: usize = 4096 + 41;
pub const PLATFORM_BPS: u16 = 500;
/// Whether `attested: true` may be deployed. False until gate 2 (private AI) passes; the
/// contract is rebuilt to change it, never configured (ARCHITECTURE 5.3).
pub const ATTESTATION_ENABLED: bool = false;

/// The accounts and pool a deployment must use. The mainnet values are fixed; a sandbox
/// build passes its own (the contract picks one at compile time, never at run time).
#[derive(Clone, Debug)]
pub struct Network {
    pub quote_token: String,
    pub base_token: String,
    pub dcl_contract: String,
    pub pool: String,
}

impl Network {
    pub fn mainnet() -> Self {
        Network {
            quote_token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1".into(),
            base_token: "wrap.near".into(),
            dcl_contract: "dclv2.ref-labs.near".into(),
            pool: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|wrap.near|100"
                .into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub creator: String,
    pub agent: String,
    pub deliverer: String,
    pub platform_account: String,
    pub quote_token: String,
    pub dcl_contract: String,
    pub rules_hash: [u8; 32],
    pub rules_ciphertext: Vec<u8>,
    pub platform_bps: u16,
    pub key_price: u128,
    pub max_key_sales: u32,
    pub key_delivery_window_ns: u64,
    pub start_deadline_ns: u64,
    pub run_end_ns: u64,
    pub exit_grace_ns: u64,
    pub platform_claim_window_ns: u64,
    pub stale_after_blocks: u64,
    pub stale_cooldown_blocks: u64,
    pub dcl_storage: u128,
    pub attested: bool,
}

#[derive(Clone, Debug)]
pub struct PublicLimits {
    pub max_principal: u128,
    pub pool: String,
    pub max_slippage_bps: u16,
    pub max_swap_slippage_bps: u16,
    /// One swap step as a share of the holdings' value, 5,000 to 6,000 (Q16, provisional): a start
    /// from the quote token alone swaps about half.
    pub max_swap_step_bps: u16,
    pub max_observation_drift_bps: u16,
    pub max_observation_age_blocks: u64,
    pub min_range_width_bps: u32,
    pub max_range_width_bps: u32,
    pub min_action_interval_s: u64,
    pub max_actions_per_24h: u32,
    pub dust_threshold: Vec<(String, u128)>,
}

fn limit(name: &str) -> Result<(), String> {
    Err(format!("LIMIT: {name}"))
}

fn within<T: PartialOrd>(v: T, lo: T, hi: T, name: &str) -> Result<(), String> {
    if v < lo || v > hi {
        limit(name)
    } else {
        Ok(())
    }
}

/// The largest drift (points) for which the add ratio bound stays at or below 5,000 bps at
/// the centring limit for every range of at least `min_width` points: the largest D with
/// `2 * D * W <= a * (W - a)`, `a = floor(W / 4)`, at `W = min_width`. `W / (a (W - a))`
/// never increases with W over 50..5,000 (`tests::width_bound_holds_for_every_width`
/// checks it for every pair), so the minimum width is the worst case. It replaces the
/// earlier `floor(3 W / 32)`, which let the ratio reach 5,117 (width 75, drift 7). Below 4
/// points it is 0 (no range is that narrow; `new` refuses widths under 50 first).
pub fn max_drift_for_width(min_width: u32) -> u64 {
    let w = min_width as u64;
    if w < 4 {
        return 0;
    }
    let a = w / 4;
    (a * (w - a)) / (2 * w)
}

/// Validates `new`'s inputs. `now_ns` is the deploy block's timestamp and `self_id` the
/// strategy's own account. Checks run in a fixed order and the first failure is returned,
/// so each refusal message is stable (EC-C56).
pub fn validate(
    c: &Config,
    l: &PublicLimits,
    net: &Network,
    now_ns: u64,
    self_id: &str,
) -> Result<(), String> {
    // Network constants.
    if c.quote_token != net.quote_token || c.dcl_contract != net.dcl_contract || l.pool != net.pool
    {
        return limit("not the network constant");
    }
    // Accounts: distinct from each other, from the strategy itself, DCL and both tokens.
    let roles = [&c.creator, &c.agent, &c.deliverer, &c.platform_account];
    let others = [
        self_id,
        net.dcl_contract.as_str(),
        net.quote_token.as_str(),
        net.base_token.as_str(),
    ];
    for (i, r) in roles.iter().enumerate() {
        if roles[i + 1..].contains(r) || others.contains(&r.as_str()) {
            return limit("accounts not distinct");
        }
    }
    // Configuration bounds.
    if c.rules_ciphertext.len() < 41 || c.rules_ciphertext.len() > MAX_CIPHERTEXT {
        return limit("rules ciphertext size");
    }
    if c.attested && !ATTESTATION_ENABLED {
        return limit("attested");
    }
    if c.platform_bps != PLATFORM_BPS {
        return limit("platform bps");
    }
    within(c.key_price, 0, ONE_NEAR, "key price")?;
    within(c.max_key_sales, 0, 50, "key sales")?;
    within(
        c.key_delivery_window_ns,
        600 * NANOS_PER_S,
        DAY_NS,
        "key delivery window",
    )?;
    // Deadlines: start after now and within 7 days; the run ends after the start deadline and within 30 days.
    if c.start_deadline_ns <= now_ns || c.start_deadline_ns - now_ns > 7 * DAY_NS {
        return limit("start deadline");
    }
    if c.run_end_ns <= c.start_deadline_ns || c.run_end_ns - now_ns > 30 * DAY_NS {
        return limit("run end");
    }
    within(
        c.exit_grace_ns,
        3_600 * NANOS_PER_S,
        7 * DAY_NS,
        "exit grace",
    )?;
    within(
        c.platform_claim_window_ns,
        DAY_NS,
        7 * DAY_NS,
        "platform claim window",
    )?;
    within(c.stale_after_blocks, 500, 10_000, "stale after blocks")?;
    // stale_after_blocks <= 10,000 here, so 2 * it can't overflow.
    within(
        c.stale_cooldown_blocks,
        c.stale_after_blocks,
        2 * c.stale_after_blocks,
        "stale cooldown blocks",
    )?;
    within(c.dcl_storage, 2 * ONE_NEAR, 10 * ONE_NEAR, "dcl storage")?;
    // Public limits.
    within(l.max_principal, 1, MAX_PRINCIPAL_CAP, "max principal")?;
    within(l.max_slippage_bps, 1, 300, "slippage")?;
    within(l.max_swap_slippage_bps, 11, 100, "swap slippage")?;
    within(l.max_swap_step_bps, 5_000, 6_000, "swap step")?;
    within(l.max_observation_age_blocks, 1, 100, "observation age")?;
    within(l.min_range_width_bps, 50, 5_000, "min range width")?;
    within(
        l.max_range_width_bps,
        l.min_range_width_bps,
        5_000,
        "max range width",
    )?;
    within(l.max_observation_drift_bps, 1, 300, "drift")?;
    // The cross-limits, in this order, after the bounds they use (EC-C56).
    if (l.max_observation_drift_bps as u64) > max_drift_for_width(l.min_range_width_bps) {
        return limit("drift above width bound");
    }
    // max_swap_slippage_bps >= 11 here, so the subtraction can't underflow.
    if l.max_observation_drift_bps > l.max_swap_slippage_bps - 10 {
        return limit("drift above slippage");
    }
    within(l.min_action_interval_s, 300, 3_600, "action interval")?;
    within(l.max_actions_per_24h, 4, 48, "actions per 24h bound")?;
    // dust_threshold: exactly the pool's two tokens, once each.
    let toks: Vec<&str> = l.dust_threshold.iter().map(|(t, _)| t.as_str()).collect();
    let ok = toks.len() == 2
        && toks.contains(&net.quote_token.as_str())
        && toks.contains(&net.base_token.as_str());
    if !ok {
        return limit("dust threshold tokens");
    }
    // Each at least 1: a dust threshold of 0 would disable `nothing_to_add` and the
    // "below dust" tests of settle and `withdraw_storage_surplus` (contract review L-2).
    if l.dust_threshold.iter().any(|(_, v)| *v == 0) {
        return limit("dust threshold zero");
    }
    Ok(())
}

#[cfg(test)]
mod tests;
