import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { API, buildDryQuote, hasDepositAddress, main, requestDryQuote, summarizeQuote } from "./quote.ts";

const NOW = new Date("2026-11-06T00:00:00Z");
const REFUND = "0x0000000000000000000000000000000000000001";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Replaces fetch so no test can reach the real API; records each request. */
type Recorded = { url: string; method: string; headers: unknown; body: Record<string, unknown> };
function stubFetch(body: string, status = 201): { calls: number; requests: Recorded[] } {
  const counter = { calls: 0, requests: [] as Recorded[] };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    counter.calls++;
    counter.requests.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(body, { status });
  }) as typeof fetch;
  return counter;
}

test("builds a dry-run request with 6-decimal amounts, at both amount limits (EC-S01)", () => {
  const q = buildDryQuote(25, "poolside-demo.near", "public", NOW, REFUND);
  assert.equal(q.dry, true);
  assert.equal(q.amount, "25000000");
  assert.equal(q.deadline, "2026-11-06T00:30:00.000Z");
  assert.equal(buildDryQuote(1, "poolside-demo.near", "public", NOW, REFUND).amount, "1000000");
  assert.equal(buildDryQuote(250, "poolside-demo.near", "public", NOW, REFUND).amount, "250000000");
});

test("refuses amounts outside 1..250 and bad recipients, with exact messages (EC-S01)", () => {
  for (const a of [0, 251, 1.5, -1]) assert.throws(() => buildDryQuote(a, "poolside-demo.near", "public", NOW, REFUND), /^Error: amount must be a whole number of USDC from 1 to 250$/);
  for (const r of ["", "A.near", "x", "a".repeat(65)]) assert.throws(() => buildDryQuote(25, r, "public", NOW, REFUND), /^Error: recipient must be a NEAR account id$/);
});

test("refuses a malformed refund address", () => {
  for (const r of ["", "0x123", "742d35Cc6634C0532925a3b844Bc454e4438f44e00"]) assert.throws(() => buildDryQuote(25, "poolside-demo.near", "public", NOW, r), /^Error: refundTo must be an EVM address on Base$/);
});

test("talks only to the mainnet 1Click quote endpoint (EC-S02)", () => {
  assert.equal(API, "https://1click.chaindefuser.com/v0/quote");
});

test("refuses to send a non-dry request and never calls fetch (EC-S03)", async () => {
  const counter = stubFetch("{}");
  const q = { ...buildDryQuote(25, "poolside-demo.near", "public", NOW, REFUND), dry: false } as unknown as Parameters<typeof requestDryQuote>[0];
  await assert.rejects(() => requestDryQuote(q), /non-dry/);
  assert.equal(counter.calls, 0);
});

test("sends exactly one dry request and returns the parsed body", async () => {
  const counter = stubFetch(JSON.stringify({ quote: { amountOutFormatted: "24.99" } }));
  const r = await requestDryQuote(buildDryQuote(25, "poolside-demo.near", "public", NOW, REFUND));
  assert.equal(counter.calls, 1);
  assert.equal(r.status, 201);
});

test("refuses a response that contains a deposit address (L4)", async () => {
  stubFetch(JSON.stringify({ quote: { depositAddress: "0xabc" } }));
  await assert.rejects(() => requestDryQuote(buildDryQuote(25, "poolside-demo.near", "public", NOW, REFUND)), /deposit address/);
});

