import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import CheckPage from "../src/app/check/[strategy]/page.tsx";
import { checkRun } from "../src/lib/run.ts";
import { loadScenario, parseScenarioId, SCENARIO_CASES, SCENARIO_LABEL } from "../src/lib/scenario.ts";
import { parseRecordedFileLarge, parseRecordedFile } from "../src/lib/provider.ts";
import { worst } from "../src/lib/verdict.ts";

const DIR = new URL("../../../fixtures/scenario", import.meta.url).pathname;
const rowsOf = async (c: (typeof SCENARIO_CASES)[number]) => checkRun(loadScenario(c, DIR));
const row = (rows: Awaited<ReturnType<typeof rowsOf>>, start: string) => rows.find((r) => r.title.startsWith(start))!;

describe("the recorded sandbox scenario runs (backend's fixtures/scenario, read generically)", () => {
  it("is labelled: one node read twice, not two independent providers", () => {
    expect(loadScenario("good", DIR).label).toBe(SCENARIO_LABEL);
    expect(SCENARIO_LABEL).toContain("Not two independent providers");
  });
  it("good (run 4, real agent): every row the recording lets the page establish is Matching; creation block stays Unverifiable", async () => {
    const rows = await rowsOf("good");
    expect(row(rows, "The strategy's status").verdict).toBe("matching");
    expect(row(rows, "Rules match").verdict).toBe("matching");
    // The agent's own records (a swap and its paired open sharing one text, then the genuine time close), rebuilt state and all.
    for (const n of ["Action 1: Swap", "Action 2: Open", "Action 3: ClosePosition"]) {
      expect(row(rows, n).verdict, n).toBe("matching");
      expect(row(rows, n).text).toContain("The valuation point is the pool's spot point; the page cannot check that value.");
    }
    expect(row(rows, "The decision log chain").verdict).toBe("matching");
    expect(row(rows, "No close missed").verdict).toBe("matching");
    expect(row(rows, "The code hash equals").text).toBe("The deployed code hash equals the pinned hash. These are the sandbox constants from the recording (pins.json), not independently pinned.");
    expect(row(rows, "The strategy uses").text).toContain("not independently pinned");
    expect(row(rows, "The strategy uses").verdict).toBe("matching");
    // No chain evidence of the creation block: the account row can say "no change since the first sample" and nothing more.
    expect(row(rows, "No change to the account").verdict).toBe("unverifiable");
    expect(row(rows, "No change to the account").text).toContain("the creation block was not established from chain data");
    expect(worst(rows.map((r) => r.verdict))).toBe("unverifiable");
  });
  it("EC-W01: bad-tampered-rules is Not matching on the rules, and nothing is judged against them", async () => {
    const rows = await rowsOf("bad-tampered-rules");
    expect(row(rows, "Rules match").text).toBe("The revealed rules do not match the commitment.");
    expect(row(rows, "Rules match").verdict).toBe("not_matching");
    expect(row(rows, "No close missed").text).toBe("Can't check: the rules were not revealed, or do not match the commitment.");
  });
  it("EC-W23 no-agent-close (run 5): the agent never closed, the time close was due for about 15 minutes, and the page's own sampling finds the missed close: Not matching", async () => {
    const rows = await rowsOf("no-agent-close");
    expect(row(rows, "Action 3: ExitRemove").verdict).toBe("matching");
    expect(rows.some((r) => r.title.includes("ClosePosition"))).toBe(false);
    expect(row(rows, "No close missed").verdict).toBe("not_matching");
    expect(row(rows, "No close missed").text).toBe("A close was missed: time was due from block 28940 to block 36240.");
    // everything else that can be established still is, so the verdict is the missed close and nothing else
    expect(rows.filter((r) => r.verdict === "not_matching").map((r) => r.title)).toEqual(["No close missed at the sampled blocks"]);
    expect(worst(rows.map((r) => r.verdict))).toBe("not_matching");
  });
  it("EC-W08: a view that was not recorded is a failed read, so the row is unverifiable, never matching", async () => {
    const src = loadScenario("good", DIR);
    const rows = await checkRun({ ...src, head: src.head + 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("unverifiable");
  });
  it("a missing or bad recording is refused, not half-used", () => {
    expect(() => loadScenario("good", "/nonexistent")).toThrow(/could not be read/);
    expect(() => parseRecordedFileLarge("not json")).toThrow(/not JSON/);
    expect(() => parseRecordedFileLarge('{"provider":"x","run":"y","responses":[{"account":"a","method":"m","args":{},"block":1,"text":"t"},{"account":"a","method":"m","args":{},"block":1,"text":"t"}]}')).toThrow(/duplicate response/);
    // the strict reader still refuses large input: recordings need the large reader
    expect(() => parseRecordedFile(" ".repeat(5000) + "{}")).toThrow();
  });
  it("ids: only the three recordings are served", () => {
    expect(parseScenarioId("scenario-good")).toBe("good");
    expect(parseScenarioId("scenario-../../etc/passwd")).toBeNull();
    expect(parseScenarioId("good")).toBeNull();
  });
  it("the check page shows the label and the worst verdict for a recording; a missing recording is unverifiable", async () => {
    const html = renderToStaticMarkup(await CheckPage({ params: Promise.resolve({ strategy: "scenario-good" }) }));
    expect(html).toContain(SCENARIO_LABEL);
    expect(html).toContain(">Unverifiable<");
    expect(html).not.toContain(">Not matching<");
    const bad = renderToStaticMarkup(await CheckPage({ params: Promise.resolve({ strategy: "scenario-bad-tampered-rules" }) }));
    expect(bad).toContain("The revealed rules do not match the commitment.");
  });
});

describe("failure states of the check page", () => {
  const withDir = async (dir: string, id: string) => {
    const old = process.env.SCENARIO_DIR;
    process.env.SCENARIO_DIR = dir;
    try { return renderToStaticMarkup(await CheckPage({ params: Promise.resolve({ strategy: id }) })); }
    finally { if (old === undefined) delete process.env.SCENARIO_DIR; else process.env.SCENARIO_DIR = old; }
  };
  it("EC-W08: a missing recording is Unverifiable and says nothing was checked, never Matching", async () => {
    const html = await withDir("/nonexistent", "scenario-good");
    expect(html).toContain("Unverifiable: the recording for this run could not be read");
    expect(html).toContain("nothing was checked");
    expect(html).not.toContain(">Matching<");
  });
  it("a bad recording (not JSON, wrong shape) is refused the same way", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "scenario-"));
    writeFileSync(join(dir, "good.sandbox-a.json"), "not json");
    writeFileSync(join(dir, "good.sandbox-b.json"), '{"provider":"b"}');
    const html = await withDir(dir, "scenario-good");
    expect(html).toContain("Unverifiable: the recording for this run could not be read");
  });
  it("an unknown strategy id is Unverifiable, says reading live strategies is not built, and shows the id as text", async () => {
    const html = renderToStaticMarkup(await CheckPage({ params: Promise.resolve({ strategy: "not-a-run" }) }));
    expect(html).toContain("Unverifiable");
    expect(html).toContain("Reading a live strategy from two RPC providers is not built yet");
  });
});

