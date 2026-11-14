//! Slice 5: `close` and `settle` on the real wasm against the pinned DCL (EC-C168's sandbox
//! items; gate 3 Part I). A started strategy is closed by its creator and settled by an outsider
//! through a real `list_user_assets` read, which answers `{}` for an account with no internal
//! balance.
mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::AccountId;
use serde_json::{json, Value};

const POINT: i64 = 401_312;
const CAP: u128 = 500_000_000;
const MIN_GAS_START: u64 = 200 * TGAS;
const MIN_GAS_SETTLE: u64 = 80 * TGAS;
const GAS_VIEW: u64 = 10 * TGAS;
const GAS_SETTLE_CALLBACK: u64 = 20 * TGAS;

/// EC-C168 sandbox: close and settle on the real DCL and tokens.
#[tokio::test]
async fn close_and_settle_on_the_real_dcl() -> anyhow::Result<()> {
    let x = world(true).await?;
    let (id, r) = deploy(&x, false, Gas::from_gas(200 * TGAS)).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let ids = id.as_str();
    enable_usdc_minting(&x).await?;
    mint_usdc(&x, &x.creator, 600_000_000).await?;
    register(&x, WRAP, &x.creator).await?;
    let platform = account(&x.root, "platform").await?;
    register(&x, USDC, &platform).await?;
    register(&x, WRAP, &platform).await?;
    x.usdc_admin
        .call(&DCL.parse::<AccountId>()?, "create_pool")
        .args_json(json!({"token_a": USDC, "token_b": WRAP, "fee": 100, "init_point": POINT}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let r = transfer_call(&x.creator, USDC, &id, CAP, "fund").await?;
    assert!(r.is_success(), "{:?}", r.failures());

    // Before the run: close and settle are refused by status, on chain.
    let outsider = account(&x.root, "outsider").await?;
    let r = x.creator.call(&id, "close").transact().await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: wrong status"));
    let r = x
        .creator
        .call(&id, "start")
        .args_json(json!({"expected_point": POINT}))
        .gas(Gas::from_gas(MIN_GAS_START))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(view(&x, &id, "get_status").await?, json!("Running"));

    // Running: an outsider can't close before the run ends; settle isn't open yet.
    let r = outsider.call(&id, "close").transact().await?;
    assert!(
        format!("{:?}", r.failures()).contains("AUTH: creator only before run end"),
        "{:?}",
        r.failures()
    );
    let r = outsider
        .call(&id, "settle")
        .gas(Gas::from_gas(MIN_GAS_SETTLE))
        .transact()
        .await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: wrong status"));

    // The creator closes; the event names who and that the run hadn't ended.
    let r = x.creator.call(&id, "close").transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let e = receipt_with(&r, ids, "close").1;
    assert_eq!(
        (e["by"].as_str(), e["after_run_end"].as_bool()),
        (Some(x.creator.id().as_str()), Some(false))
    );
    assert_eq!(view(&x, &id, "get_status").await?, json!("Closing"));
    assert_eq!(view(&x, &id, "get_closed_at").await?, Value::Null);

    // Settle: one gas unit below refused, nothing stamped; at the minimum it closes through a real read.
    let r = outsider
        .call(&id, "settle")
        .gas(Gas::from_gas(MIN_GAS_SETTLE - 1))
        .transact()
        .await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: gas"));
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    let r = outsider
        .call(&id, "settle")
        .gas(Gas::from_gas(MIN_GAS_SETTLE))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("settle", &r);
    let e = receipt_with(&r, ids, "settle").1;
    assert!(e["closed_at_ns"].is_string(), "{e}");
    assert_eq!(view(&x, &id, "get_status").await?, json!("Closed"));
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    assert!(view(&x, &id, "get_closed_at").await?.is_string());
    // The read and the callback under half their budgets.
    for g in on(&r, DCL)
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .filter(|g| *g > TGAS / 10)
    {
        assert!(g < GAS_VIEW / 2, "DCL read burnt {g}");
    }
    let (cb, _) = receipt_with(&r, ids, "settle");
    println!("GAS settle callback: {:.3} Tgas", tgas(cb));
    assert!(cb < GAS_SETTLE_CALLBACK / 2, "callback burnt {cb}");

    // Closed: a second settle and a second close are refused.
    for m in ["settle", "close"] {
        let r = x
            .creator
            .call(&id, m)
            .gas(Gas::from_gas(MIN_GAS_SETTLE))
            .transact()
            .await?;
        assert!(
            format!("{:?}", r.failures()).contains("LIMIT: wrong status"),
            "{m}"
        );
    }
    Ok(())
}
