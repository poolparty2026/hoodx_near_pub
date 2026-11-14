//! Slice 7: `agent_swap` on the real wasm against the pinned DCL and native USDC (EC-C170's sandbox
//! items; gate 3 Part L). The pool is seeded with liquidity by an LP account; the agent account
//! named in the config calls the contract, which reads the pool, sizes the swap itself and sends it.
mod common;
use common::*;
use near_workspaces::types::Gas;
use near_workspaces::AccountId;
use serde_json::{json, Value};

const POINT: i64 = 401_312;
const LEFT: i64 = 400_812;
const RIGHT: i64 = 401_812;
const MIN_GAS_SWAP: u64 = 280 * TGAS;
const GAS_SWAP_READ_CB: u64 = 150 * TGAS;
const GAS_SWAP_RESULT: u64 = 10 * TGAS;
const GAS_SWAP: u64 = 90 * TGAS;

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

/// A real swap: the agent names the range and its observation; the contract reads the real pool
/// and the wallet, sizes about half of the 500 USDC itself, sends `ft_transfer_call` with a `Swap`
/// message and a reference-based minimum, and records the outcome. Tokens move exactly as recorded.
#[tokio::test]
async fn agent_swap_on_the_real_pool() -> anyhow::Result<()> {
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

    // Not the agent: refused on chain, nothing recorded.
    let r = x.creator.call(&id, "agent_swap").args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("01", POINT, height(&x).await?)})).gas(Gas::from_gas(MIN_GAS_SWAP)).transact().await?;
    assert!(
        format!("{:?}", r.failures()).contains("AUTH: agent only"),
        "{:?}",
        r.failures()
    );
    // One gas unit below the minimum: refused, nothing recorded.
    let r = x.agent.call(&id, "agent_swap").args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("01", POINT, height(&x).await?)})).gas(Gas::from_gas(MIN_GAS_SWAP - 1)).transact().await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: gas"),
        "{:?}",
        r.failures()
    );
    assert_eq!(view(&x, &id, "get_actions_len").await?, json!("0"));

    let usdc_before = ft_balance(&x, USDC, &id).await?;
    assert_eq!(ft_balance(&x, WRAP, &id).await?, 0);
    let r = x.agent.call(&id, "agent_swap").args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("01", POINT, height(&x).await?)})).gas(Gas::from_gas(MIN_GAS_SWAP)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("agent_swap", &r);
    let rec = action(&x, &id, 0).await?;
    println!("RECORD {rec}");
    assert_eq!(rec["result"], "Ok", "{rec}");
    let used: u128 = rec["swap"]["used"].as_str().unwrap().parse()?;
    let amount_in: u128 = rec["swap"]["amount_in"].as_str().unwrap().parse()?;
    let min_out: u128 = rec["swap"]["min_out"].as_str().unwrap().parse()?;
    assert_eq!(used, amount_in, "the pool used the whole amount");
    assert!(
        amount_in > 240_000_000 && amount_in < 260_000_000,
        "about half of 500 USDC: {amount_in}"
    );
    assert_eq!(ft_balance(&x, USDC, &id).await?, usdc_before - amount_in);
    let got = ft_balance(&x, WRAP, &id).await?;
    assert!(got >= min_out && got > 0, "got {got}, minimum {min_out}");
    assert_eq!(rec["kind"], "Swap");
    assert_eq!(rec["caller"], "agent.test.near");
    assert_eq!(rec["reference"]["point"], POINT);
    assert_eq!(view(&x, &id, "get_swaps_used").await?, json!(1));
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    assert_eq!(view(&x, &id, "get_actions_len").await?, json!("1"));
    // The payout window opened at the callback, as the agent's.
    let w = view(&x, &id, "get_settle_window").await?;
    assert_eq!(w["settle_window_class"], "Agent");
    assert!(w["settle_until_block"].as_str().unwrap().parse::<u64>()? > 0);
    // Every strategy receipt under half its fixed gas.
    let burns: Vec<u64> = on(&r, ids)
        .iter()
        .map(|o| o.gas_burnt.as_gas())
        .filter(|g| *g > TGAS / 2)
        .collect();
    println!(
        "strategy receipts: {:?}",
        burns.iter().map(|g| tgas(*g)).collect::<Vec<_>>()
    );
    for g in &burns {
        assert!(*g < GAS_SWAP_READ_CB / 2, "a strategy receipt burnt {g}");
    }
    let (cb, _) = receipt_with(&r, ids, "action_result");
    assert!(cb < GAS_SWAP_RESULT / 2, "the result callback burnt {cb}");
    for g in on(&r, USDC).iter().map(|o| o.gas_burnt.as_gas()) {
        assert!(g < GAS_SWAP / 2 || g < 5 * TGAS, "a USDC receipt burnt {g}");
    }

    // A second swap straight away is inside the action interval.
    let r = x.agent.call(&id, "agent_swap").args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("02", POINT, height(&x).await?)})).gas(Gas::from_gas(MIN_GAS_SWAP)).transact().await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: action interval"),
        "{:?}",
        r.failures()
    );
    // The same decision hash again, later, is refused as a replay (after the interval it would pass).
    assert_eq!(view(&x, &id, "get_actions_len").await?, json!("1"));
    Ok(())
}

/// A refusal after the lock, on chain: the agent's observation is 31 points off the pool's own
/// read. The record says `Refused("drift")`, the lock is free, no token moved, and the call still
/// counts toward the interval.
#[tokio::test]
async fn agent_swap_refused_for_drift_on_chain() -> anyhow::Result<()> {
    let x = world(true).await?;
    let id = running(&x).await?;
    seed_pool(
        &x,
        POINT,
        100_000_000_000,
        29_000_000_000_000_000_000_000_000_000,
    )
    .await?;
    let usdc_before = ft_balance(&x, USDC, &id).await?;
    let r = x.agent.call(&id, "agent_swap").args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("03", POINT + 31, height(&x).await?)})).gas(Gas::from_gas(MIN_GAS_SWAP)).transact().await?;
    assert!(r.is_success(), "{:?}", r.failures());
    gas_report("agent_swap (refused)", &r);
    let rec = action(&x, &id, 0).await?;
    assert_eq!(rec["result"], json!({"Refused": "drift"}), "{rec}");
    assert_eq!(
        rec["reference"],
        Value::Null,
        "no reference is kept for a refusal before it is accepted"
    );
    assert_eq!(ft_balance(&x, USDC, &id).await?, usdc_before);
    assert_eq!(ft_balance(&x, WRAP, &id).await?, 0);
    assert_eq!(view(&x, &id, "get_lock").await?, Value::Null);
    assert_eq!(view(&x, &id, "get_swaps_used").await?, json!(0));
    assert_eq!(
        view(&x, &id, "get_settle_window").await?["settle_until_block"],
        "0"
    );
    let r = x.agent.call(&id, "agent_swap").args_json(json!({"left_point": LEFT, "right_point": RIGHT, "meta": meta("04", POINT, height(&x).await?)})).gas(Gas::from_gas(MIN_GAS_SWAP)).transact().await?;
    assert!(format!("{:?}", r.failures()).contains("LIMIT: action interval"));
    Ok(())
}
