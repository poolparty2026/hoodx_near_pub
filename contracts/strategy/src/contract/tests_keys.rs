//! D57 viewing keys, unit tests (INTERFACE section 9). New edge cases: EC-C173 `buy_viewing_key`,
//! EC-C174 `deliver_key`, EC-C175 `refund_key`, EC-C176 `withdraw_near` and the bounce callback,
//! EC-C177 `start`'s reserve with escrow, EC-C178 money moves exactly once (property test).
//! Also EC-K03 (a sealed key of the wrong length is refused by `deliver_key`), EC-K05 (no deliverer:
//! the buyer refunds after the window) and EC-C36, EC-C39 (without `rekey`), EC-C62, EC-C84, EC-C137, EC-C146 for the sale.
use super::tests::*;
use super::tests_funding::{as_callback, at, events, last_event, ok};
use super::tests_start::started;
use super::*;
use crate::limits::ONE_NEAR;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::get_created_receipts;
use near_sdk::testing_env;
use near_sdk::PromiseResult;

pub(super) const PRICE: u128 = ONE_NEAR / 10;
pub(super) const WINDOW: u64 = 3_600 * crate::limits::NANOS_PER_S;
pub(super) const PK: &str = "0101010101010101010101010101010101010101010101010101010101010101";
pub(super) fn sealed(c: char) -> String {
    c.to_string().repeat(160)
}

/// A context as `who` at time `ts` with `deposit` attached and a balance of `bal`.
pub(super) fn call_at(who: &str, ts: u64, deposit: u128, bal: u128) {
    // The mock adds the deposit to the balance, as the runtime does; `bal` is the total in the call.
    let mut b = ctx(
        who,
        bal.saturating_sub(deposit),
        Gas::from_tgas(60),
        BLOCK + 100,
    );
    b.block_timestamp(ts)
        .attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}
pub(super) fn buy(s: &mut Strategy, who: &str, pk: &str, ts: u64) {
    call_at(who, ts, PRICE, BAL + PRICE);
    s.buy_viewing_key(pk.to_string());
}
fn state(s: &Strategy) -> String {
    near_sdk::serde_json::to_string(&(
        s.get_key_params(),
        s.get_key_sales(0, 50),
        s.get_status(),
        s.get_revealed(),
    ))
    .unwrap()
}
fn refuse_buy(s: &mut Strategy, who: &str, pk: &str, deposit: u128, bal: u128, msg: &str) {
    let before = state(s);
    call_at(who, NOW + 5, deposit, bal);
    assert_eq!(refused(|| s.buy_viewing_key(pk.to_string())), msg);
    assert_eq!(state(s), before, "{msg}: nothing changed");
}

/// EC-C173: a sale is stored escrowed with the exact fields, the counters move, `key_bought`.
#[test]
fn buy_stores_the_sale() {
    let mut s = started();
    buy(&mut s, "bob.near", PK, NOW + 7);
    let sale = s.get_key_sale("bob.near".into()).unwrap();
    assert_eq!(sale.buyer, acc("bob.near"));
    assert_eq!(sale.buyer_pubkey, PK);
    assert_eq!(sale.state, KeyState::Escrowed);
    assert_eq!(sale.bought_at_ns, U64(NOW + 7));
    assert_eq!(sale.price, U128(PRICE));
    assert_eq!(sale.sealed_key, None);
    let p = s.get_key_params();
    assert_eq!(
        (p.sold, p.escrow_total, p.near_owed_total),
        (1, U128(PRICE), U128(0))
    );
    assert_eq!(p.key_price, U128(PRICE));
    assert_eq!(p.deliverer, acc("deliverer.near"));
    assert_eq!(p.max_key_sales, 20);
    let e = last_event();
    assert_eq!(e["event"], "key_bought");
    assert_eq!(e["data"][0]["index"], 0);
    assert_eq!(e["data"][0]["buyer"], "bob.near");
    assert_eq!(e["data"][0]["buyer_pubkey"], PK);
    assert_eq!(e["data"][0]["bought_at_ns"], (NOW + 7).to_string());
    assert_eq!(e["data"][0]["price"], PRICE.to_string());
    assert!(calls().is_empty(), "no promise on a purchase");
}

/// EC-C173: the refusals, each with the exact message and nothing changed.
#[test]
fn buy_refusals_in_order() {
    // Not Running.
    for st in [
        Status::Open,
        Status::Cancelled,
        Status::Closing,
        Status::Closed,
    ] {
        let mut s = started();
        s.status = st;
        refuse_buy(
            &mut s,
            "bob.near",
            PK,
            PRICE,
            BAL + PRICE,
            "LIMIT: wrong status",
        );
    }
    // Already revealed beats a bad deposit.
    let mut s = started();
    s.revealed = Some("x".into());
    refuse_buy(&mut s, "bob.near", "zz", 0, BAL, "LIMIT: already revealed");
    // Price: one yocto under and over, zero.
    let mut s = started();
    for d in [PRICE - 1, PRICE + 1, 0, 2 * PRICE] {
        refuse_buy(&mut s, "bob.near", PK, d, BAL + d, "LIMIT: key price");
    }
    // A bad key (price is checked first).
    let bad = [
        "",
        &PK[..62],
        &format!("{PK}00"),
        &PK.to_uppercase().replace('0', "A"),
        &"0".repeat(64),
        &"g".repeat(64),
        &format!("0x{}", &PK[..62]),
    ];
    for k in bad {
        refuse_buy(
            &mut s,
            "bob.near",
            k,
            PRICE,
            BAL + PRICE,
            "LIMIT: buyer key",
        );
    }
    // Upper-case hex of the right length is refused.
    refuse_buy(
        &mut s,
        "bob.near",
        &"AB".repeat(32),
        PRICE,
        BAL + PRICE,
        "LIMIT: buyer key",
    );
    // One sale per account.
    buy(&mut s, "bob.near", PK, NOW + 7);
    refuse_buy(
        &mut s,
        "bob.near",
        PK,
        PRICE,
        BAL + PRICE,
        "LIMIT: already bought",
    );
    // Not enough free balance for the record.
    let mut s = started();
    refuse_buy(
        &mut s,
        "bob.near",
        PK,
        PRICE,
        1,
        "LIMIT: balance for registration",
    );
}

