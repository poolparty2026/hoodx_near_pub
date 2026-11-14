import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED, ALLOWED_CALLS, DCL, MAX_DCL_STORAGE, MAX_TOKEN_STORAGE, MAX_USDC, MAX_WRAP, POOL, RPC, USDC, WRAP,
  WRAP_STORAGE, GAS_MARGIN,
  assertMainnet, assertRunAllowed, availableNear, buildTx, checkAccount, checkAmounts, checkNoContract, checkOwnPosition, checkPoint,
  checkTestSize, checkTxMatches, cliArgs, NEAR_SPAWN, rpcErrorText, canonical, receiptBlocks, openPositions, removeMin, slotsFull, depositsLanded, feeComparison, feesAbove0, formatDeposit, main, nearDecimal,
  parseAmount, parseFlags, parsePredictRemove, parseTxHash, preflight, removeResult, txOutcome, u128, unwrapAmount, withdrawPlan,
  type IO, type Tx,
} from "./mainnet-roundtrip.ts";

const ME = "alice.near";
const S04 = "--account has a contract or function-call keys (a strategy or agent account, or a wallet with dApp logins?); use a freshly created test account with only a full-access key (EC-S04)";
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const deposit = (receiver: string, amount: bigint): Tx => ({ receiver, method: "ft_transfer_call", args: { receiver_id: DCL, amount: String(amount), msg: "\"Deposit\"" }, depositYocto: 1n, gasTgas: 100 });

test("EC-S01: the caps and counterparties are pinned to their literal values", () => {
  assert.equal(MAX_USDC, 5_000_000n);
  assert.equal(MAX_WRAP, 10n ** 24n);
  assert.equal(MAX_DCL_STORAGE, 10n ** 24n);
  assert.equal(MAX_TOKEN_STORAGE, 10n ** 22n);
  assert.equal(DCL, "dclv2.ref-labs.near");
  assert.equal(USDC, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
  assert.equal(WRAP, "wrap.near");
  assert.equal(POOL, "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1|wrap.near|100");
  assert.deepEqual([...ALLOWED].sort(), ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "dclv2.ref-labs.near", "wrap.near"]);
  assert.equal(ALLOWED_CALLS.size, 9);
});

test("EC-S02: views go to the mainnet RPC and the CLI signs on mainnet from the keychain", () => {
  assert.equal(RPC, "https://rpc.mainnet.near.org");
  const args = cliArgs({ receiver: DCL, method: "withdraw_asset", args: { token_id: USDC, skip_unwrap_near: true }, depositYocto: 0n, gasTgas: 100 }, ME);
  assert.deepEqual(args, ["contract", "call-function", "as-transaction", DCL, "withdraw_asset", "json-args", JSON.stringify({ token_id: USDC, skip_unwrap_near: true }),
    "prepaid-gas", "100 Tgas", "attached-deposit", "0 NEAR", "sign-as", ME, "network-config", "mainnet", "sign-with-keychain", "send"]);
  assert.throws(() => checkAccount("alice.testnet"), { message: "--account is a testnet account; this script runs on mainnet" });
});

test("EC-S03, EC-S08: run and recover need the review flag; dry doesn't", () => {
  assert.throws(() => assertRunAllowed({ mode: "run", reviewed: false }), { message: "run mode needs --i-have-reviewed-this-script" });
  assert.throws(() => assertRunAllowed({ mode: "recover", reviewed: false }), { message: "recover mode needs --i-have-reviewed-this-script" });
  assertRunAllowed({ mode: "run", reviewed: true });
  assertRunAllowed({ mode: "dry", reviewed: false });
  assert.throws(() => parseFlags(["send", "--account", ME]), { message: "first argument must be dry, run or recover" });
  assert.throws(() => parseFlags([]), { message: "first argument must be dry, run or recover" });
});

test("EC-S07: only allow-listed (receiver, method) pairs can be built", () => {
  assert.throws(() => buildTx({ receiver: "evil.near", method: "ft_transfer_call", args: {}, depositYocto: 1n, gasTgas: 30 }, ME), { message: "refusing a transaction to evil.near" });
  for (const [r, m] of [[WRAP, "storage_unregister"], [DCL, "nft_transfer"], [DCL, "mft_transfer"], [USDC, "ft_transfer"], [USDC, "near_withdraw"], [DCL, "near_deposit"]] as const) {
    assert.throws(() => buildTx({ receiver: r, method: m, args: {}, depositYocto: 1n, gasTgas: 30 }, ME), { message: `refusing ${m} on ${r}` });
  }
});

test("EC-S07: token transfers only deposit into DCL, with exactly 1 yoctoNEAR, above 0 and within the caps", () => {
  assert.ok(buildTx(deposit(USDC, MAX_USDC), ME));
  assert.ok(buildTx(deposit(WRAP, MAX_WRAP), ME));
  assert.throws(() => buildTx(deposit(USDC, MAX_USDC + 1n), ME), { message: "USDC amount over the cap" });
  assert.throws(() => buildTx(deposit(WRAP, MAX_WRAP + 1n), ME), { message: "wNEAR amount over the cap" });
  assert.throws(() => buildTx(deposit(USDC, 0n), ME), { message: "transfer amount must be above 0" });
  assert.throws(() => buildTx({ ...deposit(USDC, 1n), args: { receiver_id: "evil.near", amount: "1", msg: "\"Deposit\"" } }, ME), { message: "token transfers may only go to DCL" });
  const swapMsg = JSON.stringify({ Swap: { pool_ids: [POOL], output_token: WRAP, min_output_amount: "1" } });
  assert.throws(() => buildTx({ ...deposit(USDC, 1n), args: { receiver_id: DCL, amount: "1", msg: swapMsg } }, ME), { message: "token transfers may only deposit" });
  for (const d of [0n, 2n]) assert.throws(() => buildTx({ ...deposit(USDC, 1n), depositYocto: d }, ME), { message: "token transfers attach exactly 1 yoctoNEAR" });
  assert.throws(() => buildTx({ ...deposit(USDC, 1n), args: { receiver_id: DCL, amount: "+1", msg: "\"Deposit\"" } }, ME), { message: "amount must be a decimal string" });
});

test("EC-S01: deposits and storage are capped at their limits, and storage is only for the signer", () => {
  const nd = (d: bigint): Tx => ({ receiver: WRAP, method: "near_deposit", args: {}, depositYocto: d, gasTgas: 30 });
  assert.ok(buildTx(nd(MAX_WRAP), ME));
  assert.throws(() => buildTx(nd(MAX_WRAP + 1n), ME), { message: "near_deposit over the cap" });
  const sd = (r: string, d: bigint, who = ME): Tx => ({ receiver: r, method: "storage_deposit", args: { account_id: who }, depositYocto: d, gasTgas: 30 });
  assert.ok(buildTx(sd(DCL, MAX_DCL_STORAGE), ME));
  assert.throws(() => buildTx(sd(DCL, MAX_DCL_STORAGE + 1n), ME), { message: "DCL storage over the cap" });
  assert.ok(buildTx(sd(WRAP, MAX_TOKEN_STORAGE), ME));
  assert.throws(() => buildTx(sd(WRAP, MAX_TOKEN_STORAGE + 1n), ME), { message: "token storage over the cap" });
  assert.throws(() => buildTx(sd(DCL, 1n, "bob.near"), ME), { message: "storage is only paid for the signing account" });
  const nw = (amount: bigint, d = 1n): Tx => ({ receiver: WRAP, method: "near_withdraw", args: { amount: String(amount) }, depositYocto: d, gasTgas: 30 });
  assert.ok(buildTx(nw(MAX_WRAP), ME));
  assert.throws(() => buildTx(nw(MAX_WRAP + 1n), ME), { message: "near_withdraw over the cap" });
  assert.throws(() => buildTx(nw(1n, 0n), ME), { message: "near_withdraw attaches exactly 1 yoctoNEAR" });
  assert.throws(() => buildTx({ ...nd(1n), depositYocto: -1n }, ME), { message: "negative deposit" });
});

test("EC-S01: liquidity calls attach no deposit, payouts skip unwrapping, add amounts are capped with minimums above 0", () => {
  const add = (o: Record<string, string>, d = 0n): Tx => ({ receiver: DCL, method: "add_liquidity", args: { pool_id: POOL, left_point: 0, right_point: 1, amount_x: "100", amount_y: "100", min_amount_x: "97", min_amount_y: "97", ...o }, depositYocto: d, gasTgas: 150 });
  assert.ok(buildTx(add({}), ME));
  assert.throws(() => buildTx(add({}, 1n), ME), { message: "add_liquidity attaches no deposit" });
  assert.throws(() => buildTx(add({ amount_x: String(MAX_USDC + 1n) }), ME), { message: "add amounts over the cap" });
  assert.throws(() => buildTx(add({ min_amount_x: "0" }), ME), { message: "add minimums must be above 0" });
  assert.throws(() => buildTx({ receiver: DCL, method: "withdraw_asset", args: { token_id: USDC }, depositYocto: 0n, gasTgas: 100 }, ME), { message: "withdraw_asset must skip unwrapping" });
  assert.throws(() => buildTx({ receiver: DCL, method: "remove_liquidity", args: { skip_unwrap_near: true }, depositYocto: 1n, gasTgas: 100 }, ME), { message: "remove_liquidity attaches no deposit" });
});

test("gas is 10 to 300 Tgas, whole numbers", () => {
  const g = (gas: number): Tx => ({ receiver: WRAP, method: "near_deposit", args: {}, depositYocto: 1n, gasTgas: gas });
  for (const ok of [10, 300]) assert.ok(buildTx(g(ok), ME));
  for (const bad of [9, 301, 30.5]) assert.throws(() => buildTx(g(bad), ME), { message: "gas must be 10 to 300 Tgas" });
});

test("EC-S01: amounts parse exactly, the cap is enforced through the flags, flags need values", () => {
  assert.equal(parseAmount("1", 6), 1_000_000n);
  assert.equal(parseAmount("0.2", 24), 2n * 10n ** 23n);
  assert.equal(parseAmount("5.000001", 6), 5_000_001n);
  for (const bad of ["", "-1", "+1", "1e3", "01", "1.", ".5"]) assert.throws(() => parseAmount(bad, 6), { message: `amount must be a plain decimal number: ${JSON.stringify(bad)}` });
  assert.throws(() => parseAmount("1.0000001", 6), { message: "amount has more than 6 decimals" });
  assert.equal(parseFlags(["dry", "--account", ME, "--usdc", "5"]).usdc, MAX_USDC);
  assert.throws(() => parseFlags(["dry", "--account", ME, "--usdc", "5.000001"]), { message: "--usdc must be above 0 and at most 5" });
  assert.throws(() => parseFlags(["dry", "--account", ME, "--wrap-near", "0"]), { message: "--wrap-near must be above 0 and at most 1" });
  assert.throws(() => parseFlags(["dry", "--account", ME, "--wrap-near", "1.000000000000000000000001"]), { message: "--wrap-near must be above 0 and at most 1" });
  assert.throws(() => parseFlags(["dry", "--account", ME, "--usdc"]), { message: "--usdc needs a value" });
  assert.throws(() => parseFlags(["dry", "--account", ME, "--key", "x"]), { message: "unknown argument --key" });
  checkAmounts(MAX_USDC, MAX_WRAP);
  assert.throws(() => checkAmounts(0n, 1n), { message: "--usdc must be above 0 and at most 5" });
  const f = parseFlags(["dry", "--account", ME]);
  assert.deepEqual({ usdc: f.usdc, wrap: f.wrap, reviewed: f.reviewed, lpt: f.lpt }, { usdc: 1_000_000n, wrap: 2n * 10n ** 23n, reviewed: false, lpt: null });
});

