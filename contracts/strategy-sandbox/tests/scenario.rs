//! The scenario harness (MINIMAL_PLAN section 1 and 4): the acceptance scenario on the real wasm,
//! DCL and native USDC code, recording every view the check page needs at checkpoint blocks, in the
//! `RecordedFile` format of `apps/web/src/lib/provider.ts`. Output: `fixtures/scenario/` at the
//! repo root. Run with `SCENARIO=1 ./run.sh scenario` (it is slow: the sandbox clock is real time
//! and the action interval is 600 s, so a run waits about 11 minutes).
//!
//! The good run: deploy with a rules hash that is the SHA-256 of `RULES`, fund, register the DCL
//! tokens, start, swap, open, close the position on the agent's decision, `close`, `settle`,
//! `reveal`, claim. Variants made from it: `bad-tampered-rules` (the revealed text differs by one
//! character, so it no longer hashes to `rules_hash`), and `no-agent-close` (a second real run in
//! which the agent never closes and the creator's `close()` and `exit_remove` end the run).
//!
//! **Recorded:** contract and DCL and token views at checkpoint blocks. **Not recorded** (the page
//! needs them and the file format has no place for them yet): block headers and timestamps, account
//! snapshots (`code_hash`, access keys) and the creating transaction. Both "providers" are the one
//! sandbox node, so a fixture proves the page's reading and replay, not two-provider agreement.
mod common;
use common::*;
use near_workspaces::types::Gas;
use near_workspaces::AccountId;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const POINT: i64 = 401_312;
const LEFT: i64 = 400_812;
const RIGHT: i64 = 401_812;
const MIN_GAS_SWAP: u64 = 280 * TGAS;
const MIN_GAS_OPEN: u64 = 300 * TGAS;
const MIN_GAS_REMOVE: u64 = 250 * TGAS;
const SETTLE_AND_MARGIN: u64 = 65;

/// Canonical (sorted keys, no spaces) rules text in the shape of `packages/rules` RulesV1.
const RULES: &str = r#"{"close_after_s":3600,"pool":"usdc.test.near|wrap.test.near|100","quote_token":"usdc.test.near","range":{"centre":"mid","width_bps":1000},"salt":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","stop_loss_bps":1000,"take_profit_bps":500,"version":1}"#;

fn meta(hash_byte: &str, point: i64, block: u64) -> Value {
    json!({"observed": {"block": block.to_string(), "point": point}, "decision_hash": hash_byte.repeat(32), "chain_head": null})
}
async fn height(x: &World) -> anyhow::Result<u64> {
    Ok(x.w.view_block().await?.height())
}

/// A JSON-RPC call to the sandbox node (through curl: no HTTP client is a dependency of this crate).
fn rpc(x: &World, method: &str, params: Value) -> anyhow::Result<Value> {
    let body = json!({"jsonrpc": "2.0", "id": "s", "method": method, "params": params}).to_string();
    let out = std::process::Command::new("curl")
        .args([
            "-sS",
            "-X",
            "POST",
            "-H",
            "content-type: application/json",
            "-d",
            &body,
            &x.w.rpc_addr(),
        ])
        .output()?;
    anyhow::ensure!(out.status.success(), "curl failed");
    let v: Value = serde_json::from_slice(&out.stdout)?;
    anyhow::ensure!(v.get("error").is_none(), "rpc error {v}");
    Ok(v["result"].clone())
}

/// Collects `{account, method, args, block, text}` responses.
struct Recorder {
    responses: Vec<Value>,
}
impl Recorder {
    async fn one(
        &mut self,
        x: &World,
        account: &str,
        method: &str,
        args: Value,
        block: u64,
    ) -> anyhow::Result<()> {
        let acct: AccountId = account.parse()?;
        let r =
            x.w.view(&acct, method)
                .args_json(args.clone())
                .block_height(block)
                .await;
        // A view that panics (for example a method that doesn't exist yet) is not recorded: the
        // page treats a missing response as a failed read.
        if let Ok(r) = r {
            let text = String::from_utf8(r.result)?;
            self.responses.push(json!({"account": account, "method": method, "args": args, "block": block, "text": text}));
        }
        Ok(())
    }

