/**
 * Gate 3 part D: a tiny real round trip on Rhea DCL mainnet, run by a person.
 *
 * It answers what the sandbox couldn't: whether `remove_liquidity`'s return
 * includes the fees, on the real fee-100 USDC/wNEAR pool. Plan (each
 * transaction shown and confirmed one at a time; the script stops at the first
 * failure):
 *   1. register at wrap.near if needed, wrap a little NEAR (`near_deposit`)
 *   2. register at DCL if needed (`storage_deposit`; this NEAR can't be recovered)
 *   3. deposit USDC and wNEAR into DCL (`ft_transfer_call`, msg "Deposit"),
 *      then check DCL's internal balance holds them
 *   4. re-predict and add a small position around the current point (`add_liquidity`)
 *   5. wait, re-reading the position's unclaimed fees
 *   6. remove it (`remove_liquidity`, skip_unwrap_near) and print the three-way
 *      fee comparison: unclaimed fees before, the `liquidity_removed` event, and
 *      the amounts the call returned
 *   7. withdraw what DCL holds for the account (`withdraw_asset`, non-zero only)
 *   8. optionally unwrap the wNEAR this run added (`near_withdraw`)
 * `recover` mode only removes a named position the account owns in the pool
 * (`--lpt`, recover only, at most twice the run's caps), withdraws non-zero DCL
 * balances, and lists any position still open, for a run that stopped half way.
 *
 * Safety:
 * - Signing is done by the NEAR CLI (near-cli-rs) from the person's own
 *   keychain (`sign-with-keychain`). This script never reads, asks for or logs a
 *   key, and passes arguments as an array, never through a shell.
 * - Only these (receiver, method) pairs can be built (`buildTx`): wrap.near
 *   storage_deposit, near_deposit, ft_transfer_call to DCL, near_withdraw;
 *   USDC ft_transfer_call to DCL; DCL storage_deposit, add_liquidity,
 *   remove_liquidity, withdraw_asset. Storage is only ever paid for the
 *   signing account. Nothing can be sent to any other account.
 * - Amounts are capped in code: at most 5 USDC and 1 NEAR wrapped (test money
 *   counts toward the 500 USDC cap, D4); DCL storage at most 1 NEAR.
 * - The RPC must report `chain_id` mainnet, and `.testnet` accounts are refused.
 * - The mode is required: `dry` makes only view calls and prints the planned
 *   commands; `run` and `recover` need `--i-have-reviewed-this-script`.
 * - Before `run` on mainnet, SECURITY_PROCESS section 4 requires two
 *   independent security audits of this script, `/security-review`, and the
 *   lead reading both reports (gate 3, part D).
 *
 * Usage (Node 22.18 or later, which runs .ts directly):
 *   node mainnet-roundtrip.ts dry --account you.near [--usdc 1] [--wrap-near 0.2]
 *   node mainnet-roundtrip.ts run --account you.near [--usdc 1] [--wrap-near 0.2] --i-have-reviewed-this-script
 *   node mainnet-roundtrip.ts recover --account you.near [--lpt <lpt_id>] --i-have-reviewed-this-script
 * Behind an HTTPS proxy, set NODE_USE_ENV_PROXY=1.
 *
 * near-cli-rs (read in its 0.31.1 source by an audit, not yet run here): it
 * re-encodes json-args with sorted keys, so arguments are compared with keys
 * sorted; it prints "Transaction ID: <hash>" on stderr, which the script leaves
 * on the terminal, so the person pastes the hash, and a pasted hash is accepted
 * only once and only if its receipts ran after this send started. `run` and
 * `recover` refuse any other `near` than near-cli-rs 0.31.x. near is started
 * with no terminal input, so if it would prompt (it can when it rejects an
 * argument or can't use the keychain) it fails instead; never answer a near
 * prompt or paste a key. Its exit codes are
 * unverified; the script checks each transaction's outcome itself.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

export const DCL = "dclv2.ref-labs.near";
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const WRAP = "wrap.near";
export const POOL = `${USDC}|${WRAP}|100`;
export const RPC = "https://rpc.mainnet.near.org";
export const ALLOWED = new Set([DCL, USDC, WRAP]);
/** The only calls this script can make. */
export const ALLOWED_CALLS = new Set([
  `${WRAP}:storage_deposit`, `${WRAP}:near_deposit`, `${WRAP}:ft_transfer_call`, `${WRAP}:near_withdraw`,
  `${USDC}:ft_transfer_call`,
  `${DCL}:storage_deposit`, `${DCL}:add_liquidity`, `${DCL}:remove_liquidity`, `${DCL}:withdraw_asset`,
]);
export const MAX_USDC = 5_000_000n; // 5 USDC, 6 decimals
export const MAX_WRAP = 10n ** 24n; // 1 NEAR
export const MAX_DCL_STORAGE = 10n ** 24n; // 1 NEAR
export const MAX_TOKEN_STORAGE = 10n ** 22n; // 0.01 NEAR
export const WRAP_STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR, wrap.near's bound
export const GAS_MARGIN = 3n * 10n ** 23n; // 0.3 NEAR kept for gas in the preflight
export const HALF_WIDTH = 20; // points each side of the current point (spacing 1 at fee 100)
export const RPC_TIMEOUT_MS = 20_000;
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const YOCTO_PER_NEAR = 10n ** 24n;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export interface Tx { receiver: string; method: string; args: Record<string, unknown>; depositYocto: bigint; gasTgas: number }

