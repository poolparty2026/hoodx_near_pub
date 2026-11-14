//! Slice 4: `start` on the real wasm against the pinned DCL, native USDC and wrap.near code
//! (EC-C136, EC-C167's sandbox items; gate 3 Part H). The DCL pool is created at the live point
//! (401,312, fee 100) by the DCL owner, as `create_pool` is owner-callable.
mod common;
use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::AccountId;
use serde_json::{json, Value};

const POINT: i64 = 401_312;
const CAP: u128 = 500_000_000;
/// The contract's slice 4 constants.
const MIN_GAS_START: u64 = 200 * TGAS;
const GAS_VIEW: u64 = 10 * TGAS;
const GAS_READ_STORAGE: u64 = 5 * TGAS;
const GAS_START_CALLBACK: u64 = 30 * TGAS;

async fn start(
    x: &World,
    id: &AccountId,
    point: i64,
    gas: u64,
) -> anyhow::Result<ExecutionFinalResult> {
    Ok(x.creator
        .call(id, "start")
        .args_json(json!({ "expected_point": point }))
        .gas(Gas::from_gas(gas))
        .transact()
        .await?)
}

fn start_event(r: &ExecutionFinalResult, id: &str) -> Value {
    receipt_with(r, id, "start").1
}

fn refused_event(r: &ExecutionFinalResult, id: &str) -> Value {
    receipt_with(r, id, "start_refused").1
}

/// EC-C167 sandbox: `start` against the real pool and tokens. Refusals in order on chain; a
/// missing payee, a point past the drift bound and then a good start; the six reads and the
/// callback each burn under half their fixed gas; `Running` afterwards.
#[tokio::test]
async fn start_on_the_real_pool() -> anyhow::Result<()> {
    let x = world(true).await?;
    let (id, r) = deploy(&x, false, Gas::from_gas(200 * TGAS)).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let ids = id.as_str();
    enable_usdc_minting(&x).await?;
    mint_usdc(&x, &x.creator, 600_000_000).await?;
    register(&x, WRAP, &x.creator).await?;
    let dcl: AccountId = DCL.parse()?;
    x.usdc_admin
        .call(&dcl, "create_pool")
        .args_json(json!({"token_a": USDC, "token_b": WRAP, "fee": 100, "init_point": POINT}))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    // Not funded: refused at the first checks, on chain.
    let r = start(&x, &id, POINT, MIN_GAS_START).await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: not funded"),
        "{:?}",
        r.failures()
    );
    assert_eq!(view(&x, &id, "get_status").await?, json!("Open"));

    let r = transfer_call(&x.creator, USDC, &id, CAP, "fund").await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(
        view(&x, &id, "get_principal").await?,
        json!(CAP.to_string())
    );

    // One gas unit below the minimum: refused, nothing changed.
    let r = start(&x, &id, POINT, MIN_GAS_START - 1).await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: gas"));
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);

    // The platform account doesn't exist: the payee reads are `null`, the callback refuses and
    // releases the lock (a callback never panics), the strategy stays Open.
    let r = start(&x, &id, POINT, MIN_GAS_START).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("start (platform missing)", &r);
    let e = refused_event(&r, ids);
    assert_eq!(e["reason"], "LIMIT: payee not registered", "{e}");
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    assert_eq!(view(&x, &id, "get_status").await?, json!("Open"));
    assert_eq!(view(&x, &id, "get_started_at").await?, Value::Null);

    // The platform registered at both tokens; the creator already is. A point past the drift bound.
    let platform = account(&x.root, "platform").await?;
    register(&x, USDC, &platform).await?;
    register(&x, WRAP, &platform).await?;
    let r = start(&x, &id, POINT + 31, MIN_GAS_START).await?;
    assert_eq!(refused_event(&r, ids)["reason"], "LIMIT: drift");
    assert_eq!(view(&x, &id, "get_status").await?, json!("Open"));

    // A good start, at the drift bound exactly.
    let r = start(&x, &id, POINT - 30, MIN_GAS_START).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("start", &r);
    let e = start_event(&r, ids);
    assert_eq!(e["point"], POINT);
    assert_eq!(e["principal"], CAP.to_string());
    assert_eq!(view(&x, &id, "get_status").await?, json!("Running"));
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    assert!(view(&x, &id, "get_started_at").await?.is_string());

    // Each read under half its fixed gas, the callback under half of its own.
    let burns = |acct: &str| -> Vec<u64> {
        on(&r, acct)
            .iter()
            .map(|o| o.gas_burnt.as_gas())
            .filter(|g| *g > TGAS / 10)
            .collect()
    };
    for g in burns(DCL) {
        assert!(g < GAS_VIEW / 2, "DCL view burnt {g}");
    }
    for t in [USDC, WRAP] {
        for g in burns(t) {
            assert!(g < GAS_READ_STORAGE / 2, "{t} view burnt {g}");
        }
    }
    let (cb, _) = receipt_with(&r, ids, "start");
    println!("GAS start callback: {:.3} Tgas", tgas(cb));
    assert!(cb < GAS_START_CALLBACK / 2, "callback burnt {cb}");

    // Running: cancel and withdraw are refused; a second start too.
    let r = x.creator.call(&id, "cancel").transact().await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: wrong status"));
    let r = start(&x, &id, POINT, MIN_GAS_START).await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: wrong status"));
    Ok(())
}

/// Contract review M2: the callback's price loop at its longest. Points +-786,431 have 19 set
/// bits (the most squarings and multiplies below the bound); +786,431 is the division path for the
/// base dust (quote is token_x, so the exponent is negative), -786,431 the multiplication path.
/// Each runs in its own world with a pool created at that point, and the callback must still burn
/// under half of its fixed gas.
#[tokio::test]
async fn start_at_the_longest_price_loops() -> anyhow::Result<()> {
    for point in [786_431i64, -786_431] {
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
            .args_json(json!({"token_a": USDC, "token_b": WRAP, "fee": 100, "init_point": point}))
            .deposit(NearToken::from_near(1))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        let r = transfer_call(&x.creator, USDC, &id, CAP, "fund").await?;
        assert!(r.is_success(), "{:?}", r.failures());
        let r = start(&x, &id, point, MIN_GAS_START).await?;
        assert!(r.is_success(), "{:?}", r.failures());
        if point > 0 {
            // The base dust (1 wNEAR) is worth almost nothing in USDC here: it starts.
            let e = start_event(&r, ids);
            assert_eq!(e["point"], point, "{e}");
            assert_eq!(view(&x, &id, "get_status").await?, json!("Running"));
            let (cb, _) = receipt_with(&r, ids, "start");
            println!("GAS start callback at {point}: {:.3} Tgas", tgas(cb));
            assert!(
                cb < GAS_START_CALLBACK / 2,
                "callback burnt {cb} at {point}"
            );
        } else {
            // At -786,431 one unit of the base token is worth more than u128::MAX quote units, so
            // the dust check saturates and refuses (the full valuation still ran): the refusal
            // path under half the callback's gas, the lock released, still Open.
            let e = refused_event(&r, ids);
            assert_eq!(e["reason"], "LIMIT: dust threshold", "{e}");
            let (cb, _) = receipt_with(&r, ids, "start_refused");
            println!(
                "GAS start callback (refused) at {point}: {:.3} Tgas",
                tgas(cb)
            );
            assert!(
                cb < GAS_START_CALLBACK / 2,
                "callback burnt {cb} at {point}"
            );
            assert_eq!(view(&x, &id, "get_status").await?, json!("Open"));
            assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
        }
    }
    Ok(())
}