test("refuses deposit addresses or memos in any key spelling, as objects or in arrays, and in unparseable text (re-audit L-4, EC-S06)", async () => {
  const q = buildDryQuote(25, "poolside-demo.near", "public", NOW, REFUND);
  for (const body of [
    '{"quote":{"\\u0064epositAddress":"0xabc"}}',
    JSON.stringify({ quote: { depositAddress: { chain: "base", address: "0xabc" } } }),
    JSON.stringify({ quote: { DepositAddress: 5 } }),
    JSON.stringify({ quotes: [{ ok: 1 }, { depositMemo: "m" }] }),
    "not json, depositAddress: 0xabc",
    "not json, deposit_memo: 123",
    JSON.stringify({ quote: { deposit_address: "0xabc" } }),
    JSON.stringify({ quote: { "Deposit-Address": "x" } }),
    "deposit_address: x",
    JSON.stringify({ quote: { "deposit address": "x" } }),
    JSON.stringify({ quote: { "deposit.address": "x" } }),
    JSON.stringify({ quote: { depositAddressV2: "x" } }),
    JSON.stringify({ quote: JSON.stringify({ depositAddress: "0x1" }) }),
    JSON.stringify({ quote: "{not json, depositAddress: 0x1" }),
    "not json, deposit__address: x",
    "not json, deposit - memo: x",
    JSON.stringify({ message: "send to depositAddress 0xabc" }),
    JSON.stringify({ quote: { note: "deposit memo: 1" } }),
    JSON.stringify({ quote: { deposit: { address: "0x1" } } }),
    JSON.stringify({ deposit: { memo: "m" } }),
    JSON.stringify({ quote: { depositAddr: "0x1" } }),
    JSON.stringify({ quote: { depositTo: "0x1" } }),
    JSON.stringify({ quote: { deposit: [{ address: "0x1" }] } }),
    JSON.stringify({ quote: { deposit: { base: { address: "0x1" } } } }),
    JSON.stringify({ quote: { deposit: "0x1" } }),
    JSON.stringify({ quote: { depositInfo: { address: "0x1" } } }),
    JSON.stringify({ quote: { depositAccount: "x.near" } }),
    JSON.stringify({ quote: { deposit: { to: "0x1" } } }),
    JSON.stringify({ quote: { deposit: { addr: "0x1" } } }),
    JSON.stringify({ quote: { deposit: { details: { address: "0x1" } } } }),
    JSON.stringify({ message: "send to deposit_to 0xabc" }),
    "depositAddr=0xabc",
    JSON.stringify({ quote: { userDepositAddress: "0x1" } }),
    JSON.stringify({ quote: { address_for_deposit: "0x1" } }),
    JSON.stringify({ depositType: { address: "0x1" } }),
    JSON.stringify({ depositType: "0xabc" }),
    JSON.stringify({ quote: JSON.stringify({ deposit: "0x1" }) }),
    JSON.stringify("deposit\u005faddress: 0x1234"),
    '"deposit\\u005faddress: 0x1234"',
    JSON.stringify({ quote: { "dep\u0435sitAddress": "0x1" } }),
  ]) {
    stubFetch(body);
    await assert.rejects(() => requestDryQuote(q), /^Error: refusing a quote that contains a deposit address$/, body);
  }
});

test("accepts a null deposit address and the echoed depositType (re-audit L-4, EC-S06)", async () => {
  stubFetch(JSON.stringify({ quoteRequest: { depositType: "ORIGIN_CHAIN" }, quote: { depositAddress: null, amountOut: "1" } }));
  const body = { quoteRequest: { depositType: "ORIGIN_CHAIN" }, quote: { depositAddress: null, amountOut: "1" } };
  const r = await requestDryQuote(buildDryQuote(25, "poolside-demo.near", "public", NOW, REFUND));
  assert.equal(r.status, 201);
  assert.deepEqual(r.json, body);
  const nest = (n: number): unknown => { let d: unknown = 1; for (let i = 0; i < n; i++) d = [d]; return d; };
  assert.equal(hasDepositAddress(nest(32)), false, "accepts clean input nested 32 levels");
  assert.equal(hasDepositAddress(nest(33)), true, "refuses input nested beyond 32 levels");
  assert.equal(hasDepositAddress({ deposit: { address: null, memo: null }, depositType: "INTENTS" }), false);
  assert.equal(hasDepositAddress({ depositMode: "SIMPLE", deposit: [], depositInfo: {} }), false);
  // A depositToken field with a value is refused too (fails closed; not a field 1Click is known to send).
  assert.equal(hasDepositAddress({ depositToken: "usdc" }), true);
  assert.equal(hasDepositAddress([null, 1, "x", "{\"a\": 1}", "[1, 2]", { a: [{ b: null }] }]), false);
});