/** Whole or decimal amount in a token with `decimals`, as a bigint. Refuses signs, exponents and too many decimals. */
export function parseAmount(text: string, decimals: number): bigint {
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text);
  if (!m) throw new Error(`amount must be a plain decimal number: ${JSON.stringify(text)}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`amount has more than ${decimals} decimals`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** A u128 amount from an RPC answer, strictly decimal. */
export function u128(v: unknown, what: string): bigint {
  if (typeof v !== "string" || !DECIMAL.test(v)) throw new Error(`${what} must be a decimal string`);
  const n = BigInt(v);
  if (n >= 1n << 128n) throw new Error(`${what} must fit in u128`);
  return n;
}

export function checkAccount(account: string): string {
  if (account.length < 2 || account.length > 64 || !ACCOUNT_ID.test(account)) throw new Error("--account must be a NEAR account id");
  if (ALLOWED.has(account)) throw new Error("--account must be your own test account");
  if (account.endsWith(".testnet")) throw new Error("--account is a testnet account; this script runs on mainnet");
  return account;
}

export function checkAmounts(usdc: bigint, wrap: bigint): void {
  if (usdc <= 0n || usdc > MAX_USDC) throw new Error("--usdc must be above 0 and at most 5");
  if (wrap <= 0n || wrap > MAX_WRAP) throw new Error("--wrap-near must be above 0 and at most 1");
}

/** The only way a transaction is made: (receiver, method) allow-listed, deposits capped, transfers only to DCL, storage only for the signer. */
export function buildTx(t: Tx, account: string): Tx {
  if (!ALLOWED.has(t.receiver)) throw new Error(`refusing a transaction to ${t.receiver}`);
  if (!ALLOWED_CALLS.has(`${t.receiver}:${t.method}`)) throw new Error(`refusing ${t.method} on ${t.receiver}`);
  if (t.depositYocto < 0n) throw new Error("negative deposit");
  if (!Number.isInteger(t.gasTgas) || t.gasTgas < 10 || t.gasTgas > 300) throw new Error("gas must be 10 to 300 Tgas");
  if (t.method === "ft_transfer_call") {
    if (t.args["receiver_id"] !== DCL) throw new Error("token transfers may only go to DCL");
    if (t.args["msg"] !== "\"Deposit\"") throw new Error("token transfers may only deposit");
    if (t.depositYocto !== 1n) throw new Error("token transfers attach exactly 1 yoctoNEAR");
    const amount = u128(t.args["amount"], "amount");
    if (amount === 0n) throw new Error("transfer amount must be above 0");
    if (t.receiver === USDC && amount > MAX_USDC) throw new Error("USDC amount over the cap");
    if (t.receiver === WRAP && amount > MAX_WRAP) throw new Error("wNEAR amount over the cap");
  }
  if (t.method === "near_deposit" && t.depositYocto > MAX_WRAP) throw new Error("near_deposit over the cap");
  if (t.method === "near_withdraw") {
    if (t.depositYocto !== 1n) throw new Error("near_withdraw attaches exactly 1 yoctoNEAR");
    if (u128(t.args["amount"], "amount") > MAX_WRAP) throw new Error("near_withdraw over the cap");
  }
  if (t.method === "storage_deposit") {
    if (t.args["account_id"] !== account) throw new Error("storage is only paid for the signing account");
    if (t.receiver === DCL && t.depositYocto > MAX_DCL_STORAGE) throw new Error("DCL storage over the cap");
    if (t.receiver !== DCL && t.depositYocto > MAX_TOKEN_STORAGE) throw new Error("token storage over the cap");
  }
  if (["add_liquidity", "remove_liquidity", "withdraw_asset"].includes(t.method)) {
    if (t.depositYocto !== 0n) throw new Error(`${t.method} attaches no deposit`);
    if (t.method !== "add_liquidity" && t.args["skip_unwrap_near"] !== true) throw new Error(`${t.method} must skip unwrapping`);
  }
  if (t.method === "add_liquidity") {
    const ax = u128(t.args["amount_x"], "amount_x"), ay = u128(t.args["amount_y"], "amount_y");
    if (ax > MAX_USDC || ay > MAX_WRAP) throw new Error("add amounts over the cap");
    const mx = u128(t.args["min_amount_x"], "min_amount_x"), my = u128(t.args["min_amount_y"], "min_amount_y");
    if ((mx === 0n && ax > 0n) || (my === 0n && ay > 0n)) throw new Error("add minimums must be above 0");
    if (mx > ax || my > ay) throw new Error("add minimums above the amounts");
    if (t.args["pool_id"] !== POOL) throw new Error("add only to the USDC/wNEAR fee-100 pool");
    checkPoint(t.args["left_point"]); checkPoint(t.args["right_point"]);
    if ((t.args["left_point"] as number) >= (t.args["right_point"] as number)) throw new Error("left point must be below right point");
  }
  if (t.method === "remove_liquidity") {
    if (typeof t.args["lpt_id"] !== "string" || t.args["lpt_id"] === "") throw new Error("remove needs an lpt_id");
    if (u128(t.args["amount"], "amount") === 0n) throw new Error("remove amount must be above 0");
    u128(t.args["min_amount_x"], "min_amount_x"); u128(t.args["min_amount_y"], "min_amount_y");
  }
  return t;
}

/** A DCL point: an integer within ±800,000. */
export function checkPoint(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < -800_000 || v > 800_000) throw new Error("point must be an integer within ±800000");
  return v;
}

/** The RPC must report mainnet (EC-S02). */
export function assertMainnet(status: unknown): void {
  const id = (status as { chain_id?: unknown } | null)?.chain_id;
  if (id !== "mainnet") throw new Error(`the RPC reports chain_id ${String(id)}, not mainnet`);
}

/** EC-S04: refuse an account with a contract deployed, a global contract, or any function-call key (a strategy or agent account). */
export function checkNoContract(codeHash: unknown, account: Record<string, unknown>, keys: unknown): void {
  const msg = "--account has a contract or function-call keys (a strategy or agent account, or a wallet with dApp logins?); use a freshly created test account with only a full-access key (EC-S04)";
  if (codeHash !== "11111111111111111111111111111111") throw new Error(msg);
  if (account["global_contract_hash"] != null || account["global_contract_account_id"] != null) throw new Error(msg);
  const list = (keys as { keys?: { access_key?: { permission?: unknown } }[] } | null)?.keys;
  if (!Array.isArray(list)) throw new Error("view_access_key_list returned an unexpected shape; stopping");
  if (list.some((k) => k.access_key?.permission !== "FullAccess")) throw new Error(msg);
}

/** NEAR the account can spend: its balance minus what its storage locks (1e19 yoctoNEAR per byte). */
export function availableNear(amount: bigint, storageUsage: number): bigint {
  const locked = BigInt(storageUsage) * 10n ** 19n;
  return amount > locked ? amount - locked : 0n;
}

export interface OwnPosition { amount: bigint; unclaimed_fee_x: bigint; unclaimed_fee_y: bigint }

/** A `get_liquidity` answer for a position this account owns in the pinned pool, or a refusal. */
export function checkOwnPosition(pos: unknown, account: string): OwnPosition {
  if (pos === null || typeof pos !== "object") throw new Error("position not found");
  const p = pos as Record<string, unknown>;
  if (p["owner_id"] !== account) throw new Error("that position isn't owned by this account");
  if (p["pool_id"] !== POOL) throw new Error("that position isn't in the USDC/wNEAR fee-100 pool");
  const amount = u128(p["amount"], "position liquidity");
  if (amount === 0n) throw new Error("that position has no liquidity");
  return { amount, unclaimed_fee_x: u128(p["unclaimed_fee_x"], "unclaimed_fee_x"), unclaimed_fee_y: u128(p["unclaimed_fee_y"], "unclaimed_fee_y") };
}

/** `predict_remove_liquidity`'s answer as [x, y]. Unverified shape (gate 3 part D): anything else is refused. */
export function parsePredictRemove(v: unknown): [bigint, bigint] {
  if (!Array.isArray(v) || v.length !== 2) throw new Error("predict_remove_liquidity returned an unexpected shape; stopping");
  return [u128(v[0], "predicted x"), u128(v[1], "predicted y")];
}

/** Recover only positions of this script's size: at most twice the run caps. */
export function checkTestSize(x: bigint, y: bigint, what: string): void {
  if (x > 2n * MAX_USDC || y > 2n * MAX_WRAP) throw new Error(`${what} is larger than this script's test money; handle it by hand`);
}

