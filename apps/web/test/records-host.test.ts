import { describe, expect, it } from "vitest";
import { chainHead, decisionHash } from "@poolside/rules";
import { buildFixture } from "../src/lib/fixtures.ts";
import { hostLookup, recordUrl, recordsBases, recordsConfig, recordsOrigins, MAX_RECORD_BYTES } from "../src/lib/records-host.ts";
import { checkRun } from "../src/lib/run.ts";
import { recordedProvider } from "../src/lib/provider.ts";

type Res = { ok: boolean; status: number; text(): Promise<string> };
const res = (status: number, body = ""): Res => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const row = (rows: Awaited<ReturnType<typeof checkRun>>, start: string) => rows.find((r) => r.title.startsWith(start))!;
const A = "https://a.example/";
const B = "https://b.example/records";

type Over = Record<string, Res | "throw">; // key: "<host>|<hash>"
function net(f: ReturnType<typeof buildFixture>, over: Over = {}) {
  const calls: string[] = [];
  const fetchFn = async (url: string): Promise<Res> => {
    calls.push(url);
    const host = new URL(url).hostname;
    const hash = url.split("/").pop()!.replace(".txt", "");
    const o = over[`${host}|${hash}`] ?? over[`${host}|*`];
    if (o === "throw") throw new Error("network");
    if (o) return o;
    const text = f.log.get(hash);
    return text === undefined ? res(404) : res(200, text);
  };
  return { fetchFn, calls };
}
const run = (f: ReturnType<typeof buildFixture>, bases: string[], over: Over = {}) => checkRun({ ...f.source, decisionText: hostLookup(bases, net(f, over).fetchFn) });
const firstHash = (f: ReturnType<typeof buildFixture>) => [...f.log.keys()][0]!;

describe("the records host (untrusted, content-addressed): EC-W05", () => {
  it("match: a body whose SHA-256 equals the decision_hash is accepted", async () => {
    const f = buildFixture("good");
    const rows = await run(f, [A]);
    expect(rows.filter((r) => r.title.startsWith("Action ")).map((r) => r.verdict)).toEqual(["matching", "matching"]);
  });
  it("EC-W05 mismatch: the same wrong body from two hosts is tampering, not matching", async () => {
    const f = buildFixture("good");
    const h = firstHash(f);
    const rows = await run(f, [A, B], { [`a.example|${h}`]: res(200, "{}"), [`b.example|${h}`]: res(200, "{}") });
    expect(row(rows, "Action 1").verdict).toBe("not_matching");
    expect(row(rows, "Action 1").text).toBe("The decision record does not match its hash.");
  });
  it("one host cannot convict: a wrong body, or a 404, from a single host is Unverifiable", async () => {
    const f = buildFixture("good");
    const h = firstHash(f);
    for (const o of [res(200, "{}"), res(404)]) {
      const rows = await run(f, [A], { [`a.example|${h}`]: o });
      expect(row(rows, "Action 1").verdict).toBe("unverifiable");
      expect(row(rows, "Action 1").text).toBe("Can't check: the records host is not configured, or only one host is. One host cannot show that a record was never published.");
    }
  });
  it("EC-W05 missing: a 404 from two hosts is not published, not matching", async () => {
    const f = buildFixture("good");
    const h = firstHash(f);
    const rows = await run(f, [A, B], { [`a.example|${h}`]: res(404), [`b.example|${h}`]: res(404) });
    expect(row(rows, "Action 1").verdict).toBe("not_matching");
    expect(row(rows, "Action 1").text).toBe("The decision record is not published.");
  });
  it("no host configured (RECORDS_BASE_URLS unset): Unverifiable, never an accusation", async () => {
    const rows = await run(buildFixture("good"), []);
    expect(row(rows, "Action 1").verdict).toBe("unverifiable");
    expect(row(rows, "Action 1").text).toBe("Can't check: the records host is not configured, or only one host is. One host cannot show that a record was never published.");
  });
  it("fetch failure (network error, 5xx, too large) with a second host that says 404 is unverifiable, never matching and never 'not published'", async () => {
    const f = buildFixture("good");
    const h = firstHash(f);
    for (const o of ["throw", res(503), res(200, "x".repeat(MAX_RECORD_BYTES + 1))] as const) {
      const rows = await run(f, [A, B], { [`a.example|${h}`]: o, [`b.example|${h}`]: res(404) });
      expect(row(rows, "Action 1").verdict).toBe("unverifiable");
      expect(row(rows, "Action 1").text).toBe("Can't check: the decision records could not be fetched.");
    }
  });
  it("only the content-addressed URL is read: <base>/<hash>.txt, and a non-hex hash never reaches a host", async () => {
    const f = buildFixture("good");
    const n = net(f);
    const h = firstHash(f);
    expect(await hostLookup([B], n.fetchFn)(h)).toBe(f.log.get(h));
    expect(n.calls).toEqual([`https://b.example/records/${h}.txt`]);
    expect(await hostLookup([A], n.fetchFn)("../../etc/passwd")).toBeNull();
    expect(n.calls).toHaveLength(1);
    expect(recordUrl("javascript:alert(1)", h)).toBeNull();
  });
});

