use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::json;

const SPIKE1: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../gate3-access-keys/target/wasm32-unknown-unknown/release");
fn wasm(p: &str) -> Vec<u8> { std::fs::read(p).unwrap_or_else(|_| panic!("missing {p}")) }

fn show(label: &str, r: &near_workspaces::result::ExecutionFinalResult) {
    println!("--- {label}: success={}", r.is_success());
    for o in r.receipt_outcomes() {
        if !o.logs.is_empty() { println!("  [{}] logs: {:?}", o.executor_id, o.logs); }
        if o.is_failure() { println!("  [{}] FAILED: {:?}", o.executor_id, o.clone().into_result().err()); }
    }
    if let Err(e) = r.clone().into_result() { println!("  final error: {e:?}"); }
}

#[tokio::test]
async fn dcl_lifecycle() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let mk = |name: &'static str| { let root = root.clone(); async move {
        root.create_subaccount(name).initial_balance(NearToken::from_near(50)).transact().await.unwrap().into_result().unwrap() } };
    let owner: Account = mk("owner").await;
    let lp: Account = mk("lp").await;
    let other: Account = mk("other").await;

    // Two test tokens: "usdc" (6 decimals in name only) and "wnear".
    let tok = wasm(&format!("{SPIKE1}/token.wasm"));
    let usdc: Contract = mk("usdc").await.deploy(&tok).await?.into_result()?;
    let wnear: Contract = mk("wnear").await.deploy(&tok).await?.into_result()?;
    for t in [&usdc, &wnear] {
        t.call("new").args_json(json!({"owner_id": lp.id(), "total_supply": "1000000000000"})).transact().await?.into_result()?;
    }
    // Sink: a contract receiver that records ft_on_transfer calls.
    let sink: Contract = mk("sink").await.deploy(&wasm(&format!("{SPIKE1}/sink.wasm"))).await?.into_result()?;

    // DCL: the exact mainnet WASM.
    let dcl: Contract = mk("dcl").await.deploy(&wasm(concat!(env!("CARGO_MANIFEST_DIR"), "/wasm/dclv2-2.4.2.wasm"))).await?.into_result()?;
    let r = dcl.call("new").args_json(json!({"owner_id": owner.id(), "wnear_id": wnear.id(), "farming_contract_id": owner.id()})).transact().await?;
    show("dcl.new", &r);

    // Storage registrations.
    for t in [&usdc, &wnear] {
        for a in [dcl.id(), sink.id(), other.id()] {
            root.call(t.id(), "storage_deposit").args_json(json!({"account_id": a})).deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
        }
    }
    let r = owner.call(dcl.id(), "extend_whitelisted_tokens").args_json(json!({"token_ids": [usdc.id(), wnear.id()]})).deposit(NearToken::from_yoctonear(1)).transact().await?;
    show("extend_whitelisted_tokens", &r);
    let r = owner.call(dcl.id(), "create_pool").args_json(json!({"token_a": usdc.id(), "token_b": wnear.id(), "fee": 2000, "init_point": 0})).deposit(NearToken::from_near(1)).max_gas().transact().await?;
    show("create_pool", &r);
    let pool_id: String = r.json().unwrap_or_default();
    println!("pool_id = {pool_id}");
    for a in [&lp, &other] {
        let r = a.call(dcl.id(), "storage_deposit").args_json(json!({"account_id": a.id()})).deposit(NearToken::from_near(1)).transact().await?;
        show("dcl.storage_deposit", &r);
    }
    let r = lp.call(dcl.id(), "register_tokens").args_json(json!({"token_ids": [usdc.id(), wnear.id()]})).deposit(NearToken::from_yoctonear(1)).transact().await?;
    show("register_tokens", &r);

    // Deposit both tokens into DCL internal balances. Try message variants.
    for msg in ["", "\"Deposit\"", "{\"Deposit\":{}}"] {
        let r = lp.call(usdc.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl.id(), "amount": "1000000", "msg": msg})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
        show(&format!("usdc deposit msg={msg:?}"), &r);
    }
    let r = lp.call(wnear.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl.id(), "amount": "1000000", "msg": "\"Deposit\""})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
    show("wnear deposit", &r);
    let assets: serde_json::Value = dcl.view("list_user_assets").args_json(json!({"account_id": lp.id()})).await?.json()?;
    println!("lp assets after deposit: {assets}");

    // Add liquidity from internal balances.
    let pid = if pool_id.is_empty() { format!("{}|{}|2000", usdc.id(), wnear.id()) } else { pool_id.clone() };
    let r = lp.call(dcl.id(), "add_liquidity").args_json(json!({"pool_id": pid, "left_point": -800, "right_point": 800, "amount_x": "100000", "amount_y": "100000", "min_amount_x": "0", "min_amount_y": "0"})).max_gas().transact().await?;
    show("add_liquidity", &r);
    println!("add_liquidity returned: {:?}", r.json::<serde_json::Value>().ok());
    let pos: serde_json::Value = dcl.view("list_liquidities").args_json(json!({"account_id": lp.id()})).await?.json()?;
    println!("lp positions: {pos}");
    let lpt_id = pos[0]["lpt_id"].as_str().unwrap_or("").to_string();

    // Positions are NFTs: transfer one to `other`.
    let r = lp.call(dcl.id(), "nft_transfer").args_json(json!({"receiver_id": other.id(), "token_id": lpt_id})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
    show("nft_transfer position lp -> other", &r);
    let pos_other: serde_json::Value = dcl.view("list_liquidities").args_json(json!({"account_id": other.id()})).await?.json()?;
    println!("other positions after transfer: {pos_other}");

    // Remove all liquidity (by the new owner), then try removing again (empty position).
    let liq = pos_other[0]["amount"].as_str().unwrap_or("0").to_string();
    let r = other.call(dcl.id(), "remove_liquidity").args_json(json!({"lpt_id": lpt_id, "amount": liq, "min_amount_x": "0", "min_amount_y": "0"})).max_gas().transact().await?;
    show("remove_liquidity all", &r);
    println!("remove returned: {:?}", r.json::<serde_json::Value>().ok());
    let pos_other: serde_json::Value = dcl.view("list_liquidities").args_json(json!({"account_id": other.id()})).await?.json()?;
    println!("other positions after full remove: {pos_other}");
    let r = other.call(dcl.id(), "remove_liquidity").args_json(json!({"lpt_id": lpt_id, "amount": "0", "min_amount_x": "0", "min_amount_y": "0"})).max_gas().transact().await?;
    show("remove_liquidity on removed position", &r);
    let assets: serde_json::Value = dcl.view("list_user_assets").args_json(json!({"account_id": other.id()})).await?.json()?;
    println!("other assets after remove: {assets}");

    // Withdraw: to a registered account, observing delivery mode via the sink.
    // `other` is a plain account; first move its assets to the sink? DCL withdraws to the caller.
    let r = other.call(dcl.id(), "withdraw_asset").args_json(json!({"token_id": usdc.id()})).max_gas().transact().await?;
    show("withdraw_asset usdc (registered receiver)", &r);
    let bal: String = usdc.view("ft_balance_of").args_json(json!({"account_id": other.id()})).await?.json()?;
    println!("other usdc balance after withdraw: {bal}");

    // Withdraw failure: unregister `other` from wnear first by using an account never registered.
    let unreg: Account = mk("unreg").await;
    let r = other.call(dcl.id(), "nft_transfer").args_json(json!({"receiver_id": unreg.id(), "token_id": lpt_id})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
    show("nft_transfer empty position to unreg", &r);
    // Give unreg a DCL internal wnear balance: other deposits on its behalf is not possible; so unreg deposits nothing.
    // Instead: other (registered for wnear) withdraws wnear normally; then test failure with the sink unregistered below.
    let r = other.call(dcl.id(), "withdraw_asset").args_json(json!({"token_id": wnear.id()})).max_gas().transact().await?;
    show("withdraw_asset wnear", &r);

    // Failure path: lp deposits wnear, then lp (NOT registered as receiver? lp owns supply so is registered).
    // Use a fresh account registered at DCL but not at the token.
    let fresh: Account = mk("fresh").await;
    let r = fresh.call(dcl.id(), "storage_deposit").args_json(json!({"account_id": fresh.id()})).deposit(NearToken::from_near(1)).transact().await?; show("fresh dcl storage", &r);
    let r = fresh.call(dcl.id(), "register_tokens").args_json(json!({"token_ids": [usdc.id()]})).deposit(NearToken::from_yoctonear(1)).transact().await?; show("fresh register", &r);
    // lp sends usdc to fresh via DCL? Use mft? Simplest: lp sends usdc to fresh at the token level requires fresh registered... so register fresh, deposit, then unregister fresh at token.
    root.call(usdc.id(), "storage_deposit").args_json(json!({"account_id": fresh.id()})).deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
    lp.call(usdc.id(), "ft_transfer").args_json(json!({"receiver_id": fresh.id(), "amount": "5000"})).deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    let r = fresh.call(usdc.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl.id(), "amount": "5000", "msg": "\"Deposit\""})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?; show("fresh deposit", &r);
    let r = fresh.call(usdc.id(), "storage_unregister").args_json(json!({"force": true})).deposit(NearToken::from_yoctonear(1)).transact().await?; show("fresh unregister from usdc", &r);
    let before: serde_json::Value = dcl.view("list_user_assets").args_json(json!({"account_id": fresh.id()})).await?.json()?;
    let r = fresh.call(dcl.id(), "withdraw_asset").args_json(json!({"token_id": usdc.id()})).max_gas().transact().await?;
    show("withdraw_asset to unregistered receiver", &r);
    println!("withdraw returned: {:?}", r.json::<serde_json::Value>().ok());
    let after: serde_json::Value = dcl.view("list_user_assets").args_json(json!({"account_id": fresh.id()})).await?.json()?;
    let lost: serde_json::Value = dcl.view("list_lostfound").args_json(json!({})).await.map(|v| v.json().unwrap_or_default()).unwrap_or_default();
    println!("fresh assets before {before} after {after}; lostfound {lost}");

    // Delivery mode: does a withdraw call ft_on_transfer on a contract receiver?
    let _ = (&sink, &worker);
    Ok(())
}

