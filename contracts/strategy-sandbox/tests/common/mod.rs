//! Helpers shared by the sandbox tests (moved unchanged from `new.rs`, slice 3b).
#![allow(dead_code)]
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::{ExecutionFinalResult, ExecutionOutcome};
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
pub const STRATEGY_WASM: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/sandbox/wasm32-unknown-unknown/release/strategy.wasm"
);
pub const WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/wasm");
/// The pinned hashes, as in wasm/README.md and fetch_wasm.py.
pub const PINNED_WASM: [(&str, &str); 3] = [
    ("dclv2.wasm", "3G34Nhjmir5JPYPtijaA9iCNnHDPR7h3wfC9H77woEGo"),
    ("wrap.wasm", "DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1"),
    ("usdc.wasm", "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q"),
];
pub const SANDBOX_SHA256: &str = "797b9d7a9a23907048d68a427e86a55c94f1de232dbfb8b8a1eec09ecef3bf13";
pub const NS: u64 = 1_000_000_000;
pub const DAY: u64 = 86_400 * NS;
pub const TGAS: u64 = 1_000_000_000_000;
pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// The contract's TOKEN_STORAGE, GAS_REGISTER, GAS_CALLBACK and MIN_GAS_NEW / MIN_GAS_RETRY.
pub const TOKEN_STORAGE: u128 = 1_250_000_000_000_000_000_000;
pub const GAS_REGISTER: u64 = 15 * TGAS;
pub const GAS_CALLBACK: u64 = 10 * TGAS;
pub const DCL_STORAGE: u128 = 2 * NEAR;
pub const FUNDING: u128 = 20 * NEAR;
pub const STALE_AFTER: u64 = 500;
pub const USDC: &str = "usdc.test.near";
pub const WRAP: &str = "wrap.test.near";
pub const DCL: &str = "dcl.test.near";

pub fn read(p: &str) -> Vec<u8> {
    std::fs::read(p)
        .unwrap_or_else(|_| panic!("missing {p}: run contracts/strategy-sandbox/run.sh"))
}

/// The newest mtime under `dir`, skipping test-only modules (`tests*.rs`), which never change the
/// wasm, so editing a unit test doesn't trip the stale-wasm guard (test audit 3b M2).
pub fn newest_mtime(dir: &std::path::Path) -> std::time::SystemTime {
    let mut t = std::time::UNIX_EPOCH;
    for e in std::fs::read_dir(dir).unwrap() {
        let e = e.unwrap();
        if e.file_name().to_string_lossy().starts_with("tests") {
            continue;
        }
        let m = if e.file_type().unwrap().is_dir() {
            newest_mtime(&e.path())
        } else {
            e.metadata().unwrap().modified().unwrap()
        };
        t = t.max(m);
    }
    t
}

/// Refuses to run on anything unchecked (security audit 2b M-1, L-4): the near-sandbox binary must
/// be the pinned one, named by NEAR_SANDBOX_BIN_PATH so near-workspaces downloads nothing; each
/// mainnet wasm must match its pinned code hash; and the strategy wasm must be newer than its source.
pub fn check_inputs() {
    assert!(
        std::env::var_os("SANDBOX_ARTIFACT_URL").is_none(),
        "SANDBOX_ARTIFACT_URL is set; refusing"
    );
    let bin = std::env::var("NEAR_SANDBOX_BIN_PATH")
        .expect("NEAR_SANDBOX_BIN_PATH is unset: run contracts/strategy-sandbox/run.sh");
    assert_eq!(
        hex::encode(Sha256::digest(read(&bin))),
        SANDBOX_SHA256,
        "{bin} isn't the pinned near-sandbox"
    );
    for (f, want) in PINNED_WASM {
        let got = bs58::encode(Sha256::digest(read(&format!("{WASM}/{f}")))).into_string();
        assert_eq!(got, want, "{f} isn't the pinned code");
    }
    let built = std::fs::metadata(STRATEGY_WASM)
        .and_then(|m| m.modified())
        .unwrap_or_else(|_| panic!("missing {STRATEGY_WASM}: run run.sh"));
    let src = newest_mtime(std::path::Path::new(&format!(
        "{ROOT}/contracts/strategy/src"
    )))
    .max(
        ["contracts/strategy/Cargo.toml", "Cargo.toml", "Cargo.lock"]
            .iter()
            .map(|f| {
                std::fs::metadata(format!("{ROOT}/{f}"))
                    .unwrap()
                    .modified()
                    .unwrap()
            })
            .max()
            .unwrap(),
    );
    // The sandbox build names the .test.near accounts; the mainnet build never does (CI checks it).
    let wasm = read(STRATEGY_WASM);
    assert!(
        wasm.windows(9).any(|w| w == b"test.near"),
        "{STRATEGY_WASM} isn't the sandbox build: run run.sh"
    );
    assert!(
        built >= src,
        "the sandbox strategy wasm is older than its source: run run.sh"
    );
}