test("the account is the person's own mainnet account, at most 64 characters", () => {
  assert.equal(checkAccount(ME), ME);
  assert.equal(checkAccount("a".repeat(64)), "a".repeat(64));
  assert.throws(() => checkAccount("a".repeat(65)), { message: "--account must be a NEAR account id" });
  for (const bad of ["", "A.near", "a"]) assert.throws(() => checkAccount(bad), { message: "--account must be a NEAR account id" });
  for (const own of [DCL, USDC, WRAP]) assert.throws(() => checkAccount(own), { message: "--account must be your own test account" });
});

test("preflight refuses a run that would strand money", () => {
  const pool = { state: "Running", token_x: USDC, token_y: WRAP, fee: 100 };
  const rich = { usdc: MAX_USDC, near: 10n ** 25n };
  assert.deepEqual(preflight(pool, rich, 1_000_000n, 2n * 10n ** 23n, true, 5n * 10n ** 23n, [0n, 0n]), []);
  assert.deepEqual(preflight({ ...pool, state: "Paused" }, rich, 1n, 1n, false, null, [0n, 0n]), ["pool state is Paused, not Running"]);
  assert.deepEqual(preflight({ ...pool, token_x: WRAP, token_y: USDC }, rich, 1n, 1n, false, null, [0n, 0n]), ["pool tokens or fee aren't USDC/wNEAR fee 100"]);
  assert.deepEqual(preflight(pool, { ...rich, usdc: 999_999n }, 1_000_000n, 1n, false, null, [0n, 0n]), ["USDC balance 999999 is below --usdc 1000000"]);
  const need = 2n * 10n ** 23n + 5n * 10n ** 23n + 3n * 10n ** 23n;
  assert.deepEqual(preflight(pool, { ...rich, near: need }, 1n, 2n * 10n ** 23n, false, 5n * 10n ** 23n, [0n, 0n]), []);
  assert.deepEqual(preflight(pool, { ...rich, near: need - 1n }, 1n, 2n * 10n ** 23n, false, 5n * 10n ** 23n, [0n, 0n]), ["NEAR balance 0.999999999999999999999999 NEAR is below the 1 NEAR needed (wrap, storage and gas)"]);
  // wrap.near storage counts toward the NEAR needed
  const needW = 2n * 10n ** 23n + WRAP_STORAGE + 5n * 10n ** 23n + GAS_MARGIN;
  assert.deepEqual(preflight(pool, { ...rich, near: needW }, 1n, 2n * 10n ** 23n, true, 5n * 10n ** 23n, [0n, 0n]), []);
  assert.deepEqual(preflight(pool, { ...rich, near: needW - 1n }, 1n, 2n * 10n ** 23n, true, 5n * 10n ** 23n, [0n, 0n]), [`NEAR balance ${nearDecimal(needW - 1n)} is below the ${nearDecimal(needW)} needed (wrap, storage and gas)`]);
  assert.deepEqual(preflight({ ...pool, fee: 2000 }, rich, 1n, 1n, false, null, [0n, 0n]), ["pool tokens or fee aren't USDC/wNEAR fee 100"]);
  // EC-S09: an earlier run's DCL balance must be recovered first
  assert.deepEqual(preflight(pool, rich, 1n, 1n, false, null, [1n, 0n]), ["DCL already holds USDC 1 and wNEAR 0 for this account; run recover first"]);
  assert.deepEqual(preflight(pool, rich, 1n, 1n, false, null, [0n, 1n]), ["DCL already holds USDC 0 and wNEAR 1 for this account; run recover first"]);
});

test("the deposits must have landed in DCL before the add", () => {
  assert.equal(depositsLanded({ [USDC]: "1000000", [WRAP]: "200" }, 1_000_000n, 200n), null);
  assert.equal(depositsLanded({ [USDC]: "999999", [WRAP]: "200" }, 1_000_000n, 200n), "DCL holds USDC 999999 and wNEAR 200, less than deposited");
  assert.equal(depositsLanded({}, 1n, 1n), "DCL holds USDC 0 and wNEAR 0, less than deposited");
});

test("withdraws are planned only for non-zero DCL balances; unwrap only what the run added", () => {
  assert.deepEqual(withdrawPlan({ [USDC]: "0", [WRAP]: "5" }, ME).map((t) => t.args["token_id"]), [WRAP]);
  assert.deepEqual(withdrawPlan({}, ME), []);
  assert.equal(unwrapAmount(37n, 40n), 3n);
  assert.equal(unwrapAmount(40n, 37n), 0n);
  assert.equal(unwrapAmount(0n, MAX_WRAP + 5n), MAX_WRAP);
});

test("a failed transaction stops the script; a failed later receipt is told apart", () => {
  assert.equal(txOutcome({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }] }), "ok");
  assert.equal(txOutcome({ status: { Failure: {} } }), "failed");
  assert.equal(txOutcome({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { Failure: { ActionError: {} } } } }] }), "receipt_failed");
  assert.equal(txOutcome(null), "failed");
  assert.equal(txOutcome({}), "failed");
  assert.equal(txOutcome({ status: {} }), "failed");
});

test("strict u128 reads from RPC answers", () => {
  assert.equal(u128("123", "x"), 123n);
  for (const bad of [123, "+1", "01", "", "1.5"]) assert.throws(() => u128(bad, "x"), { message: "x must be a decimal string" });
  assert.throws(() => u128((1n << 128n).toString(), "x"), { message: "x must fit in u128" });
});

test("finds the transaction hash in the CLI output, or reports none", () => {
  assert.equal(parseTxHash("Transaction sent ...\nTransaction ID: 8MbWbCEhRWXhVDEAa7Cg7fJUqYaHjv1khXnmBdYyvNPk\n"), "8MbWbCEhRWXhVDEAa7Cg7fJUqYaHjv1khXnmBdYyvNPk");
  assert.equal(parseTxHash("no hash here"), null);
});

test("the fee comparison reads only this account's remove on DCL, from the top-level return", () => {
  const event = { claim_fee_token_x: "5", claim_fee_token_y: "6", refund_token_x: "100", refund_token_y: "200" };
  const ev = (data: unknown) => `EVENT_JSON:${JSON.stringify({ event: "liquidity_removed", data: [data] })}`;
  const tx = (signer: string, receiver: string, method: string) => ({
    status: { SuccessValue: b64(["105", "206"]) },
    transaction: { signer_id: signer, receiver_id: receiver, actions: [{ FunctionCall: { method_name: method } }] },
    receipts_outcome: [
      { outcome: { executor_id: DCL, logs: [ev(event)], status: { SuccessValue: b64(["1", "1"]) } } },
      { outcome: { executor_id: "evil.near", logs: [ev({ refund_token_x: "9" })], status: { SuccessValue: b64(["9", "9"]) } } },
      { outcome: { executor_id: DCL, logs: [ev({ refund_token_x: "7" })], status: { Failure: {} } } },
    ],
  });
  const r = removeResult(tx(ME, DCL, "remove_liquidity"), ME);
  assert.deepEqual(r.returned, ["105", "206"]);
  assert.deepEqual(r.event, event);
  const u = { x: 5n, y: 6n, block: 77 };
  // fees paid together with the refund: the balance change equals refund + fee
  const together = feeComparison(u, r.event, r.returned, [100n, 200n], [105n, 206n]);
  assert.deepEqual(together, [
    "unclaimed fees just before the remove (get_liquidity at block 77): x=5 y=6",
    "predict_remove_liquidity just before the remove: x=100 y=200",
    "liquidity_removed event: claim_fee_token_x=5 claim_fee_token_y=6 refund_token_x=100 refund_token_y=200",
    "remove_liquidity returned: x=105 y=206",
    "wallet plus DCL internal balance changed by: x=105 y=206",
    "returned == refund_token: false",
    "returned == refund_token + claim_fee_token: true",
    "balance change == refund_token: false",
    "balance change == refund_token + claim_fee_token: true",
    "fees in the event equal the unclaimed fees read just before (may differ if swaps happened in between): true",
    "note: these lines are evidence, not the answer; confirm against the DCL 2.4.2 source before writing it into gate 3",
  ]);
  // fees not paid with the refund: the two fixtures print different lines
  const apart = feeComparison(u, r.event, ["100", "200"], [100n, 200n], [100n, 200n]);
  assert.ok(apart.includes("balance change == refund_token: true"));
  assert.ok(apart.includes("balance change == refund_token + claim_fee_token: false"));
  assert.notDeepEqual(apart, together);
  assert.ok(feeComparison(u, r.event, ["105", "200"], [0n, 0n], [0n, 0n]).includes("returned == refund_token + claim_fee_token: false"));
  // the y half of each equality matters
  assert.ok(feeComparison({ x: 5n, y: 7n, block: 1 }, r.event, r.returned, [0n, 0n], [105n, 206n]).includes("fees in the event equal the unclaimed fees read just before (may differ if swaps happened in between): false"));
  // no fees: inconclusive, no equalities
  const nofee = feeComparison(u, { ...event, claim_fee_token_x: "0", claim_fee_token_y: "0" }, ["100", "200"], [0n, 0n], [100n, 200n]);
  assert.equal(nofee.at(-1), "inconclusive: no fees claimed");
  assert.ok(!nofee.some((l) => l.startsWith("returned ==")));
  // missing or non-decimal fields: inconclusive, never compared against zeros
  for (const bad of [{ ...event, claim_fee_token_y: undefined }, { ...event, refund_token_x: "0x10" }, { ...event, refund_token_x: "" }]) {
    const l = feeComparison(u, bad as Record<string, string>, r.returned, [0n, 0n], [0n, 0n]);
    assert.equal(l.at(-1), "inconclusive: an event field or the return is missing or not a decimal");
  }
  assert.equal(feeComparison(u, null, null, [0n, 0n], [0n, 0n]).at(-1), "inconclusive: an event field or the return is missing or not a decimal");
  for (const bad of [tx("bob.near", DCL, "remove_liquidity"), tx(ME, WRAP, "remove_liquidity"), tx(ME, DCL, "add_liquidity")]) {
    assert.throws(() => removeResult(bad, ME), { message: "that transaction is not this account's remove_liquidity on DCL" });
  }
});