/// EC-C146: the 20th (the limit) is accepted, the 21st refused; at 50 and 51 too; 0 refuses all,
/// and a refunded sale still holds its slot.
#[test]
fn sales_cap_at_the_limit_and_one_over() {
    let mut s = started();
    for i in 0..20 {
        buy(&mut s, &format!("b{i}.near"), PK, NOW + i);
    }
    refuse_buy(
        &mut s,
        "b20.near",
        PK,
        PRICE,
        BAL + PRICE,
        "LIMIT: key sales full",
    );
    assert_eq!(s.get_key_params().sold, 20);

    let mut s = started();
    s.config.max_key_sales = 50;
    for i in 0..50 {
        buy(&mut s, &format!("b{i}.near"), PK, NOW + i);
    }
    refuse_buy(
        &mut s,
        "b50.near",
        PK,
        PRICE,
        BAL + PRICE,
        "LIMIT: key sales full",
    );
    assert_eq!(s.get_key_sales(0, 50).len(), 50);

    let mut s = started();
    s.config.max_key_sales = 0;
    s.config.key_price = U128(0);
    refuse_buy(&mut s, "bob.near", PK, 0, BAL, "LIMIT: key sales full");
}

/// A price of 0 accepts only a zero deposit; a deposit on a free key is `LIMIT: key price`.
#[test]
fn free_key_takes_no_deposit() {
    let mut s = started();
    s.config.key_price = U128(0);
    refuse_buy(&mut s, "bob.near", PK, 1, BAL + 1, "LIMIT: key price");
    call_at("bob.near", NOW + 5, 0, BAL);
    s.buy_viewing_key(PK.into());
    assert_eq!(s.get_key_params().escrow_total, U128(0));
}

/// EC-C84, EC-C36: the escrowed NEAR is never free, so a purchase that would leave the balance
/// below stake + escrow + record bytes is refused, and one yocto above the line is accepted.
#[test]
fn purchase_keeps_escrow_covered() {
    let mut s = started();
    buy(&mut s, "bob.near", PK, NOW + 7);
    let stake = env::storage_byte_cost().as_yoctonear() * (USAGE + STORAGE_MARGIN_BYTES) as u128;
    let rec = env::storage_byte_cost().as_yoctonear() * KEY_SALE_BYTES;
    // Balance in the call already includes the new deposit.
    let line = stake + PRICE /* held */ + PRICE /* new */ + rec;
    refuse_buy(
        &mut s,
        "carol.near",
        PK,
        PRICE,
        line - 1,
        "LIMIT: balance for registration",
    );
    call_at("carol.near", NOW + 8, PRICE, line);
    s.buy_viewing_key(PK.into());
    assert_eq!(s.get_key_params().sold, 2);
}

/// EC-C177, EC-C84: `start` also needs the balance to cover escrow + owed (both 0 in practice).
#[test]
fn start_reserve_counts_escrow_and_owed() {
    use super::tests_start::{ready, start_at_for_keys};
    // The smallest balance at which a fresh `ready()` strategy starts.
    let passes = |bal: u128, escrow: u128, owed: u128| -> Result<(), String> {
        let mut t = ready();
        t.escrow_total = escrow;
        t.near_owed_total = owed;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            start_at_for_keys(&mut t, bal)
        }))
        .map_err(|_| "refused".to_string())
    };
    let (mut lo, mut hi) = (0u128, BAL);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if passes(mid, 0, 0).is_ok() {
            hi = mid
        } else {
            lo = mid + 1
        }
    }
    let base = lo;
    assert!(passes(base, 0, 0).is_ok() && passes(base - 1, 0, 0).is_err());
    // Escrow only, owed only, and both: one yocto below the line is refused with the exact
    // message and nothing changes; the line itself starts.
    for (escrow, owed) in [(1u128, 0u128), (0, 1), (500, 0), (0, 500), (500, 500)] {
        let line = base + escrow + owed;
        assert!(passes(line, escrow, owed).is_ok(), "{escrow} {owed}");
        assert!(passes(line - 1, escrow, owed).is_err(), "{escrow} {owed}");
        let mut t = ready();
        t.escrow_total = escrow;
        t.near_owed_total = owed;
        let before = (
            t.get_status(),
            t.get_principal(),
            t.get_lock(),
            t.next_op_id,
        );
        assert_eq!(
            refused(|| start_at_for_keys(&mut t, line - 1)),
            "LIMIT: storage reserve",
            "{escrow} {owed}"
        );
        assert_eq!(
            (
                t.get_status(),
                t.get_principal(),
                t.get_lock(),
                t.next_op_id
            ),
            before
        );
    }
    // The old lower bounds, spelled out: owed alone and escrow alone each move the line.
    assert!(passes(base, 0, 1).is_err() && passes(base, 1, 0).is_err());
}