describe("decision texts of a recording: <dir>/records/<hash>.txt (content-addressed)", () => {
  it("a record file is read, a missing one is not published, an oversized one is a failed read, a non-hex hash never touches the disk", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readRecordFile } = await import("../src/lib/scenario.ts");
    const { MAX_RECORD_BYTES } = await import("../src/lib/records-host.ts");
    const dir = mkdtempSync(join(tmpdir(), "records-"));
    mkdirSync(join(dir, "records"));
    const h = "a".repeat(64);
    writeFileSync(join(dir, "records", `${h}.txt`), "record text");
    expect(readRecordFile(join(dir, "records"), h)).toBe("record text");
    expect(readRecordFile(join(dir, "records"), "b".repeat(64))).toEqual({ failed: true, reason: "recording" }); // one source: missing is Unverifiable
    writeFileSync(join(dir, "records", `${"c".repeat(64)}.txt`), "x".repeat(MAX_RECORD_BYTES + 1));
    expect(readRecordFile(join(dir, "records"), "c".repeat(64))).toEqual({ failed: true });
    expect(readRecordFile(join(dir, "records"), "../../etc/passwd")).toBeNull();
  });
});

// The test the lead asked for: it loads whatever fixtures/scenario/good.* contains. It can only assert Matching once the recording is
// complete enough for the page to rebuild each action's state (block headers) and to read each decision text. Until then it is
// skipped with the reason, instead of failing or passing by accident. When it runs, every action row must be Matching.
describe("the recorded good run reads Matching on every action once the recording is complete", () => {
  it("every action row is Matching when the recording has block headers and decision texts", async (ctx) => {
    const rows = await checkRun(loadScenario("good", DIR));
    const actions = rows.filter((r) => r.title.startsWith("Action "));
    const incomplete = actions.some((r) => r.text === "The decision record is not published." || r.text.includes("recording incomplete") || r.text.startsWith("Can't check this action: the market state"));
    if (incomplete) ctx.skip("the good recording has no decision texts or block headers yet");
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.map((r) => r.verdict)).toEqual(actions.map(() => "matching"));
  });
});