test("people see NEAR amounts as decimals; the CLI gets exact amounts", () => {
  assert.equal(nearDecimal(5n * 10n ** 23n), "0.5 NEAR");
  assert.equal(nearDecimal(10n ** 24n), "1 NEAR");
  assert.equal(formatDeposit(1n), "1 yoctoNEAR");
  assert.equal(formatDeposit(10n ** 24n), "1 NEAR");
});

test("EC-S01: the add's amount_y cap, minimums, pool and points; remove arguments; the remaining build-check boundaries", () => {
  const add = (o: Record<string, unknown>): Tx => ({ receiver: DCL, method: "add_liquidity", args: { pool_id: POOL, left_point: 0, right_point: 1, amount_x: "100", amount_y: "100", min_amount_x: "97", min_amount_y: "97", skip_unwrap_near: true, ...o }, depositYocto: 0n, gasTgas: 150 });
  const t = add({ amount_y: String(MAX_WRAP), amount_x: String(MAX_USDC) });
  assert.deepEqual(buildTx(t, ME), t);
  assert.throws(() => buildTx(add({ amount_y: String(MAX_WRAP + 1n) }), ME), { message: "add amounts over the cap" });
  assert.throws(() => buildTx(add({ min_amount_y: "0" }), ME), { message: "add minimums must be above 0" });
  assert.deepEqual(buildTx(add({ amount_x: "0", min_amount_x: "0" }), ME).args["amount_x"], "0");
  assert.throws(() => buildTx(add({ min_amount_x: "101" }), ME), { message: "add minimums above the amounts" });
  assert.throws(() => buildTx(add({ pool_id: `${USDC}|${WRAP}|2000` }), ME), { message: "add only to the USDC/wNEAR fee-100 pool" });
  assert.throws(() => buildTx(add({ left_point: 1, right_point: 1 }), ME), { message: "left point must be below right point" });
  assert.throws(() => buildTx(add({ right_point: 800_001 }), ME), { message: "point must be an integer within ±800000" });
  assert.throws(() => buildTx(add({ left_point: null }), ME), { message: "point must be an integer within ±800000" });
  const rm = (o: Record<string, unknown>): Tx => ({ receiver: DCL, method: "remove_liquidity", args: { lpt_id: "p#1", amount: "10", min_amount_x: "1", min_amount_y: "1", skip_unwrap_near: true, ...o }, depositYocto: 0n, gasTgas: 150 });
  assert.deepEqual(buildTx(rm({}), ME), rm({}));
  assert.throws(() => buildTx(rm({ skip_unwrap_near: undefined }), ME), { message: "remove_liquidity must skip unwrapping" });
  assert.throws(() => buildTx(rm({ lpt_id: "" }), ME), { message: "remove needs an lpt_id" });
  assert.throws(() => buildTx(rm({ amount: "0" }), ME), { message: "remove amount must be above 0" });
  assert.throws(() => buildTx(rm({ min_amount_y: undefined }), ME), { message: "min_amount_y must be a decimal string" });
  const sd = (r: string, who: string): Tx => ({ receiver: r, method: "storage_deposit", args: { account_id: who }, depositYocto: 1n, gasTgas: 30 });
  assert.throws(() => buildTx(sd(WRAP, "bob.near"), ME), { message: "storage is only paid for the signing account" });
  const nw = (amount: bigint, d: bigint): Tx => ({ receiver: WRAP, method: "near_withdraw", args: { amount: String(amount) }, depositYocto: d, gasTgas: 30 });
  assert.throws(() => buildTx(nw(1n, 2n), ME), { message: "near_withdraw attaches exactly 1 yoctoNEAR" });
  assert.deepEqual(buildTx(nw(0n, 1n), ME), nw(0n, 1n));
  const nd: Tx = { receiver: WRAP, method: "near_deposit", args: {}, depositYocto: 0n, gasTgas: 30 };
  assert.deepEqual(buildTx(nd, ME), nd);
  assert.equal(u128(((1n << 128n) - 1n).toString(), "x"), (1n << 128n) - 1n);
});

test("EC-S01 property: buildTx never accepts an amount or deposit over its cap", () => {
  let seed = 12345;
  const rnd = (max: bigint) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return (BigInt(seed) * max) / BigInt(2 ** 31); };
  for (let i = 0; i < 2000; i++) {
    const a = rnd(3n * MAX_WRAP), u = rnd(3n * MAX_USDC);
    for (const [tx, cap] of [[deposit(WRAP, a), MAX_WRAP], [deposit(USDC, u), MAX_USDC], [{ receiver: WRAP, method: "near_deposit", args: {}, depositYocto: a, gasTgas: 30 } as Tx, MAX_WRAP]] as const) {
      const amt = tx.method === "near_deposit" ? tx.depositYocto : BigInt(tx.args["amount"] as string);
      let ok = true; try { buildTx(tx, ME); } catch { ok = false; }
      if (amt > cap) assert.equal(ok, false, `accepted ${amt} over ${cap}`);
    }
    const b = rnd(2n * MAX_WRAP), c = rnd(2n * MAX_WRAP);
    const w = unwrapAmount(b, c);
    assert.ok(w <= MAX_WRAP && w <= (c > b ? c - b : 0n));
    const n = rnd(10n ** 30n);
    assert.equal(parseAmount(n.toString(), 0), n);
  }
});

test("EC-S02: the RPC must report chain_id mainnet", () => {
  assertMainnet({ chain_id: "mainnet" });
  for (const bad of [{ chain_id: "testnet" }, {}, null]) assert.throws(() => assertMainnet(bad), /not mainnet$/);
  assert.throws(() => assertMainnet({ chain_id: "testnet" }), { message: "the RPC reports chain_id testnet, not mainnet" });
});

test("EC-S04: an account with a contract deployed is refused", () => {
  const FA = { keys: [{ access_key: { permission: "FullAccess" } }] };
  checkNoContract("11111111111111111111111111111111", {}, FA);
  assert.throws(() => checkNoContract("9Zr7GbqmWbqVX9LNXtTB3SvMjHgVUEnmNFRu9MhbHjX9", {}, FA), { message: S04 });
});

test("spendable NEAR excludes what the account's storage locks", () => {
  assert.equal(availableNear(10n ** 24n, 0), 10n ** 24n);
  assert.equal(availableNear(10n ** 24n, 1000), 10n ** 24n - 10n ** 22n);
  assert.equal(availableNear(10n ** 21n, 10_000), 0n);
});

test("EC-S10: only this account's position in the pinned pool, of test size, is removed", () => {
  const pos = { owner_id: ME, pool_id: POOL, amount: "10", unclaimed_fee_x: "0", unclaimed_fee_y: "1", left_point: 0, right_point: 1 };
  assert.deepEqual(checkOwnPosition(pos, ME), { amount: 10n, unclaimed_fee_x: 0n, unclaimed_fee_y: 1n });
  assert.throws(() => checkOwnPosition(null, ME), { message: "position not found" });
  assert.throws(() => checkOwnPosition({ ...pos, owner_id: undefined }, ME), { message: "that position isn't owned by this account" });
  assert.throws(() => checkOwnPosition({ ...pos, owner_id: "bob.near" }, ME), { message: "that position isn't owned by this account" });
  assert.throws(() => checkOwnPosition({ ...pos, pool_id: `${USDC}|${WRAP}|2000` }, ME), { message: "that position isn't in the USDC/wNEAR fee-100 pool" });
  assert.throws(() => checkOwnPosition({ ...pos, amount: "0" }, ME), { message: "that position has no liquidity" });
  assert.equal(feesAbove0(checkOwnPosition(pos, ME)), true);
  assert.equal(feesAbove0(checkOwnPosition({ ...pos, unclaimed_fee_y: "0" }, ME)), false);
  assert.deepEqual(parsePredictRemove(["1", "2"]), [1n, 2n]);
  for (const bad of [{ x: "1", y: "2" }, ["1"], null]) assert.throws(() => parsePredictRemove(bad), { message: "predict_remove_liquidity returned an unexpected shape; stopping" });
  checkTestSize(2n * MAX_USDC, 2n * MAX_WRAP, "that position");
  assert.throws(() => checkTestSize(2n * MAX_USDC + 1n, 0n, "that position"), { message: "that position is larger than this script's test money; handle it by hand" });
  assert.throws(() => checkTestSize(0n, 2n * MAX_WRAP + 1n, "that position"), { message: "that position is larger than this script's test money; handle it by hand" });
  assert.throws(() => withdrawPlan({ [USDC]: String(2n * MAX_USDC + 1n) }, ME), { message: `DCL holds ${2n * MAX_USDC + 1n} of USDC for this account, more than this script's test money; withdraw it by hand` });
  assert.equal(withdrawPlan({ [USDC]: String(2n * MAX_USDC), [WRAP]: String(2n * MAX_WRAP) }, ME).length, 2);
});

test("checkPoint accepts ±800000 and refuses one past or non-integers", () => {
  for (const ok of [-800_000, 0, 800_000]) assert.equal(checkPoint(ok), ok);
  for (const bad of [-800_001, 800_001, 1.5, "1", undefined]) assert.throws(() => checkPoint(bad), { message: "point must be an integer within ±800000" });
});

test("the looked-up transaction must be the one just sent", () => {
  const t: Tx = { receiver: WRAP, method: "near_deposit", args: {}, depositYocto: 5n, gasTgas: 30 };
  const r = (signer: string, receiver: string, method: string, deposit: string, args: unknown = {}, gas = 30e12) => ({ transaction: { signer_id: signer, receiver_id: receiver, actions: [{ FunctionCall: { method_name: method, deposit, gas, args: b64(args) } }] } });
  checkTxMatches(r(ME, WRAP, "near_deposit", "5"), t, ME);
  for (const bad of [r("bob.near", WRAP, "near_deposit", "5"), r(ME, DCL, "near_deposit", "5"), r(ME, WRAP, "ft_transfer_call", "5"), r(ME, WRAP, "near_deposit", "6"), r(ME, WRAP, "near_deposit", "5", { x: 1 }), r(ME, WRAP, "near_deposit", "5", {}, 31e12), { transaction: { signer_id: ME, receiver_id: WRAP, actions: [r(ME, WRAP, "near_deposit", "5").transaction.actions[0], r(ME, WRAP, "near_deposit", "5").transaction.actions[0]] } }, {}]) {
    assert.throws(() => checkTxMatches(bad, t, ME), { message: "that transaction is not the one just sent; stopping" });
  }
});

