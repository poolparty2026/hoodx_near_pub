// How the page consumes a verifier's three-way result (packages/rules: verifyDecisionRecordAgainstChain, once it lands).
// The switch is exhaustive on purpose: a new result added in packages/rules fails to compile here, and `cant_check` can never be
// shown as a pass. A result this code doesn't know at run time (a version skew) is Unverifiable, never Matching.
import type { Verdict } from "./verdict.ts";

export type VerifierStatus = "matching" | "not_matching" | "cant_check";

export function verdictOf(status: VerifierStatus): Verdict {
  switch (status) {
    case "matching": return "matching";
    case "not_matching": return "not_matching";
    case "cant_check": return "unverifiable";
    default: {
      const unreachable: never = status;
      void unreachable;
      return "unverifiable"; // an unknown status from a newer library is "can't check"
    }
  }
}