describe("an oversized or odd recording is refused, never a crash (audit L1)", () => {
  const write = async (name: string, body: string, bodyB = body) => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "scenario-big-"));
    writeFileSync(join(dir, `${name}.sandbox-a.json`), body);
    writeFileSync(join(dir, `${name}.sandbox-b.json`), bodyB);
    return dir;
  };
  const file = (n: number) => `{"provider":"a","run":"good","responses":[${Array.from({ length: n }, (_, i) => `{"account":"s.near","method":"get_config","args":{},"block":${i},"text":"x"}`).join(",")}]}`;
  it("250,000 get_config responses: refused as too many, not a RangeError", async () => {
    const dir = await write("good", file(250_000));
    expect(() => loadScenario("good", dir)).toThrow(/too many responses/);
  });
  it("200,000 responses are read (the head is the largest block, no argument spreading)", async () => {
    const dir = await write("good", file(200_000));
    expect(loadScenario("good", dir).head).toBe(199_999);
  });
  it("a recording with no get_config is refused", async () => {
    const dir = await write("good", '{"provider":"a","run":"good","responses":[]}');
    expect(() => loadScenario("good", dir)).toThrow(/no get_config/);
  });
  it("the check page and the home page show an oversized recording as unverifiable", async () => {
    const dir = await write("good", file(250_000));
    const old = process.env.SCENARIO_DIR;
    process.env.SCENARIO_DIR = dir;
    try {
      const html = renderToStaticMarkup(await CheckPage({ params: Promise.resolve({ strategy: "scenario-good" }) }));
      expect(html).toContain("Unverifiable: the recording for this run could not be read");
      const { cardVerdict } = await import("../src/lib/runs.ts");
      expect(await cardVerdict("scenario-good")).toEqual({ verdict: "unverifiable", incomplete: false });
    } finally { if (old === undefined) delete process.env.SCENARIO_DIR; else process.env.SCENARIO_DIR = old; }
  });
});

