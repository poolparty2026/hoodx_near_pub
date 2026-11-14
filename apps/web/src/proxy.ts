import { NextResponse, type NextRequest } from "next/server";
import { recordsOrigins } from "@/lib/records-host.ts";
import { rpcOrigins } from "@/lib/keys/rpcs.ts";

// A fresh nonce per request: Next adds it to its own scripts, and nothing else inline may run.
// 'strict-dynamic' lets those trusted scripts load their chunks. No 'unsafe-inline' for scripts.
// The testnet RPC origins are allowed on EVERY page, not only /follow. A client-side navigation (Next's router) keeps the
// Content Security Policy of the page it started from, so a policy scoped to /follow would silently block Buy after a click from
// another page. The cost: the other pages (check, strategies) may also connect to those two testnet RPC hosts, a slightly wider
// channel for script that already ran there; scripts are limited by the nonce and no inline script runs. Checked in a real browser
// by test/browser/csp-follow.mjs.
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    // Allowed connections: the fixed RPC origin, the two testnet RPC origins from lib/keys/rpcs.ts, and the records hosts from RECORDS_BASE_URLS (none by default).
    ["connect-src 'self' https://free.rpc.fastnear.com", ...rpcOrigins(), ...recordsOrigins()].join(" "),
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|hoody/|hoodx-wordmark).*)" }],
};
