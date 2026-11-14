import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

// Every page needs the per-request nonce from src/proxy.ts, so none may be prerendered.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "hoodx on NEAR",
  description: "hoodx on NEAR: rules are committed by hash before a run. The check at close is in progress and today reads only hand-made runs and sandbox recordings.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: [{ media: "(prefers-color-scheme: light)", color: "#fffaf3" }, { media: "(prefers-color-scheme: dark)", color: "#1c1d3d" }] };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-10 focus:rounded-lg focus:bg-butter focus:px-3 focus:py-1.5 focus:font-bold focus:text-navy">Skip to content</a>
        <div aria-hidden className="flex h-1.5 w-full">
          <div className="bg-mint" style={{ width: "55%" }} />
          <div className="bg-lavender" style={{ width: "25%" }} />
          <div className="bg-peach" style={{ width: "20%" }} />
        </div>
        <header className="mx-auto flex max-w-3xl items-center gap-2 px-4 py-4">
          <picture>
            <source media="(prefers-color-scheme: light)" srcSet="/hoodx-wordmark.svg" />
            <img src="/hoodx-wordmark-on-dark.svg" alt="hoodx" height={36} style={{ height: 36, width: "auto" }} />
          </picture>
          <span className="text-lg font-bold tracking-tight">on NEAR</span>
          <nav className="ml-auto text-sm"><a className="underline" href="/journey">The whole process</a></nav>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto max-w-3xl px-4 pb-16">{children}</main>
        <footer className="mx-auto max-w-3xl px-4 pb-8 text-sm text-muted">
          hoodx on NEAR - an autonomous LP agent. Rules are committed by hash; the check page reads hand-made sample runs and sandbox recordings for now.
        </footer>
      </body>
    </html>
  );
}
