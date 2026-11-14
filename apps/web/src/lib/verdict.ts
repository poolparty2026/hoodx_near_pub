// Verdict levels for the check page (ARCHITECTURE section 8, EC-W13, EC-W18, EC-W20).
// GUESS, to confirm with the co-leads: where "could not act" ranks against "unverifiable".
// The documents fix only: not matching beats unverifiable beats matching (EC-W18), and
// "could not act" sits below "matching" and above "not matching" (EC-W20).
// Here: matching < could not act < unverifiable < not matching, so the worst finding wins.

export const VERDICTS = ["matching", "could_not_act", "unverifiable", "not_matching"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_TEXT: Record<Verdict, string> = {
  matching: "Matching",
  could_not_act: "Could not act",
  unverifiable: "Unverifiable",
  not_matching: "Not matching",
};

const RANK: Record<Verdict, number> = { matching: 0, could_not_act: 1, unverifiable: 2, not_matching: 3 };

/** The run's verdict is the worst finding. No findings at all is unverifiable, never matching. */
export function worst(findings: readonly Verdict[]): Verdict {
  let out: Verdict | undefined;
  for (const f of findings) if (out === undefined || RANK[f] > RANK[out]) out = f;
  return out ?? "unverifiable";
}

/** Brand: Hoody's mood for a verdict (hoodx-brand skill). */
export const VERDICT_MOOD: Record<Verdict, "happy" | "sleepy" | "shh" | "cute-rekt"> = {
  matching: "happy",
  could_not_act: "sleepy",
  unverifiable: "shh",
  not_matching: "cute-rekt",
};
