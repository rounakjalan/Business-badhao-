# Hermes Browser Runtime

The real, separate, always-available process that performs Instagram lead
discovery for Business Badhao using a genuine local Chromium browser — this
is the "Hermes runtime" the discovery architecture refers to. It is **not**
part of the Next.js app and is **never deployed to Vercel**: Vercel's
serverless execution model cannot host a persistent, authenticated browser
session (functions are short-lived and stateless), so this runs instead as an
ordinary long-lived process on a machine you provision and operate yourself
— a spare desktop/server you already have, a small VPS, a home server, a
self-managed container host, whatever you already control. This repository
does not choose or provision that machine for you.

Uses **puppeteer-core** (Chrome DevTools Protocol) driving a **real,
locally-installed** Chrome or Chromium binary. Not Playwright, not
Browserbase, not any cloud browser service, not TinyFish — genuinely local.

## What this is (and isn't)

- **Is**: a small Node.js program that opens a real Chromium window, lets a
  human log into one organization's own Instagram account manually, saves
  that authenticated session to a dedicated local profile directory, and
  later reuses it to perform real searches on Instagram's own web UI when
  Business Badhao asks it to.
- **Isn't**: an API client for a documented Instagram search endpoint (no
  such public endpoint exists) — it drives a real browser exactly the way a
  human would, by navigating and typing into Instagram's own pages.
- **Isn't**: a way around Instagram's own security. If Instagram shows a
  CAPTCHA, a "confirm it's you" challenge, or 2FA, this runtime stops and
  reports it honestly (`browser_unavailable`) rather than attempting to
  solve or bypass it — a human must resolve it by re-running `login.mjs` and
  completing that challenge themselves in the visible browser window.

## Requirements

- Node.js **22.12 or newer** (required by `puppeteer-core`'s current major
  version).
- A real, already-installed Google Chrome or Chromium binary on this same
  machine.
- Outbound network access from this machine to both `instagram.com` and your
  Business Badhao deployment's own URL.
- One dedicated Instagram account per organization you want to run discovery
  for, that you are authorized to operate on that organization's behalf.

## Setup

```bash
cd hermes-browser-runtime
npm install
cp .env.example .env
```

Edit `.env`:

- `BUSINESS_BADHAO_API_URL` — your deployment's base URL.
- `INSTAGRAM_DISCOVERY_RUNTIME_TOKEN` — must be the **exact same value** you
  set as this Vercel deployment's own `INSTAGRAM_DISCOVERY_RUNTIME_TOKEN`
  environment variable. Generate one long random secret (e.g.
  `openssl rand -hex 32`) and set it in both places — this is the
  server-to-server credential that lets this runtime call Business Badhao's
  `session-report`/`jobs/claim`/`jobs/complete` endpoints at all; without it
  those endpoints honestly refuse every request (HTTP 503 `not_configured`).
- `CHROMIUM_EXECUTABLE_PATH` — absolute path to your installed Chrome/Chromium
  binary (e.g. `/usr/bin/google-chrome`, `/usr/bin/chromium-browser`,
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`).
- `PROFILES_DIR` — where per-organization Chromium profiles are stored.
  Defaults to `./profiles`. **Treat this directory as sensitive**: it holds
  real, live Instagram session state (not passwords, but a working
  authenticated session is itself a credential). Restrict its file
  permissions and never commit it or copy it off this machine casually.

Then load the env file however your shell/process manager prefers, e.g.:

```bash
export $(grep -v '^#' .env | xargs)   # or: node --env-file=.env <script>
```

## First-time connection (once per organization)

In Business Badhao's Settings → Integrations, click "Connect Instagram
Discovery" for the organization first — this creates the pending connection
row the report below will attach to. Then, on this machine:

```bash
node login.mjs --org <organizationId>
```

A real, visible Chromium window opens on `instagram.com/accounts/login`. Log
in manually with that organization's dedicated Instagram account — this
script never reads, stores, or transmits the password itself; it only
detects, by watching the page Instagram itself renders, that a login
succeeded, then reports `{status: "connected", username, profileRef}` to
Business Badhao's `session-report` endpoint. If Instagram shows a CAPTCHA or
2FA challenge, complete it in the same window; the script keeps waiting (up
to 10 minutes) rather than giving up immediately.

Settings → Integrations should now show "Connected" as `@<the account you
logged in as>`.

## Running discovery (the worker)

```bash
node worker.mjs
```

Runs forever, polling `POST /api/instagram-discovery/jobs/claim` every
`WORKER_POLL_INTERVAL_MS` (default 4s). When Business Badhao's discovery
pipeline needs an Instagram result for a query, it creates a job; this
process claims it, reopens that organization's already-authenticated
Chromium profile (headless), performs one real search on Instagram's own web
UI, visits a bounded number of the resulting profiles to read their real bio/
category/external-link, and reports the structured result back via
`jobs/complete`. If the saved session has expired or Instagram is showing a
challenge, it reports that honestly (`session_expired` /
`browser_unavailable`) and fails the job rather than fabricating a result —
re-run `login.mjs` for that organization to restore it.

**Run this persistently** so it's actually there when a discovery run needs
it — Business Badhao's own discovery request only waits a bounded amount of
time (`INSTAGRAM_DISCOVERY_JOB_TIMEOUT_MS` on the Vercel side, 60s by
default) for a job to be claimed and completed, so a worker that isn't
currently running simply means that particular run gets no Instagram results
for that query (Tavily/Exa results are entirely unaffected either way). Use
whatever process supervisor you're already comfortable with:

```bash
# pm2
pm2 start worker.mjs --name hermes-browser-runtime

# systemd (example unit — adjust paths/user)
# [Service]
# WorkingDirectory=/opt/hermes-browser-runtime
# EnvironmentFile=/opt/hermes-browser-runtime/.env
# ExecStart=/usr/bin/node worker.mjs
# Restart=always
```

## Multiple organizations

Run one `login.mjs --org <id>` per organization once (each gets its own
profile directory under `PROFILES_DIR`, named after its `organizationId` —
never shared). A single `worker.mjs` process serves every organization that
has a `connected`/`ready` status: it claims whichever job is oldest across
all of them and opens that job's own organization's profile — profiles are
never mixed.

## Selector maintenance

`lib/instagram.mjs` navigates and reads Instagram's own rendered web pages
using CSS selectors written against Instagram's public web UI structure.
Instagram changes this markup periodically, the way any large web app does.
If discovery starts returning zero real candidates for queries where you'd
expect results, inspect the live, logged-in page (Chrome DevTools → Inspect)
and update the selectors in that file — this is ordinary maintenance for any
DOM-based browser automation, not a sign of a broken design.
