//! D57 viewing keys on the real wasm (INTERFACE section 9; EC-C173 to EC-C178, EC-K05: no delivery,
//! refund after the window). Checks what the
//! unit tests could only mock: the deposit and balance accounting of a payable call, a real
//! transfer to the creator and to a buyer, the delivery window against block time, and a
//! transfer that bounces (a deleted creator account) being held in `near_owed` and pulled
//! after the account exists again.
mod common;
use common::*;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::AccountId;
use serde_json::{json, Value};

const PRICE: u128 = 100_000_000_000_000_000_000_000;
const PK: &str = "0101010101010101010101010101010101010101010101010101010101010101";

fn failed(r: &near_workspaces::result::ExecutionFinalResult, msg: &str) -> bool {
    format!("{:?}", r.failures()).contains(msg)
}

async fn buy(
    who: &near_workspaces::Account,
    id: &AccountId,
    deposit: u128,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(who
        .call(id, "buy_viewing_key")
        .args_json(json!({"buyer_pubkey": PK}))
        .deposit(NearToken::from_yoctonear(deposit))
        .max_gas()
        .transact()
        .await?)
}

async fn deliver(
    d: &near_workspaces::Account,
    id: &AccountId,
    buyer: &AccountId,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(d.call(id, "deliver_key")
        .args_json(json!({"buyer": buyer, "sealed_key": "ab".repeat(80)}))
        .gas(Gas::from_gas(30 * TGAS))
        .transact()
        .await?)
}

