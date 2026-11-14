//! Slice 3b: funding, `cancel` and `withdraw` on the real wasm, against native USDC's and
//! wrap.near's mainnet code (EC-C03, EC-C46, EC-C134 and EC-C166's sandbox items; test audit M3,
//! security U-1 to U-3). Every fact gate 3 Part G records is asserted here; figures only printed
//! are marked so there.
mod common;
use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};

/// The contract's slice 3 constants.
const QUIET_INBOUND_BLOCKS: u64 = 40;
const MIN_GAS_WITHDRAW: u64 = 100 * TGAS;
const GAS_VIEW: u64 = 10 * TGAS;
const GAS_FT_TRANSFER: u64 = 20 * TGAS;
const GAS_ON_BALANCE: u64 = 50 * TGAS;
const GAS_CALLBACK: u64 = 10 * TGAS;
const CAP: u128 = 500_000_000; // max_principal in `args`: 500 USDC
const MINTED: u128 = 600_000_000;

async fn withdraw(
    x: &World,
    id: &AccountId,
    token: &str,
    gas: u64,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(x.creator
        .call(id, "withdraw")
        .args_json(json!({ "token": token }))
        .gas(Gas::from_gas(gas))
        .transact()
        .await?)
}

/// EC-C03, EC-C134 sandbox: the creator's `fund` through native USDC's real `ft_transfer_call`
/// credits exactly the cap and the token refunds the excess; a 4 KB `msg` and an outsider's
/// wNEAR are refunded in full; `ft_on_transfer` burns under a 5 Tgas ceiling.
/// EC-C46, EC-C166 sandbox: after `cancel`, `withdraw` waits `QUIET_INBOUND_BLOCKS`, is refused one
/// gas unit below `MIN_GAS_WITHDRAW`, and at it pays the creator exactly the balance, each receipt
/// under half its fixed gas; a zero balance sends nothing; a kept wNEAR transfer paid to an
/// unregistered creator fails at the token and stays in the strategy, then is paid once the
/// creator registers.
#[tokio::test]
async fn fund_cancel_and_withdraw_on_real_tokens() -> anyhow::Result<()> {
    let x = world(true).await?;
    let (id, r) = deploy(&x, false, Gas::from_gas(200 * TGAS)).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    enable_usdc_minting(&x).await?;
    mint_usdc(&x, &x.creator, MINTED).await?;
    let ids = id.as_str();

    // Fund one above the cap: exactly the cap credited, 1 refunded by the token.
    let r = transfer_call(&x.creator, USDC, &id, CAP + 1, "fund").await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let (gas, d) = receipt_with(&r, ids, "inbound");
    assert_eq!(
        (d["credited"].as_str(), d["returned"].as_str()),
        (Some("500000000"), Some("1"))
    );
    println!("GAS ft_on_transfer (fund): {:.3} Tgas", tgas(gas));
    assert!(gas < 5 * TGAS, "ft_on_transfer burnt {gas}");
    assert_eq!(
        view(&x, &id, "get_principal").await?,
        json!(CAP.to_string())
    );
    assert_eq!(ft_balance(&x, USDC, x.creator.id()).await?, MINTED - CAP);
    assert_eq!(ft_balance(&x, USDC, &id).await?, CAP);

    // A 4 KB msg: refunded in full, under the same ceiling.
    let r = transfer_call(&x.creator, USDC, &id, 10, &"f".repeat(4_096)).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let (gas, d) = receipt_with(&r, ids, "inbound");
    assert_eq!(d["returned"], "10");
    println!("GAS ft_on_transfer (4 KB msg): {:.3} Tgas", tgas(gas));
    assert!(gas < 5 * TGAS, "4 KB msg burnt {gas}");
    assert_eq!(ft_balance(&x, USDC, x.creator.id()).await?, MINTED - CAP);

    // An outsider's wNEAR with msg "fund" in Open: refunded in full.
    let outsider = account(&x.root, "outsider").await?;
    register(&x, WRAP, &outsider).await?;
    outsider
        .call(&WRAP.parse()?, "near_deposit")
        .deposit(NearToken::from_near(2))
        .transact()
        .await?
        .into_result()?;
    let r = transfer_call(&outsider, WRAP, &id, NEAR, "fund").await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(
        receipt_with(&r, ids, "inbound").1["returned"],
        NEAR.to_string()
    );
    assert_eq!(ft_balance(&x, WRAP, outsider.id()).await?, 2 * NEAR);
    assert_eq!(ft_balance(&x, WRAP, &id).await?, 0);
    let refund_block: u64 = view(&x, &id, "get_last_inbound_block")
        .await?
        .as_str()
        .unwrap()
        .parse()?;

    // Cancel, then withdraw too early.
    x.creator
        .call(&id, "cancel")
        .transact()
        .await?
        .into_result()?;
    assert_eq!(view(&x, &id, "get_status").await?, json!("Cancelled"));
    // The refund set last_inbound_block at its own block (test audit 3b M1): unconditional.
    let now = x.w.view_block().await?.height();
    assert!(
        refund_block > 0 && refund_block <= now,
        "{refund_block} {now}"
    );
    assert!(
        now + 1 < refund_block + QUIET_INBOUND_BLOCKS,
        "{refund_block} {now}"
    );
    let r = withdraw(&x, &id, USDC, MIN_GAS_WITHDRAW).await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: inbound transfer settling"),
        "{:?}",
        r.failures()
    );
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    assert_eq!(ft_balance(&x, USDC, &id).await?, CAP);
    assert_eq!(ft_balance(&x, USDC, x.creator.id()).await?, MINTED - CAP);
    x.w.fast_forward(QUIET_INBOUND_BLOCKS).await?;

    // One gas unit below MIN_GAS_WITHDRAW: refused, nothing changed.
    let r = withdraw(&x, &id, USDC, MIN_GAS_WITHDRAW - 1).await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: gas"));
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);

    // Native USDC with the creator blocklisted (security audit 3b L4, T27/M10): the transfer
    // fails at the token, the USDC stays, the lock is released; after unblocklisting it is paid.
    let usdc_id: AccountId = USDC.parse()?;
    x.usdc_admin
        .call(&usdc_id, "blocklist")
        .args_json(json!({ "account_id": x.creator.id() }))
        .transact()
        .await?
        .into_result()?;
    let r = withdraw(&x, &id, USDC, MIN_GAS_WITHDRAW).await?;
    let d = receipt_with(&r, ids, "withdraw").1;
    assert_eq!(
        (d["ok"].as_bool(), d["amount"].as_str()),
        (Some(false), Some("500000000")),
        "{d}"
    );
    assert!(
        on(&r, USDC)
            .iter()
            .any(|o| (*o).clone().into_result().is_err()),
        "a failed USDC receipt"
    );
    assert_eq!(ft_balance(&x, USDC, &id).await?, CAP);
    assert_eq!(ft_balance(&x, USDC, x.creator.id()).await?, MINTED - CAP);
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    x.usdc_admin
        .call(&usdc_id, "unblocklist")
        .args_json(json!({ "account_id": x.creator.id() }))
        .transact()
        .await?
        .into_result()?;

    // At MIN_GAS_WITHDRAW: the whole balance to the creator.
    let r = withdraw(&x, &id, USDC, MIN_GAS_WITHDRAW).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("withdraw", &r);
    let (g_start, _) = receipt_with(&r, ids, "withdraw_started");
    let (g_done, d) = receipt_with(&r, ids, "withdraw");
    assert_eq!(
        d,
        json!({"op_id": "1", "token": USDC, "amount": CAP.to_string(), "ok": true})
    );
    assert_eq!(ft_balance(&x, USDC, x.creator.id()).await?, MINTED);
    assert_eq!(ft_balance(&x, USDC, &id).await?, 0);
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    // Each receipt under half its fixed gas: the view, the balance callback (the one strategy
    // receipt with no event), the transfer and its callback.
    let usdc: Vec<u64> = on(&r, USDC)
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .filter(|g| *g > TGAS / 2)
        .collect();
    assert_eq!(usdc.len(), 2, "{usdc:?}"); // ft_balance_of, ft_transfer
    assert!(
        usdc[0] < GAS_VIEW / 2 && usdc[1] < GAS_FT_TRANSFER / 2,
        "{usdc:?}"
    );
    let strategy: Vec<u64> = on(&r, ids)
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .filter(|g| *g > TGAS / 2)
        .collect();
    assert_eq!(strategy.len(), 3, "{strategy:?}"); // withdraw, on_withdraw_balance, on_withdrawn
    assert!(strategy[1] < GAS_ON_BALANCE / 2, "{strategy:?}");
    assert!(g_done < GAS_CALLBACK / 2, "{g_done}");
    println!("GAS withdraw own receipt: {:.3} Tgas", tgas(g_start));

    // A zero balance: nothing sent.
    let r = withdraw(&x, &id, WRAP, MIN_GAS_WITHDRAW).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let d = receipt_with(&r, ids, "withdraw").1;
    assert_eq!(
        (d["reason"].as_str(), d["ok"].as_bool()),
        (Some("nothing to withdraw"), Some(false))
    );
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    assert!(on(&r, WRAP).len() == 1, "only the balance read");

    // In Cancelled, wNEAR is kept; the creator isn't registered at wrap, so the transfer fails at
    // the token and the wNEAR stays; after registering, the next withdraw pays it.
    let r = transfer_call(&outsider, WRAP, &id, NEAR, "").await?;
    assert!(r.is_success());
    assert_eq!(receipt_with(&r, ids, "inbound").1["returned"], "0");
    assert_eq!(ft_balance(&x, WRAP, &id).await?, NEAR);
    assert_eq!(
        view(&x, &id, "get_principal").await?,
        json!(CAP.to_string())
    );
    assert_eq!(
        view(&x, &id, "get_last_inbound_block").await?,
        json!(refund_block.to_string())
    );
    let r = withdraw(&x, &id, WRAP, MIN_GAS_WITHDRAW).await?;
    let d = receipt_with(&r, ids, "withdraw").1;
    assert_eq!(d["ok"], false, "{d}");
    assert_eq!(d["amount"], NEAR.to_string());
    assert!(!r.failures().is_empty(), "the wrap transfer receipt failed");
    assert_eq!(ft_balance(&x, WRAP, &id).await?, NEAR);
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    register(&x, WRAP, &x.creator).await?;
    let r = withdraw(&x, &id, WRAP, MIN_GAS_WITHDRAW).await?;
    assert_eq!(receipt_with(&r, ids, "withdraw").1["ok"], true);
    assert_eq!(ft_balance(&x, WRAP, x.creator.id()).await?, NEAR);
    assert_eq!(ft_balance(&x, WRAP, &id).await?, 0);
    Ok(())
}
