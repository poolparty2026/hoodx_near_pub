//! Slice 8: `register_tokens` and `agent_open` on the real wasm against the pinned DCL and native
//! USDC (gate 3 Part M). An LP account seeds the pool; the creator registers the tokens; the agent
//! swaps about half and then opens one position (a paired open under the swap's decision hash);
//! the test reads the position back from DCL and prints every receipt's gas burn.
mod common;
use common::*;
use near_workspaces::types::Gas;
use near_workspaces::AccountId;
use serde_json::{json, Value};

const POINT: i64 = 401_312;
const LEFT: i64 = 400_812;
const RIGHT: i64 = 401_812;
const MIN_GAS_SWAP: u64 = 280 * TGAS;
const MIN_GAS_OPEN: u64 = 300 * TGAS;
const MIN_GAS_REGISTER_TOKENS: u64 = 60 * TGAS;
const PAYOUT_SETTLE_BLOCKS: u64 = 20;
const OFFCHAIN_MARGIN_BLOCKS: u64 = 40;

fn meta(hash_byte: &str, point: i64, block: u64) -> Value {
    json!({"observed": {"block": block.to_string(), "point": point}, "decision_hash": hash_byte.repeat(32), "chain_head": null})
}
async fn height(x: &World) -> anyhow::Result<u64> {
    Ok(x.w.view_block().await?.height())
}
async fn action(x: &World, id: &AccountId, i: u64) -> anyhow::Result<Value> {
    Ok(x.w
        .view(id, "get_action")
        .args_json(json!({"index": i.to_string()}))
        .await?
        .json()?)
}
async fn dcl_view(x: &World, m: &str, args: Value) -> anyhow::Result<Value> {
    Ok(x.w.view(&DCL.parse()?, m).args_json(args).await?.json()?)
}

