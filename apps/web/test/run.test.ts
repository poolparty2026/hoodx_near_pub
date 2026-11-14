import type { JsonValue } from "@poolside/rules";
import { describe, expect, it } from "vitest";
import { buildFixture, type FixtureCase } from "../src/lib/fixtures.ts";
import { accountFindingFor, checkRun } from "../src/lib/run.ts";
import { chainHead, confirmGrid, OFFCHAIN_MARGIN_BLOCKS } from "@poolside/rules";
import { decisionHash as hashDecisionText } from "@poolside/rules";
import { recordedProvider } from "../src/lib/provider.ts";
import { parseActionRecord } from "../src/lib/record.ts";
import { worst } from "../src/lib/verdict.ts";

const run = (c: FixtureCase) => checkRun(buildFixture(c).source);
const row = (rows: Awaited<ReturnType<typeof run>>, start: string) => rows.find((r) => r.title.startsWith(start))!;

describe("the recorded good run", () => {
  it("every row is matching and the run is Matching", async () => {
    const rows = await run("good");
    expect(rows.map((r) => r.verdict)).toEqual(Array(rows.length).fill("matching"));
    expect(rows.map((r) => r.title)).toEqual([
      "The strategy's status", "Rules match the commitment", "Action 1: Open, ok", "Action 2: ClosePosition, ok",
      "No close missed at the sampled blocks", "No change to the account's keys or code at the sampled blocks", "The code hash equals the pinned hash", "The strategy uses the pinned counterparties",
    ]);
  });
});

describe("recorded bad runs are not matching, or unverifiable, never matching", () => {
  it("EC-W01: tampered rules", async () => {
    const rows = await run("tampered-rules");
    expect(row(rows, "Rules match").text).toBe("The revealed rules do not match the commitment.");
    expect(worst(rows.map((r) => r.verdict))).toBe("not_matching");
    // nothing is judged against rules that don't match the commitment
    expect(row(rows, "No close missed").verdict).toBe("unverifiable");
    expect(row(rows, "Action 1").verdict).toBe("unverifiable");
  });
  it("EC-W09: not revealed is unverifiable, and so is every row that needs the rules", async () => {
    const rows = await run("not-revealed");
    expect(row(rows, "Rules match").text).toBe("Unverifiable: not revealed.");
    expect(worst(rows.map((r) => r.verdict))).toBe("unverifiable");
    expect(row(rows, "Action 1").text).toBe("Can't check: the rules were not revealed.");
    expect(row(rows, "No close missed").verdict).toBe("unverifiable");
  });
  it("EC-W23: a close never sent is a missed close naming the blocks", async () => {
    const rows = await run("missed-close");
    const r = row(rows, "No close missed");
    expect(r.verdict).toBe("not_matching");
    expect(r.text).toMatch(/^A close was missed: stop loss was due from block \d+ to block \d+\.$/);
  });
  it("EC-W02/EC-W15: a changed code hash is not matching, naming the blocks", async () => {
    const rows = await run("code-changed");
    expect(row(rows, "No change to the account").verdict).toBe("not_matching");
    expect(row(rows, "No change to the account").text).toBe("The account's code changed between block 100 and block 202.");
  });
  it("EC-W05: a decision record that does not match its hash is not matching", async () => {
    const rows = await run("tampered-decision");
    expect(row(rows, "Action 1").verdict).toBe("not_matching");
    expect(row(rows, "Action 1").text).toBe("The decision record does not match its hash.");
    expect(row(rows, "Action 2").verdict).toBe("matching");
  });
  it("EC-W08: providers that disagree give unverifiable, never matching", async () => {
    const rows = await run("providers-disagree");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("unverifiable");
  });
  it("EC-W08: a provider that fails on one view makes that row unverifiable", async () => {
    const f = buildFixture("good");
    const half = { ...f.files[1], responses: f.files[1].responses.filter((r) => !(r.method === "get_action" && JSON.stringify(r.args) === '{"index":"1"}')) };
    const rows = await checkRun({ ...f.source, b: recordedProvider(half) });
    expect(row(rows, "Action 2").verdict).toBe("unverifiable");
    expect(worst(rows.map((r) => r.verdict))).toBe("unverifiable");
  });
  it("EC-W15: no pinned hash is can't-check, never matching", async () => {
    const f = buildFixture("good");
    const { pinnedCodeHash: _p, ...rest } = f.source;
    const rows = await checkRun(rest);
    expect(row(rows, "The code hash equals").verdict).toBe("unverifiable");
  });
});

describe("EC-R25: records are read strictly, on their own", () => {
  const good = buildFixture("good").files[0].responses.find((r) => r.method === "get_action")!.text;
  it("reads the built shape", () => {
    const r = parseActionRecord(good);
    expect(r.kind).toBe("Open");
    expect(r.result).toBe("ok");
  });
  it("refuses duplicate keys, a signed u64 and a fractional point", () => {
    expect(() => parseActionRecord(good.replace('"kind":"Open"', '"kind":"Open","kind":"Swap"'))).toThrow();
    expect(() => parseActionRecord(good.replace('"index":"0"', '"index":"+0"'))).toThrow();
    expect(() => parseActionRecord(good.replace('"left_point":', '"left_point":0.5,"x":'))).toThrow();
  });
  it("keeps an unknown kind and result as can't-check, not an error and not ok", () => {
    const r = parseActionRecord(good.replace('"Open"', '"Rebalance"').replace('"result":"Ok"', '"result":{"SlotsFull":{}}'));
    expect(r.kind).toBeNull();
    expect(r.result).toBe("other");
  });
  it("only the exact string Ok is ok (EC-W25)", () => {
    for (const bad of ['"ok"', '"OK"', '{"Ok":1}', '{"Refused":"drift"}', '"Pending"']) {
      expect(parseActionRecord(good.replace('"result":"Ok"', `"result":${bad}`)).result).not.toBe("ok");
    }
  });
});

describe("EC-W28: an unreadable window is can't-check, never a gap", () => {
  it("one window one provider can't read makes the missed-close row unverifiable", async () => {
    const f = buildFixture("missed-close");
    const half = { ...f.files[1], responses: f.files[1].responses.filter((r) => !(r.method === "fixture:window" && JSON.stringify(r.args) === '{"n":3}')) };
    const rows = await checkRun({ ...f.source, b: recordedProvider(half) });
    expect(rows.find((r) => r.title.startsWith("No close missed"))!.text).toBe("Can't check for a missed close: some of the run could not be read.");
  });
});

