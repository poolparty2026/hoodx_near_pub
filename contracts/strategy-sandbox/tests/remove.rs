//! Slice 9: `agent_close_position` and `exit_remove` on the real wasm against the pinned DCL and
//! native USDC (gate 3 Part N). A position is opened as in `open.rs`; then the agent closes it
//! (a decision with a confirmation span), or the agent exits after `close()`; the test checks the
//! tokens back in the wallet, the fees recorded, `own_position` cleared, and that `settle` then works.
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
const MIN_GAS_REMOVE: u64 = 250 * TGAS;
const SETTLE_AND_MARGIN: u64 = 20 + 40 + 5;

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

/// Funds, seeds, registers, swaps and opens. Returns the strategy and its position id.
async fn opened(x: &World) -> anyhow::Result<(AccountId, String)> {
    let id = running(x).await?;
    seed_pool(
        x,
        POINT,
        100_000_000_000,
        29_000_000_000_000_000_000_000_000_000,
    )
    .await?;
    let r = x
        .creator
        .call(&id, "register_tokens")
        .gas(Gas::from_gas(60 * TGAS))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let h = height(x).await?;
    let r = x
        .agent
        .call(&id, "agent_swap")
        .args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("01", POINT, h)}))
        .gas(Gas::from_gas(MIN_GAS_SWAP))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    x.w.fast_forward(SETTLE_AND_MARGIN).await?;
    let h = height(x).await?;
    let r = x
        .agent
        .call(&id, "agent_open")
        .args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("01", POINT, h)}))
        .gas(Gas::from_gas(MIN_GAS_OPEN))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let rec = action(x, &id, 1).await?;
    assert_eq!(rec["result"], "Ok", "{rec}");
    let lpt = rec["open"]["lpt_id"].as_str().unwrap().to_string();
    Ok((id, lpt))
}

/// The agent closes on a decision: observation, a confirming observation a margin earlier, a new
/// hash. The position's tokens come back to the wallet, the record shows the fees, and after the
/// window the creator closes and anyone settles.
#[tokio::test]
async fn agent_close_position_on_the_real_pool() -> anyhow::Result<()> {
    let x = world(true).await?;
    let (id, lpt) = opened(&x).await?;
    let ids = id.as_str();
    x.w.fast_forward(SETTLE_AND_MARGIN + 50).await?;
    // `min_action_interval_s` is 600 s in the test args and the sandbox clock is real time: wait it out.
    tokio::time::sleep(std::time::Duration::from_secs(605)).await;
    x.w.fast_forward(SETTLE_AND_MARGIN).await?;
    let usdc_before = ft_balance(&x, USDC, &id).await?;
    let wnear_before = ft_balance(&x, WRAP, &id).await?;
    let h = height(&x).await?;
    let call = |position: &str, gas: u64, confirm_block: u64| {
        x.agent
            .call(&id, "agent_close_position")
            .args_json(json!({
                "position": position, "meta": meta("02", POINT, h),
                "confirm_observed": {"block": confirm_block.to_string(), "point": POINT},
            }))
            .gas(Gas::from_gas(gas))
            .transact()
    };
    // Refusals on chain: another position, a span of 39, gas one below.
    let r = call("other#1", MIN_GAS_REMOVE, h - 40).await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: not the own position"),
        "{:?}",
        r.failures()
    );
    let r = call(&lpt, MIN_GAS_REMOVE, h - 39).await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: confirmation span"),
        "{:?}",
        r.failures()
    );
    let r = call(&lpt, MIN_GAS_REMOVE - 1, h - 40).await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: gas"),
        "{:?}",
        r.failures()
    );
    assert_eq!(view(&x, &id, "get_actions_len").await?, json!("2"));
    let r = call(&lpt, MIN_GAS_REMOVE, h - 40).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("agent_close_position", &r);
    println!("RECEIPT FAILURES {:?}", r.receipt_failures());
    let rec = action(&x, &id, 2).await?;
    println!("RECORD {rec}");
    assert_eq!(rec["kind"], "ClosePosition");
    assert_eq!(rec["result"], "Ok", "{rec}");
    let rm = &rec["remove"];
    let reported_x: u128 = rm["reported_x"].as_str().unwrap().parse()?;
    let reported_y: u128 = rm["reported_y"].as_str().unwrap().parse()?;
    assert!(reported_x > 0 || reported_y > 0);
    assert_eq!(ft_balance(&x, USDC, &id).await?, usdc_before + reported_x);
    assert_eq!(ft_balance(&x, WRAP, &id).await?, wnear_before + reported_y);
    let fees_x: u128 = rm["fees_x"].as_str().unwrap().parse()?;
    let fees_y: u128 = rm["fees_y"].as_str().unwrap().parse()?;
    assert!(fees_x <= reported_x && fees_y <= reported_y);
    let fc = view(&x, &id, "get_fees_collected").await?;
    assert_eq!(fc["quote"], json!(fees_x.to_string()));
    assert_eq!(fc["base"], json!(fees_y.to_string()));
    assert_eq!(view(&x, &id, "get_own_position").await?, Value::Null);
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    let pos: Value =
        x.w.view(&DCL.parse()?, "get_liquidity")
            .args_json(json!({"lpt_id": lpt}))
            .await?
            .json()?;
    assert_eq!(pos, Value::Null);
    println!(
        "burns {:?}",
        on(&r, ids)
            .iter()
            .map(|o| tgas(o.gas_burnt.as_gas()))
            .collect::<Vec<_>>()
    );

    // The close is done: the creator closes, the window passes, settle works.
    let r = x
        .creator
        .call(&id, "close")
        .gas(Gas::from_gas(50 * TGAS))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    x.w.fast_forward(SETTLE_AND_MARGIN).await?;
    let r = x
        .creator
        .call(&id, "settle")
        .gas(Gas::from_gas(100 * TGAS))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(view(&x, &id, "get_status").await?, json!("Closed"));
    Ok(())
}