#[tokio::test]
async fn register_tokens_swap_and_open_on_the_real_pool() -> anyhow::Result<()> {
    let x = world(true).await?;
    let id = running(&x).await?;
    let ids = id.as_str();
    seed_pool(
        &x,
        POINT,
        100_000_000_000,
        29_000_000_000_000_000_000_000_000_000,
    )
    .await?;

    // Test audit gap 8: every callback called directly by an outsider is refused on chain.
    for (m, a) in [
        ("on_open_reads", json!({"op_id": "0"})),
        ("on_open_deposited", json!({"op_id": "0"})),
        ("on_open_add_reads", json!({"op_id": "0"})),
        ("on_open_added", json!({"op_id": "0"})),
        ("on_remove_reads", json!({"op_id": "0"})),
        ("on_remove_predicted", json!({"op_id": "0"})),
        ("on_removed", json!({"op_id": "0"})),
        ("on_tokens_registered", json!({"op_id": "0"})),
    ] {
        let r = x
            .agent
            .call(&id, m)
            .args_json(a)
            .gas(Gas::from_gas(30 * TGAS))
            .transact()
            .await?;
        assert!(
            format!("{:?}", r.failures()).contains("AUTH: callback only"),
            "{m}: {:?}",
            r.failures()
        );
    }

    // Before registration the open is refused on chain.
    let h = height(&x).await?;
    let r = x
        .agent
        .call(&id, "agent_open")
        .args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("01", POINT, h)}))
        .gas(Gas::from_gas(MIN_GAS_OPEN))
        .transact()
        .await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: tokens not registered"),
        "{:?}",
        r.failures()
    );

    // register_tokens: creator only, gas, then success.
    let r = x
        .agent
        .call(&id, "register_tokens")
        .gas(Gas::from_gas(MIN_GAS_REGISTER_TOKENS))
        .transact()
        .await?;
    assert!(format!("{:?}", r.failures()).contains("AUTH: creator only"));
    let r = x
        .creator
        .call(&id, "register_tokens")
        .gas(Gas::from_gas(MIN_GAS_REGISTER_TOKENS - 1))
        .transact()
        .await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: gas"));
    let bal_before = balance(&x, &id).await?;
    let r = x
        .creator
        .call(&id, "register_tokens")
        .gas(Gas::from_gas(MIN_GAS_REGISTER_TOKENS))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("register_tokens", &r);
    assert_eq!(view(&x, &id, "get_tokens_registered").await?, json!(true));
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    let bal_after = balance(&x, &id).await?;
    println!("NEAR before {bal_before} after {bal_after}");
    let r = x
        .creator
        .call(&id, "register_tokens")
        .gas(Gas::from_gas(MIN_GAS_REGISTER_TOKENS))
        .transact()
        .await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: tokens already registered"));

    // The swap, with decision hash 01.
    let h = height(&x).await?;
    let r = x
        .agent
        .call(&id, "agent_swap")
        .args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("01", POINT, h)}))
        .gas(Gas::from_gas(MIN_GAS_SWAP))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(action(&x, &id, 0).await?["result"], "Ok");
    let swapped_usdc = ft_balance(&x, USDC, &id).await?;
    let swapped_wnear = ft_balance(&x, WRAP, &id).await?;
    println!("after swap: usdc {swapped_usdc} wnear {swapped_wnear}");

    // Inside the settle window the open is refused as not quiet.
    let r = x.agent.call(&id, "agent_open").args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("01", POINT, height(&x).await?)})).gas(Gas::from_gas(MIN_GAS_OPEN)).transact().await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: not quiet"),
        "{:?}",
        r.failures()
    );
    x.w.fast_forward(PAYOUT_SETTLE_BLOCKS + OFFCHAIN_MARGIN_BLOCKS + 5)
        .await?;

    // One gas unit below the minimum.
    let h = height(&x).await?;
    let r = x
        .agent
        .call(&id, "agent_open")
        .args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("01", POINT, h)}))
        .gas(Gas::from_gas(MIN_GAS_OPEN - 1))
        .transact()
        .await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: gas"),
        "{:?}",
        r.failures()
    );

    // The paired open.
    let r = x
        .agent
        .call(&id, "agent_open")
        .args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("01", POINT, h)}))
        .gas(Gas::from_gas(MIN_GAS_OPEN))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("agent_open", &r);
    println!("RECEIPT FAILURES {:?}", r.receipt_failures());
    for (n, d) in events(&r) {
        println!("EVENT {n} {d}");
    }
    let rec = action(&x, &id, 1).await?;
    println!("RECORD {rec}");
    assert_eq!(rec["kind"], "Open");
    assert_eq!(rec["result"], "Ok", "{rec}");
    let lpt = rec["open"]["lpt_id"]
        .as_str()
        .expect("a position id")
        .to_string();
    assert_eq!(view(&x, &id, "get_own_position").await?, json!(lpt));
    assert_eq!(view(&x, &id, "get_opened").await?, json!(true));
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    // DCL's own view of the position: ours, in the pool, with the recorded points.
    let pos = dcl_view(&x, "get_liquidity", json!({"lpt_id": lpt})).await?;
    println!("POSITION {pos}");
    assert_eq!(pos["owner_id"], ids);
    assert_eq!(pos["left_point"], LEFT);
    assert_eq!(pos["right_point"], RIGHT);
    // The tokens left the wallet: at most the add amounts' dust and any refund remain.
    let add_x: u128 = rec["open"]["add_x"].as_str().unwrap().parse()?;
    let add_y: u128 = rec["open"]["add_y"].as_str().unwrap().parse()?;
    let usdc_after = ft_balance(&x, USDC, &id).await?;
    let wnear_after = ft_balance(&x, WRAP, &id).await?;
    println!("after open: usdc {usdc_after} wnear {wnear_after} add {add_x} {add_y}");
    assert!(
        usdc_after <= swapped_usdc - add_x + (add_x / 100),
        "usdc left {usdc_after}"
    );
    assert!(
        wnear_after <= swapped_wnear - add_y + (add_y / 100),
        "wnear left {wnear_after}"
    );
    assert_eq!(rec["open"]["deposit_x"], rec["open"]["add_x"]);
    // A second open is refused for good.
    x.w.fast_forward(PAYOUT_SETTLE_BLOCKS + OFFCHAIN_MARGIN_BLOCKS + 5)
        .await?;
    let h = height(&x).await?;
    let r = x
        .agent
        .call(&id, "agent_open")
        .args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("09", POINT, h)}))
        .gas(Gas::from_gas(MIN_GAS_OPEN))
        .transact()
        .await?;
    let f = format!("{:?}", r.failures());
    assert!(
        f.contains("LIMIT: already opened") || f.contains("LIMIT: action interval"),
        "{f}"
    );

    // Every strategy receipt's burn against its fixed gas (printed; the budgets are tuned from it).
    let burns: Vec<f64> = on(&r, ids)
        .iter()
        .map(|o| tgas(o.gas_burnt.as_gas()))
        .collect();
    println!("last call's strategy receipts: {burns:?}");

    // settle refuses while the position exists (S8 gate): close, then settle's callback refuses.
    let r = x
        .creator
        .call(&id, "close")
        .gas(Gas::from_gas(50 * TGAS))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let r = x
        .creator
        .call(&id, "settle")
        .gas(Gas::from_gas(100 * TGAS))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let ev = events(&r);
    assert!(
        ev.iter()
            .any(|(n, d)| n == "settle_refused" && d["reason"] == "LIMIT: own position exists"),
        "{ev:?}"
    );
    assert_eq!(view(&x, &id, "get_status").await?, json!("Closing"));
    Ok(())
}
