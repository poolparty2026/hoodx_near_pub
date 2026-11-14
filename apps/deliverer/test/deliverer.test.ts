import { describe, expect, it } from "vitest";
import { hashRules } from "@poolside/rules";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { generateKeyPair, openKey, sealKey } from "@poolside/seal";
import { validateRules, encryptRules } from "@poolside/rules";
import { Deliverer, parseSale, type Chain, type KeySale } from "../src/deliverer.ts";
import { signDeliverKey, makeChain, checkKeyRestriction } from "../src/chain.ts";
import { assertTestnetRpc } from "../src/guard.ts";
import { base58Encode, base58Decode, publicKeyOf } from "@poolside/near";

const WINDOW = 3_600_000_000_000n; // 1 h
const K = new Uint8Array(32).fill(7);
const ME = "deliverer.testnet";

function sale(over: Partial<KeySale> & { buyer_pubkey: string }): KeySale {
  return { buyer: "bob.testnet", state: "Escrowed", bought_at_ns: "1000", price: "1", sealed_key: null, ...over };
}

function fake(sales: KeySale[], opts: { deliverer?: string; sendOk?: boolean } = {}) {
  const sent: { buyer: string; sealed: string }[] = [];
  const chain: Chain = {
    now: async () => 0n,
    async view(method, args) {
      if (method === "get_key_params") return { key_delivery_window_ns: WINDOW.toString(), deliverer: opts.deliverer ?? ME, sold: sales.length };
      if (method === "get_key_sales") { const q = args as { from_index: number; limit: number }; return sales.slice(q.from_index, q.from_index + q.limit); }
      if (method === "get_key_sale") return sales.find((s) => s.buyer === (args as { buyer: string }).buyer) ?? null;
      throw new Error("unexpected view");
    },
    async deliverKey(buyer, sealed) {
      sent.push({ buyer, sealed });
      if (opts.sendOk === false) return { ok: false, failure: "LIMIT: not escrowed" };
      const s = sales.find((x) => x.buyer === buyer)!;
      s.state = "Released";
      return { ok: true, failure: null };
    },
  };
  return { chain, sent };
}