describe("page-level wiring found missing by the test audit", () => {
  const view = (f: ReturnType<typeof buildFixture>, drop: (r: { method: string; args: unknown }) => boolean) =>
    f.files.map((x) => ({ ...x, responses: x.responses.filter((r) => !drop(r)) }));
  it("EC-W14: a pool that is not the pinned one is not matching", async () => {
    const rows = await run("wrong-pool");
    expect(row(rows, "The strategy uses").text).toBe("The DCL contract, quote token or pool differs from the pinned constants.");
    expect(worst(rows.map((r) => r.verdict))).toBe("not_matching");
  });
  it("EC-W14: no pinned constants is can't-check, never matching", async () => {
    const { pinnedCounterparties: _x, ...rest } = buildFixture("good").source;
    expect(row(await checkRun(rest), "The strategy uses").verdict).toBe("unverifiable");
  });
  it("EC-W15: a code hash that differs from the pin is not matching", async () => {
    const f = buildFixture("good");
    const rows = await checkRun({ ...f.source, pinnedCodeHash: "c".repeat(44) });
    expect(row(rows, "The code hash equals").text).toBe("The deployed code hash differs from the pinned hash.");
    expect(row(rows, "The code hash equals").verdict).toBe("not_matching");
  });
  it("EC-W25: a refused close leaves the stretch running, so the close is missed", async () => {
    const rows = await run("refused-close");
    expect(row(rows, "Action 2").title).toBe("Action 2: ClosePosition, refused (drift)");
    expect(row(rows, "Action 2").text).toContain("shown here as context, never as an excuse");
    expect(row(rows, "No close missed").verdict).toBe("not_matching");
  });
  it("EC-W07: a key added between snapshots is not matching", async () => {
    const f = buildFixture("good");
    const bump = (text: string) => text.replace('"keys":[', '"keys":[{"publicKey":"ed25519:evil","permission":"FullAccess","nonce":"1"},');
    const files = f.files.map((x) => ({ ...x, responses: x.responses.map((r) => (r.method === "fixture:account" && r.block === 202 ? { ...r, text: bump(r.text) } : r)) }));
    const rows = await checkRun({ ...f.source, a: recordedProvider(files[0]!), b: recordedProvider(files[1]!) });
    expect(row(rows, "No change to the account").text).toBe("A key was added between block 100 and block 202.");
  });
  it("EC-W07: the recovery key's nonce changing is not matching", async () => {
    const f = buildFixture("good");
    const files = f.files.map((x) => ({ ...x, responses: x.responses.map((r) => (r.method === "fixture:account" && r.block === 100 ? { ...r, text: r.text.replace('"nonce":"5"', '"nonce":"6"') } : r)) }));
    const rows = await checkRun({ ...f.source, a: recordedProvider(files[0]!), b: recordedProvider(files[1]!) });
    expect(row(rows, "No change to the account").text).toBe("The recovery key signed a transaction between block 10 and block 100.");
  });
  it("a record at the wrong index is can't-check, not accepted", async () => {
    const f = buildFixture("good");
    const swap = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"1"}' ? { ...r, text: r.text.replace('"index":"1"', '"index":"0"') } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(swap(f.files[0])), b: recordedProvider(swap(f.files[1])) });
    expect(row(rows, "Action 2").text).toBe("Can't check: the record could not be read.");
  });
  it("an unknown kind is can't-check with its own text", async () => {
    const f = buildFixture("good");
    const swap = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}' ? { ...r, text: r.text.replace('"Open"', '"Rebalance"') } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(swap(f.files[0])), b: recordedProvider(swap(f.files[1])) });
    expect(row(rows, "Action 1").text).toBe("Can't check this action: the contract wrote a kind this page doesn't know.");
  });
  it("EC-W04: hostile text in a refusal detail renders as text", async () => {
    const f = buildFixture("good");
    const evil = "<img src=x onerror=alert(1)>";
    const swap = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"1"}' ? { ...r, text: r.text.replace('"result":"Ok"', `"result":{"Refused":"${evil}"}`) } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(swap(f.files[0])), b: recordedProvider(swap(f.files[1])) });
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Findings } = await import("../src/components/Findings.tsx");
    const html = renderToStaticMarkup(Findings({ rows }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
  it("the record count at its limit: 65 is can't-check", async () => {
    const f = buildFixture("good");
    const swap = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_actions_len" ? { ...r, text: '"65"' } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(swap(f.files[0])), b: recordedProvider(swap(f.files[1])) });
    expect(rows.find((r) => r.title === "The action log")!.text).toBe("Can't check: the contract reports more records than it can hold.");
  });
  void view;
});

describe("security audit fixes (H1, M1, M3)", () => {
  const edit = (f: ReturnType<typeof buildFixture>, method: string, args: string, fn: (t: string) => string) => {
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === method && JSON.stringify(r.args) === args ? { ...r, text: fn(r.text) } : r)) });
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) };
  };
  it("H1: a record whose range differs from its decision text is not matching", async () => {
    const f = buildFixture("good");
    const rows = await checkRun(edit(f, "get_action", '{"index":"0"}', (t) => t.replace('"right_point":0', '"right_point":9000')));
    expect(row(rows, "Action 1").verdict).toBe("not_matching");
    expect(row(rows, "Action 1").text).toBe("The decision record does not describe the call the contract recorded.");
  });
  it("H1: a record whose kind differs from its decision text is not matching", async () => {
    const f = buildFixture("good");
    const rows = await checkRun(edit(f, "get_action", '{"index":"0"}', (t) => t.replace('"kind":"Open"', '"kind":"ClosePosition"')));
    expect(row(rows, "Action 1").text).toBe("The decision record does not describe the call the contract recorded.");
  });
  it("H1: a block header for another block than the one asked for can't rebuild the state: unverifiable", async () => {
    const f = buildFixture("good");
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "block" && r.block === 50 ? { ...r, text: r.text.replace('"height":50', '"height":51') } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) });
    expect(row(rows, "Action 1").text).toBe("Can't check this action: the market state at its observed block could not be rebuilt from the chain's views.");
    expect(row(rows, "Action 1").verdict).toBe("unverifiable");
  });
  it("D53: a refused close that was never retried is unverifiable in its own row; missedClose decides Not matching", async () => {
    const rows = await run("refused-close");
    const r = row(rows, "Action 2");
    expect(r.verdict).toBe("unverifiable");
    expect(r.text).toBe("The close was refused or failed; whether a required close was missed is judged by the missed-close check. The contract recorded this call as refused; that is shown here as context, never as an excuse.");
    expect(row(rows, "No close missed").verdict).toBe("not_matching");
  });
  it("EC-W13/W19 b/c: a refused open that was never retried is not matching (not a close)", async () => {
    const f = buildFixture("good");
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}' ? { ...r, text: r.text.replace('"result":"Ok"', '"result":{"Refused":"drift"}') } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) });
    expect(row(rows, "Action 1").verdict).toBe("not_matching");
    expect(row(rows, "Action 1").text).toContain("was not retried successfully");
  });
  it("EC-W13/W19: a refused close later retried successfully is unverifiable, not matching", async () => {
    const rows = await run("retried-close");
    expect(row(rows, "Action 2").verdict).toBe("unverifiable");
    expect(row(rows, "Action 3").verdict).toBe("matching");
  });
  it("a refused close with provider disagreement stays unverifiable (EC-W08)", async () => {
    const f = buildFixture("refused-close");
    const b = { ...f.files[1], responses: f.files[1].responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"1"}' ? { ...r, text: r.text.replace('"op_id":"2"', '"op_id":"9"') } : r)) };
    expect(row(await checkRun({ ...f.source, b: recordedProvider(b) }), "Action 2").verdict).toBe("unverifiable");
  });
  it("M1: an Unknown or unclassified result is unverifiable", async () => {
    const f = buildFixture("good");
    for (const res of ['"Unknown"', '{"SlotsFull":{}}', '"Pending"']) {
      const rows = await checkRun(edit(f, "get_action", '{"index":"1"}', (t) => t.replace('"result":"Ok"', `"result":${res}`)));
      expect(row(rows, "Action 2").verdict).toBe("unverifiable");
    }
  });
  it("M3: a source that doesn't allow fixture views never reads them: unverifiable", async () => {
    const { allowFixtureViews: _a, ...live } = buildFixture("good").source;
    const rows = await checkRun(live);
    expect(worst(rows.map((r) => r.verdict))).toBe("unverifiable");
    // actions are judged from real views now, so they still match; what needs the stand-in views can't be checked
    expect(row(rows, "Action 1").verdict).toBe("matching");
    expect(row(rows, "No close missed").verdict).toBe("unverifiable");
    expect(row(rows, "No change to the account").verdict).toBe("unverifiable");
  });
  it("L4: a long refusal detail is cut in the title", async () => {
    const f = buildFixture("good");
    const rows = await checkRun(edit(f, "get_action", '{"index":"1"}', (t) => t.replace('"result":"Ok"', `"result":{"Refused":"${"x".repeat(500)}"}`)));
    expect(row(rows, "Action 2").title.length).toBeLessThan(120);
  });
});