/// Views: pages, caps and unknown accounts.
#[test]
fn views_page_and_cap() {
    let mut s = started();
    for i in 0..5 {
        buy(&mut s, &format!("b{i}.near"), PK, NOW + i);
    }
    let all = s.get_key_sales(0, 50);
    assert_eq!(all.len(), 5);
    assert_eq!(all[3].buyer, acc("b3.near"));
    assert_eq!(
        s.get_key_sales(2, 2)
            .iter()
            .map(|x| x.buyer.to_string())
            .collect::<Vec<_>>(),
        ["b2.near", "b3.near"]
    );
    assert_eq!(s.get_key_sales(0, 1000).len(), 5);
    assert!(s.get_key_sales(5, 10).is_empty());
    assert!(s.get_key_sales(u32::MAX, 10).is_empty());
    assert!(s.get_key_sale("nobody.near".into()).is_none());
    assert!(s.get_key_sale("NOT AN ACCOUNT".into()).is_none());
    assert_eq!(s.get_near_owed("b1.near".into()), U128(0));
    assert_eq!(s.get_near_owed("NOT AN ACCOUNT".into()), U128(0));
    let _ = (events, ok, at);
}

/// Transfers created by the last call: (receiver, yoctoNEAR).
fn transfers() -> Vec<(String, u128)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}
fn deliver(s: &mut Strategy, who: &str, buyer: &str, key: &str, ts: u64) -> Promise {
    call_at(who, ts, 0, BAL);
    s.deliver_key(buyer.to_string(), key.to_string())
}
fn refund(s: &mut Strategy, who: &str, ts: u64) -> Promise {
    call_at(who, ts, 0, BAL);
    s.refund_key()
}
fn bought() -> Strategy {
    let mut s = started();
    buy(&mut s, "bob.near", PK, NOW + 10);
    s
}
fn refuse_deliver(s: &mut Strategy, who: &str, buyer: &str, key: &str, ts: u64, msg: &str) {
    let before = state(s);
    assert_eq!(refused(|| drop(deliver(s, who, buyer, key, ts))), msg);
    assert_eq!(state(s), before, "{msg}: nothing changed");
}
fn refuse_refund(s: &mut Strategy, who: &str, ts: u64, msg: &str) {
    let before = state(s);
    assert_eq!(refused(|| drop(refund(s, who, ts))), msg);
    assert_eq!(state(s), before, "{msg}: nothing changed");
}

/// EC-C174, EC-C137: delivery is allowed up to one nanosecond before the deadline and refused at it;
/// it releases the escrow, stores the key and sends exactly `key_price` to the creator.
#[test]
fn deliver_releases_once() {
    let mut s = bought();
    let deadline = NOW + 10 + WINDOW;
    let _ = deliver(
        &mut s,
        "deliverer.near",
        "bob.near",
        &sealed('a'),
        deadline - 1,
    );
    let sale = s.get_key_sale("bob.near".into()).unwrap();
    assert_eq!(sale.state, KeyState::Released);
    assert_eq!(sale.sealed_key, Some(sealed('a')));
    assert_eq!(s.get_key_params().escrow_total, U128(0));
    assert_eq!(transfers(), vec![("creator.near".to_string(), PRICE)]);
    let e = events()
        .into_iter()
        .find(|e| e["event"] == "key_delivered")
        .unwrap();
    assert_eq!(e["data"][0]["index"], 0);
    assert_eq!(e["data"][0]["buyer"], "bob.near");
    assert_eq!(e["data"][0]["price"], PRICE.to_string());
    assert!(
        !e.to_string().contains(&sealed('a')),
        "the key is not in the log"
    );
    // A second delivery, even by the deliverer: refused, nothing moves.
    refuse_deliver(
        &mut s,
        "deliverer.near",
        "bob.near",
        &sealed('b'),
        deadline - 1,
        "LIMIT: not escrowed",
    );
    assert_eq!(
        s.get_key_sale("bob.near".into()).unwrap().sealed_key,
        Some(sealed('a'))
    );
}

/// EC-C137: at the deadline delivery is refused and the refund is open (exact complements).
#[test]
fn deadline_is_an_exact_complement() {
    let deadline = NOW + 10 + WINDOW;
    let mut s = bought();
    refuse_deliver(
        &mut s,
        "deliverer.near",
        "bob.near",
        &sealed('a'),
        deadline,
        "LIMIT: delivery window closed",
    );
    refuse_deliver(
        &mut s,
        "deliverer.near",
        "bob.near",
        &sealed('a'),
        deadline + 1,
        "LIMIT: delivery window closed",
    );
    refuse_refund(
        &mut s,
        "bob.near",
        deadline - 1,
        "LIMIT: delivery window open",
    );
    let _ = refund(&mut s, "bob.near", deadline);
    assert_eq!(
        s.get_key_sale("bob.near".into()).unwrap().state,
        KeyState::Refunded
    );
}