/** The remove's minimum for one side: 97% of the prediction, and at least 1 whenever the prediction is above 0. */
export function removeMin(predicted: bigint): bigint {
  const m = (predicted * 97n) / 100n;
  return predicted > 0n && m === 0n ? 1n : m;
}

/** A reason to refuse when the account's DCL liquidity slots are full (an add would fail with E107), or null. */
export function slotsFull(detail: unknown): string | null {
  const d = (detail ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : typeof v === "string" && DECIMAL.test(v) ? Number(v) : null);
  const cur = n(d["cur_liquidity_slots"]), max = n(d["max_slots"]);
  if (cur === null || max === null) return "can't read DCL slots (get_user_storage_detail)";
  return cur >= max ? `DCL slots are full (${cur} of ${max}); an add would fail with E107` : null;
}

/** This account's positions in the pinned pool, from `list_liquidities`. */
export function openPositions(list: unknown, account: string): string[] {
  if (!Array.isArray(list)) throw new Error("list_liquidities returned an unexpected shape; stopping");
  return list.filter((p) => p && typeof p === "object" && (p as Record<string, unknown>)["pool_id"] === POOL && (p as Record<string, unknown>)["owner_id"] === account)
    .map((p) => String((p as Record<string, unknown>)["lpt_id"]));
}

/** The distinct receipt block hashes of a transaction, in order (for measuring how many blocks its receipts span). */
export function receiptBlocks(result: unknown): string[] {
  const out: string[] = [];
  for (const o of (result as TxStatus)?.receipts_outcome ?? []) if (typeof o.block_hash === "string" && !out.includes(o.block_hash)) out.push(o.block_hash);
  return out;
}

/** An RPC error as text: the cause name first, so a long error cut for printing never hides it (an unknown account is recognised by it). */
export function rpcErrorText(error: unknown): string {
  const name = (error as { cause?: { name?: unknown } } | null)?.cause?.name;
  return `RPC error${typeof name === "string" && /^[A-Z_]{1,64}$/.test(name) ? ` ${name}` : ""}: ${JSON.stringify(error).slice(0, 200)}`;
}

/** The remove can only answer the gate question if it claims fees. */
export function feesAbove0(p: OwnPosition): boolean {
  return p.unclaimed_fee_x > 0n || p.unclaimed_fee_y > 0n;
}

