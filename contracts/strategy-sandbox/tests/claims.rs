//! Slice 6: `exit_withdraw`, `claim_platform` and `claim_creator` on the real wasm against native
//! USDC and the pinned DCL (EC-C169's sandbox items; gate 3 Part K). `fees_collected` can't be raised
//! by anything in this build, so it is set by patching the state of a `Running` strategy (the
//! platform's cut is a twentieth of it); the trading slices will raise it for real.
mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::AccountId;
use serde_json::{json, Value};

const MIN_GAS_CLAIM: u64 = 180 * TGAS;
const MIN_GAS_SETTLE: u64 = 80 * TGAS;
const MIN_GAS_EXIT: u64 = 180 * TGAS;
const GAS_CLAIM_READ_CB: u64 = 100 * TGAS;
const GAS_CALLBACK: u64 = 10 * TGAS;
const GAS_FT_TRANSFER: u64 = 20 * TGAS;
const GAS_VIEW: u64 = 10 * TGAS;
const CAP: u128 = 500_000_000;
const FEES: u128 = 20_000_000; // owed to the platform: 1_000_000 (1 USDC)

async fn close_and_settle(x: &World, id: &AccountId) -> anyhow::Result<()> {
    x.creator
        .call(id, "close")
        .transact()
        .await?
        .into_result()?;
    let outsider = account(&x.root, "outsider").await?;
    let r = outsider
        .call(id, "settle")
        .gas(Gas::from_gas(MIN_GAS_SETTLE))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(view(x, id, "get_status").await?, json!("Closed"));
    Ok(())
}

async fn claim(
    x: &World,
    caller: &near_workspaces::Account,
    id: &AccountId,
    m: &str,
    gas: u64,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(caller
        .call(id, m)
        .args_json(json!({"token": USDC}))
        .gas(Gas::from_gas(gas))
        .transact()
        .await
        .map(|r| {
            let _ = x;
            r
        })?)
}

/// `exit_withdraw` on the real DCL with nothing in the account: the creator may call it while
/// `Running`; it reads `{}` and writes only an event; no window opens; an outsider is refused until
/// the grace period; one gas unit below the minimum is refused.
#[tokio::test]
async fn exit_withdraw_with_nothing_to_withdraw() -> anyhow::Result<()> {
    let x = world(true).await?;
    let id = running(&x).await?;
    let ids = id.as_str();
    let outsider = account(&x.root, "outsider").await?;
    let r = outsider
        .call(&id, "exit_withdraw")
        .args_json(json!({"token": USDC}))
        .gas(Gas::from_gas(MIN_GAS_EXIT))
        .transact()
        .await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: exit not open yet"),
        "{:?}",
        r.failures()
    );
    let r = x
        .creator
        .call(&id, "exit_withdraw")
        .args_json(json!({"token": USDC}))
        .gas(Gas::from_gas(MIN_GAS_EXIT - 1))
        .transact()
        .await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: gas"));
    let r = x
        .creator
        .call(&id, "exit_withdraw")
        .args_json(json!({"token": USDC}))
        .gas(Gas::from_gas(MIN_GAS_EXIT))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("exit_withdraw", &r);
    let e = receipt_with(&r, ids, "exit_withdraw").1;
    assert_eq!(
        (e["ok"].as_bool(), e["reason"].as_str()),
        (Some(false), Some("LIMIT: nothing to withdraw")),
        "{e}"
    );
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    assert_eq!(
        view(&x, &id, "get_settle_window").await?["settle_until_block"],
        "0"
    );
    for g in on(&r, DCL)
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .filter(|g| *g > TGAS / 10)
    {
        assert!(g < GAS_VIEW / 2, "DCL read burnt {g}");
    }
    // The same call again inside the interval is rate limited, for the same class and token.
    let r = x
        .creator
        .call(&id, "exit_withdraw")
        .args_json(json!({"token": USDC}))
        .gas(Gas::from_gas(MIN_GAS_EXIT))
        .transact()
        .await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: rate limited"));
    Ok(())
}