const STRAT = "s.testnet";
const R = validateRules({ version: 1, pool: `${"ab".repeat(32)}|wrap.near|100`, quote_token: "ab".repeat(32), range: { width_bps: 800, centre: "mid" },
  take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432_000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
const CONFIG = {
  rules_ciphertext: Buffer.from(encryptRules(R, K, new Uint8Array(24).fill(3), STRAT)).toString("base64"),
  rules_hash: Array.from(hashRules(R)).map((b) => b.toString(16).padStart(2, "0")).join(""),
};
// The clock is the chain's (latest final block), never the host's.
const mk = (chain: Chain, nowNs: bigint, extra: Partial<ConstructorParameters<typeof Deliverer>[0]> = {}) =>
  new Deliverer({
    chain: { ...chain, now: async () => nowNs, view: async (m, a) => (m === "get_config" ? CONFIG : chain.view(m, a)) },
    rulesKey: K, accountId: ME, strategyId: STRAT, ...extra,
  });

describe("Deliverer", () => {
  it("seals K to the view's buyer_pubkey and delivers; the buyer opens it", async () => {
    const kp = await generateKeyPair();
    const { chain, sent } = fake([sale({ buyer_pubkey: kp.publicKey })]);
    const out = await mk(chain, 2000n).tick();
    expect(out).toEqual([{ buyer: "bob.testnet", result: "delivered" }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sealed).toMatch(/^[0-9a-f]{160}$/);
    expect(await openKey(sent[0]!.sealed, kp)).toEqual(K);
  });

  it("idempotent: a second tick (restart) sends nothing for a Released sale", async () => {
    const kp = await generateKeyPair();
    const { chain, sent } = fake([sale({ buyer_pubkey: kp.publicKey })]);
    await mk(chain, 2000n).tick();
    expect(await mk(chain, 2000n).tick()).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("refund path: window closed at the exact deadline is not delivered (complement of refund_key)", async () => {
    const kp = await generateKeyPair();
    const deadline = 1000n + WINDOW;
    const a = fake([sale({ buyer_pubkey: kp.publicKey })]);
    expect(await mk(a.chain, deadline, { marginNs: 0n }).tick()).toEqual([{ buyer: "bob.testnet", result: "skipped", reason: "window closed" }]);
    expect(a.sent).toHaveLength(0);
    const b = fake([sale({ buyer_pubkey: kp.publicKey })]);
    expect((await mk(b.chain, deadline - 1n, { marginNs: 0n }).tick())[0]!.result).toBe("delivered");
  });

  it("skips a sale inside the safety margin", async () => {
    const kp = await generateKeyPair();
    const { chain, sent } = fake([sale({ buyer_pubkey: kp.publicKey })]);
    const out = await mk(chain, 1000n + WINDOW - 5n, { marginNs: 10n }).tick();
    expect(out[0]).toMatchObject({ result: "skipped", reason: "too close to deadline" });
    expect(sent).toHaveLength(0);
  });

  it("EC-K05 (refund half): a Refunded sale is skipped, nothing is sent", async () => {
    const kp = await generateKeyPair();
    const { chain, sent } = fake([sale({ buyer_pubkey: kp.publicKey, state: "Refunded" })]);
    expect(await mk(chain, 2000n).tick()).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("EC-K06: seals to the key read from the single-sale view even if the list differs", async () => {
    const listed = await generateKeyPair();
    const real = await generateKeyPair();
    const sent: string[] = [];
    const chain: Chain = {
      now: async () => 0n,
      async view(m) {
        if (m === "get_key_params") return { key_delivery_window_ns: WINDOW.toString(), deliverer: ME, sold: 1 };
        if (m === "get_key_sales") return [sale({ buyer_pubkey: listed.publicKey })];
        return sale({ buyer_pubkey: real.publicKey });
      },
      async deliverKey(_b, s) { sent.push(s); return { ok: true, failure: null }; },
    };
    await mk(chain, 2000n).tick();
    expect(await openKey(sent[0]!, real)).toEqual(K);
    await expect(openKey(sent[0]!, listed)).rejects.toThrow("SEAL: cannot open");
  });

  it("a sale released between list and read is skipped", async () => {
    const kp = await generateKeyPair();
    const chain: Chain = {
      now: async () => 0n,
      async view(m) {
        if (m === "get_key_params") return { key_delivery_window_ns: WINDOW.toString(), deliverer: ME, sold: 1 };
        if (m === "get_key_sales") return [sale({ buyer_pubkey: kp.publicKey })];
        return sale({ buyer_pubkey: kp.publicKey, state: "Released" });
      },
      async deliverKey() { throw new Error("must not send"); },
    };
    expect(await mk(chain, 2000n).tick()).toEqual([{ buyer: "bob.testnet", result: "skipped", reason: "not escrowed" }]);
  });

  it("a failed send is reported, nothing thrown, backed off, then retried when chain time passes the backoff", async () => {
    const kp = await generateKeyPair();
    const f = fake([sale({ buyer_pubkey: kp.publicKey })], { sendOk: false });
    let clock = 2000n;
    const d = new Deliverer({ chain: { ...f.chain, now: async () => clock, view: async (m, a) => (m === "get_config" ? CONFIG : f.chain.view(m, a)) }, rulesKey: K, accountId: ME, strategyId: STRAT });
    expect(await d.tick()).toEqual([{ buyer: "bob.testnet", result: "failed", reason: "LIMIT: not escrowed" }]);
    expect(await d.tick()).toEqual([{ buyer: "bob.testnet", result: "skipped", reason: "backing off" }]);
    expect(f.sent).toHaveLength(1);
    clock += 11_000_000_000n; // past the 10 s first backoff
    expect((await d.tick())[0]).toMatchObject({ result: "failed" });
    expect(f.sent).toHaveLength(2);
    clock += 11_000_000_000n; // the second backoff is 20 s: still backing off
    expect((await d.tick())[0]).toMatchObject({ reason: "backing off" });
  });


  it("one bad sale does not block the next", async () => {
    const kp = await generateKeyPair();
    const bad = sale({ buyer: "bad.testnet", buyer_pubkey: "zz" });
    const good = sale({ buyer: "good.testnet", buyer_pubkey: kp.publicKey });
    const f = fake([bad, good]);
    const out = await mk(f.chain, 2000n).tick();
    expect(out.map((o) => o.result)).toEqual(["failed", "delivered"]);
  });

  it("refuses to run as anyone but the contract's deliverer", async () => {
    const f = fake([], { deliverer: "other.testnet" });
    await expect(mk(f.chain, 1n).tick()).rejects.toThrow("DELIVERER: this account is not the contract's deliverer");
  });

  it("refuses malformed params and a non-list sales view", async () => {
    const base = (params: unknown, sales: unknown): Chain => ({
      now: async () => 0n,
      async view(m) { return m === "get_key_params" ? params : sales; },
      async deliverKey() { throw new Error("no"); },
    });
    await expect(mk(base(null, []), 1n).tick()).rejects.toThrow("DELIVERER: key params");
    await expect(mk(base({ key_delivery_window_ns: "-1", deliverer: ME, sold: 0 }, []), 1n).tick()).rejects.toThrow("key_delivery_window_ns");
    await expect(mk(base({ key_delivery_window_ns: "1", deliverer: 5, sold: 0 }, []), 1n).tick()).rejects.toThrow("deliverer");
    await expect(mk(base({ key_delivery_window_ns: "1", deliverer: ME, sold: -1 }, []), 1n).tick()).rejects.toThrow("sold");
    await expect(mk(base({ key_delivery_window_ns: "1", deliverer: ME, sold: 0 }, {}), 1n).tick()).rejects.toThrow("sales is not a list");
  });

  it("rules key must be 32 bytes", () => {
    expect(() => new Deliverer({ chain: { ...fake([]).chain, now: async () => 0n }, rulesKey: new Uint8Array(31), accountId: ME, strategyId: STRAT })).toThrow("rules key must be 32 bytes");
  });

  it("parseSale rejects each malformed field", () => {
    const ok = { buyer: "b.testnet", buyer_pubkey: "ab".repeat(32), state: "Escrowed", bought_at_ns: "1", price: "1", sealed_key: null };
    expect(parseSale(ok)).toEqual(ok);
    for (const bad of [null, [], { ...ok, buyer: "" }, { ...ok, buyer_pubkey: "AB".repeat(32) }, { ...ok, state: "x" },
      { ...ok, bought_at_ns: "01" }, { ...ok, price: 1 }, { ...ok, sealed_key: 5 }]) {
      expect(() => parseSale(bad)).toThrow(/^DELIVERER: /);
    }
  });
});

describe("M1 EC-K03: the held key must open the on-chain rules", () => {
  it("EC-K03/EC-K04: a wrong K throws at verify and at tick, and sends nothing (so the buyer never gets a key that fails the hash check)", async () => {
    const kp = await generateKeyPair();
    const f = fake([sale({ buyer_pubkey: kp.publicKey })]);
    const d = mk(f.chain, 2000n, { rulesKey: new Uint8Array(32).fill(9) });
    await expect(d.verifyKey()).rejects.toThrow("DELIVERER: rules key does not open the on-chain rules");
    await expect(d.tick()).rejects.toThrow("DELIVERER: rules key does not open the on-chain rules");
    expect(f.sent).toHaveLength(0);
  });
  it("a ciphertext bound to another strategy is refused", async () => {
    const f = fake([]);
    await expect(mk(f.chain, 1n, { strategyId: "other.testnet" }).verifyKey()).rejects.toThrow("does not open");
  });
  it("an unreadable config is refused", async () => {
    const chain: Chain = { now: async () => 0n, view: async () => null, deliverKey: async () => ({ ok: true, failure: null }) };
    await expect(new Deliverer({ chain, rulesKey: K, accountId: ME, strategyId: STRAT }).verifyKey()).rejects.toThrow("config is unreadable");
  });
});

describe("clock and parallelism", () => {
  it("a slow send does not starve the next sale (both in flight at once)", async () => {
    const a = await generateKeyPair(), b = await generateKeyPair();
    const sales = [sale({ buyer: "a.testnet", buyer_pubkey: a.publicKey }), sale({ buyer: "b.testnet", buyer_pubkey: b.publicKey })];
    let started = 0, maxConcurrent = 0, running = 0;
    const chain: Chain = {
      now: async () => 0n,
      async view(m, args) {
        if (m === "get_key_params") return { key_delivery_window_ns: WINDOW.toString(), deliverer: ME, sold: 2 };
        if (m === "get_key_sales") return sales;
        return sales.find((s) => s.buyer === (args as { buyer: string }).buyer) ?? null;
      },
      async deliverKey() {
        started++; running++; maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        return { ok: true, failure: null };
      },
    };
    const out = await mk(chain, 2000n).tick();
    expect(out.map((o) => o.result)).toEqual(["delivered", "delivered"]);
    expect(maxConcurrent).toBe(2);
    expect(started).toBe(2);
  });
});

describe("guard and key restriction", () => {
  it("assertTestnetRpc: exact hosts only", () => {
    for (const ok of ["https://rpc.testnet.near.org", "https://rpc.testnet.fastnear.com", "http://127.0.0.1:3030", "http://localhost:3030"]) {
      expect(() => assertTestnetRpc(ok)).not.toThrow();
    }
    for (const bad of ["https://rpc.mainnet.near.org", "https://testnet.evil.com", "https://rpc.mainnet.near.org/?testnet", "http://rpc.testnet.near.org",
      "https://user:pw@rpc.testnet.near.org", "https://rpc.testnet.near.org.evil.com", "not a url"]) {
      expect(() => assertTestnetRpc(bad)).toThrow(/^DELIVERER: /);
    }
  });

  const rpcWith = (permission: unknown) => ({
    rpcUrl: "https://rpc.testnet.near.org",
    fetch: (async () => new Response(JSON.stringify({ result: permission === undefined ? {} : { permission } }))) as unknown as typeof fetch,
  });
  const pk = new Uint8Array(32).fill(5);
  it("checkKeyRestriction accepts only a deliver_key-only key to the strategy", async () => {
    const fc = (receiver: string, methods: unknown) => ({ FunctionCall: { receiver_id: receiver, method_names: methods, allowance: "1" } });
    expect(await checkKeyRestriction(rpcWith(fc(STRAT, ["deliver_key"])), ME, pk, STRAT)).toEqual({ ok: true, reason: "" });
    expect((await checkKeyRestriction(rpcWith("FullAccess"), ME, pk, STRAT)).reason).toBe("key is full access");
    expect((await checkKeyRestriction(rpcWith(fc("other.testnet", ["deliver_key"])), ME, pk, STRAT)).reason).toBe("key receiver is not the strategy");
    expect((await checkKeyRestriction(rpcWith(fc(STRAT, [])), ME, pk, STRAT)).ok).toBe(false);
    expect((await checkKeyRestriction(rpcWith(fc(STRAT, ["deliver_key", "refund_key"])), ME, pk, STRAT)).ok).toBe(false);
    expect((await checkKeyRestriction(rpcWith(fc(STRAT, ["refund_key"])), ME, pk, STRAT)).ok).toBe(false);
    expect((await checkKeyRestriction(rpcWith(undefined), ME, pk, STRAT)).reason).toBe("key not found on the account");
    expect((await checkKeyRestriction(rpcWith({}), ME, pk, STRAT)).reason).toBe("key permission unreadable");
  });
});

describe("keys.rs behaviours", () => {
  it("failed payout receipt but sale Released: counted as delivered", async () => {
    const kp = await generateKeyPair();
    const sales = [sale({ buyer_pubkey: kp.publicKey })];
    const chain: Chain = {
      now: async () => 0n,
      async view(m, a) {
        if (m === "get_key_params") return { key_delivery_window_ns: WINDOW.toString(), deliverer: ME, sold: 1 };
        if (m === "get_key_sales") return sales;
        return sales.find((s) => s.buyer === (a as { buyer: string }).buyer) ?? null;
      },
      async deliverKey(_b, sealed) { sales[0]!.state = "Released"; sales[0]!.sealed_key = sealed; return { ok: false, failure: "payout receipt failed" }; },
    };
    expect(await mk(chain, 2000n).tick()).toEqual([{ buyer: "bob.testnet", result: "delivered" }]);
  });

  it("low-order buyer key (contract only refuses all-zero): fails, nothing sent, other sales unaffected", async () => {
    const good = await generateKeyPair();
    const low = sale({ buyer: "low.testnet", buyer_pubkey: "01" + "00".repeat(31) });
    const f = fake([low, sale({ buyer: "ok.testnet", buyer_pubkey: good.publicKey })]);
    const out = await mk(f.chain, 2000n).tick();
    expect(out.map((o) => o.result)).toEqual(["failed", "delivered"]);
    expect(f.sent.map((s) => s.buyer)).toEqual(["ok.testnet"]);
  });
});

describe("sealing property: wrong buyer cannot open", () => {
  it("EC-K01 via delivery", async () => {
    const a = await generateKeyPair(), b = await generateKeyPair();
    await expect(openKey(await sealKey(K, a.publicKey), b)).rejects.toThrow();
  });
});


function edKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32));
  const pub = new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  return { seed, pub, secret: "ed25519:" + base58Encode(new Uint8Array([...seed, ...pub])) };
}

describe("signDeliverKey", () => {
  it("signature verifies; method is deliver_key; deposit is zero", () => {
    const k = edKey();
    const args = new TextEncoder().encode('{"buyer":"b.testnet","sealed_key":"00"}');
    const { base64 } = signDeliverKey({ signerId: ME, seed: k.seed, publicKey: k.pub, nonce: 5n, receiverId: "s.testnet", blockHash: new Uint8Array(32), args, gas: 1n });
    const all = Buffer.from(base64, "base64");
    const sig = all.subarray(-64), tx = all.subarray(0, -65);
    expect(all[all.length - 65]).toBe(0); // ed25519 signature tag
    const ok = verify(null, createHash("sha256").update(tx).digest(), createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), k.pub]), format: "der", type: "spki" }), sig);
    expect(ok).toBe(true);
    expect(tx.includes(Buffer.from("deliver_key"))).toBe(true);
    expect(tx.subarray(-16).every((b) => b === 0)).toBe(true);
  });
});

