import { describe, expect, it } from "vitest";
import { parseRecordedFile, readBoth, recordedProvider, type ViewRequest } from "../src/lib/provider.ts";

const REQ: ViewRequest = { account: "steady.strat-12.near", method: "get_status", args: {}, block: 100 };
const file = (provider: string, responses: unknown[]) => parseRecordedFile(JSON.stringify({ provider, run: "good", responses }));
const resp = (text: string, o: Record<string, unknown> = {}) => ({ account: REQ.account, method: REQ.method, args: {}, block: 100, text, ...o });

describe("recorded provider", () => {
  it("replays the response for the exact account, method, args and block", async () => {
    const p = recordedProvider(file("a", [resp('"Open"')]));
    expect(await p.view(REQ)).toEqual({ ok: true, value: '"Open"' });
  });
  it("a request it holds no response for is a failed read, never a guess", async () => {
    const p = recordedProvider(file("a", [resp('"Open"')]));
    expect(await p.view({ ...REQ, block: 101 })).toEqual({ ok: false });
    expect(await p.view({ ...REQ, method: "get_principal" })).toEqual({ ok: false });
    expect(await p.view({ ...REQ, account: "other.near" })).toEqual({ ok: false });
    expect(await p.view({ ...REQ, args: { x: 1 } })).toEqual({ ok: false });
  });
  it("argument key order does not matter", async () => {
    const p = recordedProvider(file("a", [resp("1", { method: "get_actions", args: { from: "0", limit: 5 } })]));
    expect((await p.view({ ...REQ, method: "get_actions", args: { limit: 5, from: "0" } })).ok).toBe(true);
  });
});

describe("fixture files are read strictly", () => {
  it.each([
    ["not an object", "[]"],
    ["no responses", '{"provider":"a","run":"good"}'],
    ["a duplicate key", '{"provider":"a","provider":"b","run":"good","responses":[]}'],
    ["a fractional block", JSON.stringify({ provider: "a", run: "g", responses: [resp("1", { block: 1.5 })] })],
    ["a negative block", JSON.stringify({ provider: "a", run: "g", responses: [resp("1", { block: -1 })] })],
    ["a missing text", JSON.stringify({ provider: "a", run: "g", responses: [{ account: "x", method: "m", args: {}, block: 1 }] })],
    ["the same request twice", JSON.stringify({ provider: "a", run: "g", responses: [resp("1"), resp("2")] })],
  ])("refuses %s", (_n, text) => {
    expect(() => parseRecordedFile(text)).toThrow(/^(STATE|JSON_)/);
  });
});

describe("readBoth (EC-W08)", () => {
  const a = (t: string) => recordedProvider(file("a", [resp(t)]));
  const b = (t: string) => recordedProvider(file("b", [resp(t)]));
  it("agreement gives the value", async () => {
    expect(await readBoth(a('"Open"'), b('"Open"'), REQ)).toEqual({ kind: "agreed", value: '"Open"' });
  });
  it("the same JSON with different spacing or key order agrees", async () => {
    expect((await readBoth(a('{"x":1,"y":2}'), b('{ "y": 2, "x": 1 }'), REQ)).kind).toBe("agreed");
  });
  it("different answers disagree, and the page treats that as unverifiable", async () => {
    expect(await readBoth(a('"Open"'), b('"Running"'), REQ)).toEqual({ kind: "disagree" });
  });
  it("one provider without the response is a failed read", async () => {
    const empty = recordedProvider(file("b", []));
    expect(await readBoth(a('"Open"'), empty, REQ)).toEqual({ kind: "failed" });
    expect(await readBoth(empty, a('"Open"'), REQ)).toEqual({ kind: "failed" });
  });
  it("text that can't be read never counts as agreement, even if identical", async () => {
    expect(await readBoth(a('{"x":1,"x":2}'), b('{"x":1,"x":2}'), REQ)).toEqual({ kind: "disagree" });
    expect(await readBoth(a("1e2"), b("1e2"), REQ)).toEqual({ kind: "disagree" });
  });
});