/// The full claim path on native USDC: the platform's cut first, then the creator's rest, from the
/// real wallet balance, each transfer and callback under half its fixed gas.
#[tokio::test]
async fn claims_pay_the_platform_then_the_creator() -> anyhow::Result<()> {
    let x = world(true).await?;
    let id = running(&x).await?;
    let ids = id.as_str();
    patch_fees(&x, &id, FEES).await?;
    assert_eq!(
        view(&x, &id, "get_fees_collected").await?,
        json!({"quote": FEES.to_string(), "base": "0"})
    );
    close_and_settle(&x, &id).await?;
    let platform: AccountId = "platform.test.near".parse()?;
    let before_creator = ft_balance(&x, USDC, x.creator.id()).await?;
    assert_eq!(ft_balance(&x, USDC, &id).await?, CAP);

    // The creator waits for the platform's window while it is owed something.
    let r = claim(&x, &x.creator, &id, "claim_creator", MIN_GAS_CLAIM).await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: platform window"),
        "{:?}",
        r.failures()
    );
    // Only the creator may claim the creator's share.
    let outsider = account(&x.root, "claimer").await?;
    let r = claim(&x, &outsider, &id, "claim_creator", MIN_GAS_CLAIM).await?;
    assert!(format!("{:?}", r.failures()).contains("AUTH: creator only"));
    // An outsider's platform claim: one gas unit below refused; at the minimum it pays the owed amount.
    let r = claim(&x, &outsider, &id, "claim_platform", MIN_GAS_CLAIM - 1).await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: gas"));
    let r = claim(&x, &outsider, &id, "claim_platform", MIN_GAS_CLAIM).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("claim_platform", &r);
    let e = receipt_with(&r, ids, "claim").1;
    assert_eq!(
        (e["leg"].as_str(), e["amount"].as_str(), e["ok"].as_bool()),
        (Some("platform"), Some("1000000"), Some(true)),
        "{e}"
    );
    assert_eq!(ft_balance(&x, USDC, &platform).await?, 1_000_000);
    assert_eq!(ft_balance(&x, USDC, &id).await?, CAP - 1_000_000);
    assert_eq!(
        view(&x, &id, "get_paid_platform").await.err().map(|_| ()),
        Some(()),
        "views take their argument"
    );
    let paid: Value =
        x.w.view(&id, "get_paid_platform")
            .args_json(json!({"token": USDC}))
            .await?
            .json()?;
    assert_eq!(paid, "1000000");
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    // Each receipt under half its fixed gas.
    for o in on(&r, USDC)
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .filter(|g| *g > TGAS / 10)
    {
        assert!(
            o < GAS_VIEW.max(GAS_FT_TRANSFER) / 2,
            "USDC receipt burnt {o}"
        );
    }
    let (cb, _) = receipt_with(&r, ids, "claim");
    assert!(cb < GAS_CALLBACK / 2, "leg callback burnt {cb}");
    // The platform is owed nothing now: a second platform claim is `nothing owed`.
    let r = claim(&x, &outsider, &id, "claim_platform", MIN_GAS_CLAIM).await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: rate limited"),
        "the same class inside the interval"
    );
    let r = claim(&x, &x.creator, &id, "claim_platform", MIN_GAS_CLAIM).await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: nothing owed"));

    // With nothing owed the creator may claim before the window, and gets the whole wallet.
    let r = claim(&x, &x.creator, &id, "claim_creator", MIN_GAS_CLAIM).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("claim_creator", &r);
    let e = receipt_with(&r, ids, "claim").1;
    assert_eq!(
        (e["leg"].as_str(), e["ok"].as_bool()),
        (Some("creator"), Some(true)),
        "{e}"
    );
    assert_eq!(ft_balance(&x, USDC, &id).await?, 0);
    assert_eq!(
        ft_balance(&x, USDC, x.creator.id()).await?,
        before_creator + CAP - 1_000_000
    );
    // The same class and token again inside the interval is rate limited.
    let r = claim(&x, &x.creator, &id, "claim_creator", MIN_GAS_CLAIM).await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: rate limited"));
    Ok(())
}