#[tokio::test]
async fn keys_on_the_real_wasm() -> anyhow::Result<()> {
    let x = world(true).await?;
    let id = running(&x).await?;
    let deliverer = account(&x.root, "deliverer").await?;
    let bob = account(&x.root, "bob").await?;
    let carol = account(&x.root, "carol").await?;
    let mut wire = serde_json::Map::new();
    let params = |v: Value| v["escrow_total"].as_str().unwrap().parse::<u128>().unwrap();

    // Purchase: wrong deposit refunded to the buyer, nothing stored; the exact deposit escrowed.
    let b0 = balance(&x, bob.id()).await?;
    let r = buy(&bob, &id, PRICE - 1).await?;
    assert!(failed(&r, "LIMIT: key price"), "{:?}", r.failures());
    assert!(
        b0 - balance(&x, bob.id()).await? < NEAR / 20,
        "deposit came back"
    );
    let none: Value =
        x.w.view(&id, "get_key_sale")
            .args_json(json!({"buyer": bob.id()}))
            .await?
            .json()?;
    assert_eq!(none, Value::Null, "a refused purchase stores nothing");
    let c0 = balance(&x, &id).await?;
    let r = buy(&bob, &id, PRICE).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("buy_viewing_key", &r);
    assert!(balance(&x, &id).await? >= c0 + PRICE - NEAR / 200);
    let p = x.w.view(&id, "get_key_params").await?.json::<Value>()?;
    assert_eq!(params(p.clone()), PRICE);
    assert_eq!(p["sold"], 1);
    let sale: Value =
        x.w.view(&id, "get_key_sale")
            .args_json(json!({"buyer": bob.id()}))
            .await?
            .json()?;
    assert_eq!(sale["state"], "Escrowed");
    assert_eq!(sale["buyer_pubkey"], PK);
    // Same account again.
    let r = buy(&bob, &id, PRICE).await?;
    assert!(failed(&r, "LIMIT: already bought"));

    // Deliver by a stranger, then by the deliverer: the creator is paid exactly once.
    let r = deliver(&carol, &id, bob.id()).await?;
    assert!(failed(&r, "AUTH: deliverer only"));
    let cr0 = balance(&x, x.creator.id()).await?;
    let r = deliver(&deliverer, &id, bob.id()).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("deliver_key", &r);
    assert_eq!(balance(&x, x.creator.id()).await? - cr0, PRICE);
    let p = x.w.view(&id, "get_key_params").await?.json::<Value>()?;
    assert_eq!(params(p.clone()), 0);
    wire.insert(
        "get_key_sale_released".into(),
        x.w.view(&id, "get_key_sale")
            .args_json(json!({"buyer": bob.id()}))
            .await?
            .json()?,
    );
    wire.insert("get_key_params_after_deliver".into(), p);
    let r = deliver(&deliverer, &id, bob.id()).await?;
    assert!(failed(&r, "LIMIT: not escrowed"));
    assert_eq!(balance(&x, x.creator.id()).await? - cr0, PRICE);
    let r = bob.call(&id, "refund_key").max_gas().transact().await?;
    assert!(failed(&r, "LIMIT: not escrowed"));

    // Refund: not before the window, then once; the buyer gets exactly the price back.
    let r = buy(&carol, &id, PRICE).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let r = carol.call(&id, "refund_key").max_gas().transact().await?;
    assert!(failed(&r, "LIMIT: delivery window open"));
    let t0 = x.w.view_block().await?.timestamp();
    let mut t1 = t0;
    for _ in 0..4 {
        x.w.fast_forward(13_000).await?;
        t1 = x.w.view_block().await?.timestamp();
        if t1 - t0 >= 3_600 * NS + 10 * NS {
            break;
        }
    }
    println!("block time advanced {} s", (t1 - t0) / NS);
    assert!(
        t1 - t0 >= 3_600 * NS,
        "the sandbox must advance past the delivery window"
    );
    let r = deliver(&deliverer, &id, carol.id()).await?;
    assert!(failed(&r, "LIMIT: delivery window closed"));
    let k0 = balance(&x, carol.id()).await?;
    let r = carol.call(&id, "refund_key").max_gas().transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("refund_key", &r);
    let got = balance(&x, carol.id()).await? - k0;
    assert!(got <= PRICE && PRICE - got < NEAR / 20, "refund {got}");
    let r = carol.call(&id, "refund_key").max_gas().transact().await?;
    assert!(failed(&r, "LIMIT: not escrowed"));
    let p = x.w.view(&id, "get_key_params").await?.json::<Value>()?;
    assert_eq!(params(p.clone()), 0);
    wire.insert(
        "get_key_sale_refunded".into(),
        x.w.view(&id, "get_key_sale")
            .args_json(json!({"buyer": carol.id()}))
            .await?
            .json()?,
    );
    wire.insert("get_key_params_after_refund".into(), p);

    // A payout that bounces: the creator account is deleted, so the transfer fails and its NEAR
    // returns; the callback holds it in near_owed[creator]. Then the account exists again and
    // pulls it with withdraw_near.
    let dave = account(&x.root, "dave").await?;
    let r = buy(&dave, &id, PRICE).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    x.creator
        .clone()
        .delete_account(x.root.id())
        .await?
        .into_result()?;
    let held0 = balance(&x, &id).await?;
    let r = deliver(&deliverer, &id, dave.id()).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let owed: Value =
        x.w.view(&id, "get_near_owed")
            .args_json(json!({"account": x.creator.id()}))
            .await?
            .json()?;
    assert_eq!(owed, json!(PRICE.to_string()), "bounce is held");
    assert!(
        balance(&x, &id).await? + NEAR / 20 >= held0,
        "the NEAR is still in the contract"
    );
    let p = x.w.view(&id, "get_key_params").await?.json::<Value>()?;
    assert_eq!(p["near_owed_total"], PRICE.to_string());
    // Nothing owed to others.
    let r = bob.call(&id, "withdraw_near").max_gas().transact().await?;
    assert!(failed(&r, "LIMIT: nothing owed"));
    let creator2 = account(&x.root, "creator").await?;
    let w0 = balance(&x, creator2.id()).await?;
    let r = creator2
        .call(&id, "withdraw_near")
        .max_gas()
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("withdraw_near", &r);
    let w1 = balance(&x, creator2.id()).await?;
    println!(
        "withdraw: before {w0} after {w1} price {PRICE} events {:?}",
        r.logs()
    );
    assert!(w1 + NEAR / 20 >= w0 + PRICE);
    let owed: Value =
        x.w.view(&id, "get_near_owed")
            .args_json(json!({"account": creator2.id()}))
            .await?
            .json()?;
    assert_eq!(owed, json!("0"));
    let r = creator2
        .call(&id, "withdraw_near")
        .max_gas()
        .transact()
        .await?;
    assert!(failed(&r, "LIMIT: nothing owed"));
    // POOLSIDE_DUMP_WIRE=<path> writes the real serde output of the Released and Refunded views.
    if let Ok(path) = std::env::var("POOLSIDE_DUMP_WIRE") {
        let head = String::from_utf8(
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(ROOT)
                .output()?
                .stdout,
        )?;
        wire.insert(
            "provenance".into(),
            json!(format!(
                "Real serde_json output of the strategy wasm (sandbox build), read with near-workspaces view calls. Test: contracts/strategy-sandbox/tests/keys.rs keys_on_the_real_wasm, run with POOLSIDE_DUMP_WIRE set, on a tree whose HEAD was {}. Sandbox accounts and sandbox time. Fixture for apps/web.",
                head.trim()
            )),
        );
        std::fs::write(
            path,
            serde_json::to_string_pretty(&Value::Object(wire))? + "\n",
        )?;
    }
    Ok(())
}