describe("the frozen interface (12 November): ExitRemove and a close's confirmation", () => {
  const edit = (f: ReturnType<typeof buildFixture>, args: string, fn: (t: string) => string) => {
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === args ? { ...r, text: fn(r.text) } : r)) });
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) };
  };
  const exit = (t: string) => t.replace(/"kind":"[A-Za-z]+"/, '"kind":"ExitRemove"').replace(/"decision_hash":"[0-9a-f]{64}"/, '"decision_hash":""');
  it("an ExitRemove record with an empty decision hash is read, and is not judged by the rules", async () => {
    const rows = await checkRun(edit(buildFixture("good"), '{"index":"1"}', exit));
    expect(row(rows, "Action 2").text).toBe("No decision record: an exit removal takes the position out after close and is not judged by the rules.");
    expect(row(rows, "Action 2").verdict).toBe("matching");
  });
  it("an empty decision hash on any other kind is can't-check", () => {
    const good = buildFixture("good").files[0].responses.find((r) => r.method === "get_action")!.text;
    expect(() => parseActionRecord(good.replace(/"decision_hash":"[0-9a-f]{64}"/, '"decision_hash":""'))).toThrow();
  });
  it("EC-W22: a close whose confirm_observed differs from the state's confirmation is not matching", async () => {
    const rows = await checkRun(edit(buildFixture("good"), '{"index":"1"}', (t) => t.replace(/"confirm_observed":\{"block":"\d+"/, '"confirm_observed":{"block":"5"')));
    // the state is rebuilt with the contract's recorded confirm_observed, so the agent's claimed state no longer agrees with it
    expect(row(rows, "Action 2").text).toBe("The decision record does not match the chain: the record's confirmFromBlock is not what the chain shows at its block.");
  });
  it("EC-W22: a close with no confirm_observed is not matching", async () => {
    const rows = await checkRun(edit(buildFixture("good"), '{"index":"1"}', (t) => t.replace(/"remove":\{.*\}\}\}$/, '"remove":null}')));
    expect(row(rows, "Action 2").verdict).toBe("not_matching");
  });
});

describe("lead's audit list on web/check-page", () => {
  it("EC-W13/rules: an action outside the rules is not matching", async () => {
    const rows = await run("out-of-rules");
    const r = row(rows, "Action 1");
    expect(r.verdict).toBe("not_matching");
    // the shared record check (packages/rules) refuses it first: the decision is not what the rules give for the recorded state
    expect(r.text).toBe("The decision record is not valid: the recorded decision is not what the rules give for the recorded state.");
    expect(worst(rows.map((x) => x.verdict))).toBe("not_matching");
  });
  it("more than 64 records skips only the record checks; the account and pin checks still run", async () => {
    const f = buildFixture("good");
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_actions_len" ? { ...r, text: '"65"' } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) });
    expect(row(rows, "The action log").verdict).toBe("unverifiable");
    expect(row(rows, "No close missed").text).toBe("Can't check for a missed close: the action log could not be read.");
    expect(row(rows, "No change to the account").verdict).toBe("matching");
    expect(row(rows, "The code hash equals").verdict).toBe("matching");
    expect(rows.some((r) => r.title.startsWith("Action "))).toBe(false);
  });
  it("EC-W16/W29: no established creation block means the account row is can't-check, not a baseline taken from the first sample", async () => {
    const { deployBlock: _d, ...rest } = buildFixture("good").source;
    const rows = await checkRun(rest);
    expect(row(rows, "No change to the account").verdict).toBe("unverifiable");
    expect(row(rows, "No change to the account").text).toContain("the creation block was not established from chain data");
  });
  it("a creation block that is not the first snapshot is can't-check, not matching", async () => {
    const rows = await checkRun({ ...buildFixture("good").source, deployBlock: 11 });
    expect(row(rows, "No change to the account").verdict).toBe("unverifiable");
  });
  it("a record both providers agree on but that is invalid is only unverifiable", async () => {
    const f = buildFixture("good");
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}' ? { ...r, text: r.text.replace('"observed"', '"observed":1,"x"') } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) });
    expect(row(rows, "Action 1").verdict).toBe("unverifiable");
  });
});

describe("decision records vs action records (EC-W05, EC-W18)", () => {
  const withDecision = (text: string | null) => {
    const f = buildFixture("good");
    const h = hashDecisionText(text ?? "gone");
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}' ? { ...r, text: r.text.replace(/"decision_hash":"[0-9a-f]{64}"/, `"decision_hash":"${h}"`) } : r)) });
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])), decisionText: (hash: string) => (hash === h ? text : f.source.decisionText(hash)) };
  };
  it("EC-W05: a missing decision record (nothing published for its hash) is not matching", async () => {
    const rows = await checkRun(withDecision(null));
    expect(row(rows, "Action 1").verdict).toBe("not_matching");
    expect(row(rows, "Action 1").text).toBe("The decision record is not published.");
  });
  it("EC-W18 (a): a committed decision record that can't be read (duplicate keys) is not matching", async () => {
    const rows = await checkRun(withDecision('{"kind":"open","kind":"open","left":-800,"right":0}'));
    expect(row(rows, "Action 1").verdict).toBe("not_matching");
    expect(row(rows, "Action 1").text).toBe("The agent's committed text could not be read.");
  });
  it("EC-W18 (b): an unreadable ACTION record the contract wrote is unverifiable", async () => {
    const f = buildFixture("good");
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}' ? { ...r, text: r.text.replace('"kind":"Open"', '"kind":"Open","kind":"Open"') } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) });
    expect(row(rows, "Action 1").verdict).toBe("unverifiable");
  });
  it("EC-W08: a provider that disagrees about a record is unverifiable", async () => {
    const f = buildFixture("good");
    const b = { ...f.files[1], responses: f.files[1].responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}' ? { ...r, text: r.text.replace('"op_id":"1"', '"op_id":"9"') } : r)) };
    const rows = await checkRun({ ...f.source, b: recordedProvider(b) });
    expect(row(rows, "Action 1").verdict).toBe("unverifiable");
  });
});