pub struct World {
    pub w: Worker<Sandbox>,
    pub root: Account,
    pub creator: Account,
    /// The agent account named in the strategy's config (`agent.test.near`).
    pub agent: Account,
    pub now: u64,
    /// Native USDC's two admins and master minters (its multisig needs two approvals); `usdc_admin`
    /// is also the minter. See `mint_usdc` and gate 3 Part G.
    pub usdc_admin: Account,
    pub usdc_admin2: Account,
}

pub async fn account(root: &Account, name: &str) -> anyhow::Result<Account> {
    Ok(root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(30))
        .transact()
        .await?
        .into_result()?)
}

/// wrap.near's code at wrap.test.near.
pub async fn deploy_wrap(root: &Account) -> anyhow::Result<()> {
    let c = account(root, "wrap")
        .await?
        .deploy(&read(&format!("{WASM}/wrap.wasm")))
        .await?
        .into_result()?;
    c.call("new")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// The sandbox's tokens and DCL at the accounts the sandbox build expects. `with_base` false leaves
/// wrap.test.near empty, so its registration fails and can be retried after it is deployed.
pub async fn world(with_base: bool) -> anyhow::Result<World> {
    check_inputs();
    let w = near_workspaces::sandbox().await?;
    let root = w.root_account()?;
    let owner = account(&root, "owner").await?;
    let owner2 = account(&root, "owner2").await?;
    // Native USDC's code, with its own init (the arguments are read from its wasm: the role lists and
    // NEP-148 metadata). Only its storage calls are used here.
    let usdc = account(&root, "usdc")
        .await?
        .deploy(&read(&format!("{WASM}/usdc.wasm")))
        .await?
        .into_result()?;
    usdc.call("init")
        .args_json(json!({
            "admin_ids": [owner.id(), owner2.id()], "master_minter_ids": [owner.id(), owner2.id()], "owner_ids": [owner.id()],
            "pauser_ids": [owner.id()], "blocklister_id": owner.id(),
            "metadata": {"spec": "ft-1.0.0", "name": "USD Coin", "symbol": "USDC", "decimals": 6}
        }))
        .transact()
        .await?
        .into_result()?;
    if with_base {
        deploy_wrap(&root).await?;
    }
    let dcl = account(&root, "dcl")
        .await?
        .deploy(&read(&format!("{WASM}/dclv2.wasm")))
        .await?
        .into_result()?;
    dcl.call("new")
        .args_json(
            json!({"owner_id": owner.id(), "wnear_id": WRAP, "farming_contract_id": owner.id()}),
        )
        .transact()
        .await?
        .into_result()?;
    let creator = account(&root, "creator").await?;
    let agent = account(&root, "agent").await?;
    let now = w.view_block().await?.timestamp();
    Ok(World {
        w,
        root,
        creator,
        agent,
        now,
        usdc_admin: owner,
        usdc_admin2: owner2,
    })
}

pub fn args(now: u64, creator: &AccountId, attested: bool) -> Value {
    json!({
        "config": {
            "creator": creator, "agent": "agent.test.near", "deliverer": "deliverer.test.near", "platform_account": "platform.test.near",
            "quote_token": USDC, "dcl_contract": DCL, "rules_hash": std::env::var("POOLSIDE_RULES_HASH").unwrap_or_else(|_| "ab".repeat(32)),
            "rules_ciphertext": std::env::var("POOLSIDE_RULES_CIPHERTEXT").unwrap_or_else(|_| "AQEB".repeat(100)), "platform_bps": 500, "key_price": "100000000000000000000000", "max_key_sales": 20,
            "key_delivery_window_ns": (3_600 * NS).to_string(), "start_deadline_ns": (now + DAY).to_string(), "run_end_ns": (now + 6 * DAY).to_string(),
            "exit_grace_ns": DAY.to_string(), "platform_claim_window_ns": (2 * DAY).to_string(), "stale_after_blocks": STALE_AFTER.to_string(),
            "stale_cooldown_blocks": "600", "dcl_storage": DCL_STORAGE.to_string(), "attested": attested
        },
        "limits": {
            "max_principal": "500000000", "pool": "usdc.test.near|wrap.test.near|100", "max_slippage_bps": 50, "max_swap_slippage_bps": 60, "max_swap_step_bps": 6000,
            "max_observation_drift_bps": 30, "max_observation_age_blocks": "20", "min_range_width_bps": 1000, "max_range_width_bps": 2000,
            "min_action_interval_s": "600", "max_actions_per_24h": 6,
            "dust_threshold": [["usdc.test.near", "1000"], ["wrap.test.near", "1000000000000000000"]]
        }
    })
}

pub const ID: &str = "strategy-1.test.near";

/// The deploy N4 describes: one batch signed by the parent, creating, funding, keying, deploying and calling `new`.
pub async fn deploy(
    x: &World,
    bad_hash: bool,
    gas: Gas,
) -> anyhow::Result<(AccountId, ExecutionFinalResult)> {
    let id: AccountId = ID.parse()?;
    // `bad_hash`: uppercase hex, which `new` always refuses (`LIMIT: rules hash`), whatever gate 2
    // decides about attestation (test L5).
    let mut a = args(x.now, x.creator.id(), false);
    if bad_hash {
        a["config"]["rules_hash"] = json!("AB".repeat(32));
    }
    let key = SecretKey::from_random(KeyType::ED25519);
    let r = x
        .root
        .batch(&id)
        .create_account()
        .transfer(NearToken::from_yoctonear(FUNDING))
        .add_key(key.public_key(), AccessKey::full_access())
        .deploy(&read(STRATEGY_WASM))
        .call(Function::new("new").args_json(a).gas(gas))
        .transact()
        .await?;
    Ok((id, r))
}

pub async fn registrations(x: &World, id: &AccountId) -> anyhow::Result<Value> {
    Ok(x.w.view(id, "get_registrations").await?.json()?)
}

pub async fn storage_of(x: &World, contract: &str, who: &AccountId) -> anyhow::Result<Value> {
    Ok(x.w
        .view(&contract.parse()?, "storage_balance_of")
        .args_json(json!({"account_id": who}))
        .await?
        .json()?)
}

pub async fn balance(x: &World, who: &AccountId) -> anyhow::Result<u128> {
    Ok(x.w.view_account(who).await?.balance.as_yoctonear())
}

/// Everything a refused call must leave unchanged (F6): the registrations, the status, and what
/// DCL and the tokens hold for it. The strategy's NEAR isn't compared: a refused call still earns it
/// a share of the gas it burnt (contract rewards); no deposit can leave it without a storage change.
pub async fn snapshot(x: &World, id: &AccountId) -> anyhow::Result<Value> {
    Ok(json!({
        "regs": registrations(x, id).await?,
        "status": x.w.view(id, "get_status").await?.json::<Value>()?,
        "dcl": storage_of(x, DCL, id).await?,
        "usdc": storage_of(x, USDC, id).await?,
        "wrap": storage_of(x, WRAP, id).await?,
    }))
}

/// The strategy's `poolside` events, in order, as their (event, data) pairs.
pub fn events(r: &ExecutionFinalResult) -> Vec<(String, Value)> {
    r.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|v| v["standard"] == "poolside")
        .map(|v| {
            (
                v["event"].as_str().unwrap().to_string(),
                v["data"][0].clone(),
            )
        })
        .collect()
}

