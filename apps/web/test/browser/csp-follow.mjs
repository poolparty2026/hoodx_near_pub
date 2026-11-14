// Real-browser check (Playwright, built app): a client-side navigation from another page to a /follow page must not leave
// the testnet RPC blocked by the Content Security Policy. Run: pnpm --filter web build && node apps/web/test/browser/csp-follow.mjs
// Exit code 0 = no CSP violation for a testnet RPC; 1 = a violation (Buy would fail silently).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");
const PORT = Number(process.env.PORT ?? 3222), BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("pnpm", ["--filter", "web", "exec", "next", "start", "-p", String(PORT), "-H", "127.0.0.1"], { stdio: "ignore" });
let failed = false;
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE)).ok) break; } catch { /* not up */ } await sleep(500); }
  const browser = await chromium.launch();
  for (const start of ["/", "/check/fixture-good", "/strategies"]) {
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript(() => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
    await page.goto(BASE + start, { waitUntil: "networkidle" });
    // Worst case: a client-side (soft) navigation, as Next's router would do for a <Link>. A link is injected and clicked.
    await page.evaluate(() => window.next.router.push("/follow/strategy.fixture.testnet"));
    await page.waitForURL("**/follow/**");
    await page.getByRole("button", { name: "Load from testnet" }).waitFor();
    // The page's own code path: ask both testnet RPCs. Whether the sandbox network lets the request through does not matter;
    // only a CSP violation does.
    await page.evaluate(async () => { for (const u of ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"]) { try { await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); } catch { /* network */ } } });
    await sleep(500);
    const violations = (await page.evaluate(() => window.__csp)).filter((v) => /rpc/.test(v));
    console.log(`${start} -> /follow (soft navigation): ${violations.length === 0 ? "no CSP violation" : "CSP VIOLATIONS: " + violations.join("; ")}`);
    if (violations.length > 0) failed = true;
  }
  await browser.close();
} finally { server.kill("SIGTERM"); }
process.exit(failed ? 1 : 0);
