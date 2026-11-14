import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy, config } from "../src/proxy.ts";

const csp = () => proxy(new NextRequest("http://localhost/check/x")).headers.get("content-security-policy")!;

describe("the Content Security Policy (defence in depth for EC-W04)", () => {
  it("has a fresh nonce on every request", () => {
    const n = (s: string) => /'nonce-([^']+)'/.exec(s)![1];
    expect(n(csp())).not.toBe(n(csp()));
  });
  it("allows no inline script and no framing, plugins or base tag", () => {
    const c = csp();
    const script = c.split("; ").find((d) => d.startsWith("script-src"))!;
    expect(script).not.toContain("unsafe-inline");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).toContain("'wasm-unsafe-eval'"); // libsodium needs WebAssembly compilation; not JS eval
    expect(c).toContain("frame-ancestors 'none'");
    expect(c).toContain("object-src 'none'");
    expect(c).toContain("base-uri 'none'");
    expect(c).toContain("default-src 'self'");
  });
  it("passes the same nonce to the app as the one in the policy", () => {
    const res = proxy(new NextRequest("http://localhost/"));
    const inPolicy = /'nonce-([^']+)'/.exec(res.headers.get("content-security-policy")!)![1];
    // GUESS: this header name is how Next.js hands request headers on; update it if Next changes it.
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(inPolicy);
  });
  it("uses strict-dynamic, no unsafe style source for scripts, and only the RPC origin for connections", () => {
    const c = csp();
    expect(c).toContain("'strict-dynamic'");
    expect(c).toContain("style-src 'self' 'unsafe-inline'");
    expect(c).toContain("connect-src 'self' https://free.rpc.fastnear.com https://rpc.testnet.near.org https://test.rpc.fastnear.com;");
  });
  it("every page renders per request, so the nonce can be attached (test L10)", async () => {
    const layout = await import("../src/app/layout.tsx");
    expect(layout.dynamic).toBe("force-dynamic");
  });
  it("skips only static assets", () => {
    expect(JSON.stringify(config.matcher)).toContain("_next/static");
  });
});

describe("the records hosts in connect-src (from RECORDS_BASE_URLS)", () => {
  it("adds exactly the origins of the configured hosts, and nothing when unset", () => {
    const old = process.env.RECORDS_BASE_URLS;
    try {
      process.env.RECORDS_BASE_URLS = "https://records.example/x, javascript:alert(1)";
      expect(csp()).toContain("connect-src 'self' https://free.rpc.fastnear.com https://rpc.testnet.near.org https://test.rpc.fastnear.com https://records.example;");
      delete process.env.RECORDS_BASE_URLS;
      expect(csp()).toContain("connect-src 'self' https://free.rpc.fastnear.com https://rpc.testnet.near.org https://test.rpc.fastnear.com;");
    } finally {
      if (old === undefined) delete process.env.RECORDS_BASE_URLS; else process.env.RECORDS_BASE_URLS = old;
    }
  });
});

import { TESTNET_RPCS } from "../src/lib/keys/rpcs.ts";
import { TESTNET_RPCS as CHAIN_RPCS } from "../src/lib/keys/chain.ts";
import { TESTNET_RPC as WALLET_RPC } from "../src/lib/keys/wallet.ts";
describe("M1: every RPC the follow flow uses is allowed by connect-src", () => {
  it("chain.ts and wallet.ts use the same constants the policy is built from", () => {
    const connect = proxy(new NextRequest("http://localhost/follow/s.testnet")).headers.get("content-security-policy")!.split("; ").find((d) => d.startsWith("connect-src"))!;
    expect([...CHAIN_RPCS]).toEqual([...TESTNET_RPCS]);
    for (const u of [...CHAIN_RPCS, WALLET_RPC]) expect(connect).toContain(new URL(u).origin);
  });
});

describe("A3: the testnet RPC origins are allowed on every page (a client-side navigation keeps the old policy)", () => {
  const at = (path: string) => proxy(new NextRequest(`http://localhost${path}`)).headers.get("content-security-policy")!;
  it("present on /follow, the check page, the home page and the strategies pages", () => {
    for (const o of ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"]) for (const p of ["/follow/s.testnet", "/check/x", "/", "/strategies"]) expect(at(p)).toContain(o);
  });
});