/** NEAR amounts as decimal NEAR for people (yoctoNEAR is exact but unreadable). */
export function nearDecimal(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR, frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac} NEAR` : `${whole} NEAR`;
}

export function formatDeposit(yocto: bigint): string {
  return yocto % YOCTO_PER_NEAR === 0n ? `${yocto / YOCTO_PER_NEAR} NEAR` : `${yocto} yoctoNEAR`;
}

/** near-cli-rs argv for one transaction, signed from the person's keychain. */
export function cliArgs(t: Tx, account: string): string[] {
  return ["contract", "call-function", "as-transaction", t.receiver, t.method, "json-args", JSON.stringify(t.args),
    "prepaid-gas", `${t.gasTgas} Tgas`, "attached-deposit", formatDeposit(t.depositYocto),
    "sign-as", account, "network-config", "mainnet", "sign-with-keychain", "send"];
}

/** The hash near-cli-rs prints after sending, or null. */
export function parseTxHash(output: string): string | null {
  const m = /Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{43,44})\b/.exec(output);
  return m ? m[1]! : null;
}

interface TxStatus {
  status?: { SuccessValue?: string; Failure?: unknown };
  transaction?: { signer_id?: string; receiver_id?: string; actions?: { FunctionCall?: { method_name?: string; deposit?: string; args?: string; gas?: number } }[] };
  receipts_outcome?: { block_hash?: string; outcome?: { executor_id?: string; logs?: string[]; status?: { SuccessValue?: string; Failure?: unknown } } }[];
}

/** "failed" if the transaction failed; "receipt_failed" if it succeeded but a later receipt (for example a payout) failed; else "ok". */
export function txOutcome(result: unknown): "ok" | "receipt_failed" | "failed" {
  const r = result as TxStatus;
  if (!r || typeof r !== "object" || !r.status || r.status.SuccessValue === undefined || r.status.Failure !== undefined) return "failed";
  return (r.receipts_outcome ?? []).some((o) => o.outcome?.status?.Failure !== undefined) ? "receipt_failed" : "ok";
}

/** JSON with object keys sorted at every level: near-cli-rs re-encodes `json-args` with sorted keys, so arguments are compared in this form. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** The looked-up transaction must be the one just sent: signer, receiver, method and deposit. */
export function checkTxMatches(result: unknown, t: Tx, account: string): void {
  const r = result as TxStatus;
  const acts = r?.transaction?.actions;
  const fc = Array.isArray(acts) && acts.length === 1 ? acts[0]?.FunctionCall : undefined;
  let args: string | null = null;
  try { args = canonical(JSON.parse(Buffer.from(fc?.args ?? "", "base64").toString("utf8"))); } catch { /* mismatch below */ }
  if (r?.transaction?.signer_id !== account || r.transaction.receiver_id !== t.receiver || fc?.method_name !== t.method || fc?.deposit !== String(t.depositYocto) || args !== canonical(t.args) || fc?.gas !== t.gasTgas * 1e12) {
    throw new Error("that transaction is not the one just sent; stopping");
  }
}

/** The remove's return (the transaction's top-level value) and DCL's `liquidity_removed` event, only for this account's remove on DCL. */
export function removeResult(result: unknown, account: string): { returned: [string, string] | null; event: Record<string, string> | null } {
  const r = result as TxStatus;
  const method = r.transaction?.actions?.[0]?.FunctionCall?.method_name;
  if (r.transaction?.signer_id !== account || r.transaction?.receiver_id !== DCL || method !== "remove_liquidity") {
    throw new Error("that transaction is not this account's remove_liquidity on DCL");
  }
  let returned: [string, string] | null = null;
  const sv = r.status?.SuccessValue;
  if (sv) {
    try {
      const v = JSON.parse(Buffer.from(sv, "base64").toString("utf8")) as unknown;
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string") returned = [v[0], v[1]];
    } catch { /* leave null */ }
  }
  let event: Record<string, string> | null = null;
  for (const o of r.receipts_outcome ?? []) {
    if (o.outcome?.executor_id !== DCL || o.outcome?.status?.Failure !== undefined) continue;
    for (const l of o.outcome?.logs ?? []) {
      if (!l.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(l.slice("EVENT_JSON:".length)) as { event?: string; data?: Record<string, string>[] };
        if (e.event === "liquidity_removed" && e.data?.[0]) event = e.data[0];
      } catch { /* other event */ }
    }
  }
  return { returned, event };
}

const optU128 = (v: unknown): bigint | null => (typeof v === "string" && DECIMAL.test(v) && BigInt(v) < 1n << 128n ? BigInt(v) : null);

/**
 * The fee comparison, as lines to print. It reports what was seen and draws no conclusion beyond equalities.
 * `delta` is the change in wallet plus DCL internal balance across the remove (what DCL actually paid).
 */
export function feeComparison(unclaimed: { x: bigint; y: bigint; block: number }, event: Record<string, string> | null, returned: [string, string] | null, predicted: [bigint, bigint], delta: [bigint, bigint]): string[] {
  const e = (k: string) => (event ? optU128(event[k]) : null);
  const show = (v: bigint | null) => (v === null ? "unknown" : String(v));
  const [fx, fy, rx, ry] = [e("claim_fee_token_x"), e("claim_fee_token_y"), e("refund_token_x"), e("refund_token_y")];
  const ret = returned ? [optU128(returned[0]), optU128(returned[1])] : [null, null];
  const lines = [
    `unclaimed fees just before the remove (get_liquidity at block ${unclaimed.block}): x=${unclaimed.x} y=${unclaimed.y}`,
    `predict_remove_liquidity just before the remove: x=${predicted[0]} y=${predicted[1]}`,
    `liquidity_removed event: claim_fee_token_x=${show(fx)} claim_fee_token_y=${show(fy)} refund_token_x=${show(rx)} refund_token_y=${show(ry)}`,
    `remove_liquidity returned: x=${show(ret[0]!)} y=${show(ret[1]!)}`,
    `wallet plus DCL internal balance changed by: x=${delta[0]} y=${delta[1]}`,
  ];
  if (fx === null || fy === null || rx === null || ry === null || ret[0] === null || ret[1] === null) {
    lines.push("inconclusive: an event field or the return is missing or not a decimal");
    return lines;
  }
  if (fx === 0n && fy === 0n) { lines.push("inconclusive: no fees claimed"); return lines; }
  lines.push(`returned == refund_token: ${ret[0] === rx && ret[1] === ry}`);
  lines.push(`returned == refund_token + claim_fee_token: ${ret[0] === rx + fx && ret[1] === ry + fy}`);
  lines.push(`balance change == refund_token: ${delta[0] === rx && delta[1] === ry}`);
  lines.push(`balance change == refund_token + claim_fee_token: ${delta[0] === rx + fx && delta[1] === ry + fy}`);
  lines.push(`fees in the event equal the unclaimed fees read just before (may differ if swaps happened in between): ${fx === unclaimed.x && fy === unclaimed.y}`);
  lines.push("note: these lines are evidence, not the answer; confirm against the DCL 2.4.2 source before writing it into gate 3");
  return lines;
}

/** `near` is the spendable NEAR (`availableNear`). */
export interface Balances { usdc: bigint; near: bigint }
export interface PoolState { state: unknown; token_x: unknown; token_y: unknown; fee: unknown }

/** Reasons to refuse starting a run, or [] if it may start. */
export function preflight(pool: PoolState, bal: Balances, usdc: bigint, wrap: bigint, needWrapStorage: boolean, dclStorage: bigint | null, internal: [bigint, bigint]): string[] {
  const why: string[] = [];
  if (internal[0] > 0n || internal[1] > 0n) why.push(`DCL already holds USDC ${internal[0]} and wNEAR ${internal[1]} for this account; run recover first`);
  if (pool.state !== "Running") why.push(`pool state is ${String(pool.state)}, not Running`);
  if (pool.token_x !== USDC || pool.token_y !== WRAP || pool.fee !== 100) why.push("pool tokens or fee aren't USDC/wNEAR fee 100");
  if (bal.usdc < usdc) why.push(`USDC balance ${bal.usdc} is below --usdc ${usdc}`);
  const needNear = wrap + (needWrapStorage ? WRAP_STORAGE : 0n) + (dclStorage ?? 0n) + GAS_MARGIN;
  if (bal.near < needNear) why.push(`NEAR balance ${nearDecimal(bal.near)} is below the ${nearDecimal(needNear)} needed (wrap, storage and gas)`);
  return why;
}

/** The internal balances DCL must hold after the deposits, or a reason they don't. */
export function depositsLanded(assets: unknown, usdc: bigint, wrap: bigint): string | null {
  const a = (assets ?? {}) as Record<string, unknown>;
  const x = a[USDC] === undefined ? 0n : u128(a[USDC], "internal USDC");
  const y = a[WRAP] === undefined ? 0n : u128(a[WRAP], "internal wNEAR");
  if (x < usdc || y < wrap) return `DCL holds USDC ${x} and wNEAR ${y}, less than deposited`;
  return null;
}

/** `withdraw_asset` calls for the non-zero DCL balances only. */
export function withdrawPlan(assets: unknown, account: string): Tx[] {
  const a = (assets ?? {}) as Record<string, unknown>;
  const out: Tx[] = [];
  for (const t of [USDC, WRAP]) {
    const v = a[t] === undefined ? 0n : u128(a[t], "internal balance");
    if (v > (t === USDC ? 2n * MAX_USDC : 2n * MAX_WRAP)) throw new Error(`DCL holds ${v} of ${t === USDC ? "USDC" : "wNEAR"} for this account, more than this script's test money; withdraw it by hand`);
    if (v > 0n) {
      out.push(buildTx({ receiver: DCL, method: "withdraw_asset", args: { token_id: t, skip_unwrap_near: true }, depositYocto: 0n, gasTgas: 100 }, account));
    }
  }
  return out;
}