/// The exit: after `close()` the agent removes the position with no decision, and a second exit
/// has nothing to remove.
#[tokio::test]
async fn exit_remove_on_the_real_pool() -> anyhow::Result<()> {
    let x = world(true).await?;
    let (id, lpt) = opened(&x).await?;
    let ids = id.as_str();
    let r = x
        .creator
        .call(&id, "close")
        .gas(Gas::from_gas(50 * TGAS))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    // An outsider can't exit yet.
    let outsider = account(&x.root, "outsider").await?;
    let r = outsider
        .call(&id, "exit_remove")
        .args_json(json!({"position": lpt}))
        .gas(Gas::from_gas(MIN_GAS_REMOVE))
        .transact()
        .await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: exit not open yet"),
        "{:?}",
        r.failures()
    );
    let r = x
        .agent
        .call(&id, "exit_remove")
        .args_json(json!({"position": lpt}))
        .gas(Gas::from_gas(MIN_GAS_REMOVE))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("exit_remove", &r);
    println!("RECEIPT FAILURES {:?}", r.receipt_failures());
    let rec = action(&x, &id, 2).await?;
    println!("RECORD {rec}");
    assert_eq!(rec["kind"], "ExitRemove");
    assert_eq!(rec["result"], "Ok", "{rec}");
    assert_eq!(view(&x, &id, "get_own_position").await?, Value::Null);
    println!(
        "burns {:?}",
        on(&r, ids)
            .iter()
            .map(|o| tgas(o.gas_burnt.as_gas()))
            .collect::<Vec<_>>()
    );
    // Nothing is left to exit.
    let r = x
        .creator
        .call(&id, "exit_remove")
        .args_json(json!({"position": lpt}))
        .gas(Gas::from_gas(MIN_GAS_REMOVE))
        .transact()
        .await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: not the own position"),
        "{:?}",
        r.failures()
    );
    x.w.fast_forward(SETTLE_AND_MARGIN).await?;
    let r = x
        .creator
        .call(&id, "settle")
        .gas(Gas::from_gas(100 * TGAS))
        .transact()
        .await?;
    assert!(r.is_success(), "{:?}", r.failures());
    assert_eq!(view(&x, &id, "get_status").await?, json!("Closed"));
    Ok(())
}