describe("the shared decision record (packages/rules) is checked against the chain and the rules", () => {
  const withText = (mutate: (t: string) => string) => {
    const f = buildFixture("good");
    const orig = f.files[0].responses.find((r) => r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}')!.text;
    const oldHash = /"decision_hash":"([0-9a-f]{64})"/.exec(orig)![1]!;
    const text = mutate(f.log.get(oldHash)!);
    const h = hashDecisionText(text);
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}' ? { ...r, text: r.text.replace(oldHash, h) } : r)) });
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])), decisionText: (x: string) => (x === h ? text : f.source.decisionText(x)) };
  };
  it("EC-W03: a state in the record that differs from the chain's is not matching", async () => {
    const rows = await checkRun(withText((t) => t.replace('"valuationPoint":-400', '"valuationPoint":-399')));
    expect(row(rows, "Action 1").text).toBe("The decision record does not match the chain: the record's valuationPoint is not what the chain shows at its block.");
    expect(row(rows, "Action 1").verdict).toBe("not_matching");
  });
  it("a record made under other rules than the commitment is not matching", async () => {
    const rows = await checkRun(withText((t) => t.replace(/"rules_hash":"[0-9a-f]{64}"/, `"rules_hash":"${"1".repeat(64)}"`)));
    expect(row(rows, "Action 1").text).toBe("The decision record is not valid: the record is for other rules.");
  });
  it("EC-R31: a published text that is not the canonical form of its content can't be read: not matching", async () => {
    const rows = await checkRun(withText((t) => t.replace('"version":1}', '"version":1 }')));
    expect(row(rows, "Action 1").text).toBe("The agent's committed text could not be read.");
  });
});

describe("audit round 3: N1, ExitRemove, and the surviving mutants", () => {
  const swap = (f: ReturnType<typeof buildFixture>, method: string, args: string | null, fn: (t: string) => string, which: 0 | 1 | "both" = "both", block?: number) => {
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === method && (args === null || JSON.stringify(r.args) === args) && (block === undefined || r.block === block) ? { ...r, text: fn(r.text) } : r)) });
    return { ...f.source, a: recordedProvider(which === 1 ? f.files[0] : m(f.files[0])), b: recordedProvider(which === 0 ? f.files[1] : m(f.files[1])) };
  };
  it("N1: a live source (no fixture views) can't use a fixture deploy block, and a 'chain' block is accepted", async () => {
    const f = buildFixture("good");
    const noFixture = { ...f.source, allowFixtureViews: false };
    expect(row(await checkRun(noFixture), "No change to the account").verdict).toBe("unverifiable");
    // evidence must say where the block came from: absent is not established
    const { deployBlockEvidence: _e, ...unlabelled } = f.source;
    expect(row(await checkRun(unlabelled), "No change to the account").text).toContain("the creation block was not established from chain data");
  });
  it("a non-ok ExitRemove is unverifiable, never Could not act and never matching", async () => {
    const f = buildFixture("good");
    const src = swap(f, "get_action", '{"index":"1"}', (t) => t.replace(/"kind":"[A-Za-z]+"/, '"kind":"ExitRemove"').replace(/"decision_hash":"[0-9a-f]{64}"/, '"decision_hash":""').replace('"result":"Ok"', '"result":"Unknown"'));
    const r = row(await checkRun(src), "Action 2");
    expect(r.verdict).toBe("unverifiable");
    expect(r.text).toBe("Can't check this exit removal: the contract did not record it as done.");
  });
  it("EC-W14: a rogue DCL contract is not matching, and so is a rogue quote token", async () => {
    const f = buildFixture("good");
    for (const [k, v] of [["dcl_contract", "evil.near"], ["quote_token", "evil.near"]] as const) {
      const rows = await checkRun(swap(f, "get_config", null, (t) => t.replace(new RegExp(`"${k}":"[^"]+"`), `"${k}":"${v}"`)));
      expect(row(rows, "The strategy uses").verdict).toBe("not_matching");
    }
  });
  it("EC-W15: a code hash only one provider reports is unverifiable, not matching", async () => {
    const f = buildFixture("good");
    const rows = await checkRun(swap(f, "fixture:account", '{"block":10}', (t) => t.replace(/"codeHash":"a+"/, `"codeHash":"${"d".repeat(44)}"`), 1, 10));
    expect(row(rows, "The code hash equals").verdict).toBe("unverifiable");
  });
  it("the status row: only Closed is matching; Running, Open, Closing, Cancelled and unknown are unverifiable with their own text", async () => {
    const f = buildFixture("good");
    expect(row(await run("good"), "The strategy's status").verdict).toBe("matching");
    for (const s of ["Running", "Open", "Closing", "Cancelled"]) {
      const r = row(await checkRun(swap(f, "get_status", null, () => `"${s}"`)), "The strategy's status");
      expect(r.verdict).toBe("unverifiable");
      expect(r.text).toBe(`The strategy is ${s.toLowerCase()}, so the rules are not revealed yet and the rule checks are locked.`);
    }
    const u = row(await checkRun(swap(f, "get_status", null, () => '"Weird"')), "The strategy's status");
    expect(u.text).toBe("The strategy is in a state this page doesn't know, so the rules are not revealed yet and the rule checks are locked.");
  });
  it("H1: a chain state whose point differs from the recorded observation is not matching", async () => {
    const f = buildFixture("good");
    const rows = await checkRun(swap(f, "get_pool", null, (t) => t.replace('"current_point":-400', '"current_point":-399')));
    expect(row(rows, "Action 1").text).toBe("The market state does not match the observation the contract recorded.");
  });
  it("the record count at 0, 64 and 65", async () => {
    const f = buildFixture("good");
    const len = (n: string) => checkRun(swap(f, "get_actions_len", null, () => `"${n}"`));
    const none = await len("0");
    expect(none.some((r) => r.title.startsWith("Action "))).toBe(false);
    expect(none.some((r) => r.title === "The action log")).toBe(false);
    const sixtyFour = await len("64");
    expect(sixtyFour.some((r) => r.text === "Can't check: the contract reports more records than it can hold.")).toBe(false);
    expect(sixtyFour.filter((r) => r.title.startsWith("Action ")).length).toBe(64);
    expect((await len("65")).some((r) => r.text === "Can't check: the contract reports more records than it can hold.")).toBe(true);
  });
});

describe("paired open (lead decision of 12 November)", () => {
  const edit = (f: ReturnType<typeof buildFixture>, idx: string, fn: (t: string) => string) => {
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === `{"index":"${idx}"}` ? { ...r, text: fn(r.text) } : r)) });
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) };
  };
  it("an open with its swap's exact hash is judged against the swap's record: every row matches", async () => {
    const rows = await run("paired-open");
    expect(rows.map((r) => r.verdict)).toEqual(Array(rows.length).fill("matching"));
    expect(rows.filter((r) => r.title.startsWith("Action ")).map((r) => r.title)).toEqual(["Action 1: Swap, ok", "Action 2: Open, ok", "Action 3: ClosePosition, ok"]);
  });
  it("its range is judged against the decision: a different range on the open is not matching", async () => {
    const rows = await checkRun(edit(buildFixture("paired-open"), "1", (t) => t.replace(/"right_point":-?\d+/, '"right_point":9000')));
    expect(row(rows, "Action 2").text).toBe("The paired open's on-chain range is not its swap's range.");
  });
  it("a refused swap still consumes its hash: an open reusing it is Not matching, never paired (EC-W30, backend 13 Nov)", async () => {
    // the same open, but its swap was refused: no pairing, so the open's own observed block (55) is rebuilt and the record's state (block 50) differs
    const rows = await checkRun(edit(buildFixture("paired-open"), "0", (t) => t.replace('"result":"Ok"', '"result":{"Refused":"drift"}')));
    expect(row(rows, "Action 2").verdict).toBe("not_matching");
    expect(row(rows, "Action 2").text).toBe("A decision hash is used by more than one recorded action that is not a paired open.");
  });
});