test("hash length and flag values", () => {
  const h = (n: number) => "1".repeat(0) + "A".repeat(n);
  assert.equal(parseTxHash(`Transaction ID: ${h(43)}`), h(43));
  assert.equal(parseTxHash(`Transaction ID: ${h(44)}`), h(44));
  assert.equal(parseTxHash(`Transaction ID: ${h(42)}`), null);
  assert.equal(parseTxHash(`Transaction ID: ${h(45)}`), null);
  assert.throws(() => parseFlags(["dry", "--account", "--usdc", "1"]), { message: "--account needs a value" });
  assert.equal(depositsLanded({ [USDC]: "1000000", [WRAP]: "199" }, 1_000_000n, 200n), "DCL holds USDC 1000000 and wNEAR 199, less than deposited");
});

// ---- main, driven through a stubbed chain and CLI ----

interface Chain { chain_id: string; code_hash: string; point: number; internal: Record<string, string>; need: [string, string]; pos: Record<string, unknown> | null; predictRemove: unknown }
const base = (): Chain => ({ chain_id: "mainnet", code_hash: "11111111111111111111111111111111", point: 400_000, internal: {}, need: ["900000", "100000000000000000000000"], pos: null, predictRemove: ["1", "1"] });
function stub(c: Chain, answers: string[] = []): { io: IO; logs: string[]; sent: string[][]; rpcs: string[] } {
  const logs: string[] = [], sent: string[][] = [], rpcs: string[] = [];
  const enc = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
  const io: IO = {
    rpc: async (method, params) => {
      rpcs.push(method);
      const p = params as Record<string, string>;
      if (method === "status") return { chain_id: c.chain_id };
      if (method === "block") return { header: { height: 100 } };
      if (method === "query" && p["request_type"] === "view_account") return { amount: String(10n ** 25n), storage_usage: 100, code_hash: c.code_hash };
      if (method === "query" && p["request_type"] === "view_access_key_list") return { keys: [{ public_key: "ed25519:x", access_key: { nonce: 1, permission: "FullAccess" } }] };
      if (method === "query") {
        const m = p["method_name"]!;
        const r: Record<string, unknown> = {
          ft_balance_of: String(MAX_USDC), get_pool: { state: "Running", token_x: USDC, token_y: WRAP, fee: 100, current_point: c.point },
          storage_balance_of: { total: "1" }, storage_balance_bounds: { min: String(5n * 10n ** 23n) }, list_user_assets: c.internal,
          predict_add_liquidity: { need_x: c.need[0], need_y: c.need[1] }, get_liquidity: c.pos, predict_remove_liquidity: c.predictRemove,
          get_user_storage_detail: { max_slots: 40, cur_liquidity_slots: 0 }, list_liquidities: [],
        };
        return { result: enc(r[m]), block_height: 1 };
      }
      throw new Error(`unexpected rpc ${method}`);
    },
    near: (args) => { if (args[0] === "--version") return { status: 0, stdout: "near-cli-rs 0.31.1" }; sent.push(args); return { status: 1, stdout: "" }; },
    ask: async () => answers.shift() ?? "",
    log: (l) => { logs.push(l); },
    sleep: async () => {},
  };
  return { io, logs, sent, rpcs };
}

test("EC-S03, EC-S08: main checks the review flag before any RPC call", async () => {
  const s = stub(base());
  await assert.rejects(main(["run", "--account", ME], s.io), { message: "run mode needs --i-have-reviewed-this-script" });
  await assert.rejects(main(["recover", "--account", ME], s.io), { message: "recover mode needs --i-have-reviewed-this-script" });
  assert.deepEqual(s.rpcs, []);
});

test("EC-S02: main refuses an RPC that isn't mainnet", async () => {
  const s = stub({ ...base(), chain_id: "testnet" });
  await assert.rejects(main(["dry", "--account", ME], s.io), { message: "the RPC reports chain_id testnet, not mainnet" });
  assert.deepEqual(s.sent, []);
});

test("EC-S04: main refuses an account with a contract", async () => {
  const s = stub({ ...base(), code_hash: "9Zr7GbqmWbqVX9LNXtTB3SvMjHgVUEnmNFRu9MhbHjX9" });
  await assert.rejects(main(["dry", "--account", ME], s.io), { message: S04 });
  assert.deepEqual(s.sent, []);
});

test("EC-S03: dry mode predicts the add, prints every planned command, and sends nothing", async () => {
  const s = stub(base());
  await main(["dry", "--account", ME], s.io);
  assert.deepEqual(s.sent, []);
  assert.ok(s.logs.includes("range [399980, 400021): predict_add_liquidity needs USDC 900000 and wNEAR 100000000000000000000000 now (re-predicted just before the add)"));
  for (const m of ["near_deposit", "ft_transfer_call", "add_liquidity", "remove_liquidity", "withdraw_asset", "near_withdraw"]) assert.ok(s.logs.some((l) => l.startsWith("  near ") && l.includes(` ${m} `)), m);
  assert.equal(s.logs.at(-1), "\ndry run: nothing was sent.");
});

test("a failed preflight stops run before any send", async () => {
  const s = stub({ ...base(), internal: { [USDC]: "5" } });
  await assert.rejects(main(["run", "--account", ME, "--i-have-reviewed-this-script"], s.io), { message: "preflight failed; nothing was sent" });
  assert.deepEqual(s.sent, []);
  assert.ok(s.logs.includes("preflight: DCL already holds USDC 5 and wNEAR 0 for this account; run recover first"));
  const t = stub({ ...base(), need: ["1000001", "1"] });
  await assert.rejects(main(["run", "--account", ME, "--i-have-reviewed-this-script"], t.io), { message: "preflight failed; nothing was sent" });
  assert.ok(t.logs.includes("preflight: predict_add_liquidity asks for more than the amounts given"));
  assert.deepEqual(t.sent, []);
});

test("a person saying no, or the CLI failing, stops with the recover hint only after something was sent", async () => {
  const s = stub(base(), ["no"]);
  await assert.rejects(main(["run", "--account", ME, "--i-have-reviewed-this-script"], s.io), { message: "stopped by the person" });
  assert.deepEqual(s.sent, []);
  const t = stub(base(), ["yes"]);
  await assert.rejects(main(["run", "--account", ME, "--i-have-reviewed-this-script"], t.io), { message: `near CLI exited with 1 (if the transaction may have landed, recover without --lpt lists any open position); stopping. Funds stay in your wallet (as wNEAR), your DCL internal balance or a position: run recover --account ${ME} --i-have-reviewed-this-script` });
  assert.equal(t.sent.length, 1);
  assert.ok(t.logs.some((l) => l.includes("sign-with-keychain")), "the full CLI command is shown before the send");
});

test("EC-S10: recover of a position that no longer exists goes on to the withdraws", async () => {
  const s = stub({ ...base(), pos: null });
  await main(["recover", "--account", ME, "--lpt", "p#1", "--i-have-reviewed-this-script"], s.io);
  assert.ok(s.logs.includes("position p#1 no longer exists (already removed); going on to the withdraws"));
  assert.deepEqual(s.sent, []);
});

test("EC-S10: recover refuses a position that isn't this account's, in another pool, or over test size, before any send", async () => {
  const pos = { owner_id: ME, pool_id: POOL, amount: "10", unclaimed_fee_x: "1", unclaimed_fee_y: "1" };
  for (const [c, msg] of [
    [{ pos: { ...pos, owner_id: "bob.near" } }, "that position isn't owned by this account"],
    [{ pos: { ...pos, pool_id: "x|y|100" } }, "that position isn't in the USDC/wNEAR fee-100 pool"],
    [{ pos, predictRemove: [String(2n * MAX_USDC + 1n), "0"] }, "that position is larger than this script's test money; handle it by hand"],
    [{ pos, predictRemove: { x: "1" } }, "predict_remove_liquidity returned an unexpected shape; stopping"],
  ] as const) {
    const s = stub({ ...base(), ...c });
    await assert.rejects(main(["recover", "--account", ME, "--lpt", "p#1", "--i-have-reviewed-this-script"], s.io), { message: msg });
    assert.deepEqual(s.sent, []);
  }
});

// ---- a stubbed chain that accepts sends, for the run path after the first send ----

