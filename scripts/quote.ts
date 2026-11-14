/**
 * No-funds path (gate 4): asks the NEAR Intents 1Click API for DRY-RUN quotes
 * from USDC on another chain to native USDC on NEAR. A dry run returns no
 * deposit address, so nothing can be sent. This script refuses to send any
 * request without `dry: true`.
 *
 * Usage: node quote.ts <amountUsdc> <existing-recipient.near> <team refundTo 0x... on Base>
 * Run with NODE_USE_ENV_PROXY=1 behind an HTTPS proxy.
 */
/** Mainnet 1Click API: Intents has no testnet (EC-S02). Dry runs only. */
export const API = "https://1click.chaindefuser.com/v0/quote";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export interface QuoteRequest {
  dry: true;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
  confidentiality: "public" | "basic" | "advanced";
}

/** Builds a dry-run request. Amount is whole USDC, converted to 6-decimal units. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function buildDryQuote(amountUsdc: number, recipient: string, confidentiality: QuoteRequest["confidentiality"], now: Date, refundTo: string): QuoteRequest {
  if (!EVM_ADDRESS.test(refundTo)) throw new Error("refundTo must be an EVM address on Base");
  if (!Number.isSafeInteger(amountUsdc) || amountUsdc < 1 || amountUsdc > 250) throw new Error("amount must be a whole number of USDC from 1 to 250");
  if (recipient.length < 2 || recipient.length > 64 || !ACCOUNT_ID.test(recipient)) throw new Error("recipient must be a NEAR account id");
  return {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: USDC_BASE,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: USDC_NEAR,
    amount: String(amountUsdc * 1_000_000),
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now.getTime() + 30 * 60_000).toISOString(),
    confidentiality,
  };
}

export async function requestDryQuote(body: QuoteRequest): Promise<{ status: number; json: unknown }> {
  if (body.dry !== true) throw new Error("refusing to request a non-dry quote");
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  // A dry run must never return a deposit address; if it does, refuse to show it
  // (L4). Checked on the parsed JSON so escaped keys and non-string values count
  // too (re-audit L-4); unparseable text is refused if it mentions one at all.
  // A body that parses to a JSON string is checked decoded and raw, so \u escapes can't hide it.
  if (typeof json === "string" ? DEPOSIT_TEXT.test(json) || DEPOSIT_TEXT.test(text) : hasDepositAddress(json)) {
    throw new Error("refusing a quote that contains a deposit address");
  }
  return { status: res.status, json };
}

// Deposit fields a dry quote may echo (gate 4), as enum strings only; every other
// key containing "deposit" must be null or empty (test and security re-audits of 2643df5).
const DEPOSIT_ALLOWED = new Set(["deposittype", "depositmode"]);
const DEPOSIT_TEXT = /deposit[\W_]*(addr|memo|to\b|account|info)/i;

/** Whether `x` holds any value other than null, undefined, or empty objects and arrays. */
function hasValue(x: unknown, depth: number): boolean {
  if (depth > 32) return true; // defence in depth: hasDepositAddress refuses at the same depth first
  if (x === null || x === undefined) return false;
  if (Array.isArray(x)) return x.some((y) => hasValue(y, depth + 1));
  if (typeof x === "object") return Object.values(x).some((y) => hasValue(y, depth + 1));
  return true;
}

/**
 * Whether any object in `v`, at any depth, has a deposit field with a value, or
 * any string mentions a deposit address, memo, recipient or account. String values
 * that are themselves JSON are searched too. Refuses rather than recurse too deep.
 */
export function hasDepositAddress(v: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (typeof v === "string") {
    if (DEPOSIT_TEXT.test(v)) return true;
    const t = v.trim();
    if (!(t.startsWith("{") || t.startsWith("["))) return false;
    try { return hasDepositAddress(JSON.parse(t), depth + 1); } catch { return false; }
  }
  if (Array.isArray(v)) return v.some((x) => hasDepositAddress(x, depth + 1));
  if (v === null || typeof v !== "object") return false;
  return Object.entries(v).some(([k, x]) => {
    // NFKC folds look-alike forms; any remaining non-ASCII letter in a key is refused.
    if (/[^\x00-\x7f]/.test(k.normalize("NFKC"))) return true;
    const n = k.toLowerCase().replace(/[^a-z]/g, "");
    if (n.includes("deposit") && hasValue(x, depth + 1)) {
      // depositType and depositMode may only carry an enum-like string, such as ORIGIN_CHAIN.
      if (!(DEPOSIT_ALLOWED.has(n) && typeof x === "string" && /^[A-Z_]{1,32}$/.test(x))) return true;
    }
    return hasDepositAddress(x, depth + 1);
  });
}

/**
 * The only fields ever printed: three amounts that must look like decimal numbers,
 * a time estimate in whole seconds, or the API's error message as printable ASCII
 * with address-like runs redacted. The raw response is never printed, so the
 * deposit check above is a second layer, not the only one (test re-audit F1).
 */
export function summarizeQuote(json: unknown): Record<string, string | number | null> {
  const scalar = (v: unknown): string | number | null => (typeof v === "string" || typeof v === "number" ? v : null);
  // Amounts must look like amounts; anything else is dropped (re-audit L-4).
  const amount = (v: unknown): string | null => (typeof v === "string" && /^[0-9]{1,40}(\.[0-9]{1,40})?$/.test(v) ? v : null);
  const seconds = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const q = json !== null && typeof json === "object" ? (json as Record<string, unknown>)["quote"] : undefined;
  if (q !== null && typeof q === "object" && !Array.isArray(q)) {
    const o = q as Record<string, unknown>;
    return { amountIn: amount(o["amountInFormatted"]), amountOut: amount(o["amountOutFormatted"]), minAmountOut: amount(o["minAmountOut"]), timeEstimate: seconds(o["timeEstimate"]) };
  }
  const m = json !== null && typeof json === "object" ? scalar((json as Record<string, unknown>)["message"]) : null;
  // Printable ASCII only, and any address-like run (0x hex, or 20+ letters and digits) redacted.
  const clean = (t: string): string => t.replace(/[^\x20-\x7e]/g, "").replace(/0x[0-9a-fA-F]{6,}|[A-Za-z0-9._-]{20,}/g, "[redacted]").slice(0, 200);
  return { error: typeof m === "string" ? clean(m) : "no quote in the response" };
}

/** The command line: prints one summarised line per confidentiality mode, never the raw response. */
export async function main(argv: readonly string[], log: (line: string) => void, now = new Date()): Promise<void> {
  const amount = Number(argv[0] ?? "25");
  const recipient = argv[1];
  if (recipient === undefined) throw new Error("give an existing NEAR account as recipient; 1Click refuses accounts that don't exist");
  const refundTo = argv[2];
  if (refundTo === undefined) throw new Error("give a team-controlled Base address as refundTo");
  for (const mode of ["public", "basic", "advanced"] as const) {
    const { status, json } = await requestDryQuote(buildDryQuote(amount, recipient, mode, now, refundTo));
    log(JSON.stringify({ confidentiality: mode, status, quote: summarizeQuote(json) }));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2), (l) => console.log(l));