describe("makeChain over a fake RPC", () => {
  it("views at final and sends deliver_key", async () => {
    const k = edKey();
    const calls: { method: string; params: any }[] = [];
    const fakeFetch = (async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ method: body.params.request_type ?? body.method, params: body.params });
      let result: unknown;
      if (body.method === "block") {
        result = { header: { timestamp_nanosec: "1234567890123456789" } };
      } else if (body.params.request_type === "call_function") {
        result = { result: [...Buffer.from('{"a":1}')], block_height: 5, block_hash: base58Encode(new Uint8Array(32).fill(9)) };
      } else if (body.params.request_type === "view_access_key") {
        result = { nonce: 41, block_hash: base58Encode(new Uint8Array(32).fill(9)) };
      } else result = { status: { SuccessValue: "" }, receipts_outcome: [] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200 });
    }) as unknown as typeof fetch;
    const chain = makeChain({ rpcUrl: "https://rpc.testnet.near.org", fetch: fakeFetch }, "s.testnet", ME, k.secret);
    expect(await chain.now()).toBe(1234567890123456789n);
    calls.length = 0;
    expect(await chain.view("get_key_params", {})).toEqual({ a: 1 });
    expect(calls[0]!.params.finality).toBe("final");
    expect(await chain.deliverKey("b.testnet", "00")).toEqual({ ok: true, failure: null });
    expect(calls.map((c) => c.method)).toEqual(["call_function", "view_access_key", "send_tx"]);
    void base58Decode;
  });
});

