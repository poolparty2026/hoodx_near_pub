//! Slice 2b: the strategy's `new` and registrations on the real wasm, against the mainnet DCL,
//! native USDC and wrap.near code (EC-C165's sandbox items). The quote token (usdc.test.near) runs
//! native USDC's code and the base token (wrap.test.near) runs wrap.near's, as on mainnet.
//! Every fact gate 3 Part F records is asserted here; figures only printed are marked so there.
mod common;
use common::*;
use near_workspaces::result::{ExecutionFinalResult, ValueOrReceiptId};
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::AccountId;
use serde_json::{json, Value};

/// EC-C165 sandbox: the parent's one-batch deploy at exactly MIN_GAS_NEW works (security L-3,
/// test F3): three registrations start and end Ok with nonce 1, the tokens hold exactly
/// TOKEN_STORAGE and DCL exactly dcl_storage, the strategy paid exactly that, and each call and
/// callback burnt under half its fixed gas.
#[tokio::test]
async fn the_parents_deploy_at_min_gas_registers_all_three() -> anyhow::Result<()> {
    let x = world(true).await?;
    let (id, r) = deploy(&x, false, Gas::from_tgas(200)).await?;
    gas_report("deploy", &r);
    assert!(r.is_success(), "{:?}", r.failures());
    let regs = registrations(&x, &id).await?;
    for t in ["quote_token", "base_token", "dcl_storage"] {
        assert_eq!(regs[t]["state"], "Ok", "{t}: {regs}");
        assert_eq!(regs[t]["nonce"], 1, "{t}: {regs}");
    }
    assert_eq!(regs["dcl_storage"]["deposit_may_have_landed"], true);
    assert_deploy_events(&r, x.creator.id(), true);
    // What DCL and the tokens now hold for the strategy, exactly.
    assert_eq!(
        storage_of(&x, DCL, &id).await?,
        json!({"available": "0", "total": DCL_STORAGE.to_string()})
    );
    for t in [USDC, WRAP] {
        assert_eq!(
            storage_of(&x, t, &id).await?["total"],
            TOKEN_STORAGE.to_string(),
            "{t}"
        );
    }
    // The strategy paid exactly the three deposits; it gains only its share of the gas its own
    // receipts burnt (contract rewards), which stays under 0.002 NEAR here (test L2).
    let paid = DCL_STORAGE + 2 * TOKEN_STORAGE;
    let left = balance(&x, &id).await?;
    assert!(
        left >= FUNDING - paid && left < FUNDING - paid + NEAR / 500,
        "left {left}"
    );
    // Gas: each storage call and each callback under half its fixed budget.
    for t in [USDC, WRAP, DCL] {
        let o = call_on(&r, t);
        assert!(
            o.gas_burnt.as_gas() < GAS_REGISTER / 2,
            "{t} burnt {}",
            tgas(o.gas_burnt.as_gas())
        );
    }
    let cbs = callbacks(&r, ID);
    assert_eq!(cbs.len(), 3);
    for o in cbs {
        assert!(
            o.gas_burnt.as_gas() < GAS_CALLBACK / 2,
            "a callback burnt {}",
            tgas(o.gas_burnt.as_gas())
        );
    }
    Ok(())
}

/// EC-C165 sandbox: a refused `new` reverts the whole batch, deploy included: no account is left,
/// and no token or DCL storage was bought for it.
#[tokio::test]
async fn a_refused_new_reverts_the_whole_batch() -> anyhow::Result<()> {
    let x = world(true).await?;
    let (id, r) = deploy(&x, true, Gas::from_tgas(300)).await?;
    assert!(r.is_failure());
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: rules hash"),
        "{:?}",
        r.failures()
    );
    assert!(
        x.w.view_account(&id).await.is_err(),
        "the account must not exist after a refused new"
    );
    assert!(events(&r).is_empty());
    for c in [DCL, USDC, WRAP] {
        assert!(storage_of(&x, c, &id).await?.is_null(), "{c}");
    }
    Ok(())
}

/// EC-C165 sandbox: one below MIN_GAS_NEW the batch is refused and reverts.
#[tokio::test]
async fn new_below_its_minimum_gas_reverts() -> anyhow::Result<()> {
    let x = world(true).await?;
    let (id, r) = deploy(&x, false, Gas::from_tgas(199)).await?;
    assert!(
        format!("{:?}", r.failures()).contains("LIMIT: gas"),
        "{:?}",
        r.failures()
    );
    assert!(x.w.view_account(&id).await.is_err());
    assert!(events(&r).is_empty());
    for c in [DCL, USDC, WRAP] {
        assert!(storage_of(&x, c, &id).await?.is_null(), "{c}");
    }
    Ok(())
}

