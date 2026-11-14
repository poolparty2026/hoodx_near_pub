//! Gate 3 spike, sandbox part. Build the contracts first:
//!   ./build.sh
//! then run: cargo test -p tests-sandbox -- --nocapture
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use near_workspaces::network::Sandbox;
use serde_json::json;

const WASM_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/wasm32-unknown-unknown/release");

fn wasm(name: &str) -> Vec<u8> {
    std::fs::read(format!("{WASM_DIR}/{name}.wasm")).expect("build the wasm contracts first")
}

struct Setup {
    worker: Worker<Sandbox>,
    token: Contract,
    relay: Contract,
    sink: Contract,
    agent: Account,
    /// The agent account, signing with a function-call key scoped to the relay.
    agent_fc: Account,
}

async fn setup() -> anyhow::Result<Setup> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let agent = root.create_subaccount("agent").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;

    let sink = root.create_subaccount("sink").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?
        .deploy(&wasm("sink")).await?.into_result()?;
    let token = root.create_subaccount("token").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?
        .deploy(&wasm("token")).await?.into_result()?;
    token.call("new").args_json(json!({"owner_id": root.id(), "total_supply": "1000000000"})).transact().await?.into_result()?;

    let relay = root.create_subaccount("relay").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?
        .deploy(&wasm("relay")).await?.into_result()?;
    relay.call("new").args_json(json!({"agent": agent.id(), "allowed_receiver": sink.id(), "max_amount": "1000"}))
        .transact().await?.into_result()?;

    // Register sink with the token, then fund the relay with tokens.
    for who in [sink.id(), relay.id()] {
        root.call(token.id(), "storage_deposit").args_json(json!({"account_id": who}))
            .deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
    }
    root.call(token.id(), "ft_transfer").args_json(json!({"receiver_id": relay.id(), "amount": "5000"}))
        .deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;

    // Give the agent a function-call key that can only call the relay's agent_* methods.
    let fc_sk = SecretKey::from_random(KeyType::ED25519);
    agent.batch(agent.id())
        .add_key(fc_sk.public_key(), AccessKey::function_call_access(relay.id(), &["agent_transfer_call", "agent_register"], Some(NearToken::from_millinear(500))))
        .transact().await?.into_result()?;
    let agent_fc = Account::from_secret_key(agent.id().clone(), fc_sk, &worker);

    Ok(Setup { worker, token, relay, sink, agent, agent_fc })
}

#[tokio::test]
async fn fc_key_drives_ft_transfer_call_through_contract() -> anyhow::Result<()> {
    let s = setup().await?;
    let out = s.agent_fc.call(s.relay.id(), "agent_transfer_call")
        .args_json(json!({"token": s.token.id(), "receiver_id": s.sink.id(), "amount": "700", "msg": "{\"AddLiquidity\":{}}"}))
        .gas(Gas::from_tgas(100)).transact().await?;
    println!("FC key -> relay -> ft_transfer_call: success={} failures={:?}", out.is_success(), out.failures().len());
    assert!(out.is_success(), "{:?}", out.failures());
    let last: (String, Option<String>, String) = s.sink.view("last").await?.json()?;
    println!("sink saw msg={} sender={:?} total={}", last.0, last.1, last.2);
    assert_eq!(last.2, "700");
    assert_eq!(last.1.as_deref(), Some(s.relay.id().as_str()));
    let relay_bal: String = s.token.view("ft_balance_of").args_json(json!({"account_id": s.relay.id()})).await?.json()?;
    assert_eq!(relay_bal, "4300");
    let _ = &s.worker;
    Ok(())
}

#[tokio::test]
async fn contract_refuses_action_outside_public_limits() -> anyhow::Result<()> {
    let s = setup().await?;
    let over = s.agent_fc.call(s.relay.id(), "agent_transfer_call")
        .args_json(json!({"token": s.token.id(), "receiver_id": s.sink.id(), "amount": "1001", "msg": ""}))
        .gas(Gas::from_tgas(100)).transact().await?;
    let err = format!("{:?}", over.into_result().unwrap_err());
    println!("over cap refused: {}", err.contains("LIMIT: amount over cap"));
    assert!(err.contains("LIMIT: amount over cap"));

    let wrong = s.agent_fc.call(s.relay.id(), "agent_transfer_call")
        .args_json(json!({"token": s.token.id(), "receiver_id": s.agent.id(), "amount": "1", "msg": ""}))
        .gas(Gas::from_tgas(100)).transact().await?;
    let err = format!("{:?}", wrong.into_result().unwrap_err());
    println!("wrong receiver refused: {}", err.contains("LIMIT: receiver not allowed"));
    assert!(err.contains("LIMIT: receiver not allowed"));
    Ok(())
}

#[tokio::test]
async fn fc_key_cannot_attach_deposit() -> anyhow::Result<()> {
    let s = setup().await?;
    let res = s.agent_fc.call(s.relay.id(), "agent_transfer_call")
        .args_json(json!({"token": s.token.id(), "receiver_id": s.sink.id(), "amount": "1", "msg": ""}))
        .deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(100)).transact().await;
    let failed = match res { Err(e) => { println!("FC key + 1 yocto rejected: {e:?}"); format!("{e:?}").contains("DepositWithFunctionCall") }
                             Ok(o) => { println!("FC key + 1 yocto outcome success={}", o.is_success()); !o.is_success() } };
    assert!(failed, "a function-call key must not be able to attach a deposit");
    Ok(())
}

#[tokio::test]
async fn fc_key_cannot_call_other_contracts_or_methods() -> anyhow::Result<()> {
    let s = setup().await?;
    // Direct call to the token (wrong receiver for this key).
    let direct = s.agent_fc.call(s.token.id(), "ft_balance_of").args_json(json!({"account_id": s.agent.id()})).transact().await;
    let direct_failed = match direct { Err(e) => { println!("FC key -> token rejected: {e:?}"); format!("{e:?}").contains("ReceiverMismatch") } Ok(o) => !o.is_success() };
    assert!(direct_failed);
    // A method not in the key's list.
    let other = s.agent_fc.call(s.relay.id(), "new").args_json(json!({"agent": s.agent.id(), "allowed_receiver": s.agent.id(), "max_amount": "1"})).transact().await;
    let other_failed = match other { Err(e) => { println!("FC key -> unlisted method rejected: {e:?}"); format!("{e:?}").contains("MethodNameMismatch") } Ok(o) => !o.is_success() };
    assert!(other_failed);
    // Sending NEAR is not possible with a function-call key.
    let send = s.agent_fc.transfer_near(s.sink.id(), NearToken::from_yoctonear(1)).await;
    let send_failed = match send { Err(e) => { println!("FC key -> transfer NEAR rejected: {e:?}"); format!("{e:?}").contains("RequiresFullAccess") } Ok(o) => !o.is_success() };
    assert!(send_failed);
    Ok(())
}

#[tokio::test]
async fn non_agent_is_refused() -> anyhow::Result<()> {
    let s = setup().await?;
    let stranger = s.worker.dev_create_account().await?;
    let res = stranger.call(s.relay.id(), "agent_transfer_call")
        .args_json(json!({"token": s.token.id(), "receiver_id": s.sink.id(), "amount": "1", "msg": ""}))
        .gas(Gas::from_tgas(100)).transact().await?;
    let err = format!("{:?}", res.into_result().unwrap_err());
    println!("stranger refused: {err}");
    assert!(err.contains("AUTH: caller is not the agent"));
    Ok(())
}