describe("H2: in-flight guard (double delivery)", () => {
  it("two overlapping ticks send exactly one deliver_key for the same buyer", async () => {
    const kp = await generateKeyPair();
    const sales = [sale({ buyer_pubkey: kp.publicKey })];
    let sends = 0;
    const chain: Chain = {
      now: async () => 0n,
      async view(m, a) {
        if (m === "get_key_params") return { key_delivery_window_ns: WINDOW.toString(), deliverer: ME, sold: 1 };
        if (m === "get_key_sales") return sales;
        return sales.find((s) => s.buyer === (a as { buyer: string }).buyer) ?? null;
      },
      async deliverKey() {
        sends++;
        await new Promise((r) => setTimeout(r, 40)); // the sale stays Escrowed while FINAL is awaited
        sales[0]!.state = "Released";
        return { ok: true, failure: null };
      },
    };
    const d = mk(chain, 2000n);
    const [a, b] = await Promise.all([d.tick(), d.tick()]);
    expect(sends).toBe(1);
    expect([...a, ...b].map((o) => (o.result === "skipped" ? o.reason : o.result)).sort()).toEqual(["delivered", "in flight"]);
  });
});

describe("H3: deadline margin edges", () => {
  const deadline = 1000n + WINDOW;
  const at = async (now: bigint, extra: { marginNs?: bigint } = {}) => {
    const kp = await generateKeyPair();
    const f = fake([sale({ buyer_pubkey: kp.publicKey })]);
    const out = await mk(f.chain, now, extra).tick();
    return { out: out[0]!, sent: f.sent.length };
  };
  it("margin 10: delivers at deadline-11, skips at deadline-10 (margin) and deadline-9", async () => {
    expect((await at(deadline - 11n, { marginNs: 10n })).out.result).toBe("delivered");
    expect(await at(deadline - 10n, { marginNs: 10n })).toMatchObject({ out: { reason: "too close to deadline" }, sent: 0 });
    expect(await at(deadline - 9n, { marginNs: 10n })).toMatchObject({ out: { reason: "too close to deadline" }, sent: 0 });
  });
  it("default margin is 15 s: delivers 15 s + 1 ns before the deadline, skips at exactly 15 s, window closed at the deadline", async () => {
    expect((await at(deadline - 15_000_000_001n)).out.result).toBe("delivered");
    expect(await at(deadline - 15_000_000_000n)).toMatchObject({ out: { reason: "too close to deadline" }, sent: 0 });
    expect(await at(deadline)).toMatchObject({ out: { reason: "window closed" }, sent: 0 });
    expect(await at(deadline + 1n)).toMatchObject({ out: { reason: "window closed" }, sent: 0 });
  });
});