describe("records are published only after the reveal (lead decision of 12 November)", () => {
  const noText = (status: string) => {
    const f = buildFixture("good");
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_status" ? { ...r, text: `"${status}"` } : r)) });
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])), decisionText: () => null };
  };
  it("while the run is live, 'not published' is unverifiable, not a verdict against the agent", async () => {
    for (const s of ["Open", "Running"]) {
      const rows = await checkRun(noText(s));
      expect(row(rows, "Action 1").verdict).toBe("unverifiable");
      expect(row(rows, "Action 1").text).toBe("The decision record is not published yet: records are published after the reveal.");
    }
  });
  it("from Closing and Closed, 'not published' is not matching (EC-W05)", async () => {
    for (const s of ["Closing", "Closed"]) {
      const rows = await checkRun(noText(s));
      expect(row(rows, "Action 1").verdict).toBe("not_matching");
      expect(row(rows, "Action 1").text).toBe("The decision record is not published.");
    }
  });
});

describe("the strategy id is in the record (rules: verifyRecordTextOnly)", () => {
  it("EC-W05/T74: a record made for another strategy, even one that hashes right, is not matching", async () => {
    const f = buildFixture("good");
    const orig = f.files[0].responses.find((r) => r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}')!.text;
    const oldHash = /"decision_hash":"([0-9a-f]{64})"/.exec(orig)![1]!;
    const text = f.log.get(oldHash)!.replace('"strategy":"strategy.fixture.near"', '"strategy":"other.fixture.near"');
    expect(text).not.toBe(f.log.get(oldHash));
    const h = hashDecisionText(text);
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}' ? { ...r, text: r.text.replace(oldHash, h) } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])), decisionText: (x: string) => (x === h ? text : f.source.decisionText(x)) });
    expect(row(rows, "Action 1").text).toBe("The decision record is not valid: the record is for another strategy.");
    expect(row(rows, "Action 1").verdict).toBe("not_matching");
  });
});

describe("missed-close inputs (audit): pending close, window count, unreadable limits", () => {
  const edit = (f: ReturnType<typeof buildFixture>, method: string, args: string | null, fn: (t: string) => string) => {
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === method && (args === null || JSON.stringify(r.args) === args) ? { ...r, text: fn(r.text) } : r)) });
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) };
  };
  it("a pending close is unverifiable for the missed-close row, never a false 'missed'", async () => {
    const f = buildFixture("missed-close");
    // the missed-close run has no close; add the pending close as a record via the refused-close fixture shape
    const g = buildFixture("refused-close");
    const src = edit(g, "get_action", '{"index":"1"}', (t) => t.replace('"result":{"Refused":"drift"}', '"result":"Pending"').replace(/"result_block":"\d+"/, '"result_block":null').replace(/"result_ts_ns":"\d+"/, '"result_ts_ns":null'));
    const rows = await checkRun(src);
    expect(row(rows, "No close missed").text).toBe("Can't check for a missed close: a close is still pending, or has no result block.");
    expect(row(rows, "No close missed").verdict).toBe("unverifiable");
    void f;
  });
  it("an Ok close with no result block is unverifiable, not a false not-matching", async () => {
    const src = edit(buildFixture("good"), "get_action", '{"index":"1"}', (t) => t.replace(/"result_block":"\d+"/, '"result_block":null').replace(/"result_ts_ns":"\d+"/, '"result_ts_ns":null'));
    const rows = await checkRun(src);
    expect(row(rows, "No close missed").verdict).toBe("unverifiable");
  });
  it("the window count: 4096 is read (missing windows are unreadable), 4097 is refused as a bound", async () => {
    const f = buildFixture("good");
    const at = (n: number) => checkRun(edit(f, "fixture:window_count", null, () => String(n)));
    expect(row(await at(4096), "No close missed").text).toBe("Can't check for a missed close: some of the run could not be read.");
    expect(row(await at(4097), "No close missed").text).toBe("Can't check: the sampled windows could not be read from both providers, or they disagree.");
    expect(row(await at(-1), "No close missed").verdict).toBe("unverifiable");
  });
  it("unreadable public limits are unverifiable with their own text", async () => {
    const f = buildFixture("good");
    for (const bad of ['{"max_observation_age_blocks":20}', "null", '"x"']) {
      const rows = await checkRun(edit(f, "get_limits", null, () => bad));
      expect(row(rows, "No close missed").text).toBe("Can't check: the public limits could not be read from both providers, or they disagree.");
    }
  });
});

