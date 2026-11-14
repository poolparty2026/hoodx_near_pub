// The Content Security Policy is set per request in src/proxy.ts (it needs a nonce).
import { fileURLToPath } from "node:url";

// The sandbox recordings are read from ../../fixtures/scenario at run time (src/lib/scenario.ts), so a deployment must ship them:
// trace from the repository root and include them explicitly (a dynamic path is not found by the tracer on its own).
export default {
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // Only what the page reads: ONE recording per run (the two providers are byte-identical, so the -b files are not shipped), the decision
  // records and the pins. About 50 MB, not 100.
  outputFileTracingIncludes: { "/**": ["../../fixtures/scenario/*.sandbox-a.json", "../../fixtures/scenario/records/*.txt", "../../fixtures/scenario/pins.json"] },
  // The tracer also picks up the whole folder through the dynamic path; leave out the duplicate -b recordings and the README.
  outputFileTracingExcludes: { "/**": ["../../fixtures/scenario/*.sandbox-b.json", "../../fixtures/scenario/README.md"] },
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ["@poolside/rules"],
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
    ] }];
  },
};
