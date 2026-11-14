import { describe, expect, it } from "vitest";
import { verdictOf, type VerifierStatus } from "../src/lib/verdict-map.ts";

describe("the verifier's three results map to a verdict (EC-W18)", () => {
  it("matching is Matching, not_matching is Not matching, cant_check is Unverifiable (never a pass)", () => {
    expect(verdictOf("matching")).toBe("matching");
    expect(verdictOf("not_matching")).toBe("not_matching");
    expect(verdictOf("cant_check")).toBe("unverifiable");
  });
  it("an unknown status (a newer library) is Unverifiable, never Matching", () => {
    for (const s of ["maybe", "", "MATCHING", "ok"]) expect(verdictOf(s as VerifierStatus)).toBe("unverifiable");
  });
});