describe("the home page verdict can't turn an unreadable recording into a green card (audit M2)", () => {
  it("a missing recording directory is Unverifiable on the card, never Matching", async () => {
    const old = process.env.SCENARIO_DIR;
    process.env.SCENARIO_DIR = "/nonexistent-recordings";
    try {
      const { cardVerdict, verdictFor } = await import("../src/lib/runs.ts");
      expect(await verdictFor("scenario-good")).toBe("unverifiable");
      expect(await cardVerdict("scenario-bad-tampered-rules")).toEqual({ verdict: "unverifiable", incomplete: false });
      const Home = (await import("../src/app/page.tsx")).default;
      const html = renderToStaticMarkup(await Home());
      expect(html.match(/>Matching</g)?.length ?? 0).toBe(1); // only the hand-made good run
    } finally { if (old === undefined) delete process.env.SCENARIO_DIR; else process.env.SCENARIO_DIR = old; }
  });
  it("a recording with no records folder reads as incomplete on the card, only while Unverifiable", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "scenario-incomplete-"));
    const body = '{"provider":"a","run":"good","responses":[{"account":"s.near","method":"get_config","args":{},"block":1,"text":"{}"}]}';
    writeFileSync(join(dir, "good.sandbox-a.json"), body);
    const old = process.env.SCENARIO_DIR;
    process.env.SCENARIO_DIR = dir;
    try {
      const { cardVerdict } = await import("../src/lib/runs.ts");
      expect(await cardVerdict("scenario-good")).toEqual({ verdict: "unverifiable", incomplete: true });
      const Home = (await import("../src/app/page.tsx")).default;
      expect(renderToStaticMarkup(await Home())).toContain("Recording incomplete");
    } finally { if (old === undefined) delete process.env.SCENARIO_DIR; else process.env.SCENARIO_DIR = old; }
  });
});

describe("M-A: a Not matching card is never shown as 'Recording incomplete'", () => {
  it("scenario-bad-tampered-rules (no records folder) is Not matching and not incomplete; scenario-good stays incomplete", async () => {
    const { cardVerdict } = await import("../src/lib/runs.ts");
    expect(await cardVerdict("scenario-bad-tampered-rules")).toEqual({ verdict: "not_matching", incomplete: false });
    expect(await cardVerdict("scenario-good")).toEqual({ verdict: "unverifiable", incomplete: false });
    const Home = (await import("../src/app/page.tsx")).default;
    const html = renderToStaticMarkup(await Home());
    const card = html.slice(html.indexOf("scenario-bad-tampered-rules"), html.indexOf("scenario-no-agent-close"));
    void card;
    expect(card).toContain("Not matching");
    expect(card).not.toContain("Recording incomplete");
  });
});

describe("a missing record file in a recording is Unverifiable (a recording is a single source)", () => {
  it("the good run with an empty records folder: every action row says the recording has no file, never Not matching", async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, copyFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "scenario-norec-"));
    mkdirSync(join(dir, "records"));
    symlinkSync(resolve(DIR, "good.sandbox-a.json"), join(dir, "good.sandbox-a.json"));
    copyFileSync(join(DIR, "pins.json"), join(dir, "pins.json"));
    const rows = await checkRun(loadScenario("good", dir));
    for (const n of ["Action 1: Swap", "Action 2: Open", "Action 3: ClosePosition"]) {
      expect(row(rows, n).verdict, n).toBe("unverifiable");
      expect(row(rows, n).text).toBe("Can't check: this recording has no file for this decision record. A recording is a single source and cannot show that a record was never published.");
    }
    expect(worst(rows.map((r) => r.verdict))).toBe("unverifiable");
  });
  it("a record file that hashes wrongly is still Not matching", async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, copyFileSync, readdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "scenario-wrong-"));
    mkdirSync(join(dir, "records"));
    symlinkSync(resolve(DIR, "good.sandbox-a.json"), join(dir, "good.sandbox-a.json"));
    copyFileSync(join(DIR, "pins.json"), join(dir, "pins.json"));
    for (const f of readdirSync(join(DIR, "records"))) writeFileSync(join(dir, "records", f), "{}");
    const rows = await checkRun(loadScenario("good", dir));
    expect(row(rows, "Action 1: Swap").verdict).toBe("not_matching");
    expect(row(rows, "Action 1: Swap").text).toBe("The decision record does not match its hash.");
  });
});