/// A platform that can't receive USDC (blocklisted): its transfer fails on the real token, the
/// share stays in the wallet and owed (`paid_platform` restored), and the creator is still paid
/// `wallet - owed` in the same claim. After unblocklisting, the platform's own claim pays it.
#[tokio::test]
async fn a_blocklisted_platform_keeps_its_share_reserved() -> anyhow::Result<()> {
    let x = world(true).await?;
    let id = running(&x).await?;
    let ids = id.as_str();
    patch_fees(&x, &id, FEES).await?;
    close_and_settle(&x, &id).await?;
    let platform: AccountId = "platform.test.near".parse()?;
    let usdc: AccountId = USDC.parse()?;
    x.usdc_admin
        .call(&usdc, "blocklist")
        .args_json(json!({"account_id": platform}))
        .transact()
        .await?
        .into_result()?;
    let before_creator = ft_balance(&x, USDC, x.creator.id()).await?;

    // Past the window the creator claims: the platform leg fails, the creator leg succeeds.
    // The sandbox clock can't be moved, so the window is reached by a zero-owed claim instead:
    // first the outsider's platform claim, which fails on the blocklist.
    let outsider = account(&x.root, "claimer").await?;
    let r = claim(&x, &outsider, &id, "claim_platform", MIN_GAS_CLAIM).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let e = receipt_with(&r, ids, "claim").1;
    assert_eq!(
        (e["leg"].as_str(), e["ok"].as_bool()),
        (Some("platform"), Some(false)),
        "{e}"
    );
    assert_eq!(ft_balance(&x, USDC, &platform).await?, 0);
    assert_eq!(
        ft_balance(&x, USDC, &id).await?,
        CAP,
        "nothing left the strategy"
    );
    let paid: Value =
        x.w.view(&id, "get_paid_platform")
            .args_json(json!({"token": USDC}))
            .await?
            .json()?;
    assert_eq!(paid, "0", "restored");
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    assert_eq!(view(&x, &id, "get_claim_in_flight").await?, Value::Null);
    // The creator still waits for the window (the platform is owed), so she can't take its share.
    let r = claim(&x, &x.creator, &id, "claim_creator", MIN_GAS_CLAIM).await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: platform window"));
    assert_eq!(ft_balance(&x, USDC, x.creator.id()).await?, before_creator);
    // Unblocklisted, the creator's own platform claim (a different class slot) pays it.
    x.usdc_admin
        .call(&usdc, "unblocklist")
        .args_json(json!({"account_id": platform}))
        .transact()
        .await?
        .into_result()?;
    let r = claim(&x, &x.creator, &id, "claim_platform", MIN_GAS_CLAIM).await?;
    let e = receipt_with(&r, ids, "claim").1;
    assert_eq!(
        (e["leg"].as_str(), e["ok"].as_bool()),
        (Some("platform"), Some(true)),
        "{e}"
    );
    assert_eq!(ft_balance(&x, USDC, &platform).await?, 1_000_000);
    Ok(())
}

/// Both legs in one callback, on chain (contract review L3): with the platform window passed (the
/// sandbox clock can't reach it, so `closed_at_ns` is patched to the epoch) and the platform owed
/// 1 USDC, one `claim_creator` sends the platform's 1,000,000 and the creator's 499,000,000 from
/// one wallet read, in two transfers, and the lock is released when both have reported.
#[tokio::test]
async fn claim_creator_sends_both_legs_from_one_read() -> anyhow::Result<()> {
    let x = world(true).await?;
    let id = running(&x).await?;
    let ids = id.as_str();
    patch_fees(&x, &id, FEES).await?;
    close_and_settle(&x, &id).await?;
    let platform: AccountId = "platform.test.near".parse()?;
    let before_creator = ft_balance(&x, USDC, x.creator.id()).await?;
    // Still inside the window: refused.
    let r = claim(&x, &x.creator, &id, "claim_creator", MIN_GAS_CLAIM).await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: platform window"));
    patch_closed_at(&x, &id, 0, 1).await?;
    let r = claim(&x, &x.creator, &id, "claim_creator", MIN_GAS_CLAIM).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("claim_creator (two legs)", &r);
    let mut legs: Vec<(String, String, bool)> = on(&r, ids)
        .iter()
        .flat_map(|o| o.logs.iter())
        .filter_map(|l| serde_json::from_str::<Value>(l.strip_prefix("EVENT_JSON:")?).ok())
        .filter(|e| e["event"] == "claim")
        .map(|e| {
            let d = &e["data"][0];
            (
                d["leg"].as_str().unwrap().to_string(),
                d["amount"].as_str().unwrap().to_string(),
                d["ok"].as_bool().unwrap(),
            )
        })
        .collect();
    legs.sort();
    assert_eq!(
        legs,
        vec![
            ("creator".to_string(), "499000000".to_string(), true),
            ("platform".to_string(), "1000000".to_string(), true)
        ]
    );
    assert_eq!(ft_balance(&x, USDC, &platform).await?, 1_000_000);
    assert_eq!(
        ft_balance(&x, USDC, x.creator.id()).await?,
        before_creator + 499_000_000
    );
    assert_eq!(ft_balance(&x, USDC, &id).await?, 0);
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    assert_eq!(view(&x, &id, "get_claim_in_flight").await?, Value::Null);
    // The balance callback started two transfers and burnt far less than its fixed 100 Tgas.
    for g in on(&r, ids)
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .filter(|g| *g > TGAS / 2)
    {
        assert!(g < GAS_CLAIM_READ_CB / 2, "a strategy receipt burnt {g}");
    }
    Ok(())
}