describe("EC-K05 / EC-K02 / EC-K06", () => {
  it("EC-K05: a Released sale is never re-delivered, and the deliverer has no way to refund or rekey", async () => {
    const kp = await generateKeyPair();
    const f = fake([sale({ buyer_pubkey: kp.publicKey, state: "Released", sealed_key: "ab".repeat(80) })]);
    expect(await mk(f.chain, 2000n).tick()).toEqual([]);
    expect(f.sent).toHaveLength(0);
    expect(Object.keys(f.chain).sort()).toEqual(["deliverKey", "now", "view"]); // no refund_key / rekey path
  });
  // EC-K02 (rekey after a lost browser key) is not applicable: rekey is cut (D57). The buyer's only recourse is none after delivery.
  it("EC-K06: 50 sales (the page cap) all handled from one list read; seals only to the single-sale view's key", async () => {
    const pairs = await Promise.all(Array.from({ length: 50 }, () => generateKeyPair()));
    const sales = pairs.map((p, i) => sale({ buyer: `b${i}.testnet`, buyer_pubkey: p.publicKey }));
    const seen: unknown[] = [];
    const f = fake(sales);
    const orig = f.chain.view;
    f.chain.view = async (m, a) => { if (m === "get_key_sales") seen.push(a); return orig(m, a); };
    const out = await mk(f.chain, 2000n).tick();
    expect(seen).toEqual([{ from_index: 0, limit: 50 }, { from_index: 50, limit: 50 }]); // a full page asks for the next one
    expect(out.filter((o) => o.result === "delivered")).toHaveLength(50);
    expect(f.sent).toHaveLength(50);
  });
});