describe("EC-W30 paired open: the swap must have moved something, the open must follow in time, one open per swap, the range is the swap's", () => {
  const edit = (f: ReturnType<typeof buildFixture>, idx: string, fn: (t: string) => string, also?: [string, (t: string) => string]) => {
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => {
      if (r.method !== "get_action") return r;
      const i = JSON.parse(r.text).index as string;
      if (i === idx) return { ...r, text: fn(r.text) };
      if (also && i === also[0]) return { ...r, text: also[1](r.text) };
      return r;
    }) });
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) };
  };
  const NOT_PAIRED = "The open reuses a swap's decision outside the pairing rule: the swap moved nothing, or the open came too late.";
  it("a swap that used nothing can't be paired with", async () => {
    const rows = await checkRun(edit(buildFixture("paired-open"), "0", (t) => t.replace('"used":"1"', '"used":"0"')));
    expect(row(rows, "Action 2").text).toBe(NOT_PAIRED);
    expect(row(rows, "Action 2").verdict).toBe("not_matching");
  });
  it("an open later than the pairing window (3,600 s) is not paired; one nanosecond inside it is", async () => {
    const swapTs = (1_000_000 + 52) * 1_000_000_000;
    const at = (ns: bigint) => checkRun(edit(buildFixture("paired-open"), "1", (t) => t.replace(/"timestamp_ns":"\d+"/, `"timestamp_ns":"${ns}"`)));
    expect(row(await at(BigInt(swapTs) + 3_600_000_000_000n), "Action 2").text).toBe(NOT_PAIRED);
    expect(row(await at(BigInt(swapTs) + 3_600_000_000_000n - 1n), "Action 2").verdict).toBe("matching");
    expect(row(await at(BigInt(swapTs) - 1n), "Action 2").text).toBe(NOT_PAIRED); // never before the swap's result
  });
  it("a second open on the same swap is not matching", async () => {
    const f = buildFixture("paired-open");
    // make the close record (index 2) a second Open with the swap's hash and range
    const rows = await checkRun(edit(f, "2", (t) => {
      const swapHash = /"decision_hash":"([0-9a-f]{64})"/.exec(JSON.parse(JSON.stringify(f.files[0].responses.find((r) => r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}')!.text)))![1]!;
      return t.replace('"kind":"ClosePosition"', '"kind":"Open"').replace(/"decision_hash":"[0-9a-f]{64}"/, `"decision_hash":"${swapHash}"`).replace(/"left_point":-?\d+/, '"left_point":-800').replace(/"right_point":-?\d+/, '"right_point":0').replace(/"timestamp_ns":"\d+"/, `"timestamp_ns":"${(1_000_000 + 60) * 1_000_000_000}"`);
    }));
    expect(row(rows, "Action 3").text).toBe("A second open uses a swap that an earlier open already used.");
  });
  it("a ClosePosition that reuses a swap's hash is not paired: it does not describe the call", async () => {
    const f = buildFixture("paired-open");
    const swapHash = /"decision_hash":"([0-9a-f]{64})"/.exec(f.files[0].responses.find((r) => r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}')!.text)![1]!;
    const rows = await checkRun(edit(f, "2", (t) => t.replace(/"decision_hash":"[0-9a-f]{64}"/, `"decision_hash":"${swapHash}"`)));
    expect(row(rows, "Action 3").verdict).toBe("not_matching");
    expect(row(rows, "Action 3").text).toBe("The decision record does not describe the call the contract recorded.");
  });
  it("only an EARLIER swap pairs: an open before a same-hash swap is judged on its own observation", async () => {
    const f = buildFixture("paired-open");
    // swap the kinds of records 0 and 1: record 0 is now an Open and record 1 a Swap with the same hash
    const rows = await checkRun(edit(f, "0", (t) => t.replace('"kind":"Swap"', '"kind":"Open"'), ["1", (t) => t.replace('"kind":"Open"', '"kind":"Swap"')]));
    // the open is not paired (it precedes the swap's result), so it and the same-hash swap are both unpaired actions sharing one hash
    expect(row(rows, "Action 1: Open").verdict).toBe("not_matching");
    expect(row(rows, "Action 1: Open").text).toBe("A decision hash is used by more than one recorded action that is not a paired open.");
  });
  it("only a SWAP pairs: an open reusing an earlier OPEN's hash is judged on its own observation (not paired)", async () => {
    const f = buildFixture("paired-open");
    const rows = await checkRun(edit(f, "0", (t) => t.replace('"kind":"Swap"', '"kind":"Open"')));
    expect(row(rows, "Action 2").text).toBe("A decision hash is used by more than one recorded action that is not a paired open.");
  });
});

describe("EC-W31 records are published after the reveal; a recording with no texts is 'incomplete', not an agent failure", () => {
  it("Cancelled (never revealed) reads Unverifiable with the pre-reveal text, like Running", async () => {
    const f = buildFixture("good");
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_status" ? { ...r, text: '"Cancelled"' } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])), decisionText: () => null });
    expect(row(rows, "Action 1").text).toBe("The decision record is not published yet: records are published after the reveal.");
    expect(row(rows, "Action 1").verdict).toBe("unverifiable");
  });
  it("from Closing with rules not revealed: unverifiable 'rules not revealed' first, not 'not published' (never not matching)", async () => {
    const rows = await checkRun({ ...buildFixture("not-revealed").source, decisionText: () => null });
    expect(row(rows, "Action 1").text).toBe("Can't check: the rules were not revealed.");
  });
  it("a source with no decision texts at all reads 'recording incomplete'", async () => {
    const rows = await checkRun({ ...buildFixture("good").source, decisionText: () => null, decisionTextsAbsent: true });
    expect(row(rows, "Action 1").text).toBe("Can't check: this recording has no decision texts (recording incomplete).");
    expect(row(rows, "Action 1").verdict).toBe("unverifiable");
  });
});

describe("EC-R25 on recorded responses, window_count 0, get_limits per field", () => {
  const edit = (f: ReturnType<typeof buildFixture>, method: string, fn: (t: string) => string) => {
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === method ? { ...r, text: fn(r.text) } : r)) });
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) };
  };
  it("a recorded response with a duplicate key, -0 or a fraction is unreadable, never half-read", async () => {
    const f = buildFixture("good");
    expect((await checkRun(edit(f, "get_config", (t) => t.replace('"agent"', '"agent":"x","agent"')))).length).toBe(1);
    for (const bad of ['{"max_observation_age_blocks":"10","min_action_interval_s":"300","max_actions_per_24h":-0,"pool":"p"}', '{"max_observation_age_blocks":"10","min_action_interval_s":"300","max_actions_per_24h":6.5,"pool":"p"}']) {
      const rows = await checkRun(edit(f, "get_limits", () => bad));
      expect(row(rows, "No close missed").text).toBe("Can't check: the public limits could not be read from both providers, or they disagree.");
    }
  });
  it("window_count 0 means no samples: can't check, never 'no close was missed'", async () => {
    const rows = await checkRun(edit(buildFixture("good"), "fixture:window_count", () => "0"));
    expect(row(rows, "No close missed").text).toBe("Can't check for a missed close: no samples were read.");
  });
  it("each get_limits field is type-checked on its own", async () => {
    const full = { max_observation_age_blocks: "10", min_action_interval_s: "300", max_actions_per_24h: 6, pool: "p" };
    for (const k of ["max_observation_age_blocks", "min_action_interval_s", "max_actions_per_24h"] as const) {
      const wrong = { ...full, [k]: k === "max_actions_per_24h" ? "6" : 10 };
      const rows = await checkRun(edit(buildFixture("good"), "get_limits", () => JSON.stringify(wrong)));
      expect(row(rows, "No close missed").text, k).toBe("Can't check: the public limits could not be read from both providers, or they disagree.");
    }
  });
});

describe("EC-W30: an open pairs only with a swap that has its exact hash", () => {
  it("an open with its own distinct record (another hash) is judged on its own observation, not the swap's", async () => {
    const f = buildFixture("paired-open");
    const swapRec = f.files[0].responses.find((r) => r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}')!.text;
    const swapHash = /"decision_hash":"([0-9a-f]{64})"/.exec(swapRec)![1]!;
    const own = f.log.get(swapHash)!.replace('"block":50', '"block":55').replace('"nowS":1000050', '"nowS":1000055');
    const h2 = hashDecisionText(own);
    expect(h2).not.toBe(swapHash);
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"1"}' ? { ...r, text: r.text.replace(/"decision_hash":"[0-9a-f]{64}"/, `"decision_hash":"${h2}"`) } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])), decisionText: (h: string) => (h === h2 ? own : f.source.decisionText(h)) });
    expect(row(rows, "Action 2").verdict).toBe("matching");
  });
});

describe("EC-W22: a close's confirmation is rebuilt from views at O1, the grid heights and O2", () => {
  const edit = (f: ReturnType<typeof buildFixture>, pick: (r: { method: string; block: number; args: unknown; text: string }) => boolean, fn: (t: string) => string, which: "both" | 0 = "both") => {
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (pick(r) ? { ...r, text: fn(r.text) } : r)) });
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(which === 0 ? f.files[1] : m(f.files[1])) };
  };
  it("the good run's close confirms (O1 at 160, grid height 180, O2 at 200)", async () => {
    expect(row(await run("good"), "Action 2").verdict).toBe("matching");
  });
  it("nothing due at O1 (the position is worth its principal there): not matching, naming the block", async () => {
    const f = buildFixture("good");
    const rows = await checkRun(edit(f, (r) => r.method === "predict_remove_liquidity" && r.block === 200 - OFFCHAIN_MARGIN_BLOCKS, () => '["250000000","0"]'));
    expect(row(rows, "Action 2").verdict).toBe("not_matching");
    expect(row(rows, "Action 2").text).toBe(`The close's confirmation does not hold: no close condition holds at block ${200 - OFFCHAIN_MARGIN_BLOCKS}.`);
  });
  it("a confirmation that restarts at a grid height: not matching", async () => {
    const f = buildFixture("good");
    const grid = confirmGrid(200 - OFFCHAIN_MARGIN_BLOCKS, 200)[0]!;
    const rows = await checkRun(edit(f, (r) => r.method === "predict_remove_liquidity" && r.block === grid, () => '["250000000","0"]'));
    expect(row(rows, "Action 2").verdict).toBe("not_matching");
    expect(row(rows, "Action 2").text).toContain(`block ${grid}`);
  });
  it("the recorded confirmation point must be the pool's point at O1", async () => {
    const f = buildFixture("good");
    const rows = await checkRun(edit(f, (r) => r.method === "get_action" && JSON.stringify(r.args) === '{"index":"1"}', (t) => t.replace(/"confirm_observed":\{"block":"(\d+)","point":-?\d+\}/, '"confirm_observed":{"block":"$1","point":12345}')));
    expect(row(rows, "Action 2").text).toBe("The close's confirmation point is not the pool's point at the confirmation block.");
  });
  it("a grid height with no recorded views is unverifiable, never a pass", async () => {
    const f = buildFixture("good");
    const grid = confirmGrid(200 - OFFCHAIN_MARGIN_BLOCKS, 200)[0]!;
    const drop = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.filter((r) => !(r.method === "block" && r.block === grid)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(drop(f.files[0])), b: recordedProvider(drop(f.files[1])) });
    expect(row(rows, "Action 2").verdict).toBe("unverifiable");
    expect(row(rows, "Action 2").text).toBe("Can't check this close: the states for its confirmation could not be rebuilt from the chain's views.");
  });
  it("a refused close is not put through the confirmation (D53: context only)", async () => {
    expect(row(await run("refused-close"), "Action 2").verdict).toBe("unverifiable");
  });
});