/// The full event list of a deploy batch (test L2): `new`, the three starts in launch order, then
/// one `registration` per target (callbacks may land in any order) with `base_ok` for the base token.
pub fn assert_deploy_events(r: &ExecutionFinalResult, creator: &AccountId, base_ok: bool) {
    let ev = events(r);
    assert_eq!(ev.len(), 7, "{ev:?}");
    assert_eq!(
        ev[0],
        (
            "new".into(),
            json!({"creator": creator, "rules_hash": "ab".repeat(32)})
        )
    );
    let targets = ["QuoteToken", "BaseToken", "DclStorage"];
    for (i, t) in targets.iter().enumerate() {
        assert_eq!(
            ev[1 + i],
            (
                "registration_started".into(),
                json!({"target": t, "nonce": 1, "check_only": false})
            )
        );
    }
    let mut done: Vec<String> = ev[4..].iter().map(|e| format!("{e:?}")).collect();
    let mut want: Vec<String> = targets
        .iter()
        .map(|t| {
            let ok = *t != "BaseToken" || base_ok;
            format!(
                "{:?}",
                (
                    "registration".to_string(),
                    json!({"target": t, "nonce": 1, "check_only": false, "ok": ok})
                )
            )
        })
        .collect();
    done.sort();
    want.sort();
    assert_eq!(done, want);
}

