import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { Findings } from "../src/components/Findings.tsx";
import CheckPage from "../src/app/check/[strategy]/page.tsx";

const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>';

describe("EC-W04 / EC-W11: untrusted text is rendered as text", () => {
  it("Findings escapes markup in titles and texts", () => {
    const html = renderToStaticMarkup(<Findings rows={[{ title: EVIL, verdict: "not_matching", text: EVIL }]} />);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
  });
  it("the check page escapes the strategy id from the URL", async () => {
    const html = renderToStaticMarkup(await CheckPage({ params: Promise.resolve({ strategy: EVIL }) }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
  it("no source file uses dangerouslySetInnerHTML or innerHTML", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    for (const f of walk(new URL("../src", import.meta.url).pathname)) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML/);
    }
  });
});

describe("the check page on recorded runs", () => {
  it("a good recorded run shows Matching under the sample banner, and the not-checked list", async () => {
    const html = renderToStaticMarkup(await CheckPage({ params: Promise.resolve({ strategy: "fixture-good" }) }));
    expect(html).toContain("Sample data");
    expect(html).toContain(">Matching<");
    expect(html).toContain("Not checked in this version");
  });
  it("a bad recorded run shows Not matching", async () => {
    const html = renderToStaticMarkup(await CheckPage({ params: Promise.resolve({ strategy: "fixture-tampered-rules" }) }));
    expect(html).toContain(">Not matching<");
  });
  it("EC-W08: any other id is Unverifiable and says nothing was checked, never Matching", async () => {
    const html = renderToStaticMarkup(await CheckPage({ params: Promise.resolve({ strategy: "somebody.near" }) }));
    expect(html).toContain("Unverifiable");
    expect(html).toContain("nothing about this account has been checked");
    expect(html).not.toContain(">Matching<");
  });
});

describe("the home page: the runs a judge opens first", () => {
  it("lists the hand-made and recorded runs with the verdict the page computes, and says nothing is live", async () => {
    const Home = (await import("../src/app/page.tsx")).default;
    const html = renderToStaticMarkup(await Home());
    for (const id of ["fixture-good", "fixture-tampered-rules", "fixture-missed-close", "scenario-good", "scenario-bad-tampered-rules", "scenario-no-agent-close"]) {
      expect(html).toContain(`/check/${id}`);
    }
    expect(html).toContain("No strategy has run on mainnet");
    expect(html).toContain("hand-made");
    expect(html).toContain("sandbox recording");
    expect(html).toContain(">Matching<");   // the hand-made good run
    expect(html).toContain(">Not matching<"); // the bad runs
  });
  it("the verdicts are the check's own, not stored: the good hand-made run Matching, the tampered ones Not matching", async () => {
    const { verdictFor } = await import("../src/lib/runs.ts");
    expect(await verdictFor("fixture-good")).toBe("matching");
    expect(await verdictFor("fixture-tampered-rules")).toBe("not_matching");
    expect(await verdictFor("fixture-missed-close")).toBe("not_matching");
    expect(await verdictFor("scenario-bad-tampered-rules")).toBe("not_matching");
  });
});

describe("every verdict screen carries the not-checked list, valuation line first (claims-checker, Q15)", () => {
  it("the sample pages and the check page show the spot-valuation disclosure", async () => {
    const Sample = (await import("../src/app/sample/[case]/page.tsx")).default;
    const html = renderToStaticMarkup(await Sample({ params: Promise.resolve({ case: "good" }) }));
    expect(html).toContain("Not checked in this version");
    expect(html).toContain("spot point at each sampled block (Q15)");
    expect(html).toContain("a price moved across the whole confirmation span would pass");
    const check = renderToStaticMarkup(await CheckPage({ params: Promise.resolve({ strategy: "fixture-good" }) }));
    expect(check).toContain("spot point at each sampled block (Q15)");
  });
});

describe("accessibility: landmarks, headings, names, colour is not the only signal", () => {
  it("the layout has a skip link, a banner, a main landmark with an id, and a footer", async () => {
    const Layout = (await import("../src/app/layout.tsx")).default;
    const html = renderToStaticMarkup(Layout({ children: <p>x</p> }));
    expect(html).toContain('href="#main"');
    expect(html).toContain("Skip to content");
    expect(html).toContain('<main id="main"');
    expect(html).toContain("<header");
    expect(html).toContain("<footer");
    expect(html).toContain('<html lang="en"');
  });
  it("the result is a heading, and the verdict is written as text (not only a colour or a drawing)", async () => {
    const html = renderToStaticMarkup(await CheckPage({ params: Promise.resolve({ strategy: "fixture-tampered-rules" }) }));
    expect(html).toContain(">Result</h2>");
    expect(html).toContain(">Not matching<");
    expect(html.match(/<h1/g)?.length).toBe(1);
  });
  it("on the home cards the verdict is in the text and Hoody is decorative (no duplicated name)", async () => {
    const Home = (await import("../src/app/page.tsx")).default;
    const html = renderToStaticMarkup(await Home());
    expect(html).not.toContain('role="img"');
    expect(html).toContain('aria-hidden="true"');
    expect(html.match(/<h1/g)?.length).toBe(1);
    expect(html.match(/<h3/g)?.length).toBe(6);
  });
});