/// EC-C174, EC-C39: the refusals of `deliver_key` in order, with nothing changed.
#[test]
fn deliver_refusals_in_order() {
    let mut s = bought();
    let ts = NOW + 20;
    for who in [
        "creator.near",
        "agent.near",
        "bob.near",
        "outsider.near",
        "platform.near",
    ] {
        // AUTH beats a bad key and a missing sale.
        refuse_deliver(&mut s, who, "ghost.near", "zz", ts, "AUTH: deliverer only");
    }
    let bad = [
        String::new(),
        sealed('a')[..159].to_string(),
        format!("{}a", sealed('a')),
        sealed('A'),
        sealed('g'),
        format!("0x{}", &sealed('a')[..158]),
    ];
    for k in &bad {
        refuse_deliver(
            &mut s,
            "deliverer.near",
            "ghost.near",
            k,
            ts,
            "LIMIT: sealed key",
        );
    }
    for b in ["ghost.near", "NOT AN ACCOUNT", ""] {
        refuse_deliver(
            &mut s,
            "deliverer.near",
            b,
            &sealed('a'),
            ts,
            "LIMIT: no such sale",
        );
    }
    // Refunded: not escrowed (EC-C62), in any status.
    let _ = refund(&mut s, "bob.near", NOW + 10 + WINDOW);
    refuse_deliver(
        &mut s,
        "deliverer.near",
        "bob.near",
        &sealed('a'),
        NOW + 10 + WINDOW,
        "LIMIT: not escrowed",
    );
    // Delivery works in any status of the strategy.
    for st in [Status::Closing, Status::Closed] {
        let mut s = bought();
        s.status = st;
        let _ = deliver(&mut s, "deliverer.near", "bob.near", &sealed('c'), NOW + 20);
        assert_eq!(
            s.get_key_sale("bob.near".into()).unwrap().state,
            KeyState::Released
        );
    }
}

/// EC-C175, EC-C62: only the buyer, only once, in any status; the NEAR goes to the buyer.
#[test]
fn refund_pays_the_buyer_once() {
    let deadline = NOW + 10 + WINDOW;
    for st in [
        Status::Running,
        Status::Closing,
        Status::Closed,
        Status::Cancelled,
    ] {
        let mut s = bought();
        s.status = st;
        refuse_refund(&mut s, "carol.near", deadline, "LIMIT: no such sale");
        refuse_refund(&mut s, "creator.near", deadline, "LIMIT: no such sale");
        refuse_refund(
            &mut s,
            "bob.near",
            deadline - 1,
            "LIMIT: delivery window open",
        );
        let _ = refund(&mut s, "bob.near", deadline);
        assert_eq!(transfers(), vec![("bob.near".to_string(), PRICE)]);
        assert_eq!(s.get_key_params().escrow_total, U128(0));
        let e = events()
            .into_iter()
            .find(|e| e["event"] == "key_refunded")
            .unwrap();
        assert_eq!(e["data"][0]["buyer"], "bob.near");
        refuse_refund(&mut s, "bob.near", deadline + 5, "LIMIT: not escrowed");
        // A refunded buyer cannot buy again, and the slot stays used.
        let sold = s.get_key_params().sold;
        call_at("bob.near", deadline + 6, PRICE, BAL + PRICE);
        if st == Status::Running {
            assert_eq!(
                refused(|| s.buy_viewing_key(PK.into())),
                "LIMIT: already bought"
            );
        }
        assert_eq!(s.get_key_params().sold, sold);
    }
    // A delivered sale cannot be refunded.
    let mut s = bought();
    let _ = deliver(&mut s, "deliverer.near", "bob.near", &sealed('a'), NOW + 20);
    refuse_refund(&mut s, "bob.near", deadline + 100, "LIMIT: not escrowed");
}

/// EC-C36, EC-C176: a bounced payout or refund is held for the account, and the sale stays final.
#[test]
fn bounced_transfers_are_held_and_withdrawn() {
    // Payout bounces: held for the creator.
    let mut s = bought();
    let _ = deliver(&mut s, "deliverer.near", "bob.near", &sealed('a'), NOW + 20);
    as_callback(BLOCK + 200, vec![PromiseResult::Failed]);
    s.on_near_paid(acc("creator.near"), U128(PRICE), "key_payout".into());
    assert_eq!(s.get_near_owed("creator.near".into()), U128(PRICE));
    assert_eq!(s.get_key_params().near_owed_total, U128(PRICE));
    assert_eq!(
        s.get_key_sale("bob.near".into()).unwrap().state,
        KeyState::Released
    );
    let e = last_event();
    assert_eq!(e["event"], "near_owed");
    assert_eq!(e["data"][0]["reason"], "key_payout");
    assert_eq!(e["data"][0]["amount"], PRICE.to_string());
    // A successful transfer changes nothing.
    let mut t = bought();
    let _ = deliver(&mut t, "deliverer.near", "bob.near", &sealed('a'), NOW + 20);
    as_callback(BLOCK + 200, vec![ok("")]);
    t.on_near_paid(acc("creator.near"), U128(PRICE), "key_payout".into());
    assert_eq!(t.get_near_owed("creator.near".into()), U128(0));
    // Only the contract itself may call the callback.
    call_at("outsider.near", NOW, 0, BAL);
    assert_eq!(
        refused(|| s.on_near_paid(acc("outsider.near"), U128(PRICE), "key_payout".into())),
        "AUTH: callback only"
    );
    assert_eq!(s.get_near_owed("outsider.near".into()), U128(0));
}

