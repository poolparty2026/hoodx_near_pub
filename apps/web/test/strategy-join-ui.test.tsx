// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { StrategyJoin } from "../src/components/StrategyJoin.tsx";
import SandboxStrategyPage from "../src/app/strategies/sandbox-run/page.tsx";
import { BANNER } from "../src/lib/journey/model.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(async () => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => { root.render(<StrategyJoin />); }); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const btn = (t: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const type = async (v: string) => { await act(async () => { const i = host.querySelector("input")!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(i, v); i.dispatchEvent(new Event("input", { bubbles: true })); }); };
const click = async (el: HTMLElement) => { await act(async () => { el.click(); }); };

describe("simulated join panel", () => {
  it("the review button is disabled for a bad amount and the limit+1 error shows", async () => {
    expect(btn("Review join")!.disabled).toBe(true);
    await type("500.01");
    expect(host.textContent).toContain("The simulation accepts at most 500 USDC, the recorded maximum principal of this strategy.");
    expect(btn("Review join")!.disabled).toBe(true);
    await type("500");
    expect(btn("Review join")!.disabled).toBe(false);
  });
  it("confirm shows exact figures, the limits and no fee or return; join then exit round-trips", async () => {
    await type("100");
    await click(btn("Review join")!);
    const c = host.querySelector('[data-testid="confirm"]')!.textContent!;
    expect(c).toContain("100.00 USDC");
    expect(c).toContain("16.66%");
    expect(c).toContain("100.00 USDC / 600.00 USDC");
    expect(c).toContain("max 50 bps slippage");
    expect(c).toContain("This screen shows no fee figure and no result of any strategy");
    expect(c).toContain("Positions on Rhea are public");
    await click(btn("Simulate join")!);
    const p = host.querySelector('[data-testid="position"]')!.textContent!;
    expect(p).toContain("100.00 USDC");
    expect(p).toContain("lost when you reload");
    await click(btn("Simulate exit")!);
    expect(host.querySelector('[data-testid="position"]')).toBeNull();
    expect(host.querySelector('[data-testid="returned"]')!.textContent).toContain("100.00 USDC returned, exactly the amount put in");
  });
  it("says what is real and what is simulated, with the banner", () => {
    expect(host.textContent).toContain(BANNER);
    expect(host.textContent).toContain("Real here:");
    expect(host.textContent).toContain("Simulated:");
    expect(host.textContent).toContain("funded by the creator alone");
    expect(host.textContent).not.toMatch(/profit|earn|yield|apy|apr|anonymous/i);
  });
});

describe("strategy details page", () => {
  it("shows the recorded details, the rules-private line, the links and no fee split", () => {
    const out = renderToStaticMarkup(<SandboxStrategyPage />);
    for (const t of ["strategy-1.test.near", "5305d16d4187d171527a0b45215ecbf9f78b602de4e0c05081aff899115950ef", "creator.test.near", "agent.test.near", "500.00 USDC", "0.1 NEAR", "The rules are private until close or until a key is bought", 'href="/journey"', 'href="/check/scenario-good"', BANNER]) expect(out).toContain(t);
    expect(out).not.toMatch(/fee split|88%|7%|profit/i);
  });
});