interface Sim {
  points: number[]; internal: Record<string, bigint>; wallet: Record<string, bigint>; need: [bigint, bigint][]; fees: [string, string];
  fail?: (method: string) => "failure" | "receipt" | "mismatch" | "nohash" | "rpcdown" | "rpcdown3" | "noreceipts" | "samehash" | null; landed?: boolean; receiptHeight?: number;
  unregistered?: boolean; unregisteredAt?: string; dclMin?: bigint | string | number; heights?: number[]; vanishAfter?: number;
}
const HASH = "8MbWbCEhRWXhVDEAa7Cg7fJUqYaHjv1khXnmBdYyvNPk";
function sim(o: Partial<Sim> = {}, answers: string[] = []) {
  const st: Sim = { points: [400_000, 400_000], internal: {}, wallet: { [USDC]: MAX_USDC, [WRAP]: 0n }, need: [[900_000n, 10n ** 23n], [900_000n, 10n ** 23n]], fees: ["5", "6"], landed: true, ...o };
  const logs: string[] = [], sent: { receiver: string; method: string; args: Record<string, unknown>; deposit: bigint }[] = [], sleeps: number[] = [], order: string[] = [];
  const regs = new Set<string>();
  let pos: Record<string, unknown> | null = null, last: unknown = null, rpcDown = 0, n = 0, posReads = 0;
  const enc = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
  const dep = (d: string) => (d.endsWith(" yoctoNEAR") ? BigInt(d.split(" ")[0]!) : BigInt(d.split(" ")[0]!) * 10n ** 24n);
  const io: IO = {
    rpc: async (method, params) => {
      const p = params as Record<string, string>;
      if (method === "status") return { chain_id: "mainnet" };
      if (method === "tx") { if (rpcDown > 0) { rpcDown--; throw new Error("RPC HTTP 429"); } return last; }
      if (method === "block") { order.push("block"); return { header: { height: p["finality"] ? 100 : st.heights ? st.heights[Number(p["block_id"]!.slice(1)) - 1]! : st.receiptHeight ?? 101 } }; }
      if (p["request_type"] === "view_account") return { amount: String(10n ** 25n), storage_usage: 100, code_hash: "11111111111111111111111111111111" };
      if (p["request_type"] === "view_access_key_list") return { keys: [{ public_key: "ed25519:x", access_key: { nonce: 1, permission: "FullAccess" } }] };
      const m = p["method_name"]!, a = JSON.parse(Buffer.from(p["args_base64"]!, "base64").toString()) as Record<string, string>;
      const r: Record<string, () => unknown> = {
        ft_balance_of: () => String(st.wallet[p["account_id"] === USDC ? USDC : WRAP] ?? 0n),
        get_pool: () => ({ state: "Running", token_x: USDC, token_y: WRAP, fee: 100, current_point: st.points.length > 1 ? st.points.shift() : st.points[0] }),
        storage_balance_of: () => ((st.unregistered || st.unregisteredAt === p["account_id"]) && !regs.has(p["account_id"]!) ? null : { total: "1" }),
        storage_balance_bounds: () => ({ min: typeof st.dclMin === "bigint" || st.dclMin === undefined ? String(st.dclMin ?? 5n * 10n ** 23n) : st.dclMin }),
        list_user_assets: () => Object.fromEntries(Object.entries(st.internal).map(([k, v]) => [k, String(v)])),
        predict_add_liquidity: () => { const n = st.need.length > 1 ? st.need.shift()! : st.need[0]!; return { need_x: String(n[0]), need_y: String(n[1]) }; },
        get_liquidity: () => (a["lpt_id"] === pos?.["lpt_id"] && !(st.vanishAfter !== undefined && ++posReads > st.vanishAfter) ? pos : null),
        predict_remove_liquidity: () => ["800000", "90000000000000000000000"],
        get_user_storage_detail: () => ({ max_slots: 40, cur_liquidity_slots: pos ? 1 : 0 }),
        list_liquidities: () => (pos ? [pos] : []),
      };
      return { result: enc(r[m]!()), block_height: 7 };
    },
    near: (args) => {
      if (args[0] === "--version") return { status: 0, stdout: "near-cli-rs 0.31.1" };
      const t = { receiver: args[3]!, method: args[4]!, args: JSON.parse(args[6]!) as Record<string, unknown>, deposit: dep(args[10]!) };
      sent.push(t); order.push("send");
      if (t.method === "storage_deposit") regs.add(t.receiver === WRAP ? WRAP : DCL);
      const f = st.fail?.(t.method) ?? null;
      let value: unknown = "";
      if (t.method === "near_deposit") st.wallet[WRAP] = (st.wallet[WRAP] ?? 0n) + t.deposit;
      if (t.method === "ft_transfer_call" && st.landed) { const k = t.receiver; st.internal[k] = (st.internal[k] ?? 0n) + BigInt(t.args["amount"] as string); st.wallet[k] = (st.wallet[k] ?? 0n) - BigInt(t.args["amount"] as string); }
      if (t.method === "add_liquidity") {
        st.internal[USDC] = (st.internal[USDC] ?? 0n) - BigInt(t.args["amount_x"] as string); st.internal[WRAP] = (st.internal[WRAP] ?? 0n) - BigInt(t.args["amount_y"] as string);
        pos = { lpt_id: `${POOL}#9`, owner_id: ME, pool_id: POOL, left_point: t.args["left_point"], right_point: t.args["right_point"], amount: "1000", unclaimed_fee_x: st.fees[0], unclaimed_fee_y: st.fees[1] }; value = pos["lpt_id"];
      }
      let logsOut: string[] = [];
      if (t.method === "remove_liquidity") {
        pos = null; st.wallet[USDC] = (st.wallet[USDC] ?? 0n) + 800_005n; st.wallet[WRAP] = (st.wallet[WRAP] ?? 0n) + 90000000000000000000006n;
        value = ["800005", "90000000000000000000006"];
        logsOut = [`EVENT_JSON:${JSON.stringify({ event: "liquidity_removed", data: [{ claim_fee_token_x: st.fees[0], claim_fee_token_y: st.fees[1], refund_token_x: "800000", refund_token_y: "90000000000000000000000" }] })}`];
      }
      if (t.method === "withdraw_asset") { const k = t.args["token_id"] as string; st.wallet[k] = (st.wallet[k] ?? 0n) + (st.internal[k] ?? 0n); st.internal[k] = 0n; }
      if (t.method === "near_withdraw") st.wallet[WRAP] = (st.wallet[WRAP] ?? 0n) - BigInt(t.args["amount"] as string);
      last = {
        status: f === "failure" ? { Failure: {} } : { SuccessValue: b64(value) },
        transaction: { signer_id: f === "mismatch" ? "bob.near" : ME, receiver_id: t.receiver, actions: [{ FunctionCall: { method_name: t.method, deposit: String(t.deposit), gas: Number(args[8]!.split(" ")[0]) * 1e12, args: Buffer.from(canonical(t.args)).toString("base64") } }] },
        receipts_outcome: f === "noreceipts" ? [] : [...(st.heights ?? [0]).keys()].map((k) => ({ block_hash: `B${k + 1}`, outcome: { executor_id: DCL, logs: logsOut, status: f === "receipt" ? { Failure: {} } : { SuccessValue: "" } } })),
      };
      if (f === "rpcdown") rpcDown = 4;
      if (f === "rpcdown3") rpcDown = 3;
      const hash = n++ === 0 || f === "samehash" ? HASH : HASH.slice(0, 40) + "ABCDEFGHJKLMNPQRSTUVWXYZ"[n % 24]!.repeat(4);
      return { status: 0, stdout: f === "nohash" ? "sent\n" : `Transaction ID: ${hash}\n` };
    },
    ask: async (q) => (q.startsWith("type yes to send") ? "yes" : answers.length ? answers.shift()! : q.startsWith("press Enter") ? "remove" : q.startsWith("unwrap") ? "yes" : ""),
    log: (l) => { logs.push(l); },
    sleep: async (ms) => { sleeps.push(ms); },
  };
  return { io, logs, sent, sleeps, st, order };
}
const RUN = ["run", "--account", ME, "--i-have-reviewed-this-script"];
const HINT = `; stopping. Funds stay in your wallet (as wNEAR), your DCL internal balance or a position: run recover --account ${ME} --i-have-reviewed-this-script`;

test("a whole run: deposits, add with 97% minimums, fee comparison, withdraws, unwrap only the gain", async () => {
  const s = sim();
  await main(RUN, s.io);
  assert.deepEqual(s.sent.map((t) => t.method), ["near_deposit", "ft_transfer_call", "ft_transfer_call", "add_liquidity", "remove_liquidity", "withdraw_asset", "withdraw_asset", "near_withdraw"]);
  const add = s.sent[3]!.args;
  assert.deepEqual([add["amount_x"], add["amount_y"], add["min_amount_x"], add["min_amount_y"]], ["900000", String(10n ** 23n), String(900_000n * 97n / 100n), String(10n ** 23n * 97n / 100n)]);
  const rm = s.sent[4]!.args;
  assert.deepEqual([rm["lpt_id"], rm["min_amount_x"], rm["min_amount_y"]], [`${POOL}#9`, String(800_000n * 97n / 100n), String(90000000000000000000000n * 97n / 100n)]);
  assert.ok(s.logs.includes("  balance change == refund_token + claim_fee_token: true"));
  // the run wrapped 0.2 NEAR and deposited it; unwrap offers only what the wallet gained since the start
  // start 0; +0.2 wrapped; 0.2 deposited; 0.1 added; remove pays 0.09 + 6 yocto; withdraw returns the 0.1 left: gain 0.19 + 6 yocto
  assert.equal(s.sent[7]!.args["amount"], "190000000000000000000006");
  assert.equal(s.st.wallet[WRAP], 0n);
});

test("EC-S11: a failed, mismatched or hash-less transaction stops the run after that send", async () => {
  for (const [kind, msg] of [
    ["failure", `transaction ${HASH} failed${HINT}`],
    ["mismatch", `that transaction is not the one just sent; stopping${HINT}`],
    ["receipt", `transaction ${HASH} has a failed receipt${HINT}`],
    ["nohash", `no transaction hash${HINT}`],
  ] as const) {
    const s = sim({ fail: (m) => (m === "near_deposit" ? kind : null) });
    await assert.rejects(main(RUN, s.io), { message: msg });
    assert.equal(s.sent.length, 1, kind);
  }
});

test("EC-S11: the transaction lookup is retried three times with backoff, then the run stops", async () => {
  const s = sim({ fail: (m) => (m === "near_deposit" ? "rpcdown" : null) });
  await assert.rejects(main(RUN, s.io), { message: `RPC HTTP 429${HINT}` });
  assert.deepEqual(s.sleeps, [2000, 4000, 8000]);
  assert.equal(s.sent.length, 1);
});

test("a failed payout receipt is tolerated on remove and withdraw only", async () => {
  const s = sim({ fail: (m) => (m === "remove_liquidity" ? "receipt" : null) });
  await main(RUN, s.io);
  assert.ok(s.logs.includes("a payout receipt failed; DCL keeps that amount in the internal balance (gate 3 part C), and the withdraws below pick it up"));
});

test("EC-S12: no add when the deposits didn't land, the price left the range, or the re-predict asks for more", async () => {
  const cases: [Partial<Sim>, string][] = [
    [{ landed: false }, `DCL holds USDC 0 and wNEAR 0, less than deposited${HINT}`],
    [{ points: [400_000, 400_021] }, `the price left the range since the start${HINT}`],
    [{ points: [400_000, 399_979] }, `the price left the range since the start${HINT}`],
    [{ need: [[900_000n, 1n], [1_000_001n, 1n]] }, `predict_add_liquidity asks for more than was deposited${HINT}`],
    [{ need: [[900_000n, 1n], [1n, 2n * 10n ** 23n + 1n]] }, `predict_add_liquidity asks for more than was deposited${HINT}`],
  ];
  for (const [o, msg] of cases) {
    const s = sim(o);
    await assert.rejects(main(RUN, s.io), { message: msg });
    assert.ok(!s.sent.some((t) => t.method === "add_liquidity"), msg);
  }
  for (const pt of [400_020, 399_980]) {
    const s = sim({ points: [400_000, pt] });
    await main(RUN, s.io);
    assert.ok(s.sent.some((t) => t.method === "add_liquidity"), String(pt));
  }
});

test("the remove waits for fees above 0 and uses the add's lpt_id", async () => {
  const s = sim({ fees: ["0", "0"] }, ["remove", "stop"]);
  // with no fees the loop never removes; stop it by making the next read throw
  let reads = 0;
  const rpc = s.io.rpc;
  s.io.rpc = async (m, p) => { if ((p as Record<string, string>)["method_name"] === "get_liquidity" && ++reads > 2) throw new Error("test stop"); return rpc(m, p); };
  await assert.rejects(main(RUN, s.io), { message: `stopped by the person; stopping. Funds stay in your wallet (as wNEAR), your DCL internal balance or a position: run recover --account ${ME} --lpt '${POOL}#9' --i-have-reviewed-this-script` });
  assert.ok(s.logs.includes("no fees yet, so the remove couldn't answer the question; waiting"));
  assert.ok(!s.sent.some((t) => t.method === "remove_liquidity"));
});

test("EC-S10: a wNEAR internal balance over twice the cap is not withdrawn, in recover too", async () => {
  assert.throws(() => withdrawPlan({ [WRAP]: String(2n * MAX_WRAP + 1n) }, ME), { message: `DCL holds ${2n * MAX_WRAP + 1n} of wNEAR for this account, more than this script's test money; withdraw it by hand` });
  const s = sim({ internal: { [WRAP]: 2n * MAX_WRAP + 1n } });
  await assert.rejects(main(["recover", "--account", ME, "--i-have-reviewed-this-script"], s.io), { message: `DCL holds ${2n * MAX_WRAP + 1n} of wNEAR for this account, more than this script's test money; withdraw it by hand` });
  assert.deepEqual(s.sent, []);
});

