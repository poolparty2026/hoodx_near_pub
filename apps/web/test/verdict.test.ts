import { describe, expect, it } from "vitest";
import { VERDICTS, worst, VERDICT_TEXT, VERDICT_MOOD } from "../src/lib/verdict.ts";

describe("worst (EC-W18)", () => {
  it("no findings is unverifiable, never matching", () => {
    expect(worst([])).toBe("unverifiable");
  });
  it("all matching is matching", () => {
    expect(worst(["matching", "matching"])).toBe("matching");
  });
  it("not matching beats unverifiable beats matching", () => {
    expect(worst(["matching", "unverifiable"])).toBe("unverifiable");
    expect(worst(["unverifiable", "not_matching", "matching"])).toBe("not_matching");
  });
  it("could not act is above matching and below not matching (EC-W20)", () => {
    expect(worst(["matching", "could_not_act"])).toBe("could_not_act");
    expect(worst(["could_not_act", "not_matching"])).toBe("not_matching");
  });
  it("GUESS pinned: could not act ranks below unverifiable until the co-leads decide otherwise", () => {
    expect(worst(["could_not_act", "unverifiable"])).toBe("unverifiable");
    expect(worst(["unverifiable", "could_not_act"])).toBe("unverifiable");
  });
  it("order does not matter", () => {
    const a = worst(["not_matching", "matching", "could_not_act"]);
    const b = worst(["could_not_act", "matching", "not_matching"]);
    expect(a).toBe(b);
  });
});

describe("labels", () => {
  it("every verdict has text and a mood", () => {
    for (const v of VERDICTS) {
      expect(VERDICT_TEXT[v].length).toBeGreaterThan(0);
      expect(VERDICT_MOOD[v]).toBeTruthy();
    }
  });
  it("not matching shows Cute-rekt and matching shows Happy", () => {
    expect(VERDICT_MOOD.not_matching).toBe("cute-rekt");
    expect(VERDICT_MOOD.matching).toBe("happy");
  });
});