/// The receipt outcomes run on `executor`.
pub fn on<'a>(r: &'a ExecutionFinalResult, executor: &str) -> Vec<&'a ExecutionOutcome> {
    r.receipt_outcomes()
        .iter()
        .filter(|o| o.executor_id.as_str() == executor)
        .collect()
}

/// The one receipt on `executor` that ran a function (it burnt more than a refund's receipt does).
pub fn call_on<'a>(r: &'a ExecutionFinalResult, executor: &str) -> &'a ExecutionOutcome {
    let v: Vec<_> = on(r, executor)
        .into_iter()
        .filter(|o| o.gas_burnt.as_gas() > TGAS / 2)
        .collect();
    assert_eq!(v.len(), 1, "{executor}: {v:?}");
    v[0]
}

pub fn tgas(g: u64) -> f64 {
    g as f64 / 1e12
}

pub fn gas_report(label: &str, r: &ExecutionFinalResult) {
    for o in r.receipt_outcomes() {
        println!(
            "GAS {label}: {} burnt {:.3} Tgas",
            o.executor_id,
            tgas(o.gas_burnt.as_gas())
        );
    }
}

/// The callbacks' outcomes: the strategy receipts that logged a `registration` event.
pub fn callbacks<'a>(r: &'a ExecutionFinalResult, id: &str) -> Vec<&'a ExecutionOutcome> {
    on(r, id)
        .into_iter()
        .filter(|o| {
            o.logs
                .iter()
                .any(|l| l.contains("\"event\":\"registration\""))
        })
        .collect()
}

