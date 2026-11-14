//! Gate 3 part C: Rhea DCL called cross-contract from a probe that stands in for
//! the strategy. Each step prints what the probe's callback was told, what reads
//! issued from that callback saw, and the block of every receipt, so the order of
//! DCL's payouts and lost-and-found bookkeeping against our callback is visible.
//! Throwaway code; findings go to docs/gates/3-rhea-and-access-keys.md.
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const SPIKE1: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../gate3-access-keys/target/wasm32-unknown-unknown/release");
fn wasm(p: &str) -> Vec<u8> { std::fs::read(p).unwrap_or_else(|_| panic!("missing {p}")) }

async fn trace(w: &Worker<Sandbox>, label: &str, r: &ExecutionFinalResult) -> anyhow::Result<()> {
    println!("=== {label}: success={}", r.is_success());
    for o in r.receipt_outcomes() {
        let h = w.view_block().block_hash(o.block_hash).await.map(|b| b.height()).unwrap_or(0);
        let status = if o.is_failure() { format!("FAILED {:?}", o.clone().into_result().err()) } else { "ok".into() };
        println!("  block {h} [{}] gas={}Tgas {status} logs={:?}", o.executor_id, o.gas_burnt.as_tgas(), o.logs);
    }
    Ok(())
}

struct Env { w: Worker<Sandbox>, owner: Account, lp: Account, usdc: Contract, wrap: Contract, dcl: Contract, probe: Contract, pid: String }

impl Env {
    /// The probe calls `receiver.method(args)` and its callback issues `reads`.
    async fn run(&self, tag: &str, receiver: &near_workspaces::AccountId, method: &str, args: Value, deposit: u128, gas: u64, reads: Vec<(&near_workspaces::AccountId, &str, Value)>) -> anyhow::Result<(Vec<String>, Vec<String>)> {
        self.probe.call("clear_log").transact().await?.into_result()?;
        let reads: Vec<Value> = reads.into_iter().map(|(c, m, a)| json!({"contract": c, "method": m, "args": a.to_string()})).collect();
        let r = self.probe.call("run").args_json(json!({"tag": tag, "receiver": receiver, "method": method, "args": args.to_string(), "deposit": deposit.to_string(), "gas_tgas": gas, "reads": reads})).max_gas().transact().await?;
        trace(&self.w, tag, &r).await?;
        assert!(r.is_success(), "probe.run itself must succeed: {tag}");
        let log: Vec<String> = self.probe.view("get_log").await?.json()?;
        for l in &log { println!("  probe: {l}"); }
        let mut logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
        for o in r.receipt_outcomes() { if o.is_failure() { logs.push(format!("FAILED {:?}", o.clone().into_result().err())); } }
        Ok((logs, log))
    }
    async fn bal(&self, t: &Contract) -> anyhow::Result<String> { Ok(t.view("ft_balance_of").args_json(json!({"account_id": self.probe.id()})).await?.json()?) }
    async fn internal(&self, t: &near_workspaces::AccountId) -> anyhow::Result<u128> {
        let a = self.view("list_user_assets", json!({"account_id": self.probe.id()})).await?;
        match a.get(t.as_str()) { None => Ok(0), Some(v) => Ok(v.as_str().ok_or_else(|| anyhow::anyhow!("non-string asset {v}"))?.parse()?) }
    }
    async fn view(&self, m: &str, a: Value) -> anyhow::Result<Value> { Ok(self.dcl.view(m).args_json(a).await?.json()?) }
}

async fn setup() -> anyhow::Result<Env> {
    let w = near_workspaces::sandbox().await?;
    let root = w.root_account()?;
    let mk = |name: &'static str, near: u128| { let root = root.clone(); async move {
        root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await.unwrap().into_result().unwrap() } };
    let owner = mk("owner", 50).await;
    let lp = mk("lp", 200).await;
    let usdc: Contract = mk("usdc", 50).await.deploy(&wasm(&format!("{SPIKE1}/btoken.wasm"))).await?.into_result()?;
    usdc.call("new").args_json(json!({"owner_id": lp.id(), "total_supply": "1000000000000000000000000"})).transact().await?.into_result()?;
    let wrap: Contract = mk("wrap", 50).await.deploy(&wasm(concat!(env!("CARGO_MANIFEST_DIR"), "/wasm/wrap-near.wasm"))).await?.into_result()?;
    wrap.call("new").args_json(json!({})).transact().await?.into_result()?;
    let dcl: Contract = mk("dcl", 50).await.deploy(&wasm(concat!(env!("CARGO_MANIFEST_DIR"), "/wasm/dclv2-2.4.2.wasm"))).await?.into_result()?;
    dcl.call("new").args_json(json!({"owner_id": owner.id(), "wnear_id": wrap.id(), "farming_contract_id": owner.id()})).transact().await?.into_result()?;
    let probe: Contract = mk("probe", 50).await.deploy(&wasm(&format!("{SPIKE1}/probe.wasm"))).await?.into_result()?;
    probe.call("new").args_json(json!({"owner": probe.id()})).transact().await?.into_result()?;
    for a in [dcl.id(), lp.id(), probe.id()] {
        for t in [&usdc, &wrap] {
            root.call(t.id(), "storage_deposit").args_json(json!({"account_id": a})).deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
        }
    }
    owner.call(dcl.id(), "extend_whitelisted_tokens").args_json(json!({"token_ids": [usdc.id(), wrap.id()]})).deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    // Fee tier 100 is the v1 pool's tier (D32); fall back to 2000 if this build doesn't enable it.
    let mut pid = String::new();
    for fee in [100] {
        let r = owner.call(dcl.id(), "create_pool").args_json(json!({"token_a": usdc.id(), "token_b": wrap.id(), "fee": fee, "init_point": 0})).deposit(NearToken::from_near(1)).max_gas().transact().await?;
        if r.is_success() { pid = r.json::<String>()?; break; }
        println!("create_pool fee {fee} refused: {:?}", r.into_result().err());
    }
    assert_eq!(pid, format!("{}|{}|100", usdc.id(), wrap.id()), "fee-100 pool must be created");
    println!("pool {pid}");
    for a in [&lp] {
        a.call(dcl.id(), "storage_deposit").args_json(json!({"account_id": a.id()})).deposit(NearToken::from_near(5)).transact().await?.into_result()?;
        // register_tokens panics with E104 here even with 5 NEAR of storage; deposits work without it.
        let r = a.call(dcl.id(), "register_tokens").args_json(json!({"token_ids": [usdc.id(), wrap.id()]})).deposit(NearToken::from_yoctonear(1)).transact().await?;
        println!("setup: lp register_tokens success={}", r.is_success());
    }
    println!("setup: lp registered at dcl");
    lp.call(wrap.id(), "near_deposit").deposit(NearToken::from_near(100)).transact().await?.into_result()?;
    println!("setup: wrapped");
    // Funds for the probe, and background liquidity from lp so swaps have depth.
    for t in [&usdc, &wrap] {
        lp.call(t.id(), "ft_transfer").args_json(json!({"receiver_id": probe.id(), "amount": "10000000000000000000"})).deposit(NearToken::from_yoctonear(1)).transact().await?.into_result()?;
    }
    println!("setup: probe funded");
    for t in [&usdc, &wrap] {
        lp.call(t.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl.id(), "amount": "10000000000000000000", "msg": "\"Deposit\""})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?.into_result()?;
    }
    let r = lp.call(dcl.id(), "add_liquidity").args_json(json!({"pool_id": pid, "left_point": -20000, "right_point": 20000, "amount_x": "100000000", "amount_y": "100000000", "min_amount_x": "0", "min_amount_y": "0"})).max_gas().transact().await?;
    println!("lp background add: {}", r.is_success());
    Ok(Env { w, owner, lp, usdc, wrap, dcl, probe, pid })
}