fn owed_state(s: &Strategy) -> String {
    near_sdk::serde_json::to_string(&(s.get_key_params(), s.get_key_sales(0, 50))).unwrap()
}
fn held(s: &mut Strategy, who: &str, amount: u128) {
    as_callback(BLOCK + 300, vec![PromiseResult::Failed]);
    s.on_near_paid(acc(who), U128(amount), "key_refund".into());
}

/// EC-C176: `withdraw_near` zeroes the entry before the transfer, pays exactly the entry, and a
/// failed transfer restores it; nothing owed is refused.
#[test]
fn withdraw_near_pulls_what_is_held() {
    let mut s = bought();
    buy(&mut s, "carol.near", PK, NOW + 11);
    held(&mut s, "bob.near", PRICE);
    held(&mut s, "bob.near", 5);
    held(&mut s, "carol.near", 7);
    assert_eq!(s.get_near_owed("bob.near".into()), U128(PRICE + 5));
    assert_eq!(s.get_key_params().near_owed_total, U128(PRICE + 12));
    // Nothing owed: refused, nothing changed.
    let before = owed_state(&s);
    for who in ["dave.near", "creator.near", "deliverer.near"] {
        call_at(who, NOW + 50, 0, BAL);
        assert_eq!(refused(|| drop(s.withdraw_near())), "LIMIT: nothing owed");
        assert_eq!(owed_state(&s), before);
    }
    // Bob withdraws: entry gone before any callback, one transfer of exactly the entry.
    call_at("bob.near", NOW + 50, 0, BAL);
    let _ = s.withdraw_near();
    assert_eq!(transfers(), vec![("bob.near".to_string(), PRICE + 5)]);
    assert_eq!(s.get_near_owed("bob.near".into()), U128(0));
    assert_eq!(s.get_key_params().near_owed_total, U128(7));
    assert_eq!(s.get_near_owed("carol.near".into()), U128(7));
    let e = last_event();
    assert_eq!(e["event"], "near_withdrawn");
    assert_eq!(e["data"][0]["amount"], (PRICE + 5).to_string());
    // A second call in a row (before the callback) finds nothing: the NEAR cannot go out twice.
    call_at("bob.near", NOW + 50, 0, BAL);
    assert_eq!(refused(|| drop(s.withdraw_near())), "LIMIT: nothing owed");
    // The transfer bounces: both counters are restored.
    as_callback(BLOCK + 400, vec![PromiseResult::Failed]);
    s.on_near_paid(acc("bob.near"), U128(PRICE + 5), "withdraw".into());
    assert_eq!(s.get_near_owed("bob.near".into()), U128(PRICE + 5));
    assert_eq!(s.get_key_params().near_owed_total, U128(PRICE + 12));
    let e = last_event();
    assert_eq!(e["event"], "near_owed");
    assert_eq!(e["data"][0]["reason"], "withdraw");
    // A successful withdraw leaves it at zero.
    call_at("bob.near", NOW + 60, 0, BAL);
    let _ = s.withdraw_near();
    as_callback(BLOCK + 500, vec![ok("")]);
    s.on_near_paid(acc("bob.near"), U128(PRICE + 5), "withdraw".into());
    assert_eq!(s.get_near_owed("bob.near".into()), U128(0));
    assert_eq!(s.get_key_params().near_owed_total, U128(7));
}

/// EC-C176: owed NEAR is never free for a new purchase or for `start`'s reserve.
#[test]
fn owed_near_is_not_spendable() {
    let mut s = bought();
    held(&mut s, "bob.near", PRICE);
    let stake = env::storage_byte_cost().as_yoctonear() * (USAGE + STORAGE_MARGIN_BYTES) as u128;
    let rec = env::storage_byte_cost().as_yoctonear() * KEY_SALE_BYTES;
    let line = stake + 2 * PRICE + PRICE + rec; // escrow + owed + new deposit + record
    refuse_buy(
        &mut s,
        "carol.near",
        PK,
        PRICE,
        line - 1,
        "LIMIT: balance for registration",
    );
    call_at("carol.near", NOW + 8, PRICE, line);
    s.buy_viewing_key(PK.into());
}

use proptest::prelude::{any, prop_oneof, ProptestConfig};
use proptest::strategy::Strategy as _;
use proptest::{prop_assert, prop_assert_eq, proptest};
use std::panic::{catch_unwind, AssertUnwindSafe};

