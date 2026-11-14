// Reads one ActionRecord as the contract's `get_action(index)` returns it (docs/INTERFACE.md section 5, the
// "Built shape" of slice 7; the interface is a DRAFT until the backend freeze, so this file is the one place to change).
// Every record is read with strictParse, on its own (EC-R25): duplicate keys, -0, fractions and exponents are refused.
// A record we can't read is "can't check" (unverifiable), never a refusal by a public limit and never matching.
// Unknown kinds and results are kept as `unknown`: "Built, growing" means later slices add variants (INTERFACE section 1).
import { readU128, readU64, strictParse, RulesError, type JsonValue } from "@poolside/rules";

export type RecordKind = "Swap" | "Open" | "ClosePosition" | "ExitRemove";
const KINDS: readonly string[] = ["Swap", "Open", "ClosePosition", "ExitRemove"];

/** How the page classes a record's `result`. Only the exact string "Ok" is `ok` (EC-W25). */
export type ResultClass = "ok" | "pending" | "unknown_result" | "swap_refused" | "refused" | "failed" | "other";

export interface ActionRecord {
  readonly index: bigint;
  readonly opId: bigint;
  /** `null` when the contract wrote a kind this page doesn't know: can't check it. */
  readonly kind: RecordKind | null;
  readonly caller: string;
  readonly leftPoint: number;
  readonly rightPoint: number;
  readonly observed: { readonly block: number; readonly point: number };
  /** 64 hex characters, or "" for an ExitRemove, which takes no decision (INTERFACE section 5, frozen). */
  readonly decisionHash: string;
  /** A close's confirmation observation, from `remove.confirm_observed` (frozen shape). Null on every other record. */
  /** The record's `chain_head` (null, or the head after this record). */
  readonly chainHead: string | null;
  readonly confirmObserved: { readonly block: number; readonly point: number } | null;
  readonly callBlock: number;
  readonly timestampNs: bigint;
  /** The result block's timestamp (a paired open is judged against it, EC-C158). */
  readonly resultTsNs: bigint | null;
  /** `swap.used` of a Swap record: the amount the swap really moved. */
  readonly swapUsed: bigint | null;
  readonly resultBlock: number | null;
  readonly result: ResultClass;
  /** The refusal reason or failed stage as written, for display as plain text only. */
  readonly detail: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ACCOUNT = /^[a-z0-9._-]{2,64}$/;

const bad = (m: string): never => { throw new RulesError("STATE", `record: ${m}`); };
const obj = (v: JsonValue | undefined, what: string): { [k: string]: JsonValue } => {
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) bad(`${what} must be an object`);
  return v as { [k: string]: JsonValue };
};
const isObj = (v: JsonValue | undefined): v is { [k: string]: JsonValue } => v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
const str = (v: JsonValue | undefined, what: string): string => (typeof v === "string" ? v : bad(`${what} must be a string`));
const int = (v: JsonValue | undefined, what: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || Object.is(v, -0)) bad(`${what} must be an integer`);
  return v as number;
};
/** A u64 that fits a block height: heights are far below 2^53, a larger one is refused rather than rounded. */
const height = (v: JsonValue | undefined, what: string): number => {
  const n = readU64(str(v, what));
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) bad(`${what} is not a usable block height`);
  return Number(n);
};

function classify(result: JsonValue | undefined): { cls: ResultClass; detail: string | null } {
  if (typeof result === "string") {
    if (result === "Ok") return { cls: "ok", detail: null };
    if (result === "Pending") return { cls: "pending", detail: null };
    if (result === "Unknown") return { cls: "unknown_result", detail: null };
    if (result === "SwapRefused") return { cls: "swap_refused", detail: null };
    return { cls: "other", detail: null };
  }
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    const keys = Object.keys(result);
    if (keys.length === 1) {
      const k = keys[0]!;
      const v = result[k];
      const detail = typeof v === "string" ? v : null;
      if (k === "Refused") return { cls: "refused", detail };
      if (k === "Failed") return { cls: "failed", detail };
    }
  }
  return { cls: "other", detail: null };
}

/** Throws RulesError("STATE") for a record that can't be read; the caller shows "can't check". */
export function parseActionRecord(text: string): ActionRecord {
  const o = obj(strictParse(text), "the record");
  const kind = str(o.kind, "kind");
  const observed = obj(o.observed, "observed");
  const decisionHash = str(o.decision_hash, "decision_hash");
  // Only an ExitRemove may carry "" (frozen INTERFACE section 5); any other record without a real hash is unreadable.
  if (!(HEX64.test(decisionHash) || (decisionHash === "" && kind === "ExitRemove"))) bad("decision_hash must be 64 lowercase hex characters");
  let confirmObserved: ActionRecord["confirmObserved"] = null;
  if (o.remove !== null && o.remove !== undefined) {
    const rm = obj(o.remove, "remove");
    if (rm.confirm_observed !== null && rm.confirm_observed !== undefined) {
      const c = obj(rm.confirm_observed, "remove.confirm_observed");
      confirmObserved = { block: height(c.block, "confirm_observed.block"), point: int(c.point, "confirm_observed.point") };
    }
  }
  const caller = str(o.caller, "caller");
  if (!ACCOUNT.test(caller)) bad("caller is not an account id");
  const ch = o.chain_head;
  if (ch !== null && ch !== undefined && !(typeof ch === "string" && HEX64.test(ch))) bad("chain_head must be null or 64 lowercase hex characters");
  const resultBlock = o.result_block === null ? null : height(o.result_block, "result_block");
  const { cls, detail } = classify(o.result);
  return {
    index: readU64(str(o.index, "index")),
    opId: readU64(str(o.op_id, "op_id")),
    kind: KINDS.includes(kind) ? (kind as RecordKind) : null,
    caller,
    leftPoint: int(o.left_point, "left_point"),
    rightPoint: int(o.right_point, "right_point"),
    observed: { block: height(observed.block, "observed.block"), point: int(observed.point, "observed.point") },
    decisionHash,
    confirmObserved,
    chainHead: typeof ch === "string" ? ch : null,
    callBlock: height(o.call_block, "call_block"),
    timestampNs: readU64(str(o.timestamp_ns, "timestamp_ns")),
    resultTsNs: o.result_ts_ns === null || o.result_ts_ns === undefined ? null : readU64(str(o.result_ts_ns, "result_ts_ns")),
    swapUsed: isObj(o.swap) && typeof o.swap.used === "string" ? readU128(o.swap.used) : null,
    resultBlock,
    result: cls,
    detail,
  };
}
