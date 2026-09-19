# Hermes Browser Runtime

The real, separate process that performs Instagram lead discovery for
Business Badhao using a genuine local Chromium browser — this is the "Hermes
runtime" the discovery architecture refers to. It is **not** part of the
Next.js app's own request handling and is **never bundled into a Vercel
serverless function**: Vercel's serverless execution model cannot host a
persistent, authenticated browser session inside one HTTP request.

**By default, you don't provision or operate anything.** Business Badhao
runs this exact code itself, on demand, in its own Vercel Sandbox (a real
Linux VM Vercel provisions automatically — see
`src/lib/instagram-discovery/sandbox-runtime.ts` on the main app side): the
moment a real discovery job needs it, that Sandbox wakes, runs `worker.mjs`
until the queue is drained, and stops — no server to keep running, no
Docker/systemd to babysit, no terminal command for day-to-day use. You still
run one real, human-supervised command **once per organization** to log
that organization's own Instagram account in (see "Connect an organization"
below) — Instagram's own security requires a real human for that, and this
project won't try to automate around it — but nothing beyond that.

If you'd rather run this yourself on your own always-available machine
instead of using Business Badhao's on-demand Sandbox (e.g. for your own
infra control), that's still fully supported — see "Advanced: running your
own persistent worker" below.

Uses **puppeteer-core** (Chrome DevTools Protocol) driving a **real,
locally-installed** Chrome or Chromium binary, whether hosted by Business
Badhao's Sandbox or by you. Not Playwright, not Browserbase, not any cloud
browser service, not TinyFish — genuinely local.

## Architecture

```
Business Badhao (Vercel)
      |
Start Discovery
      |
Hermes Lead Discovery Orchestrator
      |
      +---------------------+---------------------+
      |                                           |
   Tavily (primary web)                  Instagram discovery job
      |                                           |     (instagram_discovery_jobs table)
   Exa (fallback only)                            |
      |                                           v
      |                        sandbox-runtime.ts wakes the Sandbox on demand
      |                                           |
      |                              Hermes Browser Runtime (this package)
      |                              worker.mjs, claims & processes jobs
      |                              organization's own Chromium profile
      |                              real Instagram navigation/search
      |                              (hosted in a Vercel Sandbox by default —
      |                               or by you, if you opt out — see below)
      |                                           |
      +---------------------+---------------------+
                    Combined candidates (source: "tavily" | "exa" | "instagram")
                                |
                        Nemotron 3 Ultra extraction
                                |
                     Independent Hermes Reviewer
                                |
                      Deterministic Validator
                                |
                          Deduplication
                                |
                              Leads -> Research
```

Instagram runs **additively alongside** Tavily for every discovery query —
never as a fallback gated on Tavily failing, and its own absence/timeout
never fails a query Tavily/Exa already answered. If Instagram genuinely
fails for a query, that failure is reported honestly; it is never silently
backfilled with an Exa result.

## What this is (and isn't)

- **Is**: a small Node.js service that opens a real Chromium window once so
  a human can log into one organization's own Instagram account manually,
  saves that authenticated session to a dedicated local profile directory,
  and then runs continuously, claiming and executing real discovery jobs
  Business Badhao creates.
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
  machine (or use the provided Docker image, which installs one).
- Outbound network access from this machine to both `instagram.com` and your
  Business Badhao deployment's own URL.
- One dedicated Instagram account per organization you want to run discovery
  for, that you are authorized to operate on that organization's behalf.

---

## ONE-TIME ADMIN SETUP

By default there is nothing to provision — `INSTAGRAM_DISCOVERY_RUNTIME_TOKEN`
being set on your Vercel project is what turns on Business Badhao's own
on-demand Sandbox hosting (`sandbox-runtime.ts`); if it's already set (Settings
→ Integrations will say "not configured" if it isn't), skip straight to
"Connect an organization" below. The rest of this section covers connecting
that one-time login to the Sandbox runtime, and the fully self-hosted
alternative for operators who'd rather not use it.

### Connect an organization (once per organization)

1. In Business Badhao → Settings → Integrations, click **"Connect Instagram
   Discovery"** for that organization. This creates the pending connection
   record the login step attaches to.
2. Run, on any machine with Node 22+ and a real display (your own laptop, or
   any Linux machine/container — see "Which machine to run login.mjs on"
   below):
   ```bash
   cd hermes-browser-runtime
   npm install
   cp .env.example .env   # edit: BUSINESS_BADHAO_API_URL, INSTAGRAM_DISCOVERY_RUNTIME_TOKEN
   node login.mjs --org <organizationId>
   ```
   (Settings shows the exact command with the real organization id filled
   in, with a Copy button, once a connection is requested.)
3. A real, visible Chromium window opens on `instagram.com/accounts/login`.
   Log in manually with that organization's dedicated Instagram account —
   this script never reads, stores, or transmits the password; it only
   detects, by watching the page Instagram itself renders, that login
   succeeded. If Instagram shows a CAPTCHA or 2FA challenge, complete it in
   the same window; the script keeps waiting (up to 10 minutes).
