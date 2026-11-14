# Deploying the page (Vercel), for Erik

Prepared, not run: nobody on this team has deployed it. Everything marked **unverified** is Vercel behaviour we have not seen. The commands in "Verified locally" were run from a clean clone on Node 22.23 and pnpm 10.28. No secrets, tokens or accounts are needed.

## What it is

A Next.js 16 app (`apps/web`) in a pnpm monorepo. It has no database and no wallet. It renders hand-made runs and the backend's sandbox recordings (`fixtures/scenario/`). It reads no chain and no live strategy.

## Vercel project settings (unverified)

- Import the repository, branch `web/check-page` (or the branch a co-lead names). Framework preset: Next.js.
- **Root Directory: `apps/web`.** Keep "Include source files outside of the Root Directory in the Build Step" on (the default): the app imports `packages/rules` from the workspace, and the recordings live in `fixtures/scenario/` at the repository root.
- **Node.js Version: 22.x.** pnpm comes from `packageManager` (`pnpm@10.28.0`) in the root `package.json`; Vercel reads it through Corepack.
- Install: `pnpm install --frozen-lockfile`. Build: `pnpm build` (runs `next build`). Output: default. No `vercel.json` is needed.
- `apps/web/next.config.mjs` sets `outputFileTracingRoot` to the repository root and includes only what the page reads: one recording per run (`*.sandbox-a.json`; the two providers are byte-identical, so the `-b` files are not shipped and the page reads one file twice), `records/*.txt` and `pins.json`, about 50 MB. Checked locally: the build's trace file for `/check/[strategy]` lists those files. Whether Vercel keeps them at run time is **unverified**; the smoke list below catches it (`/check/scenario-good` would read Unverifiable "recording could not be read").

## Verified locally (clean clone)

```sh
pnpm install --frozen-lockfile
pnpm --filter web exec next typegen
pnpm --filter web build
pnpm --filter web start      # http://localhost:3000
```

## Environment variables

- `RECORDS_BASE_URLS`: **leave unset.** No records host exists and no hostname is chosen. Unset means the page has no host; any run that needs decision texts reads Unverifiable. It is only used for runs that fetch records, and none do on this deployment. When a host exists: comma-separated https URLs, at least two (one host cannot convict, see the README); the Content Security Policy picks the origins up automatically.
- `SCENARIO_DIR`: leave unset (default is `fixtures/scenario/` in the repository).

## What is NOT live

No strategy has run on mainnet. Nothing on the site is a live strategy. `/check/fixture-*` runs are made by hand. `/check/scenario-*` runs are recordings of a local sandbox (one node, read twice). Any other id reads Unverifiable "nothing was checked". Viewing keys, alerts and a live-strategy check are not built. The pages say all of this; do not describe the site otherwise.

## Smoke list after deploying

1. `/` returns 200: six run cards; Matching only on "A run that matches".
2. `/check/fixture-good` returns 200: result Matching, banner "Sample data".
3. `/check/scenario-good`: result Unverifiable only on the account row (creation block not established), every action row Matching, label "Recorded sandbox run on one node, read twice...". If it says "the recording for this run could not be read", the recordings were not shipped (see above).
4. `/check/scenario-bad-tampered-rules`: Not matching on the rules row.
5. `/check/not-a-run`: Unverifiable, "nothing was checked", and never Matching.
6. Headers on `/`: `content-security-policy` (script-src with a nonce and `strict-dynamic`, `frame-ancestors 'none'`), `x-content-type-options: nosniff`, `referrer-policy: no-referrer`. Pages are rendered per request (the nonce), so none may be cached statically. The proxy (`src/proxy.ts`) running on Vercel is **unverified**.
7. `curl -s <url>/check/%3Cimg%20src=x%3E` shows the text escaped, never an element.

## Rollback

There is no data and no migration. In Vercel: Deployments, pick the last good one, "Promote to Production" (instant rollback). To take the site down, remove the production domain or pause the project. Nothing outside the project changes.