    /// Every view the replay reads, at `block`, plus the block header (height and timestamp) and the
    /// strategy account's snapshot (`view_account` with its code hash, `view_access_key_list`).
    async fn checkpoint(
        &mut self,
        x: &World,
        id: &AccountId,
        lpt: Option<&str>,
        block: u64,
    ) -> anyhow::Result<()> {
        let s = id.as_str();
        let hd = rpc(x, "block", json!({"block_id": block}))?;
        let ts = hd["header"]["timestamp"]
            .as_u64()
            .map(|t| t.to_string())
            .or_else(|| hd["header"]["timestamp"].as_str().map(String::from))
            .unwrap_or_default();
        // The block header in the shape the page reads: the timestamp is a STRING (nanoseconds exceed 2^53).
        self.responses.push(json!({"account": "near", "method": "block", "args": {"block_id": block}, "block": block,
            "text": json!({"header": {"height": block, "timestamp": ts}}).to_string()}));
        for (m, rt) in [
            ("view_account", "view_account"),
            ("view_access_key_list", "view_access_key_list"),
        ] {
            if let Ok(mut r) = rpc(
                x,
                "query",
                json!({"request_type": rt, "block_id": block, "account_id": s}),
            ) {
                if let Some(o) = r.as_object_mut() {
                    o.remove("logs");
                }
                self.responses.push(json!({"account": s, "method": m, "args": {}, "block": block, "text": r.to_string()}));
            }
        }
        for m in [
            "get_status",
            "get_config",
            "get_limits",
            "get_started_at",
            "get_principal",
            "get_swaps_used",
            "get_opened",
            "get_own_position",
            "get_fees_collected",
            "get_settle_window",
            "get_actions_len",
            "get_closed_at",
            "get_revealed",
            "get_lock",
            "get_tokens_registered",
        ] {
            self.one(x, s, m, json!({}), block).await?;
        }
        for t in [USDC, WRAP] {
            self.one(x, s, "get_platform_owed", json!({"token": t}), block)
                .await?;
            self.one(x, t, "ft_balance_of", json!({"account_id": s}), block)
                .await?;
        }
        let len: u64 = {
            let a: AccountId = s.parse()?;
            let v: Value =
                x.w.view(&a, "get_actions_len")
                    .block_height(block)
                    .await?
                    .json()?;
            v.as_str().unwrap_or("0").parse()?
        };
        let mut from = 0;
        while from < len {
            self.one(
                x,
                s,
                "get_actions",
                json!({"from": from.to_string(), "limit": 20}),
                block,
            )
            .await?;
            from += 20;
        }
        for i in 0..len {
            self.one(x, s, "get_action", json!({"index": i.to_string()}), block)
                .await?;
        }
        self.one(
            x,
            DCL,
            "get_pool",
            json!({"pool_id": format!("{USDC}|{WRAP}|100")}),
            block,
        )
        .await?;
        self.one(x, DCL, "list_user_assets", json!({"account_id": s}), block)
            .await?;
        if let Some(l) = lpt {
            self.one(x, DCL, "get_liquidity", json!({"lpt_id": l}), block)
                .await?;
            // The prediction for the position's whole liquidity, if it still has any.
            let d: AccountId = DCL.parse()?;
            if let Ok(r) =
                x.w.view(&d, "get_liquidity")
                    .args_json(json!({"lpt_id": l}))
                    .block_height(block)
                    .await
            {
                let v: Value = r.json()?;
                if let Some(amount) = v.get("amount").and_then(|a| a.as_str()) {
                    self.one(
                        x,
                        DCL,
                        "predict_remove_liquidity",
                        json!({"lpt_id": l, "amount": amount}),
                        block,
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    fn write(&self, run: &str, tamper: Option<&dyn Fn(&mut Value)>) -> anyhow::Result<()> {
        let dir = format!("{ROOT}/fixtures/scenario");
        std::fs::create_dir_all(&dir)?;
        for provider in ["sandbox-a", "sandbox-b"] {
            let mut responses = self.responses.clone();
            if let Some(t) = tamper {
                for r in responses.iter_mut() {
                    t(r);
                }
            }
            let file = json!({"provider": provider, "run": run, "responses": responses});
            std::fs::write(
                format!("{dir}/{run}.{provider}.json"),
                serde_json::to_string(&file)?,
            )?;
        }
        Ok(())
    }
}

async fn start(x: &World) -> anyhow::Result<AccountId> {
    // The deploy's rules hash is the SHA-256 of `RULES`, so `reveal` can succeed at the end.
    std::env::set_var(
        "POOLSIDE_RULES_HASH",
        hex::encode(Sha256::digest(RULES.as_bytes())),
    );
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
    anyhow::ensure!(r.is_success(), "{:?}", r.failures());
    Ok(id)
}

/// The real agent, as a background process (`apps/agent/src/main.ts`): it observes, decides, sends and
/// holds its records in `held`; once the strategy is Closing it publishes them to `records`.
fn start_agent(
    x: &World,
    id: &AccountId,
    dir: &std::path::Path,
) -> anyhow::Result<std::process::Child> {
    let (held, records) = (dir.join("held"), dir.join("records"));
    std::fs::create_dir_all(&held)?;
    std::fs::create_dir_all(&records)?;
    Ok(std::process::Command::new("node")
        .arg(format!("{ROOT}/apps/agent/src/main.ts"))
        .env("RPC_URL", x.w.rpc_addr())
        .env("STRATEGY", id.as_str())
        .env("DCL", DCL)
        .env("AGENT_ACCOUNT", x.agent.id().as_str())
        .env("AGENT_SECRET", x.agent.secret_key().to_string())
        .env("RULES_FILE", dir.join("rules.json"))
        .env("HELD_DIR", held)
        .env("RECORDS_DIR", records)
        .env("INTERVAL_S", "15")
        .env("LOG_FILE", dir.join("agent.log"))
        .stdout(std::process::Stdio::null())
        .stderr(std::fs::File::create(dir.join("agent.err"))?)
        .spawn()?)
}

fn scratch(name: &str) -> anyhow::Result<std::path::PathBuf> {
    let dir = std::env::temp_dir().join(format!("poolside-scenario-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("rules.json"), RULES)?;
    Ok(dir)
}

/// Samples while the run goes, because the sandbox keeps only recent blocks (an hour later the early ones are gone,
/// which made the first one-hour run fail with UNKNOWN_BLOCK). Every `pass` checkpoints the blocks the page samples
/// that are new (the 20-block grid, the agent's observed blocks, every action's blocks) and appends the new
/// responses to `<dir>/recording.jsonl`, so a failed run still leaves its data on disk.
struct Sampler {
    rec: Recorder,
    done: std::collections::BTreeSet<u64>,
    first: u64,
    dir: std::path::PathBuf,
    flushed: usize,
    lpt: Option<String>,
}
impl Sampler {
    fn new(first: u64, dir: &std::path::Path) -> Self {
        Sampler {
            rec: Recorder { responses: vec![] },
            done: Default::default(),
            first,
            dir: dir.to_path_buf(),
            flushed: 0,
            lpt: None,
        }
    }
    async fn pass(&mut self, x: &World, id: &AccountId, fin: bool) -> anyhow::Result<()> {
        use std::io::Write;
        let head = height(x).await?;
        let acts = actions(x, id).await?;
        if self.lpt.is_none() {
            self.lpt = acts
                .iter()
                .find_map(|a| a["open"]["lpt_id"].as_str().map(String::from));
        }
        let mut hs = sample_heights(self.first, head, &self.dir.join("agent.log"), &acts);
        if !fin && head % 20 != 0 {
            hs.retain(|b| *b != head);
        }
        for b in hs {
            if self.done.contains(&b) {
                continue;
            }
            match self.rec.checkpoint(x, id, self.lpt.as_deref(), b).await {
                Ok(()) => {
                    self.done.insert(b);
                }
                Err(e) => eprintln!("checkpoint {b} failed: {e}"),
            }
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("recording.jsonl"))?;
        for r in &self.rec.responses[self.flushed..] {
            writeln!(f, "{r}")?;
        }
        self.flushed = self.rec.responses.len();
        Ok(())
    }
}

async fn actions(x: &World, id: &AccountId) -> anyhow::Result<Vec<Value>> {
    let n: u64 = view(x, id, "get_actions_len")
        .await?
        .as_str()
        .unwrap_or("0")
        .parse()?;
    let mut out = vec![];
    for i in 0..n {
        out.push(
            x.w.view(id, "get_action")
                .args_json(json!({"index": i.to_string()}))
                .await?
                .json()?,
        );
    }
    Ok(out)
}

/// Waits (polling) until `pred` holds for the strategy's actions, at most `max_s` seconds.
async fn wait_actions(
    x: &World,
    id: &AccountId,
    s: &mut Sampler,
    max_s: u64,
    pred: impl Fn(&[Value]) -> bool,
) -> anyhow::Result<Vec<Value>> {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(max_s);
    loop {
        s.pass(x, id, false).await?;
        let a = actions(x, id).await?;
        if pred(&a) {
            return Ok(a);
        }
        anyhow::ensure!(
            std::time::Instant::now() < end,
            "timed out waiting for the agent: {a:?}"
        );
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    }
}

/// The heights the page samples: every `DENSE_STEP_BLOCKS` (20) from `first` to `last`, every block the agent
/// observed at, and the blocks of every action (call, result, observed, confirming).
fn sample_heights(first: u64, last: u64, log: &std::path::Path, acts: &[Value]) -> Vec<u64> {
    let mut h: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
    let mut b = (first / 20 + 1) * 20;
    while b <= last {
        h.insert(b);
        b += 20;
    }
    h.insert(first);
    h.insert(last);
    if let Ok(t) = std::fs::read_to_string(log) {
        for l in t.lines() {
            if let Ok(v) = serde_json::from_str::<Value>(l) {
                if let Some(b) = v["block"].as_u64().filter(|b| (first..=last).contains(b)) {
                    h.insert(b);
                }
            }
        }
    }
    for a in acts {
        for k in [
            &a["call_block"],
            &a["result_block"],
            &a["observed"]["block"],
            &a["remove"]["confirm_observed"]["block"],
        ] {
            if let Some(b) = k
                .as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|b| (first..=last).contains(b))
            {
                h.insert(b);
            }
        }
    }
    h.into_iter().collect()
}

fn copy_dir(from: &std::path::Path, to: &str) -> anyhow::Result<()> {
    std::fs::create_dir_all(to)?;
    for f in std::fs::read_dir(from)? {
        let f = f?;
        std::fs::copy(
            f.path(),
            format!("{to}/{}", f.file_name().to_string_lossy()),
        )?;
    }
    Ok(())
}

/// Brings a run to the end: the creator ends it, `settle`, `reveal`, claims. Returns the final block.
async fn finish(x: &World, id: &AccountId) -> anyhow::Result<()> {
    let r = x
        .creator
        .call(id, "close")
        .gas(Gas::from_gas(50 * TGAS))
        .transact()
        .await?;
    anyhow::ensure!(r.is_success(), "close: {:?}", r.failures());
    x.w.fast_forward(SETTLE_AND_MARGIN).await?;
    let r = x
        .creator
        .call(id, "settle")
        .gas(Gas::from_gas(100 * TGAS))
        .transact()
        .await?;
    anyhow::ensure!(r.is_success(), "settle: {:?}", r.failures());
    anyhow::ensure!(
        view(x, id, "get_status").await? == json!("Closed"),
        "not Closed"
    );
    let r = x
        .creator
        .call(id, "reveal")
        .args_json(json!({"rules_json": RULES}))
        .gas(Gas::from_gas(30 * TGAS))
        .transact()
        .await?;
    anyhow::ensure!(r.is_success(), "reveal: {:?}", r.failures());
    for t in [USDC, WRAP] {
        let r = x
            .creator
            .call(id, "claim_creator")
            .args_json(json!({"token": t}))
            .gas(Gas::from_gas(180 * TGAS))
            .transact()
            .await?;
        anyhow::ensure!(r.is_success(), "claim {t}: {:?}", r.failures());
    }
    Ok(())
}

/// The good run: the real agent swaps, opens and, when the rules' time bound has really passed, closes.
async fn good_run() -> anyhow::Result<Recorder> {
    let x = world(true).await?;
    let id = start(&x).await?;
    let dir = scratch("good")?;
    let first = height(&x).await?;
    let mut s = Sampler::new(first, &dir);
    let mut agent = start_agent(&x, &id, &dir)?;
    // swap, open, and the due time close (about an hour later).
    let acts = wait_actions(&x, &id, &mut s, 6_000, |a| {
        a.iter()
            .any(|r| r["kind"] == "ClosePosition" && r["result"] == "Ok")
    })
    .await?;
    eprintln!("good run: the agent closed ({} actions)", acts.len());
    finish(&x, &id).await?;
    // The agent publishes once it sees Closing; give it a few rounds, then stop it.
    for _ in 0..12 {
        if agent.try_wait()?.is_some() {
            break;
        }
        s.pass(&x, &id, false).await?;
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    }
    let _ = agent.kill();
    s.pass(&x, &id, true).await?;
    let rec = s.rec;
    let published = std::fs::read_dir(dir.join("records"))?.count();
    anyhow::ensure!(published >= 2, "the agent published {published} records");
    copy_dir(
        &dir.join("records"),
        &format!("{ROOT}/fixtures/scenario/records"),
    )?;
    Ok(rec)
}

/// The bad run: the same agent and rules, stopped after the open, so the due close is never sent; the creator
/// ends the run after the time bound and the position is removed by `exit_remove`. The page's own sampling
/// finds the missed close.
async fn bad_run() -> anyhow::Result<Recorder> {
    let x = world(true).await?;
    let id = start(&x).await?;
    let dir = scratch("bad")?;
    let first = height(&x).await?;
    let t0 = std::time::Instant::now();
    let mut s = Sampler::new(first, &dir);
    let mut agent = start_agent(&x, &id, &dir)?;
    wait_actions(&x, &id, &mut s, 600, |a| {
        a.iter().any(|r| r["kind"] == "Open" && r["result"] == "Ok")
    })
    .await?;
    let _ = agent.kill();
    // Let the time bound pass (the same real time as the good run), then end the run without the close.
    // The sandbox and the sampler run on with the agent stopped, so the page can see a due close that never came.
    let wait_s: u64 = std::env::var("BAD_WAIT_S")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3_700);
    while t0.elapsed() < std::time::Duration::from_secs(wait_s) {
        s.pass(&x, &id, false).await?;
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
    }
    let acts = actions(&x, &id).await?;
    let lpt = acts
        .iter()
        .find_map(|a| a["open"]["lpt_id"].as_str().map(String::from))
        .expect("an open position");
    let r = x
        .creator
        .call(&id, "close")
        .gas(Gas::from_gas(50 * TGAS))
        .transact()
        .await?;
    anyhow::ensure!(r.is_success(), "close: {:?}", r.failures());
    let r = x
        .agent
        .call(&id, "exit_remove")
        .args_json(json!({"position": lpt}))
        .gas(Gas::from_gas(250 * TGAS))
        .transact()
        .await?;
    anyhow::ensure!(r.is_success(), "exit_remove: {:?}", r.failures());
    x.w.fast_forward(SETTLE_AND_MARGIN).await?;
    let r = x
        .creator
        .call(&id, "settle")
        .gas(Gas::from_gas(100 * TGAS))
        .transact()
        .await?;
    anyhow::ensure!(r.is_success(), "settle: {:?}", r.failures());
    let r = x
        .creator
        .call(&id, "reveal")
        .args_json(json!({"rules_json": RULES}))
        .gas(Gas::from_gas(30 * TGAS))
        .transact()
        .await?;
    anyhow::ensure!(r.is_success(), "reveal: {:?}", r.failures());
    s.pass(&x, &id, true).await?;
    let rec = s.rec;
    // The agent was stopped, so the operator publishes its held records after the reveal.
    copy_dir(
        &dir.join("held"),
        &format!("{ROOT}/fixtures/scenario/records"),
    )?;
    Ok(rec)
}

/// The sandbox's pinned constants, in a file separate from the recordings: the network, the pool and the
/// strategy account's code hash as the sandbox recorded it (from the good run's last `view_account`).
fn write_pins(good: &Recorder) -> anyhow::Result<()> {
    let code_hash = good
        .responses
        .iter()
        .rev()
        .find(|r| r["method"] == "view_account")
        .and_then(|r| serde_json::from_str::<Value>(r["text"].as_str()?).ok())
        .and_then(|v| v["code_hash"].as_str().map(String::from));
    let pins = json!({
        "note": "A local sandbox, not mainnet: these constants pin what the recording was made against.",
        "dcl_contract": DCL, "quote_token": USDC, "base_token": WRAP,
        "pool": format!("{USDC}|{WRAP}|100"), "strategy_account": ID, "strategy_code_hash": code_hash,
    });
    std::fs::write(
        format!("{ROOT}/fixtures/scenario/pins.json"),
        serde_json::to_string_pretty(&pins)?,
    )?;
    Ok(())
}

#[tokio::test]
async fn record_both() -> anyhow::Result<()> {
    if std::env::var("SCENARIO").is_err() {
        eprintln!("skipped: set SCENARIO=1 (the run takes about 75 minutes)");
        return Ok(());
    }
    if std::env::var("ONLY_BAD").is_ok() {
        // Re-records only the no-agent-close world (the page needs the stretch after the due block to last
        // longer than the late-close allowance); BAD_WAIT_S is how long after the start the creator ends the run.
        bad_run().await?.write("no-agent-close", None)?;
        return Ok(());
    }
    let (good, bad) = tokio::join!(good_run(), bad_run());
    let (good, bad) = (good?, bad?);
    write_pins(&good)?;
    good.write("good", None)?;
    good.write(
        "bad-tampered-rules",
        Some(&|r: &mut Value| {
            if r["method"] == "get_revealed" && r["text"] != "null" {
                let t = r["text"].as_str().unwrap().replacen("3600", "3601", 1);
                r["text"] = json!(t);
            }
        }),
    )?;
    bad.write("no-agent-close", None)?;
    Ok(())
}