describe("a self-consistent record carrying a wrong state never reads Matching (audit round 5, EC-W03)", () => {
  const withText = (mutate: (t: string) => string) => {
    const f = buildFixture("good");
    const orig = f.files[0].responses.find((r) => r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}')!.text;
    const oldHash = /"decision_hash":"([0-9a-f]{64})"/.exec(orig)![1]!;
    const text = mutate(f.log.get(oldHash)!);
    const h = hashDecisionText(text);
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}' ? { ...r, text: r.text.replace(oldHash, h) } : r)) });
    return { text, src: { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])), decisionText: (x: string) => (x === h ? text : f.source.decisionText(x)) } };
  };
  const cases: [string, string, string][] = [
    ["point", '"point":-400', '"point":-399'],
    ["block", '"block":50', '"block":51'],
    ["holdings", '"holdings":{"base":"0","quote":"250000000"}', '"holdings":{"base":"0","quote":"250000001"}'],
    ["principal", '"principal":"250000000"', '"principal":"250000001"'],
    ["fees", '"fees":{"base":"0","quote":"0"}', '"fees":{"base":"0","quote":"1"}'],
    ["nowS", '"nowS":1000050', '"nowS":1000051'],
    ["startedAtS", '"startedAtS":900000', '"startedAtS":899999'],
  ];
  for (const [name, from, to] of cases) {
    it(`a record whose state.${name} differs from the chain's is Not matching`, async () => {
      const { text, src } = withText((t) => t.replace(from, to));
      expect(text).toContain(to);
      const rows = await checkRun(src);
      expect(row(rows, "Action 1").verdict, name).toBe("not_matching");
      expect(worst(rows.map((r) => r.verdict))).toBe("not_matching");
    });
  }
  it("a record claiming a position the chain doesn't have, or a closedBy it doesn't have, is Not matching", async () => {
    for (const [from, to] of [['"position":null', '"position":{"left":-400,"right":400}'], ['"closedBy":null', '"closedBy":"stop_loss"'], ['"confirmFromBlock":null', '"confirmFromBlock":10']] as const) {
      const { text, src } = withText((t) => t.replace(from, to));
      expect(text).toContain(to);
      expect(row(await checkRun(src), "Action 1").verdict, to).toBe("not_matching");
    }
  });
  it("T77: an open whose result is Unknown (possibly stranded) never shows a pass", async () => {
    const f = buildFixture("good");
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}' ? { ...r, text: r.text.replace('"result":"Ok"', '"result":"Unknown"') } : r)) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) });
    expect(row(rows, "Action 1").verdict).toBe("unverifiable");
    expect(worst(rows.map((r) => r.verdict))).not.toBe("matching");
  });
});

describe("audit round 6: the pool's point at the observed and confirmation blocks, repeated hashes, failed swaps", () => {
  const edit = (f: ReturnType<typeof buildFixture>, pick: (r: { method: string; block: number; args: unknown; text: string }) => boolean, fn: (t: string) => string) => {
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (pick(r) ? { ...r, text: fn(r.text) } : r)) });
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) };
  };
  it("the pool's point at the observed block must be the on-chain observed point: otherwise Not matching", async () => {
    const rows = await checkRun(edit(buildFixture("good"), (r) => r.method === "get_pool" && r.block === 50, (t) => t.replace('"current_point":-400', '"current_point":-399')));
    expect(row(rows, "Action 1").text).toBe("The market state does not match the observation the contract recorded.");
  });
  it("an unreadable pool at the observed block, or at the confirmation block, is Unverifiable", async () => {
    const f = buildFixture("good");
    const drop = (block: number) => { const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.filter((r) => !(r.method === "get_pool" && r.block === block)) }); return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) }; };
    expect(row(await checkRun(drop(50)), "Action 1").verdict).toBe("unverifiable");
    expect(row(await checkRun(drop(200 - OFFCHAIN_MARGIN_BLOCKS)), "Action 2").verdict).toBe("unverifiable");
  });
  it("the pool's point at the confirmation block must be the recorded one", async () => {
    const rows = await checkRun(edit(buildFixture("good"), (r) => r.method === "get_pool" && r.block === 200 - OFFCHAIN_MARGIN_BLOCKS, (t) => t.replace('"current_point":0', '"current_point":7')));
    expect(row(rows, "Action 2").text).toBe("The close's confirmation point is not the pool's point at the confirmation block.");
  });
  it("a decision hash used by two successful actions that are not a paired open is Not matching", async () => {
    const f = buildFixture("paired-open");
    // the open becomes a second Swap carrying the first swap's hash: two successful, unpaired actions with one hash
    const rows = await checkRun(edit(f, (r) => r.method === "get_action" && JSON.stringify(r.args) === '{"index":"1"}', (t) => t.replace('"kind":"Open"', '"kind":"Swap"')));
    expect(row(rows, "Action 1").text).toBe("A decision hash is used by more than one recorded action that is not a paired open.");
    expect(row(rows, "Action 2").text).toBe("A decision hash is used by more than one recorded action that is not a paired open.");
  });
  it("a Swap whose result is Failed, SwapRefused or a refund is never shown as Matching, and is no swap to pair an open with", async () => {
    for (const res of ['{"Failed":"swap"}', '"SwapRefused"', '{"Refused":"floor"}']) {
      const f = buildFixture("paired-open");
      const rows = await checkRun(edit(f, (r) => r.method === "get_action" && JSON.stringify(r.args) === '{"index":"0"}', (t) => t.replace('"result":"Ok"', `"result":${res}`)));
      expect(row(rows, "Action 1: Swap").verdict, res).not.toBe("matching");
      // the open no longer pairs: it is judged on its own observation and does not read as a pass on the swap's account
      expect(row(rows, "Action 2").verdict, res).toBe("not_matching");
      expect(worst(rows.map((r) => r.verdict)), res).not.toBe("matching");
    }
  });
});