/// Second scenario: wNEAR is the real wrap.near code, as on mainnet.
/// Question: when a position is removed, does the owner receive wNEAR (NEP-141)
/// or native NEAR? And where does a failed payout go?
#[tokio::test]
async fn wnear_payout_mode() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let mk = |name: &'static str| { let root = root.clone(); async move {
        root.create_subaccount(name).initial_balance(NearToken::from_near(50)).transact().await.unwrap().into_result().unwrap() } };
    let owner = mk("owner").await;
    let lp = mk("lp").await;
    let tok = wasm(&format!("{SPIKE1}/token.wasm"));
    let usdc: Contract = mk("usdc").await.deploy(&tok).await?.into_result()?;
    usdc.call("new").args_json(json!({"owner_id": lp.id(), "total_supply": "1000000000000"})).transact().await?.into_result()?;
    let wrap: Contract = mk("wrap").await.deploy(&wasm(concat!(env!("CARGO_MANIFEST_DIR"), "/wasm/wrap-near.wasm"))).await?.into_result()?;
    show("wrap.new", &wrap.call("new").args_json(json!({})).transact().await?);
    let dcl: Contract = mk("dcl").await.deploy(&wasm(concat!(env!("CARGO_MANIFEST_DIR"), "/wasm/dclv2-2.4.2.wasm"))).await?.into_result()?;
    dcl.call("new").args_json(json!({"owner_id": owner.id(), "wnear_id": wrap.id(), "farming_contract_id": owner.id()})).transact().await?.into_result()?;
    for a in [dcl.id(), lp.id()] {
        root.call(usdc.id(), "storage_deposit").args_json(json!({"account_id": a})).deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
        root.call(wrap.id(), "storage_deposit").args_json(json!({"account_id": a})).deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
    }
    owner.call(dcl.id(), "extend_whitelisted_tokens").args_json(json!({"token_ids": [usdc.id(), wrap.id()]})).deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    owner.call(dcl.id(), "create_pool").args_json(json!({"token_a": usdc.id(), "token_b": wrap.id(), "fee": 2000, "init_point": 0})).deposit(NearToken::from_near(1)).max_gas().transact().await?.into_result()?;
    lp.call(dcl.id(), "storage_deposit").args_json(json!({"account_id": lp.id()})).deposit(NearToken::from_near(1)).transact().await?.into_result()?;
    // lp wraps 2 NEAR, deposits USDC and wNEAR into DCL.
    show("near_deposit", &lp.call(wrap.id(), "near_deposit").args_json(json!({})).deposit(NearToken::from_near(2)).transact().await?);
    lp.call(usdc.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl.id(), "amount": "1000000", "msg": "\"Deposit\""})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    lp.call(wrap.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl.id(), "amount": "1000000", "msg": "\"Deposit\""})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    let pid = format!("{}|{}|2000", usdc.id(), wrap.id());
    let (x, y) = if usdc.id().as_str() < wrap.id().as_str() { ("usdc","wrap") } else { ("wrap","usdc") };
    println!("pool {pid}: token_x={x} token_y={y}");
    let r = lp.call(dcl.id(), "add_liquidity").args_json(json!({"pool_id": pid, "left_point": -800, "right_point": 800, "amount_x": "100000", "amount_y": "100000", "min_amount_x": "0", "min_amount_y": "0"})).max_gas().transact().await?;
    show("add_liquidity", &r);
    let lpt: String = r.json()?;
    let near_before = lp.view_account().await?.balance;
    let wnear_before: String = wrap.view("ft_balance_of").args_json(json!({"account_id": lp.id()})).await?.json()?;
    let pos: serde_json::Value = dcl.view("get_liquidity").args_json(json!({"lpt_id": lpt})).await?.json()?;
    let r = lp.call(dcl.id(), "remove_liquidity").args_json(json!({"lpt_id": lpt, "amount": pos["amount"], "min_amount_x": "0", "min_amount_y": "0"})).max_gas().transact().await?;
    show("remove_liquidity", &r);
    println!("remove returned {:?}", r.json::<serde_json::Value>().ok());
    let near_after = lp.view_account().await?.balance;
    let wnear_after: String = wrap.view("ft_balance_of").args_json(json!({"account_id": lp.id()})).await?.json()?;
    println!("lp native NEAR delta (incl. gas): {} yocto; lp wNEAR before {wnear_before} after {wnear_after}",
        near_after.as_yoctonear() as i128 - near_before.as_yoctonear() as i128);
    let lf: serde_json::Value = dcl.view("get_lostfound").args_json(json!({"account_id": lp.id(), "token_id": wrap.id()})).await?.json()?;
    println!("lp lostfound wNEAR: {lf}");
    let assets: serde_json::Value = dcl.view("list_user_assets").args_json(json!({"account_id": lp.id()})).await?.json()?;
    println!("lp DCL internal assets after remove: {assets}");
    // Does withdraw_asset for wNEAR unwrap too, and does it take skip_unwrap_near?
    let r = lp.call(dcl.id(), "withdraw_asset").args_json(json!({"token_id": wrap.id(), "skip_unwrap_near": true})).max_gas().transact().await?;
    show("withdraw_asset wnear skip_unwrap_near=true", &r);
    let wnear_after2: String = wrap.view("ft_balance_of").args_json(json!({"account_id": lp.id()})).await?.json()?;
    println!("lp wNEAR after withdraw with skip_unwrap_near: {wnear_after2}");
    // Again, with skip_unwrap_near on remove_liquidity.
    lp.call(usdc.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl.id(), "amount": "100000", "msg": "\"Deposit\""})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    lp.call(wrap.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl.id(), "amount": "100000", "msg": "\"Deposit\""})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    let r = lp.call(dcl.id(), "add_liquidity").args_json(json!({"pool_id": pid, "left_point": -800, "right_point": 800, "amount_x": "100000", "amount_y": "100000", "min_amount_x": "0", "min_amount_y": "0"})).max_gas().transact().await?;
    let lpt2: String = r.json()?;
    let pos: serde_json::Value = dcl.view("get_liquidity").args_json(json!({"lpt_id": lpt2})).await?.json()?;
    let w0: String = wrap.view("ft_balance_of").args_json(json!({"account_id": lp.id()})).await?.json()?;
    let r = lp.call(dcl.id(), "remove_liquidity").args_json(json!({"lpt_id": lpt2, "amount": pos["amount"], "min_amount_x": "0", "min_amount_y": "0", "skip_unwrap_near": true})).max_gas().transact().await?;
    show("remove_liquidity skip_unwrap_near=true", &r);
    let w1: String = wrap.view("ft_balance_of").args_json(json!({"account_id": lp.id()})).await?.json()?;
    println!("wNEAR token balance before {w0} after {w1}");
    // Re-add liquidity so the swap has depth.
    lp.call(usdc.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl.id(), "amount": "500000", "msg": "\"Deposit\""})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    lp.call(wrap.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl.id(), "amount": "500000", "msg": "\"Deposit\""})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    lp.call(dcl.id(), "add_liquidity").args_json(json!({"pool_id": pid, "left_point": -8000, "right_point": 8000, "amount_x": "500000", "amount_y": "500000", "min_amount_x": "0", "min_amount_y": "0"})).max_gas().transact().await?.into_result()?;
    // Swap usdc -> wnear via ft_transfer_call with skip_unwrap_near.
    let msg = json!({"Swap": {"pool_ids": [pid], "output_token": wrap.id(), "min_output_amount": "0", "skip_unwrap_near": true}}).to_string();
    let r = lp.call(usdc.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl.id(), "amount": "1000", "msg": msg})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
    show("swap usdc->wnear skip_unwrap_near=true", &r);
    let w2: String = wrap.view("ft_balance_of").args_json(json!({"account_id": lp.id()})).await?.json()?;
    println!("wNEAR token balance after swap {w2}");
    let _ = worker;
    Ok(())
}