describe("signing known answer", () => {
  it("a fixed key and transaction always produce this exact signed transaction and hash (ed25519 is deterministic)", () => {
    const seed = new Uint8Array(32).fill(1);
    
    const r = signDeliverKey({ signerId: "d.testnet", seed, publicKey: publicKeyOf(seed), nonce: 7n, receiverId: "s.testnet", blockHash: new Uint8Array(32).fill(2),
      args: new TextEncoder().encode('{"buyer":"b.testnet","sealed_key":"00"}'), gas: 50_000_000_000_000n });
    expect(r.hash).toBe("GaZcUzqbvuKJx2KpdjVqJqqtg2zakAoBBcb61iYCfi2s");
    expect(r.base64).toBe("CQAAAGQudGVzdG5ldACKiOPddAnxlf1S2y08ul1yymcJvx2UEhvzdIgBtA9vXAcAAAAAAAAACQAAAHMudGVzdG5ldAICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAQAAAAILAAAAZGVsaXZlcl9rZXknAAAAeyJidXllciI6ImIudGVzdG5ldCIsInNlYWxlZF9rZXkiOiIwMCJ9ACA9iHktAAAAAAAAAAAAAAAAAAAAAAAAADltA2Ul/C46EVHfbhNlpIzJ2f0Fj5tDrUMcKOOxtSJPZwIIIUwmQocqSgC+YniwCR7m/5TAftAoTHlR2RKP0gU=");
  });
});

describe("N1: one nonce stream for concurrent sales", () => {
  it("EC-K07: 3 concurrent deliverKey calls all land; a fake RPC rejects duplicate or lower nonces", async () => {
    const k = edKey();
    let chainNonce = 40n;
    const landed: bigint[] = [];
    const rpcFetch = (async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      const hash = base58Encode(new Uint8Array(32).fill(9));
      let result: unknown;
      if (body.params.request_type === "view_access_key") result = { nonce: Number(chainNonce), block_hash: hash };
      else if (body.method === "send_tx") {
        const raw = Buffer.from(body.params.signed_tx_base64, "base64");
        const idLen = raw.readUInt32LE(0);
        const nonce = raw.readBigUInt64LE(4 + idLen + 1 + 32);
        await new Promise((r) => setTimeout(r, 20)); // the FINAL wait
        if (nonce <= chainNonce) return new Response(JSON.stringify({ error: { name: "InvalidNonce" } }), { status: 200 });
        chainNonce = nonce;
        landed.push(nonce);
        result = { status: { SuccessValue: "" }, receipts_outcome: [] };
      } else result = {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200 });
    }) as unknown as typeof fetch;
    const chain = makeChain({ rpcUrl: "https://rpc.testnet.near.org", fetch: rpcFetch }, "s.testnet", ME, k.secret);
    const rs = await Promise.all(["a", "b", "c"].map((b) => chain.deliverKey(`${b}.testnet`, "00")));
    expect(rs.map((r) => r.ok)).toEqual([true, true, true]);
    expect(landed).toEqual([41n, 42n, 43n]);
  });
});

describe("M2 page cap at 49 / 50 / 51 sales", () => {
  for (const n of [49, 50, 51]) {
    it(`${n} escrowed sales are all delivered`, async () => {
      const pairs = await Promise.all(Array.from({ length: n }, () => generateKeyPair()));
      const f = fake(pairs.map((p, i) => sale({ buyer: `b${i}.testnet`, buyer_pubkey: p.publicKey })));
      const out = await mk(f.chain, 2000n).tick();
      expect(out.filter((o) => o.result === "delivered")).toHaveLength(n);
      expect(f.sent).toHaveLength(n);
    });
  }
});

describe("M3 window edges", () => {
  const withWindow = async (w: string, now: bigint) => {
    const kp = await generateKeyPair();
    const f = fake([sale({ buyer_pubkey: kp.publicKey })]);
    const chain: Chain = { ...f.chain, view: async (m, a) => (m === "get_key_params" ? { key_delivery_window_ns: w, deliverer: ME, sold: 1 } : f.chain.view(m, a)) };
    return { out: (await mk(chain, now).tick())[0]!, sent: f.sent.length };
  };
  it("window 0: closed at once, nothing sent", async () => {
    expect(await withWindow("0", 1000n)).toMatchObject({ out: { reason: "window closed" }, sent: 0 });
  });
  it("window u64::MAX: the deadline saturates like the contract and a sale is delivered", async () => {
    expect((await withWindow("18446744073709551615", 2000n)).out.result).toBe("delivered");
  });
  it("saturated deadline is still closed once the chain clock reaches u64::MAX", async () => {
    expect(await withWindow("18446744073709551615", (1n << 64n) - 1n)).toMatchObject({ out: { reason: "window closed" }, sent: 0 });
  });
});

