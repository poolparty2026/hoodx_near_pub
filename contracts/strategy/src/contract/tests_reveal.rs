//! Slice 10 unit tests: `reveal` (EC-C17, EC-C37, EC-C146).
use super::tests::*;
use super::tests_funding::{at, last_event};
use super::tests_start::started;
use super::*;

const RULES: &str = r#"{"version":1,"rules":[{"when":"time"}]}"#;

fn hex(b: [u8; 32]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn with_rules(rules: &str) -> Strategy {
    let mut s = started();
    at("creator.near", BLOCK + 50, NOW, Gas::from_tgas(30));
    s.config.rules_hash = hex(env::sha256_array(rules.as_bytes()));
    s
}
fn reveal_as(s: &mut Strategy, who: &str, rules: &str) {
    at(who, BLOCK + 60, NOW, Gas::from_tgas(30));
    s.reveal(rules.to_string());
}
fn expect(s: &mut Strategy, who: &str, rules: &str, msg: &str) {
    let before = (s.get_revealed(), s.get_status());
    assert_eq!(refused(|| reveal_as(s, who, rules)), msg, "{who}");
    assert_eq!((s.get_revealed(), s.get_status()), before);
}

/// EC-C37: who may reveal when.
#[test]
fn who_may_reveal_when() {
    for st in [Status::Open, Status::Cancelled] {
        let mut s = with_rules(RULES);
        s.status = st;
        expect(&mut s, "creator.near", RULES, "LIMIT: wrong status");
    }
    // Running: only the creator.
    let mut s = with_rules(RULES);
    for who in [
        "outsider.near",
        "agent.near",
        "platform.near",
        "deliverer.near",
    ] {
        expect(&mut s, who, RULES, "AUTH: creator only while running");
    }
    reveal_as(&mut s, "creator.near", RULES);
    assert_eq!(s.get_revealed().as_deref(), Some(RULES));
    // Closing and Closed: anyone.
    for st in [Status::Closing, Status::Closed] {
        let mut s = with_rules(RULES);
        s.status = st;
        reveal_as(&mut s, "outsider.near", RULES);
        assert_eq!(s.get_revealed().as_deref(), Some(RULES));
        let e = last_event();
        assert_eq!(e["event"], "reveal");
        assert_eq!(e["data"][0]["bytes"], RULES.len());
    }
}

/// EC-C17: wrong content, the same JSON in another key order or with whitespace, and a second
/// reveal are refused; only the exact committed bytes are accepted, once.
#[test]
fn only_the_exact_bytes_and_only_once() {
    let mut s = with_rules(RULES);
    for bad in [
        "",
        "{}",
        r#"{"rules":[{"when":"time"}],"version":1}"#,
        r#"{"version":1, "rules":[{"when":"time"}]}"#,
        " {\"version\":1,\"rules\":[{\"when\":\"time\"}]}",
        &format!("{RULES}\n"),
    ] {
        expect(&mut s, "creator.near", bad, "LIMIT: rules hash");
    }
    reveal_as(&mut s, "creator.near", RULES);
    expect(&mut s, "creator.near", RULES, "LIMIT: already revealed");
    expect(&mut s, "creator.near", "other", "LIMIT: already revealed");
    assert_eq!(
        s.get_revealed().as_deref(),
        Some(RULES),
        "kept byte for byte"
    );
}

/// EC-C146: 4,096 bytes is accepted, 4,097 is refused before any hashing.
#[test]
fn the_size_limit_at_the_limit_and_one_over() {
    let ok = format!("{{\"p\":\"{}\"}}", "x".repeat(4_096 - 8));
    assert_eq!(ok.len(), 4_096);
    let mut s = with_rules(&ok);
    reveal_as(&mut s, "creator.near", &ok);
    assert_eq!(s.get_revealed().map(|r| r.len()), Some(4_096));
    let over = format!("{ok} ");
    let mut s = with_rules(&over);
    expect(&mut s, "creator.near", &over, "LIMIT: rules too large");
    // Multi-byte text counts bytes, not characters: 2,049 two-byte characters are 4,098 bytes.
    let wide = "é".repeat(2_049);
    let mut s = with_rules(&wide);
    expect(&mut s, "creator.near", &wide, "LIMIT: rules too large");
}

/// The stored string needs NEAR for its storage: refused (nothing stored) if the balance would
/// fall below the stake.
#[test]
fn reveal_keeps_the_storage_stake() {
    let mut s = with_rules(RULES);
    near_sdk::testing_env!(ctx("creator.near", stake(), Gas::from_tgas(30), BLOCK + 60).build());
    assert_eq!(
        refused(|| s.reveal(RULES.to_string())),
        "LIMIT: balance for registration"
    );
    assert_eq!(s.get_revealed(), None);
}
