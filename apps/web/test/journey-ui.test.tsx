// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Journey } from "../src/components/Journey.tsx";
import { BANNER, REC } from "../src/lib/journey/model.ts";

vi.setConfig({ testTimeout: 30_000 });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement, root: Root;
beforeEach(async () => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => { root.render(<Journey verdict={<p>VERDICT-SLOT</p>} />); }); await act(async () => { await new Promise((r) => setTimeout(r, 300)); }); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const btn = (t: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === t) as HTMLButtonElement | undefined;
const click = async (el: HTMLElement) => { await act(async () => { el.click(); await new Promise((r) => setTimeout(r, 100)); }); };
const title = () => host.querySelector("#step-title")!.textContent;

describe("journey stepper", () => {
  it("starts at step 1 with the banner, Back disabled and no rules shown", () => {
    expect(host.querySelector('[data-testid="banner"]')!.textContent).toBe("Simulation on recorded sandbox data. No live strategy, no real tokens.");
    expect(BANNER).toBe(host.querySelector('[data-testid="banner"]')!.textContent);
    expect(title()).toContain("creator writes rules");
    expect(btn("Back")!.disabled).toBe(true);
    expect(host.textContent).toContain(REC.rulesHash);
    expect(host.querySelector("pre")).toBeNull();
    expect(host.textContent).toContain("Real here:");
    expect(host.textContent).toContain("Simulated:");
  });
  it("steps 3, 4 and 5 gate Next until the simulated action is done; step 5 unlocks the real rules", async () => {
    await click(btn("Next")!); // 2
    expect(title()).toBe("Fund and start");
    await click(btn("Next")!); // 3
    expect(title()).toContain("buys a viewing key");
    expect(btn("Next")!.disabled).toBe(true);
    await click(btn("Simulate buy")!);
    expect(host.textContent).toContain("state Escrowed");
    expect(btn("Next")!.disabled).toBe(false);
    await click(btn("Next")!); // 4
    expect(btn("Next")!.disabled).toBe(true);
    await click(btn("Simulate delivery")!);
    expect(host.textContent).toMatch(/sealed key \(160 hex characters, 80 bytes\): [0-9a-f]{160}/);
    await click(btn("Next")!); // 5
    expect(host.querySelector("pre")).toBeNull();
    expect(btn("Next")!.disabled).toBe(true);
    await click(btn("Open the key")!);
    expect(host.textContent).toContain("Hash check: the rules you decrypted match the recorded rules hash");
    expect(host.querySelector("pre")!.textContent).toContain('"stop_loss_bps": 1000');
    expect(btn("Next")!.disabled).toBe(false);
  });
  it("every step keeps the banner and states what is real and what is simulated; the last step has the check", async () => {
    await click(btn("Next")!); await click(btn("Next")!);
    await click(btn("Simulate buy")!); await click(btn("Next")!);
    await click(btn("Simulate delivery")!); await click(btn("Next")!);
    await click(btn("Open the key")!);
    for (let i = 5; i <= 8; i++) {
      if (i > 5) await click(btn("Next")!);
      expect(host.querySelector('[data-testid="banner"]')!.textContent).toBe(BANNER);
      expect(host.textContent).toContain("Real here:");
      expect(host.textContent).toContain("Simulated:");
    }
    expect(title()).toBe("The check");
    expect(host.textContent).toContain("VERDICT-SLOT");
    expect(btn("Next")!.disabled).toBe(true);
    await click(btn("Back")!);
    expect(title()).toBe("Close and reveal");
    expect(host.querySelector("pre")!.textContent).toContain('"take_profit_bps": 500');
  });
  it("the limits are stated and nothing claims returns, anonymity or a fee number", async () => {
    expect(host.textContent).toContain("Positions on Rhea are public and the strategy wallet is visible there");
    await click(btn("Next")!); await click(btn("Next")!);
    expect(host.textContent).toContain("anyone who holds the key can copy them or pass them on");
    await click(btn("Simulate buy")!); await click(btn("Next")!);
    expect(host.textContent).toContain("single account the buyer has to trust");
    expect(host.textContent).toContain("after delivery there is no refund");
    expect(host.textContent).toContain("If no key arrives within the delivery window, the buyer can take the payment back");
    expect(host.textContent).not.toMatch(/profit|anonymous|unstoppable|return on|%/i);
  });
});
