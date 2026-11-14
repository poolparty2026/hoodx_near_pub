import { describe, expect, it } from "vitest";
import { SAMPLE_CASES, sampleRows } from "../src/lib/sample.ts";
import { worst } from "../src/lib/verdict.ts";

describe("sample runs (plan: a good run matches, a bad run does not)", () => {
  it("good: every check is matching", () => {
    const rows = sampleRows("good");
    expect(rows.map((r) => r.verdict)).toEqual(["matching", "matching", "matching", "matching"]);
  });
  it("tampered rules: not matching", () => {
    expect(worst(sampleRows("tampered-rules").map((r) => r.verdict))).toBe("not_matching");
    expect(sampleRows("tampered-rules")[0]!.text).toBe("The revealed rules do not match the commitment.");
  });
  it("missed close: not matching, naming the blocks", () => {
    const r = sampleRows("missed-close")[3]!;
    expect(r.verdict).toBe("not_matching");
    expect(r.text).toBe("A close was missed: stop loss was due from block 0 to block 440.");
  });
  it("not revealed: unverifiable, never matching", () => {
    expect(worst(sampleRows("not-revealed").map((r) => r.verdict))).toBe("unverifiable");
  });
  it("not revealed: every row that needs the rules is unverifiable too (EC-W09)", () => {
    expect(sampleRows("not-revealed").map((r) => r.verdict)).toEqual(["unverifiable", "matching", "unverifiable", "unverifiable"]);
  });
  it("every case has the same four checks", () => {
    for (const c of SAMPLE_CASES) expect(sampleRows(c).map((r) => r.title)).toHaveLength(4);
  });
});