test("EC-S04 and EC-S07: exact refusals for contract accounts and for payouts that don't skip unwrapping", async () => {
  for (const bad of [undefined, ""]) assert.throws(() => checkNoContract(bad, {}, { keys: [] }), { message: S04 });
  const s = stub({ ...base(), code_hash: "9Zr7GbqmWbqVX9LNXtTB3SvMjHgVUEnmNFRu9MhbHjX9" });
  await assert.rejects(main(["dry", "--account", ME], s.io), { message: S04 });
  assert.deepEqual(s.rpcs, ["status", "query", "query"]);
  const full = S04;
  const FAK = { keys: [{ access_key: { permission: "FullAccess" } }] };
  assert.throws(() => checkNoContract("11111111111111111111111111111111", { global_contract_hash: "abc" }, FAK), { message: full });
  assert.throws(() => checkNoContract("11111111111111111111111111111111", { global_contract_account_id: "lib.near" }, FAK), { message: full });
  assert.throws(() => checkNoContract("11111111111111111111111111111111", {}, { keys: [{ access_key: { permission: { FunctionCall: { receiver_id: "s.near" } } } }] }), { message: full });
  checkNoContract("11111111111111111111111111111111", {}, { keys: [{ access_key: { permission: "FullAccess" } }] });
  assert.throws(() => checkNoContract("11111111111111111111111111111111", {}, {}), { message: "view_access_key_list returned an unexpected shape; stopping" });
  for (const v of [false, "true"]) {
    assert.throws(() => buildTx({ receiver: DCL, method: "withdraw_asset", args: { token_id: USDC, skip_unwrap_near: v }, depositYocto: 0n, gasTgas: 100 }, ME), { message: "withdraw_asset must skip unwrapping" });
  }
});

test("EC-S01 property: storage, near_withdraw and add amounts at or under their caps are accepted, over refused", () => {
  let seed = 777;
  const rnd = (max: bigint) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return (BigInt(seed) * max) / BigInt(2 ** 31); };
  const ok = (t: Tx) => { try { buildTx(t, ME); return true; } catch { return false; } };
  for (let i = 0; i < 1000; i++) {
    const d = rnd(2n * MAX_DCL_STORAGE), k = rnd(2n * MAX_TOKEN_STORAGE), w = rnd(2n * MAX_WRAP), x = rnd(2n * MAX_USDC) + 1n, y = rnd(2n * MAX_WRAP) + 1n;
    assert.equal(ok({ receiver: DCL, method: "storage_deposit", args: { account_id: ME }, depositYocto: d, gasTgas: 30 }), d <= MAX_DCL_STORAGE);
    assert.equal(ok({ receiver: WRAP, method: "storage_deposit", args: { account_id: ME }, depositYocto: k, gasTgas: 30 }), k <= MAX_TOKEN_STORAGE);
    assert.equal(ok({ receiver: WRAP, method: "near_withdraw", args: { amount: String(w) }, depositYocto: 1n, gasTgas: 30 }), w <= MAX_WRAP);
    const add: Tx = { receiver: DCL, method: "add_liquidity", args: { pool_id: POOL, left_point: 0, right_point: 1, amount_x: String(x), amount_y: String(y), min_amount_x: "1", min_amount_y: "1", skip_unwrap_near: true }, depositYocto: 0n, gasTgas: 150 };
    assert.equal(ok(add), x <= MAX_USDC && y <= MAX_WRAP);
  }
});

test("--lpt is only for recover mode", () => {
  assert.throws(() => parseFlags(["run", "--account", ME, "--lpt", "old#7"]), { message: "--lpt is only for recover mode" });
  assert.throws(() => parseFlags(["dry", "--account", ME, "--lpt", "old#7"]), { message: "--lpt is only for recover mode" });
  assert.equal(parseFlags(["recover", "--account", ME, "--lpt", "old#7"]).lpt, "old#7");
});

test("remove minimums are at least 1 when the prediction is above 0; full slots and open positions are reported", () => {
  assert.equal(removeMin(0n), 0n);
  assert.equal(removeMin(1n), 1n);
  assert.equal(removeMin(100n), 97n);
  assert.equal(slotsFull({ max_slots: 40, cur_liquidity_slots: 39 }), null);
  assert.equal(slotsFull({ max_slots: 40, cur_liquidity_slots: 40 }), "DCL slots are full (40 of 40); an add would fail with E107");
  assert.equal(slotsFull({}), "can't read DCL slots (get_user_storage_detail)");
  assert.deepEqual(openPositions([{ lpt_id: "a", pool_id: POOL, owner_id: ME }, { lpt_id: "b", pool_id: "x|y|100", owner_id: ME }, { lpt_id: "c", pool_id: POOL, owner_id: "bob.near" }], ME), ["a"]);
  assert.throws(() => openPositions({}, ME), { message: "list_liquidities returned an unexpected shape; stopping" });
});

test("an add that lands with a failed receipt stops with a recover hint naming its lpt_id", async () => {
  const s = sim({ fail: (m) => (m === "add_liquidity" ? "receipt" : null) });
  await assert.rejects(main(RUN, s.io), { message: `transaction ${hashAt(3)} has a failed receipt; stopping. Funds stay in your wallet (as wNEAR), your DCL internal balance or a position: run recover --account ${ME} --lpt '${POOL}#9' --i-have-reviewed-this-script` });
});

test("recover without --lpt lists the open positions and doesn't say done", async () => {
  const s = sim();
  await assert.rejects(main(RUN, { ...s.io, ask: async (q) => (q.startsWith("type yes to send") ? "yes" : q.startsWith("press Enter") ? (() => { throw new Error("stop after add"); })() : "") }), /stop after add/);
  // the same chain: one open position and the internal balance the add left; recover withdraws that and reports the position
  const r = sim();
  await main(["recover", "--account", ME, "--i-have-reviewed-this-script"], { ...s.io, log: r.io.log });
  assert.ok(s.sent.filter((t) => t.method === "withdraw_asset").length === 2);
  assert.ok(r.logs.some((l) => l.startsWith("\nnot done: DCL still holds USDC 0 and wNEAR 0, and these positions are open: ") && l.endsWith(" Run recover again with --lpt later.")), r.logs.join("|"));
});

test("a run on an account with full DCL slots is refused before any send", async () => {
  const s = stub(base());
  const rpc = s.io.rpc;
  s.io.rpc = async (m, p) => {
    const q = p as Record<string, string>;
    if (q["method_name"] === "get_user_storage_detail") return { result: [...Buffer.from(JSON.stringify({ max_slots: 40, cur_liquidity_slots: 40 }))], block_height: 1 };
    return rpc(m, p);
  };
  await assert.rejects(main(RUN, s.io), { message: "preflight failed; nothing was sent" });
  assert.ok(s.logs.includes("preflight: DCL slots are full (40 of 40); an add would fail with E107"));
  assert.deepEqual(s.sent, []);
});