#[derive(Clone, Debug)]
enum Step {
    Buy(u8),
    Deliver(u8),
    Refund(u8),
    Wait(u64),
    /// The oldest transfer in flight bounces (true) or lands (false).
    Callback(bool),
    Withdraw(u8),
}
fn step() -> impl proptest::strategy::Strategy<Value = Step> {
    prop_oneof![
        (0u8..4).prop_map(Step::Buy),
        (0u8..4).prop_map(Step::Deliver),
        (0u8..4).prop_map(Step::Refund),
        (0u64..WINDOW).prop_map(Step::Wait),
        any::<bool>().prop_map(Step::Callback),
        (0u8..4).prop_map(Step::Withdraw),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]
    /// EC-C178: whatever the order of calls and whether transfers land or bounce, a refused call
    /// changes nothing, `escrow_total` is the sum of the open sales, `near_owed_total` the sum of
    /// the entries, a released or refunded sale never pays twice, and the NEAR received equals
    /// escrow + owed + in flight + landed (nothing is created or lost).
    #[test]
    fn money_moves_exactly_once(steps in proptest::collection::vec(step(), 1..40)) {
        let mut s = started();
        let mut now = NOW + 1;
        let (mut received, mut landed) = (0u128, 0u128);
        let mut pending: Vec<(String, u128, &'static str)> = Vec::new();
        let mut pays = 0usize; // transfers created for sales
        let acct = |i: u8| format!("b{i}.near");
        for st in steps {
            let before = owed_state(&s);
            let res: Result<(), _> = match st {
                Step::Buy(i) => {
                    call_at(&acct(i), now, PRICE, BAL + PRICE);
                    catch_unwind(AssertUnwindSafe(|| s.buy_viewing_key(PK.into()))).map(|_| received += PRICE)
                }
                Step::Deliver(i) => {
                    call_at("deliverer.near", now, 0, BAL);
                    catch_unwind(AssertUnwindSafe(|| drop(s.deliver_key(acct(i), sealed('a')))))
                        .map(|_| { pending.push(("creator.near".into(), PRICE, "key_payout")); pays += 1; })
                }
                Step::Refund(i) => {
                    call_at(&acct(i), now, 0, BAL);
                    catch_unwind(AssertUnwindSafe(|| drop(s.refund_key())))
                        .map(|_| { pending.push((acct(i), PRICE, "key_refund")); pays += 1; })
                }
                Step::Wait(d) => { now += d; Ok(()) }
                Step::Callback(bounce) => {
                    if !pending.is_empty() {
                        let (who, amount, reason) = pending.remove(0);
                        if bounce {
                            as_callback(BLOCK + 300, vec![PromiseResult::Failed]);
                        } else {
                            as_callback(BLOCK + 300, vec![ok("")]);
                            landed += amount;
                        }
                        s.on_near_paid(acc(&who), U128(amount), reason.into());
                    }
                    Ok(())
                }
                Step::Withdraw(i) => {
                    let owed = s.get_near_owed(acct(i)).0;
                    call_at(&acct(i), now, 0, BAL);
                    catch_unwind(AssertUnwindSafe(|| drop(s.withdraw_near())))
                        .map(|_| pending.push((acct(i), owed, "withdraw")))
                }
            };
            if res.is_err() {
                prop_assert_eq!(owed_state(&s), before, "a refused call changed state");
            }
            let sales = s.get_key_sales(0, 50);
            let open: u128 = sales.iter().filter(|x| x.state == KeyState::Escrowed).map(|x| x.price.0).sum();
            let p = s.get_key_params();
            prop_assert_eq!(p.escrow_total.0, open);
            let owed: u128 = (0..4).map(|i| s.get_near_owed(acct(i)).0).sum::<u128>()
                + s.get_near_owed("creator.near".into()).0;
            prop_assert_eq!(p.near_owed_total.0, owed);
            let in_flight: u128 = pending.iter().map(|x| x.1).sum();
            prop_assert_eq!(received, open + owed + in_flight + landed);
            let settled = sales.iter().filter(|x| x.state != KeyState::Escrowed).count();
            prop_assert_eq!(pays, settled, "one payment per settled sale");
            prop_assert!(sales.iter().all(|x| (x.state == KeyState::Released) == x.sealed_key.is_some()));
        }
    }
}

// ---- EC-C179: every spend from a live strategy leaves escrow + owed untouched ----

const RULES179: &str = r#"{"version":1,"rules":[{"when":"time"}]}"#;
type Make = fn() -> Strategy;
type Call = fn(&mut Strategy, u128);

fn make_retry() -> Strategy {
    let mut s = deployed();
    callback(&mut s, Target::QuoteToken, false);
    s
}
fn call_retry(s: &mut Strategy, bal: u128) {
    testing_env!(ctx("creator.near", bal, Gas::from_tgas(300), BLOCK + 7).build());
    s.retry_registration(Target::QuoteToken);
}
fn call_register_tokens(s: &mut Strategy, bal: u128) {
    testing_env!(ctx("creator.near", bal, Gas::from_tgas(100), BLOCK + 100).build());
    let _ = s.register_tokens();
}
fn make_reveal() -> Strategy {
    let mut s = started();
    s.config.rules_hash = RULES179_HASH.with(|h| h.clone());
    s
}
thread_local! {
    static RULES179_HASH: String = env::sha256_array(RULES179.as_bytes()).iter().map(|x| format!("{x:02x}")).collect();
}
fn call_reveal(s: &mut Strategy, bal: u128) {
    testing_env!(ctx("creator.near", bal, Gas::from_tgas(30), BLOCK + 60).build());
    s.reveal(RULES179.to_string());
}
fn fingerprint(s: &Strategy) -> String {
    near_sdk::serde_json::to_string(&(
        s.get_status(),
        s.get_registrations(),
        s.get_revealed(),
        s.tokens_registered,
        s.get_lock(),
        s.next_op_id,
        s.get_key_params(),
    ))
    .unwrap()
}
fn passes(make: Make, call: Call, bal: u128, escrow: u128, owed: u128) -> bool {
    let mut s = make();
    s.escrow_total = escrow;
    s.near_owed_total = owed;
    catch_unwind(AssertUnwindSafe(|| call(&mut s, bal))).is_ok()
}
fn boundary(name: &str, make: Make, call: Call) {
    let (mut lo, mut hi) = (0u128, BAL);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if passes(make, call, mid, 0, 0) {
            hi = mid
        } else {
            lo = mid + 1
        }
    }
    let base = lo;
    assert!(base > 0 && base < BAL, "{name}: boundary found");
    assert!(!passes(make, call, base - 1, 0, 0), "{name}");
    for (escrow, owed) in [(1u128, 0u128), (0, 1), (PRICE, PRICE)] {
        let line = base + escrow + owed;
        let mut s = make();
        s.escrow_total = escrow;
        s.near_owed_total = owed;
        let before = fingerprint(&s);
        assert_eq!(
            refused(|| call(&mut s, line - 1)),
            "LIMIT: balance for registration",
            "{name} escrow {escrow} owed {owed}"
        );
        assert_eq!(fingerprint(&s), before, "{name}: nothing changed");
        assert!(
            passes(make, call, line, escrow, owed),
            "{name} accepted at the line"
        );
    }
}

