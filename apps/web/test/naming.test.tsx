import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Home from "../src/app/page.tsx";
import Strategies from "../src/app/strategies/page.tsx";
import Layout, { metadata } from "../src/app/layout.tsx";
import { config } from "../src/proxy.ts";

describe("D60 naming: hoodx and Hoody", () => {
  it("the home page and the layout say hoodx on NEAR and never the old names", async () => {
    const home = renderToStaticMarkup(await Home());
    const shell = renderToStaticMarkup(<Layout>{null}</Layout>);
    expect(home).toContain("hoodx on NEAR");
    expect(String(metadata.title)).toBe("hoodx on NEAR");
    for (const out of [home, shell, renderToStaticMarkup(<Strategies />), String(metadata.description)]) expect(out).not.toMatch(/Poolside|Pooly|pooly/);
    expect(shell).toContain('alt="hoodx"');
  });
  it("Hoody art and the wordmarks exist and the CSP matcher lets them through", () => {
    for (const f of ["hoodx-wordmark.svg", "hoodx-wordmark-on-dark.svg", "hoody/hoody-happy.svg", "hoody/hoody-rekt.svg", "hoody/hoody-shh.svg", "hoody/hoody-wow.svg", "hoody/hoody-hype.svg", "hoody/hoody-sleepy.svg"]) expect(existsSync(fileURLToPath(new URL(`../public/${f}`, import.meta.url)))).toBe(true);
    expect(JSON.stringify(config)).toContain("hoody/");
  });
  it("the stylesheet uses --hx-* tokens only", () => {
    const css = readFileSync(fileURLToPath(new URL("../src/app/globals.css", import.meta.url)), "utf8");
    expect(css).not.toContain("--ps-");
    expect(css).toContain("--hx-navy");
  });
});