/// EC-C165 sandbox: `#[init]` refuses a second `new`, even from the parent; the callback refuses an
/// outsider with its own AUTH: message on chain; neither changes anything (F6).
#[tokio::test]
async fn new_twice_and_a_direct_callback_are_refused_on_chain() -> anyhow::Result<()> {
    let x = world(true).await?;
    let (id, r) = deploy(&x, false, Gas::from_tgas(300)).await?;
    assert!(r.is_success());
    let before = snapshot(&x, &id).await?;
    let again = x
        .root
        .call(&id, "new")
        .args_json(args(x.now, x.creator.id(), false))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    assert!(
        format!("{:?}", again.failures()).contains("already been initialized"),
        "{:?}",
        again.failures()
    );
    assert!(events(&again).is_empty());
    assert_eq!(snapshot(&x, &id).await?, before);
    let cb = x
        .creator
        .call(&id, "on_registered")
        .args_json(json!({"target": "QuoteToken", "nonce": 1, "check_only": false}))
        .transact()
        .await?;
    assert!(
        format!("{:?}", cb.failures()).contains("AUTH: callback only"),
        "{:?}",
        cb.failures()
    );
    assert!(events(&cb).is_empty());
    assert_eq!(snapshot(&x, &id).await?, before);
    Ok(())
}

/// EC-C165 sandbox: a registration that fails (its token account has no contract) is Failed with an
/// `ok: false` event, its 0.00125 NEAR comes back to the strategy, and the other two stay Ok (F5).
/// The creator's retry at MIN_GAS_RETRY then succeeds once the token exists.
#[tokio::test]
async fn a_failed_registration_recovers_by_retry() -> anyhow::Result<()> {
    // The same deploy with every registration Ok, for the balance it leaves (gas rewards included).
    let ok_world = world(true).await?;
    let (ok_id, ok) = deploy(&ok_world, false, Gas::from_tgas(300)).await?;
    assert!(ok.is_success());
    let ok_left = balance(&ok_world, &ok_id).await?;

    let x = world(false).await?;
    let (id, r) = deploy(&x, false, Gas::from_tgas(300)).await?;
    assert!(r.is_success(), "{:?}", r.failures());
    let regs = registrations(&x, &id).await?;
    assert_eq!(regs["base_token"]["state"], "Failed");
    assert_eq!(regs["quote_token"]["state"], "Ok");
    assert_eq!(regs["dcl_storage"]["state"], "Ok");
    assert_deploy_events(&r, x.creator.id(), false);
    // Refunded: this strategy keeps one TOKEN_STORAGE more than the all-Ok one, to within the small
    // difference in their gas rewards.
    let left = balance(&x, &id).await? as i128;
    let diff = left - ok_left as i128 - TOKEN_STORAGE as i128;
    assert!(diff.abs() < (NEAR / 10_000) as i128, "refund off by {diff}");

    deploy_wrap(&x.root).await?;
    let before_quote = storage_of(&x, USDC, &id).await?;
    let retry = x
        .creator
        .call(&id, "retry_registration")
        .args_json(json!({"target": "BaseToken"}))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    gas_report("retry", &retry);
    assert!(retry.is_success(), "{:?}", retry.failures());
    let regs = registrations(&x, &id).await?;
    assert_eq!(regs["base_token"]["state"], "Ok");
    assert_eq!(regs["base_token"]["nonce"], 2);
    assert_eq!(regs["quote_token"]["nonce"], 1);
    assert_eq!(regs["dcl_storage"]["nonce"], 1);
    assert_eq!(
        storage_of(&x, WRAP, &id).await?["total"],
        TOKEN_STORAGE.to_string()
    );
    assert_eq!(storage_of(&x, USDC, &id).await?, before_quote);
    assert_eq!(
        events(&retry),
        vec![
            (
                "registration_started".into(),
                json!({"target": "BaseToken", "nonce": 2, "check_only": false})
            ),
            (
                "registration".into(),
                json!({"target": "BaseToken", "nonce": 2, "check_only": false, "ok": true})
            ),
        ]
    );
    // The retry's own receipt, its storage call and its callback, each under half its budget.
    let own: Vec<_> = on(&retry, ID)
        .into_iter()
        .filter(|o| o.logs.iter().any(|l| l.contains("registration_started")))
        .collect();
    assert_eq!(own.len(), 1);
    assert!(
        own[0].gas_burnt.as_gas() < 10 * TGAS,
        "retry burnt {}",
        tgas(own[0].gas_burnt.as_gas())
    );
    assert!(call_on(&retry, WRAP).gas_burnt.as_gas() < GAS_REGISTER / 2);
    let cbs = callbacks(&retry, ID);
    assert_eq!(cbs.len(), 1);
    assert!(cbs[0].gas_burnt.as_gas() < GAS_CALLBACK / 2);
    Ok(())
}