/// EC-C179: `retry_registration` (a launch) never spends escrow or owed NEAR. Reverting it from
/// `require_free` to `require_balance` fails this.
#[test]
fn launch_never_touches_escrow_or_owed() {
    boundary("retry_registration", make_retry, call_retry);
}
/// EC-C179: `register_tokens`, as above.
#[test]
fn register_tokens_never_touches_escrow_or_owed() {
    boundary("register_tokens", started, call_register_tokens);
}
/// EC-C179: `reveal`, as above.
#[test]
fn reveal_never_touches_escrow_or_owed() {
    boundary("reveal", make_reveal, call_reveal);
}

/// Audit M1: the payout and refund callbacks are scheduled on the contract itself with the exact
/// recipient, amount and reason, with the fixed callback gas.
#[test]
fn payment_callbacks_carry_the_right_arguments() {
    let check = |who: &str, reason: &str| {
        let c: Vec<_> = calls()
            .into_iter()
            .filter(|c| c.1 == "on_near_paid")
            .collect();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].0, ME);
        let a: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&c[0].2).unwrap();
        assert_eq!(
            a,
            near_sdk::serde_json::json!({"to": who, "amount": PRICE.to_string(), "reason": reason})
        );
        assert_eq!((c[0].3, c[0].4, c[0].5), (0, GAS_CALLBACK.as_gas(), 0));
    };
    let mut s = bought();
    let _ = deliver(&mut s, "deliverer.near", "bob.near", &sealed('a'), NOW + 20);
    check("creator.near", "key_payout");
    let mut s = bought();
    let _ = refund(&mut s, "bob.near", NOW + 10 + WINDOW);
    check("bob.near", "key_refund");
    let mut s = bought();
    held(&mut s, "bob.near", PRICE);
    call_at("bob.near", NOW + 50, 0, BAL);
    let _ = s.withdraw_near();
    check("bob.near", "withdraw");
}

/// Audit M2: the reserved bytes per sale cover the largest sale and owed entry as stored.
#[test]
fn reserved_bytes_cover_the_largest_sale() {
    let sale = KeySale {
        buyer: acc(&format!("{}.near", "a".repeat(59))),
        buyer_pubkey: "f".repeat(64),
        state: KeyState::Released,
        bought_at_ns: U64(u64::MAX),
        price: U128(u128::MAX),
        sealed_key: Some("f".repeat(160)),
    };
    let owed: (AccountId, u128) = (sale.buyer.clone(), u128::MAX);
    let size = near_sdk::borsh::to_vec(&sale).unwrap().len()
        + near_sdk::borsh::to_vec(&owed).unwrap().len();
    assert!(
        (size as u128) <= KEY_SALE_BYTES,
        "{size} > {KEY_SALE_BYTES}"
    );
}

/// Audit M4: hex boundaries. 'f' is accepted, 63 and 65 characters are refused, for both keys.
#[test]
fn hex_boundaries() {
    let mut s = started();
    for k in [&"f".repeat(63), &"f".repeat(65), &"1".repeat(63)] {
        refuse_buy(
            &mut s,
            "bob.near",
            k,
            PRICE,
            BAL + PRICE,
            "LIMIT: buyer key",
        );
    }
    buy(&mut s, "bob.near", &"f".repeat(64), NOW + 5);
    for k in [sealed('f')[..159].to_string(), format!("{}f", sealed('f'))] {
        refuse_deliver(
            &mut s,
            "deliverer.near",
            "bob.near",
            &k,
            NOW + 6,
            "LIMIT: sealed key",
        );
    }
    let _ = deliver(&mut s, "deliverer.near", "bob.near", &sealed('f'), NOW + 6);
    assert_eq!(
        s.get_key_sale("bob.near".into()).unwrap().sealed_key,
        Some(sealed('f'))
    );
}