/** How much wNEAR to offer to unwrap: only what this run added, at most `MAX_WRAP`. */
export function unwrapAmount(before: bigint, after: bigint): bigint {
  const gained = after > before ? after - before : 0n;
  return gained > MAX_WRAP ? MAX_WRAP : gained;
}

/** `run` and `recover` need the review flag. */
export function assertRunAllowed(f: { mode: string; reviewed: boolean }): void {
  if (f.mode !== "dry" && !f.reviewed) throw new Error(`${f.mode} mode needs --i-have-reviewed-this-script`);
}

export interface Flags { mode: "dry" | "run" | "recover"; account: string; usdc: bigint; wrap: bigint; lpt: string | null; reviewed: boolean }

export function parseFlags(argv: string[]): Flags {
  const [mode, ...rest] = argv;
  if (mode !== "dry" && mode !== "run" && mode !== "recover") throw new Error("first argument must be dry, run or recover");
  const valued = new Set(["--account", "--usdc", "--wrap-near", "--lpt"]);
  const vals = new Map<string, string>();
  let reviewed = false;
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]!;
    if (k === "--i-have-reviewed-this-script") { reviewed = true; continue; }
    if (!valued.has(k)) throw new Error(`unknown argument ${k}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${k} needs a value`);
    vals.set(k, v); i++;
  }
  if (vals.has("--lpt") && mode !== "recover") throw new Error("--lpt is only for recover mode");
  const account = checkAccount(vals.get("--account") ?? "");
  const usdc = parseAmount(vals.get("--usdc") ?? "1", 6);
  const wrap = parseAmount(vals.get("--wrap-near") ?? "0.2", 24);
  checkAmounts(usdc, wrap);
  return { mode, account, usdc, wrap, lpt: vals.get("--lpt") ?? null, reviewed };
}

// ---- I/O below: view calls over RPC (no keys) and the CLI for signing. Injected, so tests can drive `main`. ----

export interface IO {
  rpc(method: string, params: unknown): Promise<unknown>;
  near(args: string[]): { status: number | null; stdout: string };
  ask(question: string): Promise<string>;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
}

/** How the near CLI is started: no terminal input, so a prompt fails closed and can never be answered; stdout piped; stderr on the terminal. */
export const NEAR_SPAWN = { stdio: ["ignore", "pipe", "inherit"] as ["ignore", "pipe", "inherit"], encoding: "utf8" as const };