/// Third scenario: point semantics. Price direction, range edge inclusivity, point bounds.
#[tokio::test]
async fn point_semantics() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let mk = |name: &'static str| { let root = root.clone(); async move {
        root.create_subaccount(name).initial_balance(NearToken::from_near(50)).transact().await.unwrap().into_result().unwrap() } };
    let owner = mk("owner").await;
    let lp = mk("lp").await;
    let tok = wasm(&format!("{SPIKE1}/token.wasm"));
    let tx: Contract = mk("aaa").await.deploy(&tok).await?.into_result()?; // sorts first: token_x
    let ty: Contract = mk("bbb").await.deploy(&tok).await?.into_result()?; // token_y
    for t in [&tx, &ty] { t.call("new").args_json(json!({"owner_id": lp.id(), "total_supply": "1000000000000000"})).transact().await?.into_result()?; }
    let dcl: Contract = mk("dcl").await.deploy(&wasm(concat!(env!("CARGO_MANIFEST_DIR"), "/wasm/dclv2-2.4.2.wasm"))).await?.into_result()?;
    dcl.call("new").args_json(json!({"owner_id": owner.id(), "wnear_id": owner.id(), "farming_contract_id": owner.id()})).transact().await?.into_result()?;
    for t in [&tx, &ty] { root.call(t.id(), "storage_deposit").args_json(json!({"account_id": dcl.id()})).deposit(NearToken::from_millinear(10)).transact().await?.into_result()?; }
    owner.call(dcl.id(), "extend_whitelisted_tokens").args_json(json!({"token_ids": [tx.id(), ty.id()]})).deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    // Bounds: try init points around +-800000.
    for (p, fee) in [(800_001i64, 400), (-800_001, 1000), (800_000, 2000), (-800_000, 10000)] {
        let r = owner.call(dcl.id(), "create_pool").args_json(json!({"token_a": tx.id(), "token_b": ty.id(), "fee": fee, "init_point": p})).deposit(NearToken::from_near(1)).max_gas().transact().await?;
        println!("create_pool fee={fee} init_point={p}: success={}", r.is_success());
        if let Err(e) = r.into_result() { let s = format!("{e:?}"); println!("   error: {}", &s[s.find("panicked").unwrap_or(0)..].chars().take(160).collect::<String>()); }
    }
    // Direction: pool at init_point 6932 (1.0001^6932 ~ 2.0).
    owner.call(dcl.id(), "create_pool").args_json(json!({"token_a": tx.id(), "token_b": ty.id(), "fee": 100, "init_point": 6932})).deposit(NearToken::from_near(1)).max_gas().transact().await?.into_result()?;
    lp.call(dcl.id(), "storage_deposit").args_json(json!({"account_id": lp.id()})).deposit(NearToken::from_near(2)).transact().await?.into_result()?;
    for t in [&tx, &ty] {
        lp.call(t.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl.id(), "amount": "100000000000", "msg": "\"Deposit\""})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    }
    let pid = format!("{}|{}|100", tx.id(), ty.id());
    for (l, r) in [(6432i64, 7432i64), (6932, 7932), (5932, 6932), (6933, 7933), (5931, 6931)] {
        let res = lp.call(dcl.id(), "add_liquidity").args_json(json!({"pool_id": pid, "left_point": l, "right_point": r, "amount_x": "1000000000", "amount_y": "1000000000", "min_amount_x": "0", "min_amount_y": "0"})).max_gas().transact().await?;
        let logs: Vec<String> = res.receipt_outcomes().iter().flat_map(|o| o.logs.clone()).filter(|l| l.contains("liquidity_added")).collect();
        let paid = logs.first().map(|l| {
            let v: serde_json::Value = serde_json::from_str(l.trim_start_matches("EVENT_JSON:")).unwrap();
            (v["data"][0]["paid_token_x"].as_str().unwrap_or("?").to_string(), v["data"][0]["paid_token_y"].as_str().unwrap_or("?").to_string())
        });
        println!("current 6932, range [{l},{r}): success={} paid (x,y)={:?}", res.is_success(), paid);
    }
    let pool: serde_json::Value = dcl.view("get_pool").args_json(json!({"pool_id": pid})).await?.json()?;
    println!("pool current_point={}", pool["current_point"]);
    let _ = worker;
    Ok(())
}
