import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import StrategiesPage from "../src/app/strategies/page.tsx";
import StrategyPage from "../src/app/strategies/[id]/page.tsx";
import { SAMPLE_STRATEGIES, findStrategy } from "../src/lib/strategies.ts";

const html = async (id: string) => renderToStaticMarkup(await StrategyPage({ params: Promise.resolve({ id }) }));

describe("strategy screens (sample data)", () => {
  it("the list shows every strategy and says it is sample data", () => {
    const out = renderToStaticMarkup(<StrategiesPage />);
    for (const s of SAMPLE_STRATEGIES) expect(out).toContain(s.name);
    expect(out).toContain("Sample data. Not a real strategy");
  });
  it("a live strategy has hidden rules and no buy button until the key sale exists", async () => {
    const out = await html("steady-range");
    expect(out).toContain("Rules are private until close or until a key is bought");
    expect(out).toContain("Viewing keys: written for testnet and tested end to end in a local sandbox by script; not run on testnet or mainnet.");
    expect(out).not.toContain("<button");
  });
  it("a closed strategy has revealed rules and links to a check", async () => {
    const out = await html("weekend-tight");
    expect(out).toContain("In this sample the rules are revealed");
    expect(out).toContain('href="/sample/good"');
  });
  it("an unknown id is a not-found, never a crash or a made-up strategy", async () => {
    await expect(html("<img src=x onerror=alert(1)>")).rejects.toThrow();
    expect(findStrategy("nope")).toBeUndefined();
  });
  it("no screen shows a fee split number (gate 5 is not settled)", async () => {
    for (const s of SAMPLE_STRATEGIES) expect(await html(s.id)).not.toMatch(/\d+\s*%\s*\/\s*\d+\s*%/);
  });
  it("no copy claims returns or anonymity", async () => {
    const all = renderToStaticMarkup(<StrategiesPage />) + (await Promise.all(SAMPLE_STRATEGIES.map((s) => html(s.id)))).join("");
    expect(all).not.toMatch(/guarantee|beats the market|anonymous|unstoppable|can'?t be (shared|resold)/i);
  });
});