const quoteArg = (a: string) => (/[\s"{}|'<>]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a);

export async function main(argv: string[], io: IO): Promise<void> {
  const f = parseFlags(argv);
  assertRunAllowed(f);
  assertMainnet(await io.rpc("status", []));
  io.log(`network: mainnet (${RPC}); account ${f.account}`);
  if (f.mode !== "dry") {
    const ver = io.near(["--version"]).stdout.trim();
    // the argument re-encoding and hash output this script relies on were read in near-cli-rs 0.31.1 (gate 3 part D)
    if (!/^near-cli-rs 0\.31\.\d+$/.test(ver)) throw new Error(`this script needs near-cli-rs 0.31.x as \`near\`; found ${JSON.stringify(ver || "nothing")}`);
    io.log(`near CLI: ${ver}`);
  }

  // every RPC read is retried three times with backoff (2, 4, 8 s): the public RPC rate-limits, and a read failing mid-run would stop it (an unknown account is not retried)
  const call = async (method: string, params: unknown): Promise<unknown> => {
    for (let i = 0; ; i++) {
      try { return await io.rpc(method, params); }
      catch (e) { if (i >= 3 || String(e).includes("UNKNOWN_ACCOUNT")) throw e; await io.sleep(2000 * 2 ** i); }
    }
  };
  const view = async (account: string, method: string, args: unknown): Promise<{ value: unknown; block: number }> => {
    const r = await call("query", { request_type: "call_function", finality: "final", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }) as { result: number[]; block_height: number };
    return { value: JSON.parse(Buffer.from(r.result).toString("utf8")), block: r.block_height };
  };
  const v = async (account: string, method: string, args: unknown) => (await view(account, method, args)).value;
  const bal = async (t: string) => u128(await v(t, "ft_balance_of", { account_id: f.account }), "balance");
  const internal = async (): Promise<[bigint, bigint]> => {
    const a = ((await v(DCL, "list_user_assets", { account_id: f.account })) ?? {}) as Record<string, unknown>;
    return [a[USDC] === undefined ? 0n : u128(a[USDC], "internal USDC"), a[WRAP] === undefined ? 0n : u128(a[WRAP], "internal wNEAR")];
  };
  let acct: { amount: string; storage_usage: number; code_hash: string };
  try { acct = await call("query", { request_type: "view_account", finality: "final", account_id: f.account }) as typeof acct; }
  catch (e) { if (String(e).includes("UNKNOWN_ACCOUNT")) throw new Error(`account ${f.account} does not exist on mainnet`); throw e; }
  checkNoContract(acct.code_hash, acct as unknown as Record<string, unknown>, await call("query", { request_type: "view_access_key_list", finality: "final", account_id: f.account }));

  let sent = 0;
  const seen = new Set<string>();
  let lpt: string | null = f.lpt;
  const send = async (t: Tx, onLanded?: (r: TxStatus) => void, beforeSend?: () => Promise<void>): Promise<TxStatus> => {
    const checked = buildTx(t, f.account);
    const dep = checked.depositYocto >= 10n ** 18n ? nearDecimal(checked.depositYocto) : formatDeposit(checked.depositYocto);
    io.log(`\nnext: ${checked.method} on ${checked.receiver}, deposit ${dep}, gas ${checked.gasTgas} Tgas\n  near ${cliArgs(checked, f.account).map(quoteArg).join(" ")}`);
    io.log("  if near asks you anything (a signing method, a value, a key), press Ctrl-C and never paste a key");
    if ((await io.ask("type yes to send it, anything else to stop: ")).trim() !== "yes") throw new Error("stopped by the person");
    await beforeSend?.();
    const startHeight = ((await call("block", { finality: "final" })) as { header: { height: number } }).header.height;
    sent++;
    const out = io.near(cliArgs(checked, f.account));
    io.log(out.stdout);
    if (out.status !== 0) throw new Error(`near CLI exited with ${out.status} (if the transaction may have landed, recover without --lpt lists any open position)`);
    const hash = parseTxHash(out.stdout) ?? ((await io.ask("paste the transaction hash: ")).trim() || null);
    if (!hash) throw new Error("no transaction hash");
    if (seen.has(hash)) throw new Error("that transaction hash was already used in this run");
    seen.add(hash);
    let result: unknown = null;
    result = await call("tx", { tx_hash: hash, sender_account_id: f.account, wait_until: "FINAL" });
    checkTxMatches(result, checked, f.account);
    const blocks = receiptBlocks(result);
    if (!blocks.length) throw new Error("that transaction has no receipts to check; stopping");
    const h: number[] = [];
    for (const b of blocks) h.push(((await call("block", { block_id: b })) as { header: { height: number } }).header.height);
    if (Math.min(...h) < startHeight) throw new Error("that transaction is older than this send; stopping");
    io.log(`receipts ran in blocks ${h.join(", ")}: ${Math.max(...h) - Math.min(...h)} blocks from first to last (evidence for PAYOUT_SETTLE_BLOCKS)`);
    onLanded?.(result as TxStatus); // only once the transaction is known to be this send's, before its outcome is judged
    const o = txOutcome(result);
    if (o === "failed") throw new Error(`transaction ${hash} failed`);
    if (o === "receipt_failed") {
      if (checked.method !== "remove_liquidity" && checked.method !== "withdraw_asset") throw new Error(`transaction ${hash} has a failed receipt`);
      io.log("a payout receipt failed; DCL keeps that amount in the internal balance (gate 3 part C), and the withdraws below pick it up");
    }
    return result as TxStatus;
  };

  try {
    await flow();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (sent > 0) throw new Error(`${msg}; stopping. Funds stay in your wallet (as wNEAR), your DCL internal balance or a position: run recover --account ${f.account}${lpt ? ` --lpt '${lpt}'` : ""} --i-have-reviewed-this-script`);
    throw new Error(msg);
  }

  async function removeOwn(id: string, range?: [number, number]): Promise<void> {
    const before = await view(DCL, "get_liquidity", { lpt_id: id });
    if (before.value === null && !range) { io.log(`position ${id} no longer exists (already removed); going on to the withdraws`); lpt = null; return; }
    const pos = checkOwnPosition(before.value, f.account);
    const b = before.value as Record<string, unknown>;
    if (range && (b["left_point"] !== range[0] || b["right_point"] !== range[1])) throw new Error("that position isn't the one this run added (its range differs)");
    const pr = parsePredictRemove(await v(DCL, "predict_remove_liquidity", { lpt_id: id, amount: String(pos.amount) }));
    checkTestSize(pr[0], pr[1], "that position");
    // the baseline is read after the person confirms, just before the CLI runs, so nothing that arrives during the prompt is counted as paid by the remove
    let w0: bigint[] = [], i0: [bigint, bigint] = [0n, 0n];
    const res = await send({ receiver: DCL, method: "remove_liquidity", args: { lpt_id: id, amount: String(pos.amount), min_amount_x: String(removeMin(pr[0])), min_amount_y: String(removeMin(pr[1])), skip_unwrap_near: true }, depositYocto: 0n, gasTgas: 150 },
      (r) => { if (txOutcome(r) !== "failed") lpt = null; },
      async () => { w0 = [await bal(USDC), await bal(WRAP)]; i0 = await internal(); });
    const [w1, i1] = [[await bal(USDC), await bal(WRAP)], await internal()];
    const delta: [bigint, bigint] = [w1[0]! + i1[0] - w0[0]! - i0[0], w1[1]! + i1[1] - w0[1]! - i0[1]];
    const r = removeResult(res, f.account);
    io.log("\nfee comparison (evidence for the gate 3 report):");
    for (const l of feeComparison({ x: pos.unclaimed_fee_x, y: pos.unclaimed_fee_y, block: before.block }, r.event, r.returned, pr, delta)) io.log("  " + l);
  }

  async function flow(): Promise<void> {
    if (f.mode === "recover") {
      if (f.lpt) await removeOwn(f.lpt);
      for (const t of withdrawPlan(await v(DCL, "list_user_assets", { account_id: f.account }), f.account)) await send(t);
      io.log(`\nbalances now: USDC ${await bal(USDC)}, wNEAR ${await bal(WRAP)}`);
      await finish();
      return;
    }

    const pool = await v(DCL, "get_pool", { pool_id: POOL }) as PoolState & { current_point: unknown };
    const point = checkPoint(pool.current_point);
    const startWrap = await bal(WRAP);
    const balances = { usdc: await bal(USDC), near: availableNear(u128(acct.amount, "account balance"), acct.storage_usage) };
    io.log(`pool ${POOL}: state ${String(pool.state)}, fee ${String(pool.fee)}, current_point ${point}`);
    io.log(`balances: USDC ${balances.usdc}, wNEAR ${startWrap}, spendable NEAR ${nearDecimal(balances.near)}`);
    const wrapReg = await v(WRAP, "storage_balance_of", { account_id: f.account });
    const dclReg = await v(DCL, "storage_balance_of", { account_id: f.account });
    const bounds = await v(DCL, "storage_balance_bounds", {}) as { min: unknown };
    const dclMin = u128(bounds.min, "DCL storage minimum");
    const dclStorage = dclReg === null ? dclMin : null;
    io.log(`registered at wrap.near: ${wrapReg !== null}; at DCL: ${dclReg !== null} (DCL minimum ${nearDecimal(dclMin)}, not recoverable)`);
    const left = point - HALF_WIDTH, right = point + HALF_WIDTH + 1;
    checkPoint(left); checkPoint(right);
    const why = preflight(pool, balances, f.usdc, f.wrap, wrapReg === null, dclStorage, await internal());
    if (dclReg !== null) { const full = slotsFull(await v(DCL, "get_user_storage_detail", { user_id: f.account })); if (full) why.push(full); }
    const p0 = await v(DCL, "predict_add_liquidity", { pool_id: POOL, left_point: left, right_point: right, amount_x: String(f.usdc), amount_y: String(f.wrap) }) as { need_x: unknown; need_y: unknown };
    const [n0x, n0y] = [u128(p0.need_x, "need_x"), u128(p0.need_y, "need_y")];
    io.log(`range [${left}, ${right}): predict_add_liquidity needs USDC ${n0x} and wNEAR ${n0y} now (re-predicted just before the add)`);
    if (n0x > f.usdc || n0y > f.wrap) why.push("predict_add_liquidity asks for more than the amounts given");
    for (const w of why) io.log(`preflight: ${w}`);
    const plan: Tx[] = [];
    if (wrapReg === null) plan.push(buildTx({ receiver: WRAP, method: "storage_deposit", args: { account_id: f.account }, depositYocto: WRAP_STORAGE, gasTgas: 30 }, f.account));
    plan.push(buildTx({ receiver: WRAP, method: "near_deposit", args: {}, depositYocto: f.wrap, gasTgas: 30 }, f.account));
    if (dclStorage !== null) plan.push(buildTx({ receiver: DCL, method: "storage_deposit", args: { account_id: f.account }, depositYocto: dclStorage, gasTgas: 30 }, f.account));
    plan.push(buildTx({ receiver: USDC, method: "ft_transfer_call", args: { receiver_id: DCL, amount: String(f.usdc), msg: "\"Deposit\"" }, depositYocto: 1n, gasTgas: 100 }, f.account));
    plan.push(buildTx({ receiver: WRAP, method: "ft_transfer_call", args: { receiver_id: DCL, amount: String(f.wrap), msg: "\"Deposit\"" }, depositYocto: 1n, gasTgas: 100 }, f.account));
    io.log("\nplanned transactions:");
    for (const t of plan) io.log("  near " + cliArgs(t, f.account).map(quoteArg).join(" "));
    const later: Tx[] = [
      { receiver: DCL, method: "add_liquidity", args: { pool_id: POOL, left_point: left, right_point: right, amount_x: "<need_x>", amount_y: "<need_y>", min_amount_x: "<97% of need_x>", min_amount_y: "<97% of need_y>", skip_unwrap_near: true }, depositYocto: 0n, gasTgas: 150 },
      { receiver: DCL, method: "remove_liquidity", args: { lpt_id: "<lpt_id>", amount: "<liquidity>", min_amount_x: "<97% of predicted x>", min_amount_y: "<97% of predicted y>", skip_unwrap_near: true }, depositYocto: 0n, gasTgas: 150 },
      { receiver: DCL, method: "withdraw_asset", args: { token_id: USDC, skip_unwrap_near: true }, depositYocto: 0n, gasTgas: 100 },
      { receiver: DCL, method: "withdraw_asset", args: { token_id: WRAP, skip_unwrap_near: true }, depositYocto: 0n, gasTgas: 100 },
      { receiver: WRAP, method: "near_withdraw", args: { amount: "<wNEAR this run added>" }, depositYocto: 1n, gasTgas: 30 },
    ];
    io.log("then, with the values filled in at the time (each checked by the same rules before it is sent):");
    for (const t of later) io.log("  near " + cliArgs(t, f.account).map(quoteArg).join(" "));
    if (f.mode === "dry") { io.log(why.length ? "\ndry run: a run would be refused for the reasons above. Nothing was sent." : "\ndry run: nothing was sent."); return; }
    if (why.length) throw new Error("preflight failed; nothing was sent");

    for (const t of plan) await send(t);
    const landed = depositsLanded(await v(DCL, "list_user_assets", { account_id: f.account }), f.usdc, f.wrap);
    const full = slotsFull(await v(DCL, "get_user_storage_detail", { user_id: f.account }));
    if (full) throw new Error(full);
    if (landed) throw new Error(landed);
    const now = checkPoint((await v(DCL, "get_pool", { pool_id: POOL }) as { current_point: unknown }).current_point);
    if (now < left || now >= right) throw new Error("the price left the range since the start");
    const predict = await v(DCL, "predict_add_liquidity", { pool_id: POOL, left_point: left, right_point: right, amount_x: String(f.usdc), amount_y: String(f.wrap) }) as { need_x: unknown; need_y: unknown };
    const nx = u128(predict.need_x, "need_x"), ny = u128(predict.need_y, "need_y");
    if (nx > f.usdc || ny > f.wrap) throw new Error("predict_add_liquidity asks for more than was deposited");
    const min = (x: bigint) => String(removeMin(x)); // 97%, and at least 1 whenever the need is above 0
    // the lpt_id is read as soon as the transaction is found, before its outcome is judged, so the recover hint can name it
    await send({ receiver: DCL, method: "add_liquidity", args: { pool_id: POOL, left_point: left, right_point: right, amount_x: String(nx), amount_y: String(ny), min_amount_x: min(nx), min_amount_y: min(ny), skip_unwrap_near: true }, depositYocto: 0n, gasTgas: 150 },
      (r) => { try { const x = JSON.parse(Buffer.from(r.status?.SuccessValue ?? "", "base64").toString()); if (typeof x === "string" && x !== "") lpt = x; } catch { /* asked below */ } });
    if (!lpt) lpt = (await io.ask("the add's lpt_id was not found; paste it: ")).trim();
    io.log(`\nposition ${lpt} (keep this for recover mode)`);
    for (;;) {
      const pos = checkOwnPosition(await v(DCL, "get_liquidity", { lpt_id: lpt }), f.account);
      io.log(`position ${lpt}: liquidity ${pos.amount}, unclaimed fees x=${pos.unclaimed_fee_x} y=${pos.unclaimed_fee_y}`);
      const a = (await io.ask("press Enter to read again, type remove (only once a fee is above 0), or stop: ")).trim();
      if (a === "stop") throw new Error("stopped by the person");
      if (a !== "remove") continue;
      if (!feesAbove0(pos)) { io.log("no fees yet, so the remove couldn't answer the question; waiting"); continue; }
      await removeOwn(lpt, [left, right]);
      break;
    }
    for (const t of withdrawPlan(await v(DCL, "list_user_assets", { account_id: f.account }), f.account)) await send(t);
    const endWrap = await bal(WRAP);
    io.log(`\nbalances now: USDC ${await bal(USDC)}, wNEAR ${endWrap}`);
    const w = unwrapAmount(startWrap, endWrap);
    if (w > 0n && (await io.ask(`unwrap the ${nearDecimal(w)} of wNEAR this run added? type yes: `)).trim() === "yes") {
      await send({ receiver: WRAP, method: "near_withdraw", args: { amount: String(w) }, depositYocto: 1n, gasTgas: 30 });
    }
    await finish();
  }

  /** Ends with "done" only when DCL holds nothing and no position is open in the pool for this account. */
  async function finish(): Promise<void> {
    const left = await internal();
    const open = openPositions(await v(DCL, "list_liquidities", { account_id: f.account }), f.account);
    if (left[0] > 0n || left[1] > 0n || open.length) {
      io.log(`\nnot done: DCL still holds USDC ${left[0]} and wNEAR ${left[1]}${open.length ? `, and these positions are open: ${open.join(", ")}` : ""}. Run recover again${open.length ? " with --lpt" : ""} later.`);
      return;
    }
    const wn = await bal(WRAP);
    if (f.mode === "recover" && wn > 0n) io.log(`\nyour wallet holds ${nearDecimal(wn)} of wNEAR; if a run wrapped it, unwrap it by hand with near_withdraw`);
    io.log("\ndone. The DCL storage deposit stays at DCL (not recoverable). Report the transaction hashes and the fee comparison.");
  }
}

async function realRpc(method: string, params: unknown): Promise<unknown> {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "rt", method, params }), redirect: "error", signal: AbortSignal.timeout(RPC_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json() as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(rpcErrorText(body.error));
  return body.result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: IO = {
    rpc: realRpc,
    near: (args) => { const o = spawnSync("near", args, NEAR_SPAWN); return { status: o.status, stdout: o.stdout ?? "" }; },
    ask: (q) => rl.question(q),
    log: (l) => console.log(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  main(process.argv.slice(2), io).then(() => rl.close(), (e: unknown) => { console.error(e instanceof Error ? e.message : String(e)); rl.close(); process.exit(1); });
}