describe("M4 a Released sale with a sealed key that is not ours", () => {
  const run = async (foreign: boolean) => {
    const kp = await generateKeyPair();
    const sales = [sale({ buyer_pubkey: kp.publicKey })];
    let ours = "";
    const chain: Chain = {
      now: async () => 0n,
      async view(m, a) {
        if (m === "get_key_params") return { key_delivery_window_ns: WINDOW.toString(), deliverer: ME, sold: 1 };
        if (m === "get_key_sales") return sales;
        return sales.find((s) => s.buyer === (a as { buyer: string }).buyer) ?? null;
      },
      async deliverKey(_b, sealed) {
        ours = sealed;
        sales[0]!.state = "Released";
        sales[0]!.sealed_key = foreign ? "cd".repeat(80) : sealed;
        return { ok: false, failure: "payout receipt failed" };
      },
    };
    return mk(chain, 2000n).tick().then((o) => ({ o, ours }));
  };
  it("ours: counted as delivered", async () => {
    expect((await run(false)).o).toEqual([{ buyer: "bob.testnet", result: "delivered" }]);
  });
  it("foreign: reported as failed, not delivered", async () => {
    expect((await run(true)).o).toEqual([{ buyer: "bob.testnet", result: "failed", reason: "released with a different sealed key" }]);
  });
});

describe("M5 the single-sale view must be the same buyer", () => {
  it("EC-K06: a view answering for another account is refused and nothing is sent", async () => {
    const kp = await generateKeyPair();
    const sent: string[] = [];
    const chain: Chain = {
      now: async () => 0n,
      async view(m) {
        if (m === "get_key_params") return { key_delivery_window_ns: WINDOW.toString(), deliverer: ME, sold: 1 };
        if (m === "get_key_sales") return [sale({ buyer: "alice.testnet", buyer_pubkey: kp.publicKey })];
        return sale({ buyer: "mallory.testnet", buyer_pubkey: kp.publicKey });
      },
      async deliverKey(b) { sent.push(b); return { ok: true, failure: null }; },
    };
    expect(await mk(chain, 2000n).tick()).toEqual([{ buyer: "alice.testnet", result: "failed", reason: "sale buyer mismatch between list and single-sale view" }]);
    expect(sent).toEqual([]);
  });
});

describe("the host clock is ignored", () => {
  it("with Date.now set far in the future or the past, the chain clock alone decides", async () => {
    const real = Date.now;
    try {
      for (const fakeNow of [0, 4_102_444_800_000]) {
        Date.now = () => fakeNow;
        const kp = await generateKeyPair();
        const f = fake([sale({ buyer_pubkey: kp.publicKey })]);
        expect((await mk(f.chain, 2000n).tick())[0]!.result).toBe("delivered"); // chain time well inside the window
        const g = fake([sale({ buyer_pubkey: kp.publicKey })]);
        expect((await mk(g.chain, 1000n + WINDOW).tick())[0]).toMatchObject({ reason: "window closed" });
      }
    } finally {
      Date.now = real;
    }
  });
});

describe("lows: margin, guard, inFlight after a throw", () => {
  it("negative margin is refused", () => {
    expect(() => mk(fake([]).chain, 0n, { marginNs: -1n })).toThrow("margin must be a non-negative bigint");
  });
  it("a throw releases the in-flight slot (next pass is not stuck on 'in flight')", async () => {
    const kp = await generateKeyPair();
    let throwOnce = true;
    const f = fake([sale({ buyer_pubkey: kp.publicKey })]);
    let clock = 2000n;
    const chain: Chain = { ...f.chain, now: async () => clock, view: async (m, a) => (m === "get_config" ? CONFIG : f.chain.view(m, a)),
      async deliverKey(b, s) { if (throwOnce) { throwOnce = false; throw new Error("boom"); } return f.chain.deliverKey(b, s); } };
    const d = new Deliverer({ chain, rulesKey: K, accountId: ME, strategyId: STRAT });
    expect((await d.tick())[0]).toMatchObject({ result: "failed", reason: "boom" });
    clock += 11_000_000_000n;
    expect((await d.tick())[0]).toMatchObject({ result: "delivered" });
  });
  it("assertTestnetRpc: lookalike hosts refused", () => {
    for (const bad of ["http://localhost.evil.com:3030", "http://127.0.0.1.evil.com", "https://evil.com/localhost", "http://localhost@evil.com", "ftp://localhost"]) {
      expect(() => assertTestnetRpc(bad)).toThrow(/^DELIVERER: /);
    }
  });
});

