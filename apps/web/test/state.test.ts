import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalize, stateJson, RulesError, type MarketState } from "@poolside/rules";
import { stateViewsSource, STATE_CONTEXT, FIXTURE_STATES } from "../src/lib/fixtures.ts";
import { stateAtBlock } from "../src/lib/state.ts";

const same = (a: MarketState, b: MarketState) => canonicalize(stateJson(a)) === canonicalize(stateJson(b));
const ctx = (c: Partial<typeof STATE_CONTEXT & { closedBy: null; confirmFromBlock: number | null }> = {}) => ({ ...STATE_CONTEXT, closedBy: null, confirmFromBlock: null, ...c });

describe("the state rebuilt from views at a block (mirrors the agent's sample)", () => {
  it("round trip: the hand-made states come back exactly", async () => {
    for (const st of [FIXTURE_STATES.flat, FIXTURE_STATES.close()]) {
      const src = stateViewsSource([st]);
      expect(same(await stateAtBlock(src, ctx({ confirmFromBlock: st.confirmFromBlock }), st.block), st)).toBe(true);
    }
  });
  it("property: any state the views can express round-trips (holdings, fees, point, position)", async () => {
    await fc.assert(fc.asyncProperty(
      fc.record({
        block: fc.integer({ min: 1, max: 100_000 }),
        age: fc.integer({ min: 0, max: 400_000 }),
        point: fc.integer({ min: -800_000, max: 800_000 }),
        principal: fc.bigInt({ min: 0n, max: 10n ** 30n }),
        q: fc.bigInt({ min: 0n, max: 10n ** 30n }), b: fc.bigInt({ min: 0n, max: 10n ** 30n }),
        fq: fc.bigInt({ min: 0n, max: 10n ** 20n }), fb: fc.bigInt({ min: 0n, max: 10n ** 20n }),
        pos: fc.option(fc.record({ left: fc.integer({ min: -800_000, max: 799_999 }), w: fc.integer({ min: 1, max: 1000 }) }), { nil: null }),
      }),
      async (g) => {
        const st: MarketState = {
          nowS: 1_000_000 + g.block + g.age, startedAtS: 900_000, point: g.point, valuationPoint: g.point, block: g.block,
          confirmFromBlock: null, position: g.pos === null ? null : { left: g.pos.left, right: Math.min(g.pos.left + g.pos.w, 800_000) },
          closedBy: null, principal: g.principal, holdings: { quote: g.q, base: g.b }, fees: { quote: g.fq, base: g.fb },
        };
        if (st.position !== null && st.position.left >= st.position.right) return;
        return same(await stateAtBlock(stateViewsSource([st]), ctx(), g.block), st);
      },
    ), { numRuns: 60 });
  });
  it("EC-W08: every view the state is made of is needed: one provider failing on it means no state (never a guess)", async () => {
    const st = FIXTURE_STATES.close(); // has a position, so every view is used
    for (const m of ["block", "get_started_at", "get_principal", "get_fees_collected", "get_pool", "ft_balance_of", "list_user_assets", "get_platform_owed", "get_own_position", "get_liquidity", "predict_remove_liquidity", "get_config", "get_limits"]) {
      await expect(stateAtBlock(stateViewsSource([st], 1000, (x) => x === m), ctx({ confirmFromBlock: st.confirmFromBlock }), st.block), m).rejects.toThrow(RulesError);
    }
  });
  it("providers that disagree on a view give no state", async () => {
    const st = FIXTURE_STATES.flat;
    const src = stateViewsSource([st]);
    const other = stateViewsSource([{ ...st, point: st.point + 1 }]);
    await expect(stateAtBlock({ ...src, b: other.b }, ctx(), st.block)).rejects.toThrow(RulesError);
  });
  it("the strategy's pool or quote token must be the rules': otherwise the state can't be rebuilt", async () => {
    const st = FIXTURE_STATES.flat;
    await expect(stateAtBlock(stateViewsSource([st]), ctx({ pool: "other|pool|100" }), st.block)).rejects.toThrow(/not the rules'/);
    await expect(stateAtBlock(stateViewsSource([st]), ctx({ quoteToken: "other.near" }), st.block)).rejects.toThrow(/not the rules'/);
  });
  it("a block that was not recorded can't be rebuilt", async () => {
    await expect(stateAtBlock(stateViewsSource([FIXTURE_STATES.flat]), ctx(), 51)).rejects.toThrow(/could not be read/);
  });
});