describe("two hosts", () => {
  it("a verifying body wins over a wrong body, a 404 and a failure", async () => {
    const f = buildFixture("good");
    const h = firstHash(f);
    for (const bad of [res(200, "{}"), res(404), res(503), "throw"] as const) {
      const rows = await run(f, [A, B], { [`b.example|${h}`]: bad });
      expect(row(rows, "Action 1").verdict).toBe("matching");
    }
  });
  it("two wrong bodies that disagree are unverifiable; a wrong body from one host and a 404 from the other is unverifiable too", async () => {
    const f = buildFixture("good");
    const h = firstHash(f);
    let rows = await run(f, [A, B], { [`a.example|${h}`]: res(200, "x"), [`b.example|${h}`]: res(200, "y") });
    expect(row(rows, "Action 1").verdict).toBe("unverifiable");
    rows = await run(f, [A, B], { [`a.example|${h}`]: res(200, "x"), [`b.example|${h}`]: res(404) });
    expect(row(rows, "Action 1").verdict).toBe("unverifiable");
  });
  it("a 404 on one host and a failure on the other is unverifiable; a 404 on both is not published", async () => {
    const f = buildFixture("good");
    const h = firstHash(f);
    let rows = await run(f, [A, B], { [`a.example|${h}`]: res(404), [`b.example|${h}`]: res(503) });
    expect(row(rows, "Action 1").verdict).toBe("unverifiable");
    rows = await run(f, [A, B], { [`a.example|${h}`]: res(404), [`b.example|${h}`]: res(404) });
    expect(row(rows, "Action 1").text).toBe("The decision record is not published.");
  });
});

describe("configuration from the environment", () => {
  it("RECORDS_BASE_URLS: comma-separated http(s) URLs; anything else is dropped; unset is no host", () => {
    expect(recordsBases({})).toEqual([]);
    expect(recordsBases({ RECORDS_BASE_URLS: "https://a.example/, javascript:alert(1), nonsense, http://b.example:8080/x" })).toEqual(["https://a.example/", "http://b.example:8080/x"]);
    expect(recordsOrigins({ RECORDS_BASE_URLS: "https://a.example/x,https://a.example/y,http://b.example:8080/z" })).toEqual(["https://a.example", "http://b.example:8080"]);
  });
});

describe("the decision chain: each head follows from the one before and the decision hash (EC-R32)", () => {
  const hashes = (f: ReturnType<typeof buildFixture>) => [...f.log.keys()];
  const heads = (hs: string[]) => { const out: string[] = []; let p: string | null = null; for (const h of hs) { p = chainHead(p, h); out.push(p); } return out; };
  const withHeads = (f: ReturnType<typeof buildFixture>, hs: (string | null)[]) => {
    const m = (x: (typeof f.files)[number]) => {
      let i = 0;
      return { ...x, responses: x.responses.map((r) => {
        if (r.method !== "get_action") return r;
        const h = hs[i++];
        return { ...r, text: r.text.replace('"chain_head":null', h === null ? '"chain_head":null' : `"chain_head":"${h}"`) };
      }) };
    };
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) };
  };
  it("no heads recorded: no chain row", async () => {
    const rows = await checkRun(buildFixture("good").source);
    expect(rows.some((r) => r.title.includes("chain"))).toBe(false);
  });
  it("heads that follow: matching", async () => {
    const f = buildFixture("good");
    expect(row(await checkRun(withHeads(f, heads(hashes(f)))), "The decision log chain").verdict).toBe("matching");
  });
  it("a head that does not follow from the previous head and the hash: not matching", async () => {
    const f = buildFixture("good");
    const bad = heads(hashes(f)); bad[1] = "2".repeat(64);
    expect(row(await checkRun(withHeads(f, bad)), "The decision log chain").text).toBe("Action 2's chain head does not follow from the previous head and its decision.");
  });
  it("a first head that does not start from null: not matching", async () => {
    const f = buildFixture("good");
    const bad = heads(hashes(f)); bad[0] = "3".repeat(64);
    expect(row(await checkRun(withHeads(f, bad)), "The decision log chain").verdict).toBe("not_matching");
  });
  it("heads on some records only: unverifiable, never matching", async () => {
    const f = buildFixture("good");
    expect(row(await checkRun(withHeads(f, [null, heads(hashes(f))[1]!])), "The decision log chain").verdict).toBe("unverifiable");
  });
});