4. The authenticated session is saved to that organization's own local
   profile directory and reported to Business Badhao. Settings now shows
   **Connected** as `@<account>`.
5. If `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` are set (see
   "Connecting to the on-demand Sandbox runtime" below), `login.mjs`
   automatically pushes this profile into Business Badhao's Sandbox runtime
   as its last step — nothing further to do. Otherwise it tells you so, and
   this profile is only usable by a `worker.mjs` you run on this same
   machine (see "Advanced" below).

That's it — every subsequent "Find Leads" / "Start Discovery" in Business
Badhao automatically wakes the Sandbox runtime and runs real Instagram
discovery for this organization alongside Tavily/Exa. No terminal, Docker,
or worker command for normal, day-to-day use.

### Connecting to the on-demand Sandbox runtime

`login.mjs` pushes the profile it just created straight into the same
Sandbox `sandbox-runtime.ts` wakes on demand, using the Sandbox SDK
directly — no new endpoint on the Business Badhao deployment itself. Set,
once, in this package's own `.env` (see `.env.example`):

- `VERCEL_TOKEN` — a personal access token from
  https://vercel.com/account/tokens, scoped to the team below.
- `VERCEL_TEAM_ID` — your Vercel team ID (Team Settings → General).
- `VERCEL_PROJECT_ID` — your Business Badhao deployment's own Vercel project
  ID (Project Settings → General) — the same project
  `INSTAGRAM_DISCOVERY_RUNTIME_TOKEN` is set on.

**Which machine to run `login.mjs` on:** Chromium's cookie/session
encryption can be tied to the OS keyring of the machine that created the
profile. To keep that consistent with the Sandbox's own plain Linux
environment (no keyring), run `login.mjs` on a plain Linux machine or a
throwaway container rather than a desktop OS with a real keyring — for
example:

```bash
docker run --rm -it -v "$PWD:/app" -w /app node:22-bookworm-slim bash
# inside the container:
apt-get update && apt-get install -y chromium ca-certificates fonts-liberation
CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm install && node login.mjs --org <organizationId>
```

This container never needs a GUI of its own — `login.mjs`'s `headless:false`
browser still needs a real X display, so run this on a Linux desktop (most
distros already have one) rather than a completely headless server; the
container above is for keeping the *profile's own* OS/keyring environment
consistent with the Sandbox, not for solving the display requirement.

### Advanced: running your own persistent worker

If you'd rather operate your own always-on runtime instead of Business
Badhao's on-demand Sandbox (e.g. for your own infra control), set
`INSTAGRAM_DISCOVERY_SANDBOX_DISABLED=1` on your Vercel project (this only
stops Business Badhao from waking its own Sandbox — it never disables
Instagram discovery itself), then pick **one** of:

#### Option A — Docker

```bash
cd hermes-browser-runtime
cp .env.example .env
# edit .env: BUSINESS_BADHAO_API_URL, INSTAGRAM_DISCOVERY_RUNTIME_TOKEN
docker compose up -d --build
```

This builds a real Chromium into the image, starts the worker with
`restart: unless-stopped` (auto-restarts on crash and on machine reboot once
Docker itself is set to start on boot), exposes `/health` on port 8787, and
persists Chromium profiles to `./profiles` on the host (bind-mounted — see
`docker-compose.yml`).

#### Option B — systemd (bare metal / VM)

```bash
git clone <this repo> /opt/business-badhao   # or copy hermes-browser-runtime/ there
cd /opt/business-badhao/hermes-browser-runtime
npm install
cp .env.example .env   # edit it
sudo useradd -r hermes || true
sudo cp deploy/hermes-browser-runtime.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-browser-runtime
```

`enable` makes it start automatically on every machine boot; `Restart=always`
in the unit file makes systemd restart it if it ever crashes. Logs:
`journalctl -u hermes-browser-runtime -f`.

With either option, run `node login.mjs --org <id>` **directly on that same
host** (not inside the Docker container itself, unless you exec into it —
`login.mjs` needs a real display either way), sharing the same `./profiles`
directory the worker reads.

---

## NORMAL USER FLOW

Once the one-time setup above is done, using it day to day is:

```
Connect Instagram → Login once → Connected → Start Discovery
```

Starting a campaign's discovery in Business Badhao automatically creates
Instagram discovery jobs for every connected, authenticated organization and
(by default) wakes the Sandbox runtime to process them, within seconds — or,
if you opted into "Advanced: running your own persistent worker", the
already-running worker claims and executes them the same way. **No terminal
command is required for each discovery**, either way.

### Test Connection

Settings → Integrations → Instagram Discovery (Browser) has a **Test
Connection** button once a runtime is configured and an organization has
connected. It creates a real verification job, waits briefly for the
running worker to answer it, and reports the actual result — "session is
authenticated" or the real reason it isn't (session expired, browser
unavailable, no response from the runtime at all). This does not wait for a
real discovery run; it is a fast, on-demand health check of the saved
session.

### Reauthentication

