//! D57 end to end on the real wasm: the real TypeScript flow (`scripts/testnet/e2e.ts`: buyer key
//! pair, `buy_viewing_key`, the real `Deliverer` class signing with a function-call key limited to
//! `deliver_key`, the sealed-box open, the rules decrypted and hashed against the on-chain
//! commitment) against a sandbox node. The Rust side prepares the world and writes
//! `.testnet/run.json`; it prints no keys.
mod common;
use common::*;
use near_workspaces::types::{AccessKey, KeyType, SecretKey};
use serde_json::{json, Value};
use std::process::Command;

async fn prepare() -> anyhow::Result<(World, near_workspaces::AccountId)> {
    let prep = Command::new("node")
        .args(["scripts/testnet/sandbox-prep.ts", ID])
        .current_dir(ROOT)
        .output()?;
    anyhow::ensure!(
        prep.status.success(),
        "prep: {}",
        String::from_utf8_lossy(&prep.stderr)
    );
    let p: Value = serde_json::from_slice(&prep.stdout)?;
    std::env::set_var("POOLSIDE_RULES_HASH", p["rulesHashHex"].as_str().unwrap());
    std::env::set_var(
        "POOLSIDE_RULES_CIPHERTEXT",
        p["ciphertextB64"].as_str().unwrap(),
    );
    let x = world(true).await?;
    let id = running(&x).await?;
    let deliverer = account(&x.root, "deliverer").await?;
    let buyer = account(&x.root, "buyer").await?;
    let fc = SecretKey::from_random(KeyType::ED25519);
    deliverer
        .batch(deliverer.id())
        .add_key(
            fc.public_key(),
            AccessKey::function_call_access(&id, &["deliver_key"], None),
        )
        .transact()
        .await?
        .into_result()?;
    std::fs::create_dir_all(format!("{ROOT}/.testnet"))?;
    let run = json!({
        "rpc": x.w.rpc_addr(),
        "names": {"strategy": id, "deliverer": deliverer.id(), "buyer": buyer.id(), "creator": x.creator.id()},
        "keys": {"buyer": buyer.secret_key().to_string(), "delivererFc": fc.to_string()},
        // The sandbox charges about 0.011 NEAR for a refund_key call; allow 0.02.
        "gasSlackYocto": (2 * NEAR / 100).to_string(),
        "gasSlack": (2 * NEAR / 100).to_string(),
        "rulesKeyHex": p["rulesKeyHex"], "rulesHashHex": p["rulesHashHex"],
    });
    std::fs::write(
        format!("{ROOT}/.testnet/run.json"),
        serde_json::to_string(&run)?,
    )?;
    Ok((x, id))
}

fn e2e(args: &[&str]) -> anyhow::Result<()> {
    let out = Command::new("node")
        .args([
            "--experimental-transform-types",
            "--no-warnings",
            "scripts/testnet/e2e.ts",
        ])
        .args(args)
        .current_dir(ROOT)
        .output()?;
    println!("{}", String::from_utf8_lossy(&out.stdout));
    anyhow::ensure!(
        out.status.success(),
        "e2e failed: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Ok(())
}

#[tokio::test]
async fn e2e_buy_deliver_open() -> anyhow::Result<()> {
    let (_x, _id) = prepare().await?;
    e2e(&[])
}

#[tokio::test]
async fn e2e_buy_refund() -> anyhow::Result<()> {
    let (x, _id) = prepare().await?;

    let w = x.w.clone();
    let h = std::thread::spawn(|| e2e(&["--refund", "--no-wait"]));
    // The script buys, then polls block time; advance past the window after a pause.
    tokio::time::sleep(std::time::Duration::from_secs(20)).await;
    w.fast_forward(13_000).await?;
    h.join().unwrap()
}