test("refuses nesting at the depth limit under any key: 31 levels accepted, 32 refused (EC-S06)", () => {
  const nest = (n: number): unknown => { let d: unknown = null; for (let i = 0; i < n; i++) d = [d]; return d; };
  assert.equal(hasDepositAddress({ deposit: nest(31) }), false);
  assert.equal(hasDepositAddress({ deposit: nest(32) }), true);
  assert.equal(hasDepositAddress({ other: nest(32) }), true);
});

test("refuses depositType holding anything but an enum string (EC-S06)", () => {
  assert.equal(hasDepositAddress({ depositType: ["ORIGIN_CHAIN"] }), true);
  assert.equal(hasDepositAddress({ depositType: 5 }), true);
  assert.equal(hasDepositAddress({ depositType: "ORIGIN_CHAIN" }), false);
});

test("the CLI prints exactly the summary per mode, never extra or raw fields, and refuses missing arguments (EC-S06)", async () => {
  const stub = stubFetch(JSON.stringify({ quote: { amountInFormatted: "25", amountOutFormatted: "24.99", minAmountOut: "24742433", timeEstimate: 35, depositAddress: null, extra: "x" } }));
  const lines: string[] = [];
  await main(["25", "poolside-demo.near", REFUND], (l) => lines.push(l), NOW);
  assert.equal(lines.length, 3);
  // What was sent: POST to the API, always dry, one request per mode in order (test re-audit M-1, EC-S03).
  assert.deepEqual(stub.requests.map((r) => [r.url, r.method, r.body["dry"], r.body["confidentiality"]]),
    [[API, "POST", true, "public"], [API, "POST", true, "basic"], [API, "POST", true, "advanced"]]);
  // The whole first request pinned once (test re-audit of 50c8267, Info 7).
  assert.deepEqual(stub.requests[0]!.headers, { "content-type": "application/json" });
  // A literal expected body, not one built by the module under test (test re-audit of 342e8b9, Info-1).
  assert.deepEqual(stub.requests[0]!.body, {
    dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100,
    originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    amount: "25000000", refundTo: REFUND, refundType: "ORIGIN_CHAIN", recipient: "poolside-demo.near",
    recipientType: "DESTINATION_CHAIN", deadline: "2026-11-06T00:30:00.000Z", confidentiality: "public",
  });
  assert.equal(stub.requests[0]!.body["slippageTolerance"], 100);
  for (const [i, mode] of ["public", "basic", "advanced"].entries()) {
    assert.deepEqual(JSON.parse(lines[i]!), { confidentiality: mode, status: 201, quote: { amountIn: "25", amountOut: "24.99", minAmountOut: "24742433", timeEstimate: 35 } });
    assert.equal(lines[i]!.includes("extra"), false);
  }
  await assert.rejects(() => main(["25"], () => {}), /give an existing NEAR account as recipient/);
  await assert.rejects(() => main(["25", "poolside-demo.near"], () => {}), /give a team-controlled Base address as refundTo/);
});