/// One native USDC multisig action: created by `usdc_admin`, approved by both, executed.
async fn usdc_multisig(x: &World, id: u64, action: Value) -> anyhow::Result<()> {
    let usdc: AccountId = USDC.parse()?;
    x.usdc_admin
        .call(&usdc, "create_multisig_request")
        .args_json(json!({ "action": action }))
        .transact()
        .await?
        .into_result()?;
    // One approval isn't enough (gate 3 Part G): execution fails until the second.
    x.usdc_admin
        .call(&usdc, "approve_multisig_request")
        .args_json(json!({ "request_id": id }))
        .transact()
        .await?
        .into_result()?;
    let early = x
        .usdc_admin
        .call(&usdc, "execute_multisig_request")
        .args_json(json!({ "request_id": id }))
        .transact()
        .await?;
    assert!(
        format!("{:?}", early.failures())
            .contains("InsufficientApprovals { current: 1, required: 2 }"),
        "{:?}",
        early.failures()
    );
    for a in [&x.usdc_admin2] {
        a.call(&usdc, "approve_multisig_request")
            .args_json(json!({ "request_id": id }))
            .transact()
            .await?
            .into_result()?;
    }
    x.usdc_admin
        .call(&usdc, "execute_multisig_request")
        .args_json(json!({ "request_id": id }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Makes `usdc_admin` a minter with a large allowance (gate 3 Part G): two master minters
/// configure two controllers for it, then both controllers approve the allowance. Call once.
pub async fn enable_usdc_minting(x: &World) -> anyhow::Result<()> {
    let a = x.usdc_admin.id();
    let b = x.usdc_admin2.id();
    usdc_multisig(
        x,
        0,
        json!({"ConfigureController": {"controller_id": a, "minter_id": a}}),
    )
    .await?;
    usdc_multisig(
        x,
        1,
        json!({"ConfigureController": {"controller_id": b, "minter_id": a}}),
    )
    .await?;
    usdc_multisig(x, 2, json!({"ConfigureMinterAllowance": {"controller_id": a, "minter_allowance": "1000000000000000"}})).await?;
    Ok(())
}

/// Registers `to` at `token` (0.00125 NEAR, the bound).
pub async fn register(_x: &World, token: &str, to: &Account) -> anyhow::Result<()> {
    to.call(&token.parse()?, "storage_deposit")
        .args_json(json!({ "account_id": to.id(), "registration_only": true }))
        .deposit(NearToken::from_yoctonear(TOKEN_STORAGE))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Mints `amount` native USDC to `to` (registered first). Needs `enable_usdc_minting`.
pub async fn mint_usdc(x: &World, to: &Account, amount: u128) -> anyhow::Result<()> {
    register(x, USDC, to).await?;
    x.usdc_admin
        .call(&USDC.parse()?, "mint")
        .args_json(json!({ "to": to.id(), "amount": amount.to_string() }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// `who`'s balance of `token`, parsed from the token's own answer.
pub async fn ft_balance(x: &World, token: &str, who: &AccountId) -> anyhow::Result<u128> {
    let v: String =
        x.w.view(&token.parse()?, "ft_balance_of")
            .args_json(json!({ "account_id": who }))
            .await?
            .json()?;
    Ok(v.parse()?)
}

pub async fn transfer_call(
    from: &Account,
    token: &str,
    to: &AccountId,
    amount: u128,
    msg: &str,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(from
        .call(&token.parse()?, "ft_transfer_call")
        .args_json(json!({"receiver_id": to, "amount": amount.to_string(), "msg": msg}))
        .deposit(NearToken::from_yoctonear(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

pub async fn view(x: &World, id: &AccountId, m: &str) -> anyhow::Result<Value> {
    Ok(x.w.view(id, m).await?.json()?)
}

/// The strategy's receipt that logged `event`, and that event's data.
pub fn receipt_with(r: &ExecutionFinalResult, id: &str, event: &str) -> (u64, Value) {
    let v: Vec<(u64, Value)> = on(r, id)
        .into_iter()
        .filter_map(|o| {
            o.logs.iter().find_map(|l| {
                let e: Value = serde_json::from_str(l.strip_prefix("EVENT_JSON:")?).ok()?;
                (e["event"] == event).then(|| (o.gas_burnt.as_gas(), e["data"][0].clone()))
            })
        })
        .collect();
    assert_eq!(v.len(), 1, "{event}: {v:?}");
    v[0].clone()
}

/// Brings a deployed strategy to `Running` on the real pool and tokens: mints and funds the cap,
/// registers the creator at wrap and the platform account (created here) at both tokens, creates
/// the USDC/wNEAR fee-100 pool at the live point, and starts. Returns the strategy's id.
pub async fn running(x: &World) -> anyhow::Result<AccountId> {
    let (id, r) = deploy(x, false, Gas::from_gas(200 * TGAS)).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    enable_usdc_minting(x).await?;
    mint_usdc(x, &x.creator, 600_000_000).await?;
    register(x, WRAP, &x.creator).await?;
    let platform = account(&x.root, "platform").await?;
    register(x, USDC, &platform).await?;
    register(x, WRAP, &platform).await?;
    x.usdc_admin
        .call(&DCL.parse::<AccountId>()?, "create_pool")
        .args_json(json!({"token_a": USDC, "token_b": WRAP, "fee": 100, "init_point": 401_312}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let r = transfer_call(&x.creator, USDC, &id, 500_000_000, "fund").await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let r = x
        .creator
        .call(&id, "start")
        .args_json(json!({"expected_point": 401_312}))
        .gas(Gas::from_gas(200 * TGAS))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(view(x, &id, "get_status").await?, json!("Running"));
    Ok(id)
}

/// Sets `fees_collected` (quote token) in a strategy with an empty rate-stamp list by patching its
/// state, as nothing in this build can raise it (the trading slices will). The field sits before
/// `paid_platform` (32), `withdraw_failures` (34), `claim_in_flight` (1) and the stamp list (4).
pub async fn patch_fees(x: &World, id: &AccountId, fees_quote: u128) -> anyhow::Result<()> {
    let state = x.w.view_state(id).prefix(b"STATE").await?;
    let mut bytes = state.get(b"STATE".as_slice()).expect("STATE").clone();
    let n = bytes.len();
    assert_eq!(
        &bytes[n - 4..],
        &[0u8; 4],
        "a rate-stamp list is empty only before any settle"
    );
    let at = n - (32 + 34 + 1 + 4) - 32;
    assert_eq!(
        &bytes[at..at + 32],
        &[0u8; 32],
        "fees_collected starts at zero"
    );
    bytes[at..at + 16].copy_from_slice(&fees_quote.to_le_bytes());
    x.w.patch_state(id, b"STATE", &bytes).await?;
    Ok(())
}

/// Sets `closed_at_ns` (an `Option<u64>`) of a `Closed` strategy whose rate-stamp list holds
/// exactly `stamps` entries (11 bytes each, after the 4-byte length), by patching its state, so a
/// platform window that the sandbox clock cannot reach has passed. Fields after `closed_at_ns`:
/// `settle_until_block` 8, `last_payout_callback_block` 8, the window class 1, `fees_collected` 32,
/// `paid_platform` 32, `withdraw_failures` 34, `claim_in_flight` 1, then the stamps.
pub async fn patch_closed_at(
    x: &World,
    id: &AccountId,
    closed_at_ns: u64,
    stamps: usize,
) -> anyhow::Result<()> {
    let state = x.w.view_state(id).prefix(b"STATE").await?;
    let mut bytes = state.get(b"STATE".as_slice()).expect("STATE").clone();
    let n = bytes.len();
    let after = 8 + 8 + 1 + 32 + 32 + 34 + 1 + 4 + 11 * stamps;
    let at = n - after - 9;
    assert_eq!(bytes[at], 1, "closed_at_ns is Some after settle");
    assert_eq!(
        u32::from_le_bytes(bytes[n - 11 * stamps - 4..n - 11 * stamps].try_into()?),
        stamps as u32
    );
    bytes[at + 1..at + 9].copy_from_slice(&closed_at_ns.to_le_bytes());
    x.w.patch_state(id, b"STATE", &bytes).await?;
    Ok(())
}

/// Puts liquidity in the pool so a swap can run: an LP account registers both tokens at DCL (0.01
/// NEAR each, returned), deposits USDC and wNEAR, and adds a position around the live point.
/// `usdc` raw units of token_x and `wnear` yocto of token_y are deposited; the range is +-5,000
/// points around `point`. Returns nothing the tests need beyond the pool now having depth.
pub async fn seed_pool(x: &World, point: i64, usdc: u128, wnear: u128) -> anyhow::Result<()> {
    let dcl: AccountId = DCL.parse()?;
    // The LP needs NEAR to wrap for the wNEAR side (the default test accounts hold 30).
    let lp = x
        .root
        .create_subaccount("lp")
        .initial_balance(NearToken::from_near(40_000))
        .transact()
        .await?
        .into_result()?;
    mint_usdc(x, &lp, usdc).await?;
    register(x, WRAP, &lp).await?;
    for t in [USDC, WRAP] {
        // DCL itself must be registered at each token before it can be sent tokens.
        x.root
            .call(&t.parse()?, "storage_deposit")
            .args_json(json!({"account_id": dcl, "registration_only": true}))
            .deposit(NearToken::from_millinear(10))
            .transact()
            .await?
            .into_result()?;
    }
    lp.call(&dcl, "storage_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_near(2))
        .transact()
        .await?
        .into_result()?;
    lp.call(&dcl, "register_tokens")
        .args_json(json!({"token_ids": [USDC, WRAP]}))
        .deposit(NearToken::from_millinear(20))
        .transact()
        .await?
        .into_result()?;
    lp.call(&WRAP.parse()?, "near_deposit")
        .deposit(NearToken::from_yoctonear(wnear))
        .transact()
        .await?
        .into_result()?;
    for (t, a) in [(USDC, usdc), (WRAP, wnear)] {
        let r = transfer_call(&lp, t, &dcl, a, "\"Deposit\"").await?;
        assert!(r.is_success(), "{:?}", r.failures());
    }
    let r = lp
        .call(&dcl, "add_liquidity")
        .args_json(json!({
            "pool_id": format!("{USDC}|{WRAP}|100"),
            "left_point": point - 5_000,
            "right_point": point + 5_000,
            "amount_x": usdc.to_string(),
            "amount_y": wnear.to_string(),
            "min_amount_x": "0",
            "min_amount_y": "0",
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    Ok(())
}