test("run mode removes only the position with the run's own range, even if a wrong lpt_id is pasted", async () => {
  const s = sim();
  // the add's return is made unparseable below, so the person is asked and pastes another of their positions
  const rpc = s.io.rpc;
  s.io.rpc = async (m, p) => {
    const r = await rpc(m, p) as { status?: { SuccessValue?: string }; transaction?: { actions?: { FunctionCall?: { method_name?: string } }[] } };
    if (m === "tx" && r.transaction?.actions?.[0]?.FunctionCall?.method_name === "add_liquidity") return { ...r, status: { SuccessValue: "" } };
    const q = p as Record<string, string>;
    if (q["method_name"] === "get_liquidity" && JSON.parse(Buffer.from(q["args_base64"]!, "base64").toString())["lpt_id"] === "mine#1") {
      return { result: [...Buffer.from(JSON.stringify({ lpt_id: "mine#1", owner_id: ME, pool_id: POOL, left_point: 0, right_point: 100, amount: "5", unclaimed_fee_x: "1", unclaimed_fee_y: "1" }))], block_height: 1 };
    }
    return r;
  };
  const ask = s.io.ask;
  s.io.ask = async (q) => (q.startsWith("the add's lpt_id") ? "mine#1" : ask(q));
  await assert.rejects(main(RUN, s.io), /that position isn't the one this run added \(its range differs\)/);
  assert.ok(!s.sent.some((t) => t.method === "remove_liquidity"));
});

test("arguments are compared with keys sorted, as near-cli-rs re-encodes them; a real difference is still refused", () => {
  assert.equal(canonical({ receiver_id: DCL, amount: "1", msg: "\"Deposit\"" }), canonical({ amount: "1", msg: "\"Deposit\"", receiver_id: DCL }));
  assert.equal(canonical({ b: [{ d: 1, c: 2 }], a: null }), '{"a":null,"b":[{"c":2,"d":1}]}');
  const t: Tx = { receiver: USDC, method: "ft_transfer_call", args: { receiver_id: DCL, amount: "5", msg: "\"Deposit\"" }, depositYocto: 1n, gasTgas: 100 };
  const look = (args: unknown) => ({ transaction: { signer_id: ME, receiver_id: USDC, actions: [{ FunctionCall: { method_name: "ft_transfer_call", deposit: "1", gas: 100e12, args: Buffer.from(JSON.stringify(args)).toString("base64") } }] } });
  checkTxMatches(look({ amount: "5", msg: "\"Deposit\"", receiver_id: DCL }), t, ME);
  assert.throws(() => checkTxMatches(look({ amount: "6", msg: "\"Deposit\"", receiver_id: DCL }), t, ME), { message: "that transaction is not the one just sent; stopping" });
  assert.deepEqual(receiptBlocks({ receipts_outcome: [{ block_hash: "a" }, { block_hash: "b" }, { block_hash: "a" }] }), ["a", "b"]);
});

test("EC-S11: a pasted hash is accepted once, and only if its receipts ran after this send started", async () => {
  const old = sim({ receiptHeight: 99, fail: (m) => (m === "near_deposit" ? "nohash" : null) }, [HASH]);
  await assert.rejects(main(RUN, old.io), { message: `that transaction is older than this send; stopping${HINT}` });
  const twice = sim({ fail: () => "nohash" }, [HASH, HASH]);
  await assert.rejects(main(RUN, twice.io), { message: `that transaction hash was already used in this run${HINT}` });
  assert.equal(twice.sent.length, 2);
  const s = sim();
  await main(RUN, s.io);
  assert.ok(s.logs.includes("receipts ran in blocks 101: 0 blocks from first to last (evidence for PAYOUT_SETTLE_BLOCKS)"));
  assert.ok(s.logs.includes("near CLI: near-cli-rs 0.31.1"));
});

test("EC-S13: only an exact yes sends a transaction or the unwrap", async () => {
  for (const ans of ["", "y", "YES", "yes please", "no"]) {
    const s = stub(base(), [ans]);
    await assert.rejects(main(RUN, s.io), { message: "stopped by the person" }, JSON.stringify(ans));
    assert.deepEqual(s.sent, [], JSON.stringify(ans));
  }
  const s = sim();
  const ask = s.io.ask;
  s.io.ask = async (q) => (q.startsWith("unwrap") ? "" : ask(q));
  await main(RUN, s.io);
  assert.ok(!s.sent.some((t) => t.method === "near_withdraw"));
  assert.equal(s.logs.at(-1), "\ndone. The DCL storage deposit stays at DCL (not recoverable). Report the transaction hashes and the fee comparison.");
});

test("EC-S04 through main: a function-call key or a global contract is refused before any send", async () => {
  for (const extra of [{ keys: { keys: [{ access_key: { permission: "FullAccess" } }, { access_key: { permission: { FunctionCall: { receiver_id: "app.near" } } } }] } }, { acct: { global_contract_account_id: "lib.near" } }, { acct: { global_contract_hash: "abc" } }]) {
    const s = stub(base());
    const rpc = s.io.rpc;
    s.io.rpc = async (m, p) => {
      const q = p as Record<string, string>;
      if (q["request_type"] === "view_access_key_list" && "keys" in extra) return extra.keys;
      if (q["request_type"] === "view_account" && "acct" in extra) return { ...(await rpc(m, p) as object), ...extra.acct };
      return rpc(m, p);
    };
    for (const argv of [["dry", "--account", ME], RUN]) {
      await assert.rejects(main(argv, s.io), { message: S04 });
    }
    assert.deepEqual(s.sent, []);
  }
});

test("EC-S11: every non-payout call stops on a failed receipt; a lookup failing three times then working continues", async () => {
  for (const [m, k, lpt] of [["near_deposit", 0, ""], ["ft_transfer_call", 1, ""], ["add_liquidity", 3, ` --lpt '${POOL}#9'`], ["near_withdraw", 7, ""]] as const) {
    const s = sim({ fail: (x) => (x === m ? "receipt" : null) });
    await assert.rejects(main(RUN, s.io), { message: `transaction ${hashAt(k)} has a failed receipt; stopping. Funds stay in your wallet (as wNEAR), your DCL internal balance or a position: run recover --account ${ME}${lpt} --i-have-reviewed-this-script` });
    assert.equal(s.sent.at(-1)!.method, m);
  }
  const s = sim({ fail: (m) => (m === "near_deposit" ? "rpcdown3" : null) });
  await main(RUN, s.io);
  assert.deepEqual(s.sleeps, [2000, 4000, 8000]);
});

test("after the remove lands, the recover hint drops --lpt, and recover of a removed position goes on to the withdraws", async () => {
  const s = sim();
  let withdraws = 0;
  const ask = s.io.ask;
  s.io.ask = async (q) => (q.startsWith("type yes") && s.sent.at(-1)?.method === "withdraw_asset" && ++withdraws === 1 ? "no" : ask(q));
  await assert.rejects(main(RUN, s.io), { message: `stopped by the person${HINT}` });
  const r = sim();
  r.st.internal[WRAP] = 5n;
  await main(["recover", "--account", ME, "--lpt", "gone#1", "--i-have-reviewed-this-script"], r.io);
  assert.ok(r.logs.includes("position gone#1 no longer exists (already removed); going on to the withdraws"));
  assert.deepEqual(r.sent.map((t) => t.method), ["withdraw_asset"]);
});

test("limits at the boundary: predict equal to the deposit, the add's y minimum, the range's right point, strict parsing", async () => {
  const s = sim({ need: [[1_000_000n, 2n * 10n ** 23n], [1_000_000n, 2n * 10n ** 23n]] });
  await main(RUN, s.io);
  assert.equal(s.sent.find((t) => t.method === "add_liquidity")!.args["amount_x"], "1000000");
  const add: Tx = { receiver: DCL, method: "add_liquidity", args: { pool_id: POOL, left_point: 0, right_point: 1, amount_x: "100", amount_y: "100", min_amount_x: "97", min_amount_y: "101", skip_unwrap_near: true }, depositYocto: 0n, gasTgas: 150 };
  assert.throws(() => buildTx(add, ME), { message: "add minimums above the amounts" });
  assert.deepEqual([...ALLOWED_CALLS].sort(), [`${USDC}:ft_transfer_call`, `${DCL}:add_liquidity`, `${DCL}:remove_liquidity`, `${DCL}:storage_deposit`, `${DCL}:withdraw_asset`, `${WRAP}:ft_transfer_call`, `${WRAP}:near_deposit`, `${WRAP}:near_withdraw`, `${WRAP}:storage_deposit`].sort());
  assert.throws(() => withdrawPlan({ [USDC]: "+5" }, ME), { message: "internal balance must be a decimal string" });
  assert.throws(() => buildTx({ receiver: DCL, method: "remove_liquidity", args: { lpt_id: 7, amount: "1", min_amount_x: "0", min_amount_y: "0", skip_unwrap_near: true }, depositYocto: 0n, gasTgas: 150 }, ME), { message: "remove needs an lpt_id" });
  assert.throws(() => checkOwnPosition({ owner_id: ME, pool_id: POOL, amount: "1", unclaimed_fee_x: "0x1", unclaimed_fee_y: "0" }, ME), { message: "unclaimed_fee_x must be a decimal string" });
  // a pasted position that differs only on the right point is refused
  const r = sim();
  const rpc = r.io.rpc;
  r.io.rpc = async (m, p) => {
    const x = await rpc(m, p) as { status?: unknown; transaction?: { actions?: { FunctionCall?: { method_name?: string } }[] } };
    if (m === "tx" && x.transaction?.actions?.[0]?.FunctionCall?.method_name === "add_liquidity") return { ...x, status: { SuccessValue: "" } };
    const q = p as Record<string, string>;
    if (q["method_name"] === "get_liquidity" && JSON.parse(Buffer.from(q["args_base64"]!, "base64").toString())["lpt_id"] === "mine#2") {
      return { result: [...Buffer.from(JSON.stringify({ lpt_id: "mine#2", owner_id: ME, pool_id: POOL, left_point: 399_980, right_point: 400_100, amount: "5", unclaimed_fee_x: "1", unclaimed_fee_y: "1" }))], block_height: 1 };
    }
    return x;
  };
  const ask = r.io.ask;
  r.io.ask = async (q) => (q.startsWith("the add's lpt_id") ? "mine#2" : ask(q));
  await assert.rejects(main(RUN, r.io), /that position isn't the one this run added \(its range differs\)/);
});

const hashAt = (k: number) => (k === 0 ? HASH : HASH.slice(0, 40) + "ABCDEFGHJKLMNPQRSTUVWXYZ"[(k + 1) % 24]!.repeat(4));

test("EC-S14: a fresh account pays storage once each, exactly wrap.near's bound and DCL's minimum, for the signer", async () => {
  const s = sim({ unregistered: true });
  await main(RUN, s.io);
  const m = s.sent.map((t) => `${t.method}@${t.receiver === WRAP ? "wrap" : t.receiver === DCL ? "dcl" : "usdc"}`);
  assert.deepEqual(m.slice(0, 3), ["storage_deposit@wrap", "near_deposit@wrap", "storage_deposit@dcl"]);
  assert.equal(m.filter((x) => x.startsWith("storage_deposit")).length, 2);
  assert.deepEqual([s.sent[0]!.deposit, s.sent[0]!.args["account_id"]], [WRAP_STORAGE, ME]);
  assert.deepEqual([s.sent[2]!.deposit, s.sent[2]!.args["account_id"]], [5n * 10n ** 23n, ME]);
  const d = sim({ unregistered: true });
  await main(["dry", "--account", ME], d.io);
  assert.deepEqual(d.sent, []);
  assert.ok(d.logs.some((l) => l.includes(" storage_deposit ") && l.includes(WRAP)) && d.logs.some((l) => l.includes(" storage_deposit ") && l.includes(DCL)));
  const big = sim({ unregistered: true, dclMin: MAX_DCL_STORAGE + 1n });
  await assert.rejects(main(RUN, big.io), { message: "DCL storage over the cap" });
  assert.deepEqual(big.sent, []);
  const bad = sim({ unregistered: true, fail: (x) => (x === "storage_deposit" ? "receipt" : null) });
  await assert.rejects(main(RUN, bad.io), { message: `transaction ${HASH} has a failed receipt${HINT}` });
  assert.equal(bad.sent.length, 1);
});

test("EC-S11: no receipts to check, the freshness boundary, and the block read before each send", async () => {
  const s = sim({ fail: (x) => (x === "near_deposit" ? "noreceipts" : null) });
  await assert.rejects(main(RUN, s.io), { message: `that transaction has no receipts to check; stopping${HINT}` });
  assert.equal(s.sent.length, 1);
  const eq = sim({ receiptHeight: 100 });
  await main(RUN, eq.io);
  const span = sim({ heights: [99, 101] });
  await assert.rejects(main(RUN, span.io), { message: `that transaction is older than this send; stopping${HINT}` });
  const o = sim();
  await main(RUN, o.io);
  o.order.forEach((x, i) => { if (x === "send") assert.equal(o.order[i - 1], "block", `block read before send ${i}`); });
  const same = sim({ fail: (x) => (x === "ft_transfer_call" ? "samehash" : null) });
  await assert.rejects(main(RUN, same.io), { message: `that transaction hash was already used in this run${HINT}` });
});

test("a failed remove keeps the position in the recover hint; stop in the fee wait does too", async () => {
  const lpt = `'${POOL}#9'`;
  const s = sim({ fail: (x) => (x === "remove_liquidity" ? "failure" : null) });
  await assert.rejects(main(RUN, s.io), { message: `transaction ${hashAt(4)} failed; stopping. Funds stay in your wallet (as wNEAR), your DCL internal balance or a position: run recover --account ${ME} --lpt ${lpt} --i-have-reviewed-this-script` });
  const t = sim({}, ["stop"]);
  await assert.rejects(main(RUN, t.io), { message: `stopped by the person; stopping. Funds stay in your wallet (as wNEAR), your DCL internal balance or a position: run recover --account ${ME} --lpt ${lpt} --i-have-reviewed-this-script` });
  assert.ok(!t.sent.some((x) => x.method === "remove_liquidity"));
  const v = sim({ vanishAfter: 1 });
  await assert.rejects(main(RUN, v.io), { message: `position not found; stopping. Funds stay in your wallet (as wNEAR), your DCL internal balance or a position: run recover --account ${ME} --lpt ${lpt} --i-have-reviewed-this-script` });
  assert.ok(!v.sent.some((x) => x.method === "remove_liquidity"));
});

test("EC-S13: every non-yes answer at the unwrap prompt sends nothing", async () => {
  for (const ans of ["", "y", "YES", "yes please", "no"]) {
    const s = sim();
    const ask = s.io.ask;
    s.io.ask = async (q) => (q.startsWith("unwrap") ? ans : ask(q));
    await main(RUN, s.io);
    assert.ok(!s.sent.some((t) => t.method === "near_withdraw"), JSON.stringify(ans));
    assert.equal(s.logs.at(-1), "\ndone. The DCL storage deposit stays at DCL (not recoverable). Report the transaction hashes and the fee comparison.");
  }
});

test("reads are retried; an unknown account is refused at once; add minimums are at least 1", async () => {
  const s = sim();
  let fails = 2;
  const rpc = s.io.rpc;
  s.io.rpc = async (m, p) => { if ((p as Record<string, string>)?.["method_name"] === "list_user_assets" && fails-- > 0) throw new Error("RPC HTTP 429"); return rpc(m, p); };
  await main(RUN, s.io);
  assert.ok(s.sleeps.includes(2000) && s.sleeps.includes(4000));
  const u = sim();
  u.io.rpc = async (m, p) => { if ((p as Record<string, string>)?.["request_type"] === "view_account") throw new Error("RPC error: {\"cause\":{\"name\":\"UNKNOWN_ACCOUNT\"}}"); return sim().io.rpc(m, p); };
  await assert.rejects(main(["dry", "--account", ME], u.io), { message: `account ${ME} does not exist on mainnet` });
  assert.deepEqual(u.sleeps, []);
  const one = sim({ need: [[900_000n, 10n ** 23n], [1n, 10n ** 23n]] });
  await main(RUN, one.io);
  assert.equal(one.sent.find((t) => t.method === "add_liquidity")!.args["min_amount_x"], "1");
});

test("EC-S15: run and recover need near-cli-rs 0.31.x; nothing is sent otherwise", async () => {
  for (const ver of ["4.0.13", "", "near-cli-rs 0.32.0"]) {
    const s = sim();
    const near = s.io.near;
    s.io.near = (a) => (a[0] === "--version" ? { status: 0, stdout: ver } : near(a));
    await assert.rejects(main(RUN, s.io), { message: `this script needs near-cli-rs 0.31.x as \`near\`; found ${JSON.stringify(ver || "nothing")}` });
    assert.deepEqual(s.sent, []);
  }
});

test("a transfer arriving while the remove prompt is open isn't counted as paid by the remove", async () => {
  const s = sim();
  const ask = s.io.ask;
  s.io.ask = async (q) => { if (q.startsWith("type yes") && s.sent.length === 4) s.st.wallet[USDC] = (s.st.wallet[USDC] ?? 0n) + 5n; return ask(q); };
  await main(RUN, s.io);
  assert.ok(s.logs.includes("  wallet plus DCL internal balance changed by: x=800005 y=90000000000000000000006"));
});

test("EC-S12: slots filled by gifts between the preflight and the add stop the run before the add", async () => {
  const s = sim();
  const rpc = s.io.rpc;
  let reads = 0;
  s.io.rpc = async (m, p) => {
    if ((p as Record<string, string>)?.["method_name"] === "get_user_storage_detail" && ++reads === 2) return { result: [...Buffer.from(JSON.stringify({ max_slots: 40, cur_liquidity_slots: 40 }))], block_height: 1 };
    return rpc(m, p);
  };
  await assert.rejects(main(RUN, s.io), { message: `DCL slots are full (40 of 40); an add would fail with E107${HINT}` });
  assert.ok(!s.sent.some((t) => t.method === "add_liquidity"));
  assert.equal(s.sent.length, 3);
});

test("EC-S14: registered at only one contract pays storage only at the other, and the NEAR needed follows", async () => {
  const w = sim({ unregisteredAt: WRAP });
  await main(RUN, w.io);
  assert.deepEqual(w.sent.filter((t) => t.method === "storage_deposit").map((t) => [t.receiver, t.deposit, t.args["account_id"]]), [[WRAP, WRAP_STORAGE, ME]]);
  const d = sim({ unregisteredAt: DCL });
  await main(RUN, d.io);
  assert.deepEqual(d.sent.filter((t) => t.method === "storage_deposit").map((t) => [t.receiver, t.deposit, t.args["account_id"]]), [[DCL, 5n * 10n ** 23n, ME]]);
  const pool = { state: "Running", token_x: USDC, token_y: WRAP, fee: 100 };
  const need = (w: boolean, dcl: bigint | null) => 2n * 10n ** 23n + (w ? WRAP_STORAGE : 0n) + (dcl ?? 0n) + GAS_MARGIN;
  for (const [w2, dcl] of [[true, null], [false, 5n * 10n ** 23n]] as const) {
    assert.deepEqual(preflight(pool, { usdc: MAX_USDC, near: need(w2, dcl) }, 1n, 2n * 10n ** 23n, w2, dcl, [0n, 0n]), []);
    assert.deepEqual(preflight(pool, { usdc: MAX_USDC, near: need(w2, dcl) - 1n }, 1n, 2n * 10n ** 23n, w2, dcl, [0n, 0n]), [`NEAR balance ${nearDecimal(need(w2, dcl) - 1n)} is below the ${nearDecimal(need(w2, dcl))} needed (wrap, storage and gas)`]);
  }
});

test("EC-S14: DCL's storage minimum is parsed strictly", async () => {
  for (const bad of ["0x1", 1]) {
    const s = sim({ unregistered: true, dclMin: bad });
    await assert.rejects(main(RUN, s.io), { message: "DCL storage minimum must be a decimal string" });
    assert.deepEqual(s.sent, []);
  }
});

test("EC-S15: recover needs near-cli-rs 0.31.x too; dry mode doesn't check it", async () => {
  const s = sim();
  const near = s.io.near;
  s.io.near = (a) => (a[0] === "--version" ? { status: 0, stdout: "4.0.13" } : near(a));
  await assert.rejects(main(["recover", "--account", ME, "--i-have-reviewed-this-script"], s.io), { message: 'this script needs near-cli-rs 0.31.x as `near`; found "4.0.13"' });
  await main(["dry", "--account", ME], s.io);
  assert.deepEqual(s.sent, []);
});

test("property: removeMin is 0 only at 0, otherwise between 97% and all of x; adds at or under the caps always build", () => {
  let seed = 4242;
  const rnd = (max: bigint) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return (BigInt(seed) * max) / BigInt(2 ** 31); };
  assert.equal(removeMin(0n), 0n);
  for (let i = 0; i < 2000; i++) {
    const x = rnd((1n << 128n) - 1n) + 1n;
    const m = removeMin(x);
    assert.ok(m >= 1n && m <= x && m >= (x * 97n) / 100n);
    const nx = rnd(MAX_USDC + 1n), ny = rnd(MAX_WRAP + 1n);
    const t: Tx = { receiver: DCL, method: "add_liquidity", args: { pool_id: POOL, left_point: 0, right_point: 1, amount_x: String(nx), amount_y: String(ny), min_amount_x: String(removeMin(nx)), min_amount_y: String(removeMin(ny)), skip_unwrap_near: true }, depositYocto: 0n, gasTgas: 150 };
    assert.deepEqual(buildTx(t, ME), t);
  }
});

test("EC-S16: a real-shaped UNKNOWN_ACCOUNT error with a long account id is recognised without retries", async () => {
  const long = "poolside-audit-nonexistent-xyz.near";
  const body = { name: "HANDLER_ERROR", cause: { info: { block_hash: "9Zr7GbqmWbqVX9LNXtTB3SvMjHgVUEnmNFRu9MhbHjX9", block_height: 173456789, requested_account_id: long }, name: "UNKNOWN_ACCOUNT" }, code: -32000, message: "Server error", data: `account ${long} does not exist while viewing` };
  const text = rpcErrorText(body);
  assert.ok(JSON.stringify(body).length > 200 && text.startsWith("RPC error UNKNOWN_ACCOUNT: "));
  const s = sim();
  const rpc = s.io.rpc;
  s.io.rpc = async (m, p) => { if ((p as Record<string, string>)?.["request_type"] === "view_account") throw new Error(text); return rpc(m, p); };
  await assert.rejects(main(["dry", "--account", long], s.io), { message: `account ${long} does not exist on mainnet` });
  assert.deepEqual(s.sleeps, []);
});

test("EC-S17: recover reports wNEAR left in the wallet, and only recover, and only when there is some", async () => {
  const s = sim();
  s.st.wallet[WRAP] = 2n * 10n ** 23n;
  await main(["recover", "--account", ME, "--i-have-reviewed-this-script"], s.io);
  assert.ok(s.logs.includes("\nyour wallet holds 0.2 NEAR of wNEAR; if a run wrapped it, unwrap it by hand with near_withdraw"));
  const z = sim();
  await main(["recover", "--account", ME, "--i-have-reviewed-this-script"], z.io);
  assert.ok(!z.logs.some((l) => l.includes("your wallet holds")));
  const r = sim();
  await main(RUN, r.io);
  assert.ok(!r.logs.some((l) => l.includes("your wallet holds")));
});

test("EC-S11: a stale add hash with identical arguments leaves the recover hint without --lpt", async () => {
  const s = sim({ fail: (m) => (m === "add_liquidity" ? "nohash" : null) }, [HASH]);
  await assert.rejects(main(RUN, s.io), { message: `that transaction hash was already used in this run${HINT}` });
  assert.equal(s.sent.at(-1)!.method, "add_liquidity");
  const o = sim({ receiptHeight: 99, fail: (m) => (m === "add_liquidity" ? "nohash" : null) }, ["8MbWbCEhRWXhVDEAa7Cg7fJUqYaHjv1khXnmBdYyZZZZ"]);
  const near = o.io.near;
  let k = 0;
  o.io.near = (a) => { const r = near(a); if (a[4] === "add_liquidity") k = 1; return r; };
  const rpc = o.io.rpc;
  o.io.rpc = async (m, p) => { const q = p as Record<string, string>; if (m === "block" && q["block_id"] && k === 0) return { header: { height: 101 } }; return rpc(m, p); };
  await assert.rejects(main(RUN, o.io), { message: `that transaction is older than this send; stopping${HINT}` });
  assert.ok(o.logs.some((l) => l.includes("never paste a key")));
  assert.equal(o.sent.at(-1)!.method, "add_liquidity");
});

test("removeMin is exactly max(1, floor(97% of x)) for small x", () => {
  for (let x = 1n; x <= 1000n; x++) assert.equal(removeMin(x), (x * 97n) / 100n > 0n ? (x * 97n) / 100n : 1n, String(x));
});

test("near gets no terminal input, and an RPC error name is printed only if it is plain", () => {
  assert.equal(NEAR_SPAWN.stdio[0], "ignore");
  assert.ok(!rpcErrorText({ cause: { name: "\u001b[2JUNKNOWN_ACCOUNT" } }).startsWith("RPC error \u001b"));
  assert.ok(!rpcErrorText({ cause: { name: "\u001b[2JX" } }).includes("\u001b"));
  assert.ok(rpcErrorText({ cause: { name: "UNKNOWN_ACCOUNT" } }).startsWith("RPC error UNKNOWN_ACCOUNT: "));
});
