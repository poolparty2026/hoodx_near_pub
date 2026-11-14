# Audit: D57 viewing keys, contract slice, range 1a9004e..a509172 (origin/contract/viewing-keys)

14 November 2026. Three fresh auditors, scope only: security-auditor, contract-reviewer, test-auditor. Unit tests: 302 pass (`cargo test -p strategy --lib`), clippy clean. No sandbox test exists for the key flow yet (later range).

Verdict: **Block (test-auditor H1)**. security-auditor: pass. contract-reviewer: ready after fixes.
Counts (merged, duplicates joined): Critical 0, High 1, Medium 8, Low ~12.

## High
- **H1 (test-auditor).** `launch` (contract.rs:476), `register_tokens` (open.rs:142), `reveal` (reveal.rs:34) were switched to `require_free`; no test sets `escrow_total`/`near_owed_total` above 0 and calls them. Reverting any one to `require_balance`, or dropping `near_owed_total`, stays green. Fix: new ID EC-C179; for each method test balance = old requirement + escrow + owed - 1 (exact refusal, state unchanged) and at the line (accepted). Include a case through the real `reveal` (EC-C173 "after reveal").

## Medium
- **M1 (test, contract-reviewer, security L5).** Spec says `buy_viewing_key` is "any account (not the deliverer)"; keys.rs:124-170 does not refuse it and nothing tests it. No funds at risk (deliverer is distinct from creator/agent, limits.rs:130-142; payout goes to creator) but role separation is broken. Fix: add refusal (suggested `LIMIT: deliverer cannot buy`, position in the order stated in INTERFACE 9) plus test, or drop the clause and pin the behaviour with a test.
- **M2 (contract-reviewer, test M1).** `pay_out` callback args untested: assert the receipt has one FunctionCall `on_near_paid` with `{to, amount, reason}` correct (deliver, refund, withdraw tests, tests_keys.rs:357, 504, 591).
- **M3 (contract-reviewer, test L2).** `on_near_paid` `callback_only` guard (keys.rs ~252-262) has no negative test. Security-auditor read the guard as present (funding.rs:148). Missing guard would let anyone credit `near_owed` without NEAR and drain escrow via `withdraw_near`. Fix: test `AUTH: callback only` from outsider, creator, deliverer, buyer with full state compared; success and failure result paths.
- **M4 (contract-reviewer, security L1).** Bounce-to-missing-account (Transfer shows Failed in callback and NEAR returns) is unverified; module header says so; no `docs/gates/` entry; sandbox test needed. Write result to `docs/gates/`.
- **M5 (test M2, contract-reviewer 5).** `KEY_SALE_BYTES = 640` never checked against real serialized size (security-auditor estimates ~326 + ~84 bytes, so adequate). Fix: test the worst-case `KeySale` + `near_owed` entry serialized length against 640, or measure `storage_usage()`.
- **M6 (test M4).** Hex boundaries: 'f' never accepted, no 63/65 char cases, no pubkey of 63 zeros + '1'.
- **M7 (test M5).** Check order untested for adjacent pairs (status vs revealed, price vs key, key vs already bought, already bought vs sales full, sales full vs balance; deliver: not escrowed vs window closed).
- **M8 (test M6).** `escrow_total` accumulation covered only by the 48-case proptest; assert 2*PRICE after two buys, PRICE after one delivery, differing prices.

## Low
- Bounce callback failure (gas/panic) leaves refunded NEAR as unaccounted free balance, no retry (10 Tgas, small callback). Document in EDGE_CASES. (security 2, contract 7)
- Bounced credit to a deleted account is permanently locked in `near_owed_total`; harms no one else. Accept or design a sweep. (security 3)
- `on_near_paid` with amount 0 pushes a zero entry; skip it. (security 4)
- `key_price` 0 is allowed (limits.rs:151): one party can fill `max_key_sales` (<=50) from throwaway accounts and lock out real buyers; cost is gas only. Require price > 0 or document. (security 6, contract 4)
- `deliver_key` works after `reveal`: buyer may pay for rules already public. Spec allows; add a line to README/check page. (contract 6)
- Reserve is taken at purchase only; later `require_free` uses actual usage plus margin, delivery writes ~160 bytes. Pin max sizes in a test. (contract 5)
- Invariant `balance - storage >= escrow + owed` not enforced on exempt paths (exit, settle, claims, `credit_owed`), per principle 11. Note only. (contract 8)
- Spec drift: INTERFACE.md lines 55, 95, 204 still say "Not in v1 (D55)" and `key_sale` event name; ARCHITECTURE.md still names `key_sale`, `rekey`, `get_sealed_key`. Mark superseded by section 9.
- Test lows: refund test vacuous for non-Running statuses (tests_keys.rs:512-521); `key_refund` event/`Reason::parse` mapping unasserted; EC-C177 below-line cases assert only `is_err()`; deadline saturation and window 0/u64::MAX untested; `KeySale` JSON shape untested; `let _ = (events, ok, at);` at :300; proptest has 4 buyers, fixed price, never varies deposit/status/caller.

## Positive findings (security-auditor, contract-reviewer)
State and totals are lowered before every transfer; deliver/refund are exact complements at the deadline; refusal order and messages match INTERFACE 9; `require_free` covers all NEAR-spending paths found; no new dependency; tests give exact messages and full-state comparison.

## Needed to clear the block
H1 fixed with EC-C179. M1 to M3 fixed (code or spec). M4 to M8 fixed or accepted as open items under D52 with a THREAT_MODEL row (M4 needs the sandbox test in the later range).
