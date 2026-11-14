import { describe, expect, it, vi } from "vitest";

// The shared record check (packages/rules) now catches an out-of-rules decision first, so no record can reach withinRules
// and be refused there. This test keeps the withinRules call from being removed unnoticed: with checkAction made to refuse,
// an otherwise good run must show Not matching on its action rows.
vi.mock("../src/lib/checks.ts", async (orig) => {
  const real = await orig<typeof import("../src/lib/checks.ts")>();
  return { ...real, checkAction: () => ({ verdict: "not_matching" as const, text: "refused by the injected withinRules" }) };
});

import { buildFixture } from "../src/lib/fixtures.ts";
import { checkRun } from "../src/lib/run.ts";
import { parseRules, withinRules } from "@poolside/rules";

describe("the withinRules call is wired in (defence in depth)", () => {
  it("EC-W13: a refusal by withinRules shows the action as not matching, with its reason", async () => {
    const rows = await checkRun(buildFixture("good").source);
    const a = rows.filter((r) => r.title.startsWith("Action "));
    expect(a.length).toBe(2);
    for (const r of a) {
      expect(r.verdict).toBe("not_matching");
      expect(r.text).toBe("refused by the injected withinRules");
    }
  });
  it("withinRules alone rejects an out-of-envelope action (the rule it enforces)", () => {
    const rules = parseRules(JSON.stringify({
      version: 1, pool: `${"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"}|wrap.near|100`, quote_token: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      range: { width_bps: 800, centre: "mid" }, take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432_000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    }));
    const s = { nowS: 10_000, startedAtS: 1_000, point: -400, valuationPoint: -400, block: 50, confirmFromBlock: null, position: null, closedBy: null, principal: 250_000_000n, holdings: { quote: 250_000_000n, base: 0n }, fees: { quote: 0n, base: 0n } };
    expect(withinRules(rules, s, { kind: "open", left: -1600, right: -800 })).toEqual({ ok: false, reason: "range must contain the current point" });
    expect(withinRules(rules, s, { kind: "close", reason: "stop_loss" })).toEqual({ ok: false, reason: "no close condition holds" });
  });
});