/// EC-C165 sandbox, on the real DCL (test F4): a DCL registration left Pending past
/// stale_after_blocks is retried as a re-check only: `storage_balance_of`, no new deposit. The
/// contract parses DCL's real answer, finds its total at dcl_storage, and records Ok.
/// The Pending state is set by patching dcl_storage, the last Registration (state u8, nonce u32,
/// launched u64, flag u8, deposit u64 = 22 bytes), which a lost callback would leave on chain. Since
/// slice 3 the state has `TAIL` bytes after Registrations: principal u128, last_inbound_block u64,
/// lock `None` (1), next_op_id u64, stale_resolution_block `None` (1), started_at_ns `None` (1), the empty action log and decision
/// lists (u32 lengths), own_position `None` (1), opened (1), swaps_used (1), closed_at_ns `None` (1),
/// settle_until_block u64, last_payout_callback_block u64, settle_window_class (1), fees_collected
/// 2 x u128, paid_platform 2 x u128, withdraw_failures 2 x 17 bytes, claim_in_flight `None` (1) and
/// the empty rate-stamp list (u32 length).
#[tokio::test]
async fn a_stale_dcl_registration_is_rechecked_on_real_dcl() -> anyhow::Result<()> {
    let x = world(true).await?;
    let (id, r) = deploy(&x, false, Gas::from_tgas(300)).await?;
    assert!(r.is_success());
    let state = x.w.view_state(&id).prefix(b"STATE").await?;
    let mut bytes = state.get(b"STATE".as_slice()).expect("STATE").clone();
    const TAIL: usize =
        16 + 8 + 1 + 8 + 1 + 1 + (4 + 4 + 1 + 1 + 1) + 1 + 8 + (8 + 1 + 32 + 32 + 34 + 1) + 4;
    assert_eq!(
        &bytes[bytes.len() - TAIL..],
        &[0u8; TAIL],
        "fresh slice 3 fields"
    );
    let n = bytes.len() - TAIL;
    assert_eq!(bytes[n - 22], 1, "dcl_storage is Ok before the patch");
    assert_eq!(&bytes[n - 21..n - 17], &1u32.to_le_bytes());
    bytes[n - 22] = 0; // Pending
    x.w.patch_state(&id, b"STATE", &bytes).await?;
    assert_eq!(
        registrations(&x, &id).await?["dcl_storage"]["state"],
        "Pending"
    );

    // Not yet stale: refused, nothing changed.
    let before = snapshot(&x, &id).await?;
    let early = x
        .creator
        .call(&id, "retry_registration")
        .args_json(json!({"target": "DclStorage"}))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    assert!(
        format!("{:?}", early.failures()).contains("LIMIT: registration not failed"),
        "{:?}",
        early.failures()
    );
    assert_eq!(snapshot(&x, &id).await?, before);

    x.w.fast_forward(STALE_AFTER + 10).await?;
    let dcl_before = storage_of(&x, DCL, &id).await?;
    let retry = x
        .creator
        .call(&id, "retry_registration")
        .args_json(json!({"target": "DclStorage"}))
        .gas(Gas::from_tgas(80))
        .transact()
        .await?;
    gas_report("recheck", &retry);
    assert!(retry.is_success(), "{:?}", retry.failures());
    assert_eq!(
        events(&retry),
        vec![
            (
                "registration_started".into(),
                json!({"target": "DclStorage", "nonce": 2, "check_only": true})
            ),
            (
                "registration".into(),
                json!({"target": "DclStorage", "nonce": 2, "check_only": true, "ok": true})
            ),
        ]
    );
    let regs = registrations(&x, &id).await?;
    assert_eq!(regs["dcl_storage"]["state"], "Ok");
    assert_eq!(regs["dcl_storage"]["deposit_may_have_landed"], true);
    // No deposit went out: DCL holds what it held, and the call to DCL returned a value.
    assert_eq!(storage_of(&x, DCL, &id).await?, dcl_before);
    assert_eq!(dcl_before["total"], DCL_STORAGE.to_string());
    let dcl_call = call_on(&retry, DCL).clone();
    assert!(matches!(
        dcl_call.into_result()?,
        ValueOrReceiptId::Value(_)
    ));
    Ok(())
}