test("prints only four scalar quote fields or a cleaned error message, never the raw response (EC-S06)", () => {
  assert.deepEqual(summarizeQuote({ quote: { amountInFormatted: "25", amountOutFormatted: "24.99", minAmountOut: "24742433", timeEstimate: 35, depositAddress: "0x1", extra: { a: 1 } } }),
    { amountIn: "25", amountOut: "24.99", minAmountOut: "24742433", timeEstimate: 35 });
  assert.deepEqual(summarizeQuote({ quote: { amountInFormatted: { address: "0x1" } } }), { amountIn: null, amountOut: null, minAmountOut: null, timeEstimate: null });
  assert.deepEqual(summarizeQuote({ message: "recipient not found\u0007" }), { error: "recipient not found" });
  assert.deepEqual(summarizeQuote("raw text"), { error: "no quote in the response" });
  assert.deepEqual(summarizeQuote({ message: "x ".repeat(250) }), { error: "x ".repeat(100) });
  // Addresses without the word "deposit" are redacted or dropped (re-audit L-4).
  const addr = "0x" + "ab".repeat(20);
  assert.equal(JSON.stringify(summarizeQuote({ message: `send 25 USDC to ${addr} to continue` })).includes(addr), false);
  assert.equal(JSON.stringify(summarizeQuote({ message: "pay poolside-demo-account-1234.near now" })).includes("poolside-demo-account-1234.near"), false);
  assert.deepEqual(summarizeQuote({ quote: { amountInFormatted: `send to ${addr}`, amountOutFormatted: "24.99", minAmountOut: "1e9", timeEstimate: -1 } }),
    { amountIn: null, amountOut: "24.99", minAmountOut: null, timeEstimate: null });
});

test("allows depositType only as an anchored upper-case enum of 1 to 32 characters (test re-audit M-2, EC-S06)", () => {
  for (const v of ["A".repeat(33), "origin_chain", "0xabc ORIGIN_CHAIN", "ORIGIN_CHAIN 0xabc", ""]) {
    assert.equal(hasDepositAddress({ depositType: v }), true, JSON.stringify(v));
  }
  assert.equal(hasDepositAddress({ depositType: "A".repeat(32) }), false);
  assert.equal(hasDepositAddress({ depositMode: "SIMPLE" }), false);
  // Only depositType and depositMode are allowed, even with an enum-like value.
  assert.equal(hasDepositAddress({ depositAddress: "ORIGIN_CHAIN" }), true);
  assert.equal(hasDepositAddress({ depositMemo: "ABC" }), true);
});

test("redacts address-like runs at their cut-offs and before truncating (test re-audit L-1)", () => {
  const err = (m: string) => summarizeQuote({ message: m })["error"] as string;
  assert.equal(err("x " + "a".repeat(19)), "x " + "a".repeat(19));
  assert.equal(err("x " + "a".repeat(20)), "x [redacted]");
  assert.equal(err("to 0x12345"), "to 0x12345");
  assert.equal(err("to 0x123456"), "to [redacted]");
  const addr = "0x" + "ab".repeat(20);
  // 97 repetitions put the address across the cut: redacting first leaves "[redac", truncating first would leave "0xab".
  const straddling = err("a ".repeat(97) + addr);
  assert.equal(straddling, "a ".repeat(97) + "[redac");
});

test("pins the amount and time formats at their limits (test re-audit L-2)", () => {
  const q = (o: Record<string, unknown>) => summarizeQuote({ quote: o });
  assert.equal(q({ timeEstimate: 0 })["timeEstimate"], 0);
  assert.equal(q({ timeEstimate: 1.5 })["timeEstimate"], null);
  assert.equal(q({ timeEstimate: 2 ** 53 })["timeEstimate"], null);
  assert.equal(q({ amountInFormatted: "9".repeat(40) })["amountIn"], "9".repeat(40));
  assert.equal(q({ amountInFormatted: "9".repeat(41) })["amountIn"], null);
  assert.equal(q({ amountInFormatted: "1." + "9".repeat(40) })["amountIn"], "1." + "9".repeat(40));
  assert.equal(q({ amountInFormatted: "1." + "9".repeat(41) })["amountIn"], null);
  assert.equal(q({ amountInFormatted: "1." })["amountIn"], null);
  assert.equal(q({ amountInFormatted: ".5" })["amountIn"], null);
  assert.equal(q({ timeEstimate: 2 ** 53 - 1 })["timeEstimate"], 2 ** 53 - 1);
});