#[tokio::test]
async fn cross_contract() -> anyhow::Result<()> {
    let e = setup().await?;
    let (dcl, usdc, wrap, p) = (e.dcl.id().clone(), e.usdc.id().clone(), e.wrap.id().clone(), e.probe.id().clone());
    let lf = |t: &near_workspaces::AccountId| json!({"account_id": p, "token_id": t});

    println!("\n##### 1. storage and registration from the probe");
    e.run("dcl.storage_deposit", &dcl, "storage_deposit", json!({"account_id": p}), 1_000_000_000_000_000_000_000_000, 20, vec![(&dcl, "storage_balance_of", json!({"account_id": p}))]).await?;
    assert_eq!(e.view("storage_balance_of", json!({"account_id": p})).await?["total"], json!("1000000000000000000000000"), "probe registered at DCL with 1 NEAR");
    e.run("dcl.register_tokens", &dcl, "register_tokens", json!({"token_ids": [usdc, wrap]}), 1, 20, vec![]).await?;

    println!("\n##### 2. deposits by ft_transfer_call (what does the callback get?)");
    for t in [&usdc, &wrap] {
        e.run(&format!("deposit {t}"), t, "ft_transfer_call", json!({"receiver_id": dcl, "amount": "1000000000", "msg": "\"Deposit\""}), 1, 60,
            vec![(&dcl, "list_user_assets", json!({"account_id": p})), (t, "ft_balance_of", json!({"account_id": p}))]).await?;
    }

    println!("\n##### 3. views called cross-contract");
    e.run("views", &dcl, "get_pool", json!({"pool_id": e.pid}), 0, 10, vec![
        (&dcl, "quote", json!({"pool_ids": [e.pid], "input_token": usdc, "output_token": wrap, "input_amount": "1000", "tag": null})),
        (&dcl, "predict_add_liquidity", json!({"pool_id": e.pid, "left_point": -1000, "right_point": 1000, "amount_x": "1000000", "amount_y": "1000000"})),
        (&dcl, "get_lostfound", lf(&usdc)),
    ]).await?;

    println!("\n##### 4. add with mismatched amounts: where does the unused part go?");
    let ux0 = e.view("list_user_assets", json!({"account_id": p})).await?;
    let bx0 = (e.bal(&e.usdc).await?, e.bal(&e.wrap).await?);
    e.run("add_liquidity", &dcl, "add_liquidity", json!({"pool_id": e.pid, "left_point": -1000, "right_point": 1000, "amount_x": "500000000", "amount_y": "100000000", "min_amount_x": "0", "min_amount_y": "0"}), 0, 150,
        vec![(&dcl, "list_liquidities", json!({"account_id": p})), (&dcl, "list_user_assets", json!({"account_id": p}))]).await?;
    println!("  internal before {ux0} after {}", e.view("list_user_assets", json!({"account_id": p})).await?);
    println!("  wallet before {bx0:?} after {:?}", (e.bal(&e.usdc).await?, e.bal(&e.wrap).await?));
    let pos = e.view("list_liquidities", json!({"account_id": p})).await?;
    let lpt = pos[0]["lpt_id"].as_str().unwrap_or_default().to_string();
    println!("  probe position {}", pos[0]);

    println!("\n##### 4b. the same add with skip_unwrap_near: is the wNEAR refund still unwrapped?");
    let n0: String = e.probe.view("native_balance").await?.json()?;
    e.run("add_liquidity skip_unwrap", &dcl, "add_liquidity", json!({"pool_id": e.pid, "left_point": -1000, "right_point": 1000, "amount_x": "100000000", "amount_y": "300000000", "min_amount_x": "0", "min_amount_y": "0", "skip_unwrap_near": true}), 0, 150,
        vec![(&dcl, "list_user_assets", json!({"account_id": p})), (&wrap, "ft_balance_of", json!({"account_id": p}))]).await?;
    let n1: String = e.probe.view("native_balance").await?.json()?;
    println!("  probe native NEAR before {n0} after {n1}");

    println!("\n##### 5. fees: does get_liquidity's unclaimed_fee update in a view without touching the position?");
    println!("  before swaps: {}", e.view("get_liquidity", json!({"lpt_id": lpt})).await?);
    for (t, out) in [(&e.usdc, &wrap), (&e.wrap, &usdc)] {
        let r = e.lp.call(t.id(), "ft_transfer_call").args_json(json!({"receiver_id": dcl, "amount": "300000000", "msg": json!({"Swap": {"pool_ids": [e.pid], "output_token": out, "min_output_amount": "0", "skip_unwrap_near": true}}).to_string()})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
        println!("  lp swap via {}: {}", t.id(), r.is_success());
    }
    println!("  after swaps: {}", e.view("get_liquidity", json!({"lpt_id": lpt})).await?);
    println!("  list_liquidities: {}", e.view("list_liquidities", json!({"account_id": p})).await?[0]);

    println!("\n##### 6. a refused swap (min_output impossible): what does ft_transfer_call report?");
    e.run("swap refused", &usdc, "ft_transfer_call", json!({"receiver_id": dcl, "amount": "1000000", "msg": json!({"Swap": {"pool_ids": [e.pid], "output_token": wrap, "min_output_amount": "1000000000000", "skip_unwrap_near": true}}).to_string()}), 1, 100,
        vec![(&usdc, "ft_balance_of", json!({"account_id": p})), (&wrap, "ft_balance_of", json!({"account_id": p}))]).await?;

    let log: Vec<String> = e.probe.view("get_log").await?.json()?;
    assert!(log.iter().any(|l| l.contains("swap refused callback") && l.contains("result=ok:\"0\"")), "refused swap must report 0 used");
    println!("\n##### 7. usdc blocks the probe; remove the position: what does our callback see, and when?");
    e.lp.call(&usdc, "set_blocked").args_json(json!({"account_id": p, "blocked": true})).transact().await?.into_result()?;
    let liq = e.view("get_liquidity", json!({"lpt_id": lpt})).await?;
    println!("  predict_remove {}", e.view("predict_remove_liquidity", json!({"lpt_id": lpt, "amount": liq["amount"]})).await.map(|v| v.to_string()).unwrap_or_else(|x| x.to_string()));
    let b0 = (e.bal(&e.usdc).await?, e.bal(&e.wrap).await?);
    let i0 = e.internal(&usdc).await?;
    e.run("remove (usdc blocked)", &dcl, "remove_liquidity", json!({"lpt_id": lpt, "amount": liq["amount"], "min_amount_x": "0", "min_amount_y": "0", "skip_unwrap_near": true}), 0, 150,
        vec![(&dcl, "get_lostfound", lf(&usdc)), (&usdc, "ft_balance_of", json!({"account_id": p})), (&wrap, "ft_balance_of", json!({"account_id": p}))]).await?;
    let b1 = (e.bal(&e.usdc).await?, e.bal(&e.wrap).await?);
    println!("  wallet before {b0:?} after {b1:?}; lostfound usdc {}", e.view("get_lostfound", lf(&usdc)).await?);
    assert_eq!(b0.0, b1.0, "blocked usdc payout must not arrive");
    let log: Vec<String> = e.probe.view("get_log").await?.json()?;
    let cb = log.iter().find(|l| l.contains("remove (usdc blocked) callback")).cloned().unwrap_or_default();
    let rem: Vec<String> = serde_json::from_str(cb.split("result=ok:").nth(1).and_then(|x| x.split(" prepaid").next()).unwrap_or("[]"))?;
    assert_eq!(rem.len(), 2, "remove callback is told [x, y] although the x payout failed: {cb}");
    assert!(rem[0].parse::<u128>()? > 0);
    assert_eq!(rem, vec!["79509995".to_string(), "120505042".to_string()], "remove callback result");
    assert_eq!(e.internal(&usdc).await? - i0, rem[0].parse::<u128>()?, "the failed x payout lands in the internal balance, exactly");
    assert_eq!(b1.1.parse::<u128>()? - b0.1.parse::<u128>()?, rem[1].parse::<u128>()?, "the y payout arrives in the wallet, exactly");
    assert_eq!(e.view("get_lostfound", lf(&usdc)).await?, json!("0"), "registered account: nothing in get_lostfound");

    println!("\n##### 8. swap whose output (usdc) is blocked");
    let i8 = e.internal(&usdc).await?;
    let (sw_logs, sw_log) = e.run("swap, output blocked", &wrap, "ft_transfer_call", json!({"receiver_id": dcl, "amount": "1000000", "msg": json!({"Swap": {"pool_ids": [e.pid], "output_token": usdc, "min_output_amount": "1", "skip_unwrap_near": true}}).to_string()}), 1, 100,
        vec![(&dcl, "get_lostfound", lf(&usdc)), (&usdc, "ft_balance_of", json!({"account_id": p}))]).await?;
    assert!(sw_log.iter().any(|l| l.contains("swap, output blocked callback") && l.contains("result=ok:\"1000000\"")), "swap callback told the whole input used although the output failed");
    let sw_out: u128 = sw_logs.iter().find(|l| l.contains("\"event\":\"swap\"")).and_then(|l| l.split("\"amount_out\":\"").nth(1)).and_then(|x| x.split('"').next()).unwrap_or("0").parse()?;
    assert!(sw_out > 0);
    assert_eq!(e.internal(&usdc).await? - i8, sw_out, "the failed swap output lands in the internal balance, exactly");
    assert_eq!(e.view("get_lostfound", lf(&usdc)).await?, json!("0"));
    assert!(sw_logs.iter().any(|l| l.contains("\"event\":\"lostfound\"") && l.contains("\"locked\":false")));

    println!("\n##### 9. withdraw_asset of usdc while blocked");
    let i9 = e.internal(&usdc).await?;
    assert_eq!(i9, i0 + rem[0].parse::<u128>()? + sw_out, "internal balance = before + failed remove x + failed swap output");
    e.run("withdraw_asset usdc (blocked)", &dcl, "withdraw_asset", json!({"token_id": usdc, "skip_unwrap_near": true}), 0, 100,
        vec![(&dcl, "get_lostfound", lf(&usdc)), (&dcl, "list_user_assets", json!({"account_id": p}))]).await?;

    let log: Vec<String> = e.probe.view("get_log").await?.json()?;
    assert!(log.iter().any(|l| l.contains("withdraw_asset usdc (blocked) callback") && l.contains("result=ok:false")), "withdraw_asset returns false while blocked");
    assert_eq!(e.internal(&usdc).await?, i9, "a blocked withdraw leaves the internal balance unchanged");
    assert_eq!(e.view("get_lostfound", lf(&usdc)).await?, json!("0"));
    let w9 = e.bal(&e.usdc).await?.parse::<u128>()?;
    println!("\n##### 9b. after the block lifts: withdraw_asset recovers the internal balance?");
    e.lp.call(&usdc, "set_blocked").args_json(json!({"account_id": p, "blocked": false})).transact().await?.into_result()?;
    e.run("withdraw_asset usdc (unblocked)", &dcl, "withdraw_asset", json!({"token_id": usdc, "skip_unwrap_near": true}), 0, 100,
        vec![(&dcl, "list_user_assets", json!({"account_id": p})), (&usdc, "ft_balance_of", json!({"account_id": p}))]).await?;
    let log: Vec<String> = e.probe.view("get_log").await?.json()?;
    assert!(log.iter().any(|l| l.contains("withdraw_asset usdc (unblocked) callback") && l.contains("result=ok:true")), "withdraw_asset returns true once unblocked");
    assert_eq!(e.bal(&e.usdc).await?.parse::<u128>()? - w9, i9, "the wallet gains exactly the internal amount");
    let ua = e.view("list_user_assets", json!({"account_id": p})).await?;
    assert!(ua.get(usdc.as_str()).map_or(true, |v| v == &json!("0")), "the internal entry is emptied: {ua}");
    e.lp.call(&usdc, "set_blocked").args_json(json!({"account_id": p, "blocked": true})).transact().await?.into_result()?;
    println!("  list_lostfound {}", e.view("list_lostfound", json!({})).await.map(|v| v.to_string()).unwrap_or_else(|x| x.to_string()));

    println!("\n##### 10. withdraw_lostfound while blocked, then unblocked");
    let wb10 = e.bal(&e.usdc).await?;
    let (wl_logs, wl_log) = e.run("withdraw_lostfound usdc (blocked)", &dcl, "withdraw_lostfound", json!({"token_id": usdc}), 1, 100,
        vec![(&dcl, "get_lostfound", lf(&usdc)), (&usdc, "ft_balance_of", json!({"account_id": p}))]).await?;
    assert!(wl_log.iter().any(|l| l.contains("withdraw_lostfound usdc (blocked) callback") && l.contains("result=failed")), "withdraw_lostfound refused for a registered account");
    assert!(wl_logs.iter().any(|l| l.contains("E002: not allowed for the caller")), "refused with E002");
    assert_eq!(e.bal(&e.usdc).await?, wb10);
    e.lp.call(&usdc, "set_blocked").args_json(json!({"account_id": p, "blocked": false})).transact().await?.into_result()?;
    e.run("withdraw_lostfound usdc (unblocked)", &dcl, "withdraw_lostfound", json!({"token_id": usdc}), 1, 100,
        vec![(&dcl, "get_lostfound", lf(&usdc)), (&usdc, "ft_balance_of", json!({"account_id": p}))]).await?;

    println!("\n##### 11. wNEAR in lost and found: does withdraw_lostfound unwrap?");
    // Make a wNEAR payout fail: the probe unregisters from wrap (balance moved out first).
    let wb = e.bal(&e.wrap).await?;
    e.run("move wnear out", &wrap, "ft_transfer", json!({"receiver_id": e.lp.id(), "amount": wb}), 1, 20, vec![]).await?;
    e.run("wrap.storage_unregister", &wrap, "storage_unregister", json!({"force": true}), 1, 20, vec![]).await?;
    let (wa_logs, wa_log) = e.run("withdraw_asset wrap (unregistered)", &dcl, "withdraw_asset", json!({"token_id": wrap, "skip_unwrap_near": true}), 0, 100,
        vec![(&dcl, "get_lostfound", lf(&wrap))]).await?;
    assert!(wa_log.iter().any(|l| l.contains("withdraw_asset wrap (unregistered) callback") && l.contains("result=ok:false")), "withdraw_asset false when unregistered at the token");
    assert!(wa_logs.iter().any(|l| l.contains("\"event\":\"lostfound\"") && l.contains("\"locked\":false")));
    e.run("wrap.storage_deposit", &wrap, "storage_deposit", json!({"account_id": p}), 10_000_000_000_000_000_000_000, 20, vec![]).await?;
    let n0: String = e.probe.view("native_balance").await?.json()?;
    e.run("withdraw_lostfound wrap (no flag)", &dcl, "withdraw_lostfound", json!({"token_id": wrap}), 1, 100,
        vec![(&dcl, "get_lostfound", lf(&wrap)), (&wrap, "ft_balance_of", json!({"account_id": p}))]).await?;
    let n1: String = e.probe.view("native_balance").await?.json()?;
    println!("  probe native NEAR before {n0} after {n1}; wNEAR {}", e.bal(&e.wrap).await?);
    e.run("withdraw_lostfound wrap (skip_unwrap_near)", &dcl, "withdraw_lostfound", json!({"token_id": wrap, "skip_unwrap_near": true}), 1, 100, vec![]).await?;

    println!("\n##### 12. a gifted position: does it use the probe's DCL storage?");
    let s0 = e.view("storage_balance_of", json!({"account_id": p})).await?;
    let lpos = e.view("list_liquidities", json!({"account_id": e.lp.id()})).await?;
    let gift = lpos[0]["lpt_id"].as_str().unwrap_or_default().to_string();
    let r = e.lp.call(&dcl, "nft_transfer").args_json(json!({"receiver_id": p, "token_id": gift})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
    trace(&e.w, "gift nft_transfer", &r).await?;
    println!("  probe dcl storage before {s0} after {}", e.view("storage_balance_of", json!({"account_id": p})).await?);
    println!("  lp dcl storage {}", e.view("storage_balance_of", json!({"account_id": e.lp.id()})).await?);
    let _ = &e.owner;
    Ok(())
}

/// Evidence (DCL behaviour, not a contract test) for: T59, EC-C100.
/// Audit H1 of part C: a payee with no DCL storage gets `locked: true` lost and found,
/// which only DCL's owner can withdraw, and only to itself.
#[tokio::test]
async fn locked_lostfound() -> anyhow::Result<()> {
    let e = setup().await?;
    let (dcl, usdc, wrap) = (e.dcl.id().clone(), e.usdc.id().clone(), e.wrap.id().clone());
    let stranger = e.w.root_account()?.create_subaccount("stranger").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    for t in [&usdc, &wrap] {
        e.w.root_account()?.call(t, "storage_deposit").args_json(json!({"account_id": stranger.id()})).deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
    }
    stranger.call(&wrap, "near_deposit").deposit(NearToken::from_near(1)).transact().await?.into_result()?;
    e.lp.call(&usdc, "set_blocked").args_json(json!({"account_id": stranger.id(), "blocked": true})).transact().await?.into_result()?;
    // The stranger never calls DCL storage_deposit.
    let r = stranger.call(&wrap, "ft_transfer_call").args_json(json!({"receiver_id": dcl, "amount": "1000000", "msg": json!({"Swap": {"pool_ids": [e.pid], "output_token": usdc, "min_output_amount": "1", "skip_unwrap_near": true}}).to_string()})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
    trace(&e.w, "unregistered swap, output blocked", &r).await?;
    let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
    assert!(logs.iter().any(|l| l.contains("\"event\":\"lostfound\"") && l.contains("\"locked\":true")), "expected locked lostfound, logs {logs:?}");
    let lf: String = e.dcl.view("get_lostfound").args_json(json!({"account_id": stranger.id(), "token_id": usdc})).await?.json()?;
    println!("  get_lostfound(stranger, usdc) = {lf}");
    let out = logs.iter().find(|l| l.contains("\"event\":\"swap\"")).and_then(|l| l.split("\"amount_out\":\"").nth(1)).and_then(|x| x.split('"').next()).unwrap_or("").to_string();
    assert_eq!(lf, out, "lost and found holds exactly the swap output");
    assert!(lf.parse::<u128>()? > 0);
    e.lp.call(&usdc, "set_blocked").args_json(json!({"account_id": stranger.id(), "blocked": false})).transact().await?.into_result()?;
    let r = stranger.call(&dcl, "withdraw_lostfound").args_json(json!({"token_id": usdc})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
    let err = format!("{:?}", r.clone().into_result().err());
    println!("  stranger withdraw_lostfound: {err}");
    assert!(err.contains("E002: not allowed for the caller"));
    e.w.root_account()?.call(&usdc, "storage_deposit").args_json(json!({"account_id": e.owner.id()})).deposit(NearToken::from_millinear(10)).transact().await?.into_result()?;
    let s0: String = e.usdc.view("ft_balance_of").args_json(json!({"account_id": stranger.id()})).await?.json()?;
    let o0: String = e.usdc.view("ft_balance_of").args_json(json!({"account_id": e.owner.id()})).await?.json()?;
    let r = e.owner.call(&dcl, "withdraw_lostfound").args_json(json!({"token_id": usdc, "account_id": stranger.id()})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
    trace(&e.w, "owner withdraw_lostfound", &r).await?;
    let o1: String = e.usdc.view("ft_balance_of").args_json(json!({"account_id": e.owner.id()})).await?.json()?;
    let s1: String = e.usdc.view("ft_balance_of").args_json(json!({"account_id": stranger.id()})).await?.json()?;
    println!("  owner usdc before {o0} after {o1}; stranger before {s0} after {s1}");
    assert_eq!(o1.parse::<u128>()? - o0.parse::<u128>()?, lf.parse::<u128>()?, "the owner receives the locked amount");
    assert_eq!(s0, s1, "the payee receives nothing");
    let after: String = e.dcl.view("get_lostfound").args_json(json!({"account_id": stranger.id(), "token_id": usdc})).await?.json()?;
    assert_eq!(after, "0", "lost and found emptied, no second withdrawal possible");
    let wl: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
    assert!(wl.iter().any(|l| l.contains(&format!("\"recipient_id\":\"{}\"", e.owner.id()))), "recipient is the owner: {wl:?}");
    Ok(())
}

/// Audit L2 of part C: how much gas do cross-contract views really need?
#[tokio::test]
async fn view_gas() -> anyhow::Result<()> {
    let e = setup().await?;
    let (dcl, usdc, wrap) = (e.dcl.id().clone(), e.usdc.id().clone(), e.wrap.id().clone());
    let mut seen = Vec::new();
    for tgas in [5u64, 10, 15] {
        e.probe.call("set_read_gas").args_json(json!({"tgas": tgas})).transact().await?.into_result()?;
        e.run(&format!("views at {tgas} Tgas"), &dcl, "get_pool", json!({"pool_id": e.pid}), 0, 10, vec![
            (&dcl, "quote", json!({"pool_ids": [e.pid], "input_token": usdc, "output_token": wrap, "input_amount": "1000", "tag": null})),
            (&dcl, "predict_add_liquidity", json!({"pool_id": e.pid, "left_point": -1000, "right_point": 1000, "amount_x": "1000000", "amount_y": "1000000"})),
        ]).await?;
        let log: Vec<String> = e.probe.view("get_log").await?.json()?;
        let reads = log.iter().find(|l| l.contains(" reads ")).cloned().unwrap_or_default();
        seen.push((reads.matches("\"failed\"").count(), reads.contains("need_x")));
    }
    // (failed reads, predict worked): 5 Tgas both fail; 10 only predict works; 15 both work.
    assert_eq!(seen, vec![(2, false), (1, true), (0, true)], "view gas pattern changed: {seen:?}");
    Ok(())
}

/// Re-audit M1 of part C: a registered account whose failed payout is in a token it has
/// no internal entry for. Is it still "locked": false?
#[tokio::test]
async fn registered_no_entry() -> anyhow::Result<()> {
    let e = setup().await?;
    let (dcl, usdc, wrap, p) = (e.dcl.id().clone(), e.usdc.id().clone(), e.wrap.id().clone(), e.probe.id().clone());
    e.run("dcl.storage_deposit", &dcl, "storage_deposit", json!({"account_id": p}), 1_000_000_000_000_000_000_000_000, 20, vec![]).await?;
    let assets = e.view("list_user_assets", json!({"account_id": p})).await?;
    println!("  probe assets before (no usdc entry expected): {assets}");
    assert!(assets.get(usdc.as_str()).is_none());
    e.lp.call(&usdc, "set_blocked").args_json(json!({"account_id": p, "blocked": true})).transact().await?.into_result()?;
    e.probe.call("clear_log").transact().await?.into_result()?;
    let r = e.probe.call("run").args_json(json!({"tag": "swap new token blocked", "receiver": wrap, "method": "ft_transfer_call",
        "args": json!({"receiver_id": dcl, "amount": "1000000", "msg": json!({"Swap": {"pool_ids": [e.pid], "output_token": usdc, "min_output_amount": "1", "skip_unwrap_near": true}}).to_string()}).to_string(),
        "deposit": "1", "gas_tgas": 100, "reads": []})).max_gas().transact().await?;
    trace(&e.w, "registered, no usdc entry, output blocked", &r).await?;
    let plog: Vec<String> = e.probe.view("get_log").await?.json()?;
    assert!(plog.iter().any(|l| l.contains("swap new token blocked callback") && l.contains("result=ok:\"1000000\"")), "whole input reported used: {plog:?}");
    let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
    let ev = logs.iter().find(|l| l.contains("\"event\":\"lostfound\"")).cloned().unwrap_or_default();
    println!("  lostfound event: {ev}");
    println!("  assets after {}; get_lostfound {}", e.view("list_user_assets", json!({"account_id": p})).await?, e.view("get_lostfound", json!({"account_id": p, "token_id": usdc})).await?);
    assert!(ev.contains("\"locked\":false"), "registered account, new token: expected locked false, got {ev}");
    let out = logs.iter().find(|l| l.contains("\"event\":\"swap\"")).and_then(|l| l.split("\"amount_out\":\"").nth(1)).and_then(|x| x.split('"').next()).unwrap_or("").to_string();
    assert_eq!(e.view("list_user_assets", json!({"account_id": p})).await?[usdc.as_str()], json!(out), "DCL creates the internal entry with exactly the swap output");
    assert_eq!(e.view("storage_balance_of", json!({"account_id": p})).await?["total"], json!("1000000000000000000000000"), "the probe is registered at DCL with 1 NEAR");
    assert_eq!(e.view("get_lostfound", json!({"account_id": p, "token_id": usdc})).await?, json!("0"));
    Ok(())
}

/// Evidence (DCL behaviour, not a contract test) for: EC-C104, EC-C105, EC-C106, T61, T62.
/// Audit G4 / T61, and test re-audit G1 / G2: gift positions to a registered account at minimum
/// DCL storage, measure DCL's storage use per gift, check the account can still act, then fail a
/// payout. Also: the same swap at 100 Tgas runs out of gas once many small positions sit in range.
#[tokio::test]
async fn storage_exhausted() -> anyhow::Result<()> {
    let e = setup().await?;
    let (dcl, usdc, wrap, p) = (e.dcl.id().clone(), e.usdc.id().clone(), e.wrap.id().clone(), e.probe.id().clone());
    let bounds = e.view("storage_balance_bounds", json!({})).await?;
    let min: u128 = bounds["min"].as_str().expect("min").parse()?;
    assert_eq!(min, 500_000_000_000_000_000_000_000, "DCL minimum storage is 0.5 NEAR");
    e.run("dcl.storage_deposit min", &dcl, "storage_deposit", json!({"account_id": p, "registration_only": true}), min, 20, vec![]).await?;
    assert_eq!(e.view("storage_balance_of", json!({"account_id": p})).await?["total"], json!(min.to_string()));
    let usage = |w: Worker<Sandbox>, a: near_workspaces::AccountId| async move { w.view_account(&a).await.map(|v| v.storage_usage).unwrap_or(0) };
    let mut gifted = 0u64;
    let mut per_gift = Vec::new();
    for k in 0..40 {
        let r = e.lp.call(&dcl, "add_liquidity").args_json(json!({"pool_id": e.pid, "left_point": -100 - k, "right_point": 100 + k, "amount_x": "1000", "amount_y": "1000", "min_amount_x": "0", "min_amount_y": "0"})).max_gas().transact().await?;
        assert!(r.is_success(), "lp add {k}");
        let lpt: String = r.json()?;
        let u0 = usage(e.w.clone(), dcl.clone()).await;
        let r = e.lp.call(&dcl, "nft_transfer").args_json(json!({"receiver_id": p, "token_id": lpt})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
        assert!(r.is_success(), "gift {k}");
        let u1 = usage(e.w.clone(), dcl.clone()).await;
        per_gift.push(u1 as i64 - u0 as i64);
        assert_eq!(e.view("get_liquidity", json!({"lpt_id": lpt})).await?["owner_id"], json!(p.to_string()), "gift {k} owned by the probe");
        gifted += 1;
    }
    let owned = e.view("list_liquidities", json!({"account_id": p})).await?;
    assert_eq!(owned.as_array().map(|a| a.len()), Some(40));
    println!("  DCL storage_usage change per gift (bytes): {per_gift:?}");
    let det = e.view("get_user_storage_detail", json!({"user_id": p})).await?;
    println!("  probe storage detail after {gifted} gifts {det}");
    assert_eq!(det["max_slots"], json!(40), "0.5 NEAR gives 40 liquidity slots");
    assert_eq!(det["cur_liquidity_slots"], json!(40), "each gift takes one of the receiver's slots");
    assert_eq!(det["slot_price"], json!("10000000000000000000000"), "slot price 0.01 NEAR");
    assert_eq!(det["storage_for_asset"], json!("100000000000000000000000"), "asset storage 0.1 NEAR");
    // The 41st gift is refused.
    let r = e.lp.call(&dcl, "add_liquidity").args_json(json!({"pool_id": e.pid, "left_point": -200, "right_point": 200, "amount_x": "1000", "amount_y": "1000", "min_amount_x": "0", "min_amount_y": "0"})).max_gas().transact().await?;
    let lpt41: String = r.json()?;
    let r = e.lp.call(&dcl, "nft_transfer").args_json(json!({"receiver_id": p, "token_id": lpt41})).deposit(NearToken::from_yoctonear(1)).max_gas().transact().await?;
    let err41 = format!("{:?}", r.clone().into_result().err());
    println!("  41st gift refused with E107: {}", err41.contains("E107"));
    assert!(!r.is_success(), "the 41st gift is refused at full slots");
    assert!(err41.contains("E107"), "41st gift refused for slots (E107): {err41}");
    // Can the probe still act? A deposit and an add of its own.
    let (_, dl) = e.run("probe deposit after gifts", &wrap, "ft_transfer_call", json!({"receiver_id": dcl, "amount": "10000000", "msg": "\"Deposit\""}), 1, 60, vec![]).await?;
    let (_, udl) = e.run("probe usdc deposit after gifts", &usdc, "ft_transfer_call", json!({"receiver_id": dcl, "amount": "10000000", "msg": "\"Deposit\""}), 1, 60, vec![]).await?;
    assert!(dl.iter().any(|l| l.contains("probe deposit after gifts callback") && l.contains("result=ok:\"10000000\"")), "deposit works at full slots");
    assert!(udl.iter().any(|l| l.contains("probe usdc deposit after gifts callback") && l.contains("result=ok:\"10000000\"")), "usdc deposit works at full slots");
    let (iw, iu) = (e.internal(&wrap).await?, e.internal(&usdc).await?);
    let (al, alog) = e.run("probe add after gifts", &dcl, "add_liquidity", json!({"pool_id": e.pid, "left_point": -10, "right_point": 10, "amount_x": "1000000", "amount_y": "1000000", "min_amount_x": "0", "min_amount_y": "0"}), 0, 150, vec![]).await?;
    println!("  probe add after gifts: {:?} {:?}", alog.iter().find(|l| l.contains("callback")), al.iter().find(|l| l.starts_with("FAILED")));
    assert!(al.iter().any(|l| l.contains("E107: not enough storage for slots")), "40 gifts use up the probe's minimum DCL storage: its own add is refused");
    assert_eq!((e.internal(&wrap).await?, e.internal(&usdc).await?), (iw, iu), "an E107 add leaves the internal balances unchanged");
    // Evidence for EC-C105: the swap at 100 Tgas, then at 280.
    let w0 = e.bal(&e.wrap).await?;
    let iu0 = e.internal(&usdc).await?;
    let iw0 = e.internal(&wrap).await?;
    let (logs, plog) = e.run("swap at 100 Tgas", &wrap, "ft_transfer_call", json!({"receiver_id": dcl, "amount": "1000000", "msg": json!({"Swap": {"pool_ids": [e.pid], "output_token": usdc, "min_output_amount": "1", "skip_unwrap_near": true}}).to_string()}), 1, 100, vec![]).await?;
    assert!(logs.iter().any(|l| l.contains("Exceeded the prepaid gas")), "the swap runs out of gas at 100 Tgas: {logs:?}");
    assert_eq!(logs.iter().filter(|l| l.starts_with("FAILED")).count(), 1, "exactly one receipt failed (DCL's swap): {logs:?}");
    assert!(plog.iter().any(|l| l.contains("swap at 100 Tgas callback") && l.contains("result=ok:\"0\"")), "callback told 0 used");
    assert_eq!(e.bal(&e.wrap).await?, w0, "input refunded in full");
    assert_eq!(e.internal(&usdc).await?, iu0);
    assert_eq!(e.internal(&wrap).await?, iw0, "internal wNEAR unchanged too");
    assert_eq!(e.view("get_lostfound", json!({"account_id": p, "token_id": usdc})).await?, json!("0"));
    e.lp.call(&usdc, "set_blocked").args_json(json!({"account_id": p, "blocked": true})).transact().await?.into_result()?;
    // At exactly 40 of 40 slots (audit M1): a failed payout and withdraw_asset, before any remove.
    let slots = |e: &Env| { let (d, p) = (e.dcl.clone(), e.probe.id().clone()); async move { d.view("get_user_storage_detail").args_json(json!({"user_id": p})).await.unwrap().json::<Value>().unwrap()["cur_liquidity_slots"].clone() } };
    assert_eq!(slots(&e).await, json!(40));
    let ib = e.internal(&usdc).await?;
    let wn0 = e.bal(&e.wrap).await?.parse::<u128>()?;
    let (fl, fplog) = e.run("swap at full slots, output blocked", &wrap, "ft_transfer_call", json!({"receiver_id": dcl, "amount": "1000000", "msg": json!({"Swap": {"pool_ids": [e.pid], "output_token": usdc, "min_output_amount": "1", "skip_unwrap_near": true}}).to_string()}), 1, 280, vec![]).await?;
    assert!(fplog.iter().any(|l| l.contains("swap at full slots, output blocked callback") && l.contains("result=ok:\"1000000\"")));
    let fev = fl.iter().find(|l| l.contains("\"event\":\"lostfound\"")).cloned().expect("lostfound event at full slots");
    assert!(fev.contains("\"locked\":false"), "failed payout at 40 of 40 slots is unlocked: {fev}");
    let fout: u128 = fl.iter().find(|l| l.contains("\"event\":\"swap\"")).and_then(|l| l.split("\"amount_out\":\"").nth(1)).and_then(|x| x.split('"').next()).expect("swap event").parse()?;
    assert_eq!(wn0 - e.bal(&e.wrap).await?.parse::<u128>()?, 1_000_000, "the full input left the wallet");
    assert_eq!(e.internal(&usdc).await? - ib, fout);
    assert_eq!(e.view("get_lostfound", json!({"account_id": p, "token_id": usdc})).await?, json!("0"));
    assert_eq!(slots(&e).await, json!(40));
    let ib2 = e.internal(&usdc).await?;
    let (_, wlog) = e.run("withdraw_asset at full slots, blocked", &dcl, "withdraw_asset", json!({"token_id": usdc, "skip_unwrap_near": true}), 0, 100, vec![]).await?;
    assert!(wlog.iter().any(|l| l.contains("withdraw_asset at full slots, blocked callback") && l.contains("result=ok:false")));
    assert_eq!(e.internal(&usdc).await?, ib2, "blocked withdraw at full slots leaves the internal balance");
    assert_eq!(e.view("get_lostfound", json!({"account_id": p, "token_id": usdc})).await?, json!("0"));
    e.lp.call(&usdc, "set_blocked").args_json(json!({"account_id": p, "blocked": false})).transact().await?.into_result()?;
    let wb = e.bal(&e.usdc).await?.parse::<u128>()?;
    let (_, wlog) = e.run("withdraw_asset at full slots, unblocked", &dcl, "withdraw_asset", json!({"token_id": usdc, "skip_unwrap_near": true}), 0, 100, vec![]).await?;
    assert!(wlog.iter().any(|l| l.contains("withdraw_asset at full slots, unblocked callback") && l.contains("result=ok:true")));
    assert_eq!(e.bal(&e.usdc).await?.parse::<u128>()? - wb, ib2, "withdraw at full slots pays exactly the internal amount");
    assert_eq!(slots(&e).await, json!(40));
    e.lp.call(&usdc, "set_blocked").args_json(json!({"account_id": p, "blocked": true})).transact().await?.into_result()?;
    // Exits still work at full slots: remove a gifted position, which frees a slot.
    let g0 = owned[0]["lpt_id"].as_str().unwrap().to_string();
    let amt = owned[0]["amount"].clone();
    let (ru0, rw0) = (e.internal(&usdc).await?, e.bal(&e.wrap).await?.parse::<u128>()?);
    let (rl, _) = e.run("remove a gifted position at full slots", &dcl, "remove_liquidity", json!({"lpt_id": g0, "amount": amt, "min_amount_x": "0", "min_amount_y": "0", "skip_unwrap_near": true}), 0, 150, vec![]).await?;
    assert!(rl.iter().any(|l| l.contains("\"event\":\"liquidity_removed\"")), "remove works at full slots: {rl:?}");
    let ev = rl.iter().find(|l| l.contains("\"event\":\"liquidity_removed\"")).expect("removed event").clone();
    let field = |k: &str| -> u128 { ev.split(&format!("\"{k}\":\"")).nth(1).and_then(|x| x.split('"').next()).expect(k).parse().unwrap() };
    // Only the blocked USDC payout may fail, and only if the gift paid any USDC.
    let rfails: Vec<&String> = rl.iter().filter(|l| l.starts_with("FAILED")).collect();
    let want = if field("refund_token_x") > 0 { 1 } else { 0 };
    assert!(rfails.len() == want && rfails.iter().all(|l| l.contains("BLOCKED")), "only the blocked USDC payout failed: {rl:?}");
    assert_eq!(e.internal(&usdc).await? - ru0, field("refund_token_x"), "gift USDC lands in the internal balance (evidence for EC-C108)");
    assert_eq!(e.bal(&e.wrap).await?.parse::<u128>()? - rw0, field("refund_token_y"), "gift wNEAR lands in the wallet");
    assert_eq!(e.view("get_user_storage_detail", json!({"user_id": p})).await?["cur_liquidity_slots"], json!(39), "removing frees a slot");
    e.run("probe usdc deposit before re-add", &usdc, "ft_transfer_call", json!({"receiver_id": dcl, "amount": "10000000", "msg": "\"Deposit\""}), 1, 60, vec![]).await?;
    let (al2, al2log) = e.run("probe add after a freed slot", &dcl, "add_liquidity", json!({"pool_id": e.pid, "left_point": -10, "right_point": 10, "amount_x": "1000000", "amount_y": "1000000", "min_amount_x": "0", "min_amount_y": "0"}), 0, 150, vec![]).await?;
    // Check the add through its callback result, not its event (events can appear in failed receipts, T60);
    // the only failed receipt is the unused-USDC refund to the blocked probe.
    assert!(al2log.iter().any(|l| l.contains("probe add after a freed slot callback") && l.contains("result=ok:\"usdc.test.near|wrap.test.near|100#")), "the freed slot lets the probe add again: {al2log:?}");
    let fails: Vec<&String> = al2.iter().filter(|l| l.starts_with("FAILED")).collect();
    assert!(fails.len() == 1 && fails[0].contains("BLOCKED: receiver is blocked"), "exactly one failed receipt, the blocked refund: {al2:?}");
    assert_eq!(e.view("get_user_storage_detail", json!({"user_id": p})).await?["cur_liquidity_slots"], json!(40));
    let iu0 = e.internal(&usdc).await?;
    let (logs, plog) = e.run("swap at 280 Tgas, output blocked", &wrap, "ft_transfer_call", json!({"receiver_id": dcl, "amount": "1000000", "msg": json!({"Swap": {"pool_ids": [e.pid], "output_token": usdc, "min_output_amount": "1", "skip_unwrap_near": true}}).to_string()}), 1, 280, vec![]).await?;
    assert!(plog.iter().any(|l| l.contains("swap at 280 Tgas, output blocked callback") && l.contains("result=ok:\"1000000\"")));
    let ev = logs.iter().find(|l| l.contains("\"event\":\"lostfound\"")).cloned().expect("lostfound event after gifts");
    assert!(ev.contains("\"locked\":false"), "after 40 gifts at minimum storage, a failed payout still gets locked false: {ev}");
    let out: u128 = logs.iter().find(|l| l.contains("\"event\":\"swap\"")).and_then(|l| l.split("\"amount_out\":\"").nth(1)).and_then(|x| x.split('"').next()).expect("swap event").parse()?;
    assert_eq!(e.internal(&usdc).await? - iu0, out);
    assert_eq!(e.view("get_lostfound", json!({"account_id": p, "token_id": usdc})).await?, json!("0"));
    Ok(())
}

/// Evidence (DCL behaviour, not a contract test) for: EC-C106, control.
/// Control for `storage_exhausted`: the same add at minimum DCL storage with no gifts.
#[tokio::test]
async fn min_storage_control() -> anyhow::Result<()> {
    let e = setup().await?;
    let (dcl, wrap, p) = (e.dcl.id().clone(), e.wrap.id().clone(), e.probe.id().clone());
    e.run("dcl.storage_deposit min", &dcl, "storage_deposit", json!({"account_id": p, "registration_only": true}), 500_000_000_000_000_000_000_000, 20, vec![]).await?;
    e.run("probe deposit", &wrap, "ft_transfer_call", json!({"receiver_id": dcl, "amount": "10000000", "msg": "\"Deposit\""}), 1, 60, vec![]).await?;
    e.run("probe usdc deposit", e.usdc.id(), "ft_transfer_call", json!({"receiver_id": dcl, "amount": "10000000", "msg": "\"Deposit\""}), 1, 60, vec![]).await?;
    let (al, _) = e.run("probe add, no gifts", &dcl, "add_liquidity", json!({"pool_id": e.pid, "left_point": -10, "right_point": 10, "amount_x": "1000000", "amount_y": "1000000", "min_amount_x": "0", "min_amount_y": "0"}), 0, 150, vec![]).await?;
    let failed = al.iter().find(|l| l.starts_with("FAILED")).cloned();
    println!("  add at min storage, no gifts: {failed:?}");
    assert!(failed.is_none(), "at minimum storage with no gifts the add succeeds: {failed:?}");
    assert_eq!(e.view("get_user_storage_detail", json!({"user_id": p})).await?["cur_liquidity_slots"], json!(1));
    Ok(())
}

/// Audit L3: a second data point for the slot formula (1 NEAR should give 90 slots).
#[tokio::test]
async fn slot_formula() -> anyhow::Result<()> {
    let e = setup().await?;
    let (dcl, p) = (e.dcl.id().clone(), e.probe.id().clone());
    e.run("dcl.storage_deposit 1 NEAR", &dcl, "storage_deposit", json!({"account_id": p}), 1_000_000_000_000_000_000_000_000, 20, vec![]).await?;
    let d = e.view("get_user_storage_detail", json!({"user_id": p})).await?;
    println!("  1 NEAR: {d}");
    assert_eq!(d["max_slots"], json!(90), "(1 - 0.1) / 0.01 = 90");
    Ok(())
}

/// Evidence (DCL behaviour, not a contract test) for: T59, EC-C100.
/// Audit M1 of bdf7d71: DCL storage NEAR can't be taken back (no unregister or withdraw method).
#[tokio::test]
async fn storage_not_recoverable() -> anyhow::Result<()> {
    let e = setup().await?;
    let (dcl, p) = (e.dcl.id().clone(), e.probe.id().clone());
    e.run("dcl.storage_deposit", &dcl, "storage_deposit", json!({"account_id": p}), 1_000_000_000_000_000_000_000_000, 20, vec![]).await?;
    for (m, args) in [("storage_unregister", json!({"force": true})), ("storage_withdraw", json!({}))] {
        let (logs, plog) = e.run(m, &dcl, m, args, 1, 20, vec![]).await?;
        assert!(logs.iter().any(|l| l.contains("MethodNotFound")), "{m} doesn't exist on DCL 2.4.2: {logs:?}");
        assert!(plog.iter().any(|l| l.contains(&format!("{m} callback")) && l.contains("result=failed")));
    }
    assert_eq!(e.view("storage_balance_of", json!({"account_id": p})).await?["total"], json!("1000000000000000000000000"), "the deposit stays at DCL");
    Ok(())
}

/// Evidence (DCL behaviour, not a contract test): what `get_liquidity` of a fully removed position returns,
/// in a direct view and in a cross-contract read from the probe's callback (how the strategy will read it).
#[tokio::test]
async fn removed_position_view() -> anyhow::Result<()> {
    let e = setup().await?;
    let (dcl, wrap, p) = (e.dcl.id().clone(), e.wrap.id().clone(), e.probe.id().clone());
    e.run("dcl.storage_deposit min", &dcl, "storage_deposit", json!({"account_id": p, "registration_only": true}), 500_000_000_000_000_000_000_000, 20, vec![]).await?;
    e.run("probe deposit", &wrap, "ft_transfer_call", json!({"receiver_id": dcl, "amount": "10000000", "msg": "\"Deposit\""}), 1, 60, vec![]).await?;
    e.run("probe usdc deposit", e.usdc.id(), "ft_transfer_call", json!({"receiver_id": dcl, "amount": "10000000", "msg": "\"Deposit\""}), 1, 60, vec![]).await?;
    e.run("probe add", &dcl, "add_liquidity", json!({"pool_id": e.pid, "left_point": -10, "right_point": 10, "amount_x": "1000000", "amount_y": "1000000", "min_amount_x": "0", "min_amount_y": "0"}), 0, 150, vec![]).await?;
    let list = e.view("list_liquidities", json!({"account_id": p})).await?;
    let lpt = list[0]["lpt_id"].as_str().unwrap().to_string();
    let amount = list[0]["amount"].clone();
    e.run("remove all", &dcl, "remove_liquidity", json!({"lpt_id": lpt, "amount": amount, "min_amount_x": "0", "min_amount_y": "0", "skip_unwrap_near": true}), 0, 150, vec![]).await?;
    let direct = e.dcl.view("get_liquidity").args_json(json!({"lpt_id": lpt})).await;
    println!("  direct view of removed position: {:?}", direct.as_ref().map(|r| String::from_utf8_lossy(&r.result).to_string()).map_err(|x| x.to_string()));
    let (_, log) = e.run("cross-contract read of removed position", &dcl, "get_pool", json!({"pool_id": e.pid}), 0, 20,
        vec![(&dcl, "get_liquidity", json!({"lpt_id": lpt})), (&dcl, "get_liquidity", json!({"lpt_id": "no-such-id"}))]).await?;
    println!("  probe log: {log:?}");
    let missing = e.dcl.view("get_liquidity").args_json(json!({"lpt_id": "no-such-id"})).await;
    println!("  direct view of an id that never existed: {:?}", missing.as_ref().map(|r| String::from_utf8_lossy(&r.result).to_string()).map_err(|x| x.to_string()));
    assert_eq!(direct.expect("the view of a removed position must not fail").json::<Value>()?, Value::Null, "a removed position reads as null");
    assert!(log.iter().any(|l| l.contains("reads block=") && l.ends_with("[\"ok:null\",\"ok:null\"]")), "cross-contract reads of a removed and a never-existing position both succeed with null: {log:?}");
    assert_eq!(missing.expect("the view of an unknown id must not fail").json::<Value>()?, Value::Null);
    Ok(())
}