/// The status of the one receipt that ran `storage_deposit` on `contract`, which must be a plain
/// return value, not a promise (test F1).
fn returns_value(r: &ExecutionFinalResult, contract: &str) -> anyhow::Result<()> {
    let o = call_on(r, contract).clone();
    assert!(
        matches!(o.into_result()?, ValueOrReceiptId::Value(_)),
        "{contract} returned a promise"
    );
    Ok(())
}

/// EC-C165 sandbox. Gate 3 items the contract relies on, on the real code (security M-2, test F1, F2):
/// - DCL storage_balance_of is null for an unregistered account;
/// - DCL storage_deposit returns `{available, total}` as a plain value, and a second deposit is
///   credited (1 then 2 NEAR);
/// - wrap.near's and native USDC's code both accept a registration_only deposit from an account
///   already registered and refund it, whether 1 NEAR or the bound is attached.
#[tokio::test]
async fn dcl_and_token_storage_behaviour() -> anyhow::Result<()> {
    let x = world(true).await?;
    let dcl: AccountId = DCL.parse()?;
    let none: Value =
        x.w.view(&dcl, "storage_balance_of")
            .args_json(json!({"account_id": "nobody.test.near"}))
            .await?
            .json()?;
    assert!(none.is_null(), "{none}");
    let who = x.creator.id().clone();
    let deposit = || {
        x.root
            .call(&dcl, "storage_deposit")
            .args_json(json!({"account_id": who}))
            .deposit(NearToken::from_near(1))
            .transact()
    };
    let first = deposit().await?;
    assert!(first.is_success(), "{:?}", first.failures());
    assert_eq!(
        first.clone().json::<Value>()?,
        json!({"available": "0", "total": NEAR.to_string()})
    );
    returns_value(&first, DCL)?;
    let second = deposit().await?;
    assert!(second.is_success(), "{:?}", second.failures());
    assert_eq!(
        second.clone().json::<Value>()?,
        json!({"available": "0", "total": (2 * NEAR).to_string()})
    );
    returns_value(&second, DCL)?;
    assert_eq!(
        storage_of(&x, DCL, &who).await?,
        json!({"available": "0", "total": (2 * NEAR).to_string()})
    );

    for token in [USDC, WRAP] {
        let t: AccountId = token.parse()?;
        let bounds: Value = x.w.view(&t, "storage_balance_bounds").await?.json()?;
        assert_eq!(
            bounds["min"],
            TOKEN_STORAGE.to_string(),
            "{token}: {bounds}"
        );
        let reg = x
            .root
            .call(&t, "storage_deposit")
            .args_json(json!({"account_id": who, "registration_only": true}))
            .deposit(NearToken::from_yoctonear(TOKEN_STORAGE))
            .transact()
            .await?;
        assert!(reg.is_success(), "{token}: {:?}", reg.failures());
        // A fresh payer per token (the sandbox root also earns rewards), so a kept deposit can't
        // hide in the gas cost: the 1 NEAR call and the bound-only call must cost the same, to
        // within gas.
        let payer = account(&x.root, &format!("payer-{}", &token[..4])).await?;
        let bal = || async { balance(&x, payer.id()).await.unwrap() as i128 };
        let call = |amount: u128| {
            payer
                .call(&t, "storage_deposit")
                .args_json(json!({"account_id": who, "registration_only": true}))
                .deposit(NearToken::from_yoctonear(amount))
                .transact()
        };
        let b0 = bal().await;
        let big = call(NEAR).await?;
        let b1 = bal().await;
        let small = call(TOKEN_STORAGE).await?;
        let b2 = bal().await;
        assert!(big.is_success(), "{token}: {:?}", big.failures());
        assert!(small.is_success(), "{token}: {:?}", small.failures());
        println!(
            "{token}: re-registration with 1 NEAR spent {} yocto; with the bound {} yocto",
            b0 - b1,
            b1 - b2
        );
        assert!(
            ((b0 - b1) - (b1 - b2)).abs() < (NEAR / 1_000) as i128,
            "{token} kept part of a deposit: {} vs {}",
            b0 - b1,
            b1 - b2
        );
        // Each costs under half the bound, so neither kept even half of it (test L3).
        assert!(
            b0 - b1 < (TOKEN_STORAGE / 2) as i128 && b1 - b2 < (TOKEN_STORAGE / 2) as i128,
            "{token}: re-registrations cost {} and {}",
            b0 - b1,
            b1 - b2
        );
        assert_eq!(
            storage_of(&x, token, &who).await?["total"],
            TOKEN_STORAGE.to_string(),
            "{token}"
        );
    }
    Ok(())
}