If Instagram's session naturally expires, the worker detects this the next
time it processes a job for that organization (or via Test Connection) and
reports `session_expired` — it does **not** keep retrying discovery against
a dead session (see "Anti-abuse" below). Settings shows "Reauthentication
required" with the exact `login.mjs` command to run again.

---

## Health check

This applies to "Advanced: running your own persistent worker" — the
default Sandbox-hosted runtime doesn't expose a public port at all (nothing
inbound is needed for it: it only makes outbound calls to Business Badhao's
own API); use Settings → Integrations → **Test Connection** instead, which
works identically either way (it dispatches a real job and reports the real
result, regardless of which runtime answers it).

`GET http://<runtime-host>:8787/health` (port from `HEALTH_CHECK_PORT`)
returns JSON, safe for any monitoring tool:

```json
{
  "healthy": true,
  "workerRunning": true,
  "startedAt": "...",
  "uptimeSeconds": 1234,
  "concurrency": 1,
  "chromiumLastLaunchOk": true,
  "businessBadhaoApiReachable": true,
  "lastSuccessfulJobAt": "...",
  "lastFailedJobAt": null,
  "consecutiveFailures": 0,
  "currentJobs": [{ "id": "...", "organizationId": "...", "type": "search", "startedAt": "..." }],
  "queue": { "pending": 0, "claimed": 0, "completedLast24h": 12, "failedLast24h": 0, "expiredLast24h": 0 }
}
```

Never includes a password, cookie, token, or browser-profile content.
Returns HTTP 503 when `healthy` is false (Chromium hasn't launched
successfully, or Business Badhao is unreachable), so a Docker/orchestrator
healthcheck can act on it directly — the provided `Dockerfile` and
`docker-compose.yml` already do.

## Multiple organizations

Run one `login.mjs --org <id>` per organization once (each gets its own
profile directory under `PROFILES_DIR`, named after its `organizationId` —
never shared). A single `worker.mjs` process serves every organization that
has a `connected`/`ready` status — whether that process is the one Business
Badhao's Sandbox runtime wakes on demand, or one you run yourself: it claims
whichever job is oldest across all of them and opens that job's own
organization's profile — profiles are never mixed. Raise `WORKER_CONCURRENCY`
to process more than one organization's job at the same time (each
concurrent loop owns its own Chromium process).

## Anti-abuse / safety bounds

Conservative, environment-configurable limits on every discovery job (see
`.env.example`): a maximum number of profiles per job
(`INSTAGRAM_MAX_PROFILES_PER_JOB`), how many of those get individually
visited for bio/category/link detail (`INSTAGRAM_PROFILE_ENRICH_LIMIT`), a
politeness delay between profile visits (`INSTAGRAM_POLITENESS_DELAY_MS`),
and a hard per-job timeout (`WORKER_JOB_TIMEOUT_MS`). None of these can be
configured to bypass a CAPTCHA, evade rate limiting, or defeat any Instagram
security control — the moment Instagram itself challenges a session, the
worker stops and reports it (`browser_unavailable`), it never retries
against the same challenge, and it never attempts mass messaging of any
kind (this runtime only ever reads public profile pages).

## Job reliability

- **Stale-job recovery**: every claim attempt first sweeps any job whose
  `pending`/`claimed` state has outlived its own TTL (e.g. because a worker
  crashed mid-job) to `expired` — a crashed worker can never leave the queue
  permanently blocked.
- **Per-job timeout**: `WORKER_JOB_TIMEOUT_MS` force-closes a hung browser
  and reports the job failed rather than blocking that loop forever.
- **Graceful shutdown**: SIGINT/SIGTERM let an in-flight job finish (up to
  `WORKER_SHUTDOWN_GRACE_MS`) before exiting — safe to `docker compose
  restart` or `systemctl restart` without corrupting a job mid-flight.
- **Backoff**: repeated failures reaching Business Badhao back off
  exponentially (capped at `WORKER_MAX_BACKOFF_MS`) instead of hammering a
  down deployment.
- **Malformed job defense**: a claim response missing an expected field is
  logged and safely skipped rather than crashing the worker loop.

## Organization isolation

Each organization's Chromium profile lives at `PROFILES_DIR/<organizationId>`
— Chrome's own native profile-persistence mechanism, so two organizations'
cookies/session state can never mix. The profile ref used for every job
comes from the organization's own row in `instagram_discovery_connections`
(looked up server-side, re-validated at claim time), never from anything the
worker itself supplies — and is validated against a safe filename pattern
before it ever touches a filesystem path (see `lib/browser.mjs`).

## Selector maintenance

`lib/instagram.mjs` navigates and reads Instagram's own rendered web pages
using CSS selectors written against Instagram's public web UI structure.
Instagram changes this markup periodically, the way any large web app does.
If discovery starts returning zero real candidates for queries where you'd
expect results, inspect the live, logged-in page (Chrome DevTools → Inspect)
and update the selectors in that file — this is ordinary maintenance for any
DOM-based browser automation, not a sign of a broken design.

## Environment variables

See `.env.example` for the full, documented list (required vs. optional,
with real defaults). Never commit a real `.env`.