function rpcRig(opts: { sales: KeySale[]; clock: () => bigint; onSend?: (n: number, nonce: bigint) => Promise<Response | null> }) {
  const k = edKey();
  const hash = base58Encode(new Uint8Array(32).fill(9));
  let chainNonce = 40n;
  const landed: bigint[] = [];
  const nonceQueries: unknown[] = [];
  let sends = 0;
  const f = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body);
    let result: unknown;
    const val = (v: unknown) => ({ result: [...Buffer.from(JSON.stringify(v))], block_height: 1, block_hash: hash });
    if (body.method === "block") result = { header: { timestamp_nanosec: opts.clock().toString() } };
    else if (body.params.request_type === "view_access_key") { nonceQueries.push(body.params); result = { nonce: Number(chainNonce), block_hash: hash }; }
    else if (body.params.request_type === "call_function") {
      const m = body.params.method_name;
      const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString());
      result = val(m === "get_config" ? CONFIG : m === "get_key_params" ? { key_delivery_window_ns: WINDOW.toString(), deliverer: ME, sold: opts.sales.length }
        : m === "get_key_sales" ? opts.sales.slice(args.from_index, args.from_index + args.limit) : opts.sales.find((s) => s.buyer === args.buyer) ?? null);
    } else if (body.method === "send_tx") {
      const raw = Buffer.from(body.params.signed_tx_base64, "base64");
      const nonce = raw.readBigUInt64LE(4 + raw.readUInt32LE(0) + 1 + 32);
      const n = sends++;
      const custom = opts.onSend ? await opts.onSend(n, nonce) : null;
      if (custom) return custom;
      if (nonce <= chainNonce) return new Response(JSON.stringify({ error: { name: "InvalidNonce" } }), { status: 200 });
      chainNonce = nonce; landed.push(nonce);
      result = { status: { SuccessValue: "" }, receipts_outcome: [] };
    } else result = {};
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200 });
  }) as unknown as typeof fetch;
  const chain = makeChain({ rpcUrl: "https://rpc.testnet.near.org", fetch: f }, STRAT, ME, k.secret);
  const d = new Deliverer({ chain, rulesKey: K, accountId: ME, strategyId: STRAT });
  return { d, landed, nonceQueries, sends: () => sends };
}

describe("EC-K08: the deadline margin is re-judged inside the send queue", () => {
  it("a slow first send advances the chain clock into the second sale's margin: the second is skipped, not sent", async () => {
    const [a, b] = await Promise.all([generateKeyPair(), generateKeyPair()]);
    const sales = [sale({ buyer: "a.testnet", buyer_pubkey: a.publicKey, bought_at_ns: "1000" }), sale({ buyer: "b.testnet", buyer_pubkey: b.publicKey, bought_at_ns: "10000001000" })];
    const deadlineB = 10_000_001_000n + WINDOW;
    let clock = 1000n + WINDOW - 60_000_000_000n; // 60 s before A's deadline: both are fine at the first look
    const r = rpcRig({ sales, clock: () => clock, onSend: async (n) => { if (n === 0) clock = deadlineB - 5_000_000_000n; return null; } });
    const out = await r.d.tick();
    expect(out).toEqual([{ buyer: "a.testnet", result: "delivered" }, { buyer: "b.testnet", result: "skipped", reason: "too close to deadline" }]);
    expect(r.sends()).toBe(1);
  });
  it("the sale with the earlier deadline is sent first even when listed second", async () => {
    const [a, b] = await Promise.all([generateKeyPair(), generateKeyPair()]);
    const sales = [sale({ buyer: "late.testnet", buyer_pubkey: a.publicKey, bought_at_ns: "5000" }), sale({ buyer: "early.testnet", buyer_pubkey: b.publicKey, bought_at_ns: "1000" })];
    const order: string[] = [];
    const r = rpcRig({ sales, clock: () => 2000n, onSend: async (_n, _nonce) => null });
    const orig = r.d["o"].chain.deliverKey;
    r.d["o"].chain.deliverKey = async (buyer, s, p) => { order.push(buyer); return orig(buyer, s, p); };
    await r.d.tick();
    expect(order).toEqual(["early.testnet", "late.testnet"]);
  });
});

describe("EC-K07b: a failed send does not poison the nonce stream", () => {
  it("the first send_tx fails with HTTP 500; the next two still land with nonces 41 and 42, read at final", async () => {
    const ps = await Promise.all([0, 1, 2].map(() => generateKeyPair()));
    const sales = ps.map((p, i) => sale({ buyer: `b${i}.testnet`, buyer_pubkey: p.publicKey, bought_at_ns: String(1000 + i) }));
    const r = rpcRig({ sales, clock: () => 2000n, onSend: async (n) => (n === 0 ? new Response("boom", { status: 500 }) : null) });
    const out = await r.d.tick();
    expect(out.map((o) => o.result)).toEqual(["failed", "delivered", "delivered"]);
    expect(r.landed).toEqual([41n, 42n]);
    expect(r.nonceQueries.length).toBe(3);
    for (const q of r.nonceQueries) expect((q as { finality: string }).finality).toBe("final");
  });
});