describe("fetch policy of the records host (EC-W05, T77)", () => {
  const H = "d".repeat(64);
  const text = (n: number, ch = "x") => ch.repeat(n);
  it("the size cap counts UTF-8 bytes: exactly MAX_RECORD_BYTES is read, one more is a failed read", async () => {
    const ok = text(MAX_RECORD_BYTES);
    const over = text(MAX_RECORD_BYTES + 1);
    expect(await hostLookup([A], async () => res(200, ok))(decisionHash(ok))).toBe(ok); // a verifying body is accepted from one host
    expect(await hostLookup([A], async () => res(200, over))(H)).toMatchObject({ failed: true });
    // 6,000 three-byte characters are under 16,384 UTF-16 units but 18,000 bytes: over the cap in bytes
    expect(await hostLookup([A], async () => res(200, text(6000, "€")))(H)).toMatchObject({ failed: true });
  });
  it("the body is read as a stream and stopped at the cap, never read whole", async () => {
    let read = 0, cancelled = false;
    const chunk = new Uint8Array(4096).fill(120);
    const body = { getReader: () => ({ read: async () => { read++; return read > 1000 ? { done: true } : { done: false, value: chunk }; }, cancel: async () => { cancelled = true; } }) };
    const r = await hostLookup([A], async () => ({ ok: true, status: 200, text: async () => { throw new Error("text() must not be used"); }, body }))(H);
    expect(r).toMatchObject({ failed: true });
    expect(cancelled).toBe(true);
    expect(read).toBeLessThanOrEqual(6);
  });
  it("redirects are errors, credentials are omitted, and a rejected redirect is a failed read", async () => {
    let init: Record<string, unknown> = {};
    await hostLookup([A], async (_u, i) => { init = (i ?? {}) as Record<string, unknown>; return res(404); })(H);
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");
    expect(await hostLookup([A], async () => { throw new TypeError("redirect mode is set to error"); })(H)).toMatchObject({ failed: true });
  });
  it("the abort timer ends a hung request as a failed read", async () => {
    const hang = (_u: string, i?: { signal?: AbortSignal }) => new Promise<Res>((_ok, bad) => i?.signal?.addEventListener("abort", () => bad(new Error("aborted"))));
    expect(await hostLookup([A], hang, { timeoutMs: 20 })(H)).toMatchObject({ failed: true });
  });
  it("a URL with credentials, or a non-http(s) one, is never fetched", async () => {
    expect(recordUrl("https://user:pw@a.example/", H)).toBeNull();
    expect(recordUrl("ftp://a.example/", H)).toBeNull();
    expect(recordsBases({ RECORDS_BASE_URLS: "https://u:p@a.example/, https://ok.example/" })).toEqual(["https://ok.example/"]);
  });
  it("a set but unusable RECORDS_BASE_URLS is misconfigured: a failed read, never 'not published'", async () => {
    expect(recordsConfig({})).toEqual({ bases: [], misconfigured: false });
    expect(recordsConfig({ RECORDS_BASE_URLS: "  " })).toEqual({ bases: [], misconfigured: false });
    const c = recordsConfig({ RECORDS_BASE_URLS: "htp://typo, nonsense" });
    expect(c).toEqual({ bases: [], misconfigured: true });
    expect(await hostLookup(c.bases, async () => res(404), { misconfigured: c.misconfigured })(H)).toMatchObject({ failed: true });
  });
  it("one run has a total time budget that starts at the FIRST read, not at creation", async () => {
    let t = 0;
    const look = hostLookup([A, B], async () => res(404), { budgetMs: 100, now: () => t });
    t = 5000; // created long before use: the clock must not have started
    expect(await look(H)).toBeNull();
    t = 5100;
    expect(await look(H)).toBeNull(); // exactly at the deadline is still inside it
    t = 5101;
    expect(await look(H)).toMatchObject({ failed: true });
  });
});

describe("chain resync: heads on records 1 and 3 but not 2 (EC-R32)", () => {
  it("is unverifiable: the link into the third record can't be checked, never matching", async () => {
    const f = buildFixture("paired-open");
    const hs = [...f.log.keys()];
    const h0 = chainHead(null, hs[0]!);
    const h2 = chainHead(h0, hs[1]!);
    const heads = [h0, null, h2];
    const m = (x: (typeof f.files)[number]) => {
      let i = 0;
      return { ...x, responses: x.responses.map((r) => (r.method === "get_action" ? { ...r, text: heads[i] === undefined || heads[i++] === null ? r.text : r.text.replace('"chain_head":null', `"chain_head":"${heads[i - 1]}"`) } : r)) };
    };
    const rows = await checkRun({ ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) });
    expect(row(rows, "The decision log chain").verdict).toBe("unverifiable");
  });
});