/// Audit M1 (decision): the deliverer account may buy a key like anyone else; the sale escrows
/// and later delivers or refunds as any other. Pinned so it cannot change silently.
#[test]
fn the_deliverer_may_buy_like_anyone() {
    let mut s = started();
    buy(&mut s, "deliverer.near", PK, NOW + 10);
    assert_eq!(
        s.get_key_sale("deliverer.near".into()).unwrap().state,
        KeyState::Escrowed
    );
    assert_eq!(s.get_key_params().escrow_total, U128(PRICE));
    let _ = deliver(
        &mut s,
        "deliverer.near",
        "deliverer.near",
        &sealed('a'),
        NOW + 20,
    );
    assert_eq!(
        s.get_key_sale("deliverer.near".into()).unwrap().state,
        KeyState::Released
    );
    assert_eq!(transfers(), vec![("creator.near".to_string(), PRICE)]);
    let mut t = started();
    buy(&mut t, "deliverer.near", PK, NOW + 10);
    let _ = refund(&mut t, "deliverer.near", NOW + 10 + WINDOW);
    assert_eq!(transfers(), vec![("deliverer.near".to_string(), PRICE)]);
}

/// Audit M3: every other role as the caller of the owner-only and buyer-only methods, with the
/// whole state compared after the refusal.
#[test]
fn other_roles_are_refused_with_nothing_changed() {
    let mut s = bought();
    for who in [
        "creator.near",
        "agent.near",
        "platform.near",
        "outsider.near",
        "bob.near",
    ] {
        refuse_deliver(
            &mut s,
            who,
            "bob.near",
            &sealed('a'),
            NOW + 20,
            "AUTH: deliverer only",
        );
    }
    for who in [
        "creator.near",
        "agent.near",
        "platform.near",
        "deliverer.near",
        "outsider.near",
    ] {
        refuse_refund(&mut s, who, NOW + 10 + WINDOW, "LIMIT: no such sale");
        let before = state(&s);
        call_at(who, NOW + 50, 0, BAL);
        assert_eq!(refused(|| drop(s.withdraw_near())), "LIMIT: nothing owed");
        assert_eq!(state(&s), before);
    }
    // The buyer also has nothing owed.
    let before = state(&s);
    call_at("bob.near", NOW + 50, 0, BAL);
    assert_eq!(refused(|| drop(s.withdraw_near())), "LIMIT: nothing owed");
    assert_eq!(state(&s), before);
}

/// Audit M7: when two checks would fail, the earlier one in INTERFACE 9's list wins.
#[test]
fn the_first_failing_check_wins() {
    // buy: status over price; price over key; key over already bought; already bought over full;
    // full over balance.
    let mut s = started();
    s.status = Status::Closing;
    refuse_buy(&mut s, "bob.near", "zz", 1, BAL, "LIMIT: wrong status");
    let mut s = started();
    refuse_buy(&mut s, "bob.near", "zz", 1, BAL, "LIMIT: key price");
    buy(&mut s, "bob.near", PK, NOW + 5);
    refuse_buy(&mut s, "bob.near", "zz", PRICE, BAL, "LIMIT: buyer key");
    s.config.max_key_sales = 1;
    refuse_buy(&mut s, "bob.near", PK, PRICE, 1, "LIMIT: already bought");
    refuse_buy(&mut s, "carol.near", PK, PRICE, 1, "LIMIT: key sales full");
    // deliver: a Released sale past its deadline is "not escrowed", not "window closed".
    let mut s = bought();
    let _ = deliver(&mut s, "deliverer.near", "bob.near", &sealed('a'), NOW + 20);
    refuse_deliver(
        &mut s,
        "deliverer.near",
        "bob.near",
        &sealed('a'),
        NOW + 10 + WINDOW + 1,
        "LIMIT: not escrowed",
    );
    // refund: a Released sale inside the window is "not escrowed", not "window open".
    refuse_refund(&mut s, "bob.near", NOW + 21, "LIMIT: not escrowed");
}

/// Audit M8: the escrow counter after two purchases and after one delivery.
#[test]
fn escrow_total_follows_the_sales() {
    let mut s = bought();
    buy(&mut s, "carol.near", PK, NOW + 11);
    assert_eq!(s.get_key_params().escrow_total, U128(2 * PRICE));
    let _ = deliver(&mut s, "deliverer.near", "bob.near", &sealed('a'), NOW + 20);
    assert_eq!(s.get_key_params().escrow_total, U128(PRICE));
    let _ = refund(&mut s, "carol.near", NOW + 11 + WINDOW);
    assert_eq!(s.get_key_params().escrow_total, U128(0));
}

/// Audit: 63 zeros and a 1 is a valid key; 64 zeros is not.
#[test]
fn almost_zero_key_is_accepted() {
    let mut s = started();
    refuse_buy(
        &mut s,
        "bob.near",
        &"0".repeat(64),
        PRICE,
        BAL + PRICE,
        "LIMIT: buyer key",
    );
    buy(&mut s, "bob.near", &format!("{}1", "0".repeat(63)), NOW + 5);
    assert_eq!(s.get_key_params().sold, 1);
}