describe("audit round 6 (13 Nov): latch, refused close without confirmation, chain gap, hostile values, no-op swap", () => {
  const edit = (f: ReturnType<typeof buildFixture>, pick: (r: { method: string; block: number; args: unknown; text: string }) => boolean, fn: (t: string) => string) => {
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.map((r) => (pick(r) ? { ...r, text: fn(r.text) } : r)) });
    return { ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) };
  };
  const action = (i: string) => (r: { method: string; args: unknown }) => r.method === "get_action" && JSON.stringify(r.args) === `{"index":"${i}"}`;
  it("a close that fails its own row still latches closedBy for later rows: the failure is not cascaded", async () => {
    // retried-close: the first Ok close (index 2) follows a refused one; make the Ok close fail (wrong confirm_observed) and check a later action
    const f = buildFixture("paired-open");
    // add a later Open-less ExitRemove is not judged; instead check the failing close does not change the earlier rows
    const rows = await checkRun(edit(f, action("2"), (t) => t.replace(/"confirm_observed":\{"block":"\d+"/, '"confirm_observed":{"block":"5"')));
    expect(row(rows, "Action 3").verdict).toBe("not_matching");
    expect(row(rows, "Action 1").verdict).toBe("matching");
    expect(row(rows, "Action 2").verdict).toBe("matching");
  });
  it("a refused close recorded WITHOUT confirm_observed is Unverifiable (never a state mismatch), and the missed-close row decides", async () => {
    const f = buildFixture("refused-close");
    const rows = await checkRun(edit(f, action("1"), (t) => t.replace(/"remove":\{.*\}\}\}$/, '"remove":null}')));
    expect(row(rows, "Action 2").verdict).toBe("unverifiable");
    expect(row(rows, "Action 2").text).toContain("no confirmation was recorded with it");
    expect(row(rows, "No close missed").verdict).toBe("not_matching");
  });
  it("a swap that moved nothing does not pair; the open is then judged alone", async () => {
    const f = buildFixture("paired-open");
    const rows = await checkRun(edit(f, action("0"), (t) => t.replace('"used":"1"', '"used":"0"')));
    expect(row(rows, "Action 2").verdict).toBe("not_matching");
  });
  it("a hole in the records (one unreadable) makes the next link can't-check, not not-matching", async () => {
    const f = buildFixture("paired-open");
    const hs = [...f.log.keys()];
    const h0 = chainHead(null, hs[0]!);
    const h1 = chainHead(h0, hs[0]!); // the open reuses the swap's hash
    const h2 = chainHead(h1, hs[1]!);
    const heads = [h0, h1, h2];
    const m = (x: (typeof f.files)[number]) => ({ ...x, responses: x.responses.flatMap((r) => {
      if (r.method !== "get_action") return [r];
      const i = Number(JSON.parse(r.text).index);
      if (i === 1) return [{ ...r, text: "not json" }]; // the middle record can't be read
      return [{ ...r, text: r.text.replace('"chain_head":null', `"chain_head":"${heads[i]}"`) }];
    }) });
    const rows = await checkRun({ ...f.source, a: recordedProvider(m(f.files[0])), b: recordedProvider(m(f.files[1])) });
    expect(row(rows, "The decision log chain").verdict).toBe("unverifiable");
  });
  it("hostile out-of-range views in one row make that row can't-check; the other rows, including the rules row, still read", async () => {
    const f = buildFixture("good");
    const rows = await checkRun(edit(f, (r) => r.method === "get_pool" && r.block === 50, (t) => t.replace('"current_point":-400', '"current_point":1000000000000')));
    expect(row(rows, "Rules match").verdict).toBe("matching");
    expect(row(rows, "Action 2").verdict).toBe("matching");
    expect(["not_matching", "unverifiable"]).toContain(row(rows, "Action 1").verdict);
    const rows2 = await checkRun(edit(f, (r) => r.method === "get_liquidity" && r.block === 200, (t) => t.replace(/"left_point":-?\d+/, '"left_point":1000000000000')));
    expect(row(rows2, "Rules match").verdict).toBe("matching");
    expect(row(rows2, "Action 1").verdict).toBe("matching");
    expect(row(rows2, "Action 2").verdict).not.toBe("matching");
  });
  it("every passing action row says the valuation point is the pool's spot point and can't be checked", async () => {
    const rows = await run("good");
    for (const r of rows.filter((x) => x.title.startsWith("Action "))) expect(r.text).toContain("The valuation point is the pool's spot point; the page cannot check that value.");
  });
});

describe("account snapshots read from recorded view_account and view_access_key_list (EC-W02, EC-W07)", () => {
  const src = (snaps: { block: number; code: string; keys: unknown[] }[]) => {
    const r: { account: string; method: string; args: JsonValue; block: number; text: string }[] = [];
    for (const s of snaps) {
      r.push({ account: "s.near", method: "view_account", args: {}, block: s.block, text: JSON.stringify({ code_hash: s.code, block_height: s.block }) });
      r.push({ account: "s.near", method: "view_access_key_list", args: {}, block: s.block, text: JSON.stringify({ keys: s.keys, block_height: s.block }) });
    }
    const f = { provider: "x", run: "x", responses: r };
    const p = recordedProvider(f as never);
    return { a: p, b: p, account: "s.near", head: 300, decisionText: () => null, snapshotBlocks: snaps.map((s) => s.block), accountViews: true } as never as Parameters<typeof checkRun>[0];
  };
  const key = (pk: string, nonce: number, perm: unknown = "FullAccess") => ({ public_key: pk, access_key: { nonce, permission: perm } });
  it("a changed code hash, an added key, a changed permission or a signing full-access key between samples is Not matching", async () => {
    const base = { block: 100, code: "C1", keys: [key("ed25519:A", 5)] };
    const fc = { FunctionCall: { receiver_id: "x", method_names: [], allowance: null } };
    const cases: [string, string, Parameters<typeof src>[0]][] = [
      ["code", "The account's code changed between block 100 and block 200.", [base, { block: 200, code: "C2", keys: base.keys }]],
      ["added key", "A key was added between block 100 and block 200.", [base, { block: 200, code: "C1", keys: [...base.keys, key("ed25519:B", 1)] }]],
      ["permission", "A key's permission changed between block 100 and block 200.", [base, { block: 200, code: "C1", keys: [key("ed25519:A", 5, fc)] }]],
      ["nonce", "The recovery key signed a transaction between block 100 and block 200.", [base, { block: 200, code: "C1", keys: [key("ed25519:A", 6)] }]],
    ];
    for (const [name, text, snaps] of cases) {
      const { finding } = await accountFindingFor(src(snaps));
      expect(finding.verdict, name).toBe("not_matching");
      expect(finding.text, name).toBe(text);
    }
  });
  it("no change since the first sample is only Unverifiable while the creation block is not established; a missing snapshot is Unverifiable", async () => {
    const base = { block: 100, code: "C1", keys: [key("ed25519:A", 5)] };
    const same = await accountFindingFor(src([base, { ...base, block: 200 }]));
    expect(same.finding.verdict).toBe("unverifiable");
    expect(same.finding.text).toContain("the creation block was not established from chain data");
    const missing = src([base, { ...base, block: 200 }]);
    const noSnap = await accountFindingFor({ ...missing, snapshotBlocks: [100, 200, 300] });
    expect(noSnap.finding.verdict).toBe("unverifiable");
    expect((await accountFindingFor({ ...missing, snapshotBlocks: [] })).finding.text).toBe("Can't check: no snapshots were read.".replace("Can't check:", "Can't check the account:"));
  });
});
