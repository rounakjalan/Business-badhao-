#!/usr/bin/env node
/**
 * Long-running production worker: polls Business Badhao for pending
 * Instagram discovery jobs and, for each one, opens that organization's own
 * already-authenticated Chromium profile and performs one REAL Instagram
 * search or session check — never fabricated, never simulated. Run this
 * persistently (Docker, systemd, pm2 — see README.md) on your own
 * always-available machine. This is the "Hermes runtime" the discovery
 * architecture refers to; it is intentionally NOT deployed on Vercel (see
 * this repo's own architecture notes on why a persistent authenticated
 * browser cannot live inside a serverless request).
 *
 * Meant to start once and keep running: it polls continuously with
 * exponential backoff on repeated failures, recovers from a crashed/hung
 * Chromium by simply launching a fresh one for the next job (every job gets
 * its own browser process — the simplest and safest recovery strategy,
 * since there is never a shared, possibly-corrupted browser instance to
 * "reconnect" to), enforces a hard per-job timeout, sweeps stale claims on
 * the server side before every claim attempt, and exposes a local /health
 * endpoint for infra monitoring. No operator action is needed for each
 * individual discovery run — see section "Normal user flow" in README.md.
 */
import { openProfile } from "./lib/browser.mjs";
import { checkSessionStillValid, searchBusinessAccounts } from "./lib/instagram.mjs";
import { claimJob, completeJob, getQueueStatus, reportSession } from "./lib/api-client.mjs";
import { logger } from "./lib/logger.mjs";
import { startHealthServer } from "./lib/health-server.mjs";

const BASE_POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 4000;
const MAX_BACKOFF_MS = Number(process.env.WORKER_MAX_BACKOFF_MS) || 60_000;
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY) || 1);
const JOB_TIMEOUT_MS = Number(process.env.WORKER_JOB_TIMEOUT_MS) || 180_000;
const SHUTDOWN_GRACE_MS = Number(process.env.WORKER_SHUTDOWN_GRACE_MS) || 15_000;
const HEALTH_CHECK_PORT = Number(process.env.HEALTH_CHECK_PORT) || 0;
const QUEUE_STATUS_CACHE_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES_BEFORE_WARNING = Number(process.env.WORKER_MAX_CONSECUTIVE_FAILURES) || 5;
/**
 * Optional bounded lifetime, unset (run forever) on a normal Docker/systemd
 * deployment. Set by Business Badhao's own on-demand Sandbox runtime
 * (src/lib/instagram-discovery/sandbox-runtime.ts) when it wakes this exact
 * worker.mjs inside a short-lived Vercel Sandbox to drain the queue for one
 * discovery run, so that process doesn't sit polling forever after its job
 * is done — it exits the same graceful way a real SIGTERM would (finishing
 * any in-flight job first), never a hard kill. Nothing else in this file
 * changes: an always-on deployment that never sets this env var behaves
 * exactly as before.
 */
const MAX_RUNTIME_MS = Number(process.env.WORKER_MAX_RUNTIME_MS) || 0;

const SEARCH_OPTIONS = {
  maxResults: Number(process.env.INSTAGRAM_MAX_PROFILES_PER_JOB) || 15,
  profileEnrichLimit: Number(process.env.INSTAGRAM_PROFILE_ENRICH_LIMIT) || 8,
  politenessDelayMs: Number(process.env.INSTAGRAM_POLITENESS_DELAY_MS) || 400,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Shared, in-memory worker state — read by the /health endpoint. Never holds
// a password, cookie, token, or browser-profile content; only counters,
// timestamps, and non-sensitive identifiers (job id, organization id, job
// type). One shared object across every concurrent loop (WORKER_CONCURRENCY)
// so /health reports the whole worker's real state, not just one loop's.
// ---------------------------------------------------------------------------
const state = {
  startedAt: new Date().toISOString(),
  chromiumLastLaunchOk: null,
  businessBadhaoApiReachable: null,
  lastSuccessfulJobAt: null,
  lastFailedJobAt: null,
  currentJobs: new Map(), // loopId -> {id, organizationId, type, startedAt}
  consecutiveFailures: 0,
  shuttingDown: false,
  queueStatusCache: { fetchedAt: 0, data: null },
};

async function getCachedQueueStatus() {
  if (Date.now() - state.queueStatusCache.fetchedAt < QUEUE_STATUS_CACHE_MS) return state.queueStatusCache.data;
  try {
    const result = await getQueueStatus();
    state.queueStatusCache = { fetchedAt: Date.now(), data: result.status === 200 ? result.data.queue : null };
  } catch {
    state.queueStatusCache = { fetchedAt: Date.now(), data: null };
  }
  return state.queueStatusCache.data;
}

function buildHealthStatus() {
  const currentJobs = [...state.currentJobs.values()];
  return {
    ok: true,
    healthy: state.chromiumLastLaunchOk !== false && state.businessBadhaoApiReachable !== false && !state.shuttingDown,
    workerRunning: true,
    shuttingDown: state.shuttingDown,
    startedAt: state.startedAt,
    uptimeSeconds: Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 1000),
    concurrency: CONCURRENCY,
    chromiumLastLaunchOk: state.chromiumLastLaunchOk,
    businessBadhaoApiReachable: state.businessBadhaoApiReachable,
    lastSuccessfulJobAt: state.lastSuccessfulJobAt,
    lastFailedJobAt: state.lastFailedJobAt,
    consecutiveFailures: state.consecutiveFailures,
    currentJobs: currentJobs.map((j) => ({ id: j.id, organizationId: j.organizationId, type: j.type, startedAt: j.startedAt })),
    // Cache-only — this handler must stay synchronous, so a stale/null value
    // here just means "not fetched recently yet", never a fabricated number.
    queue: state.queueStatusCache.data,
  };
}

/** Validates the shape the claim endpoint is actually contracted to return — a malformed response (a bug on either side, or a corrupted proxy response) must never crash the worker loop or be treated as an untyped job. */
function validateJob(job) {
  if (!job || typeof job !== "object") return "job is not an object";
  if (typeof job.id !== "string" || !job.id) return "job.id is missing";
  if (typeof job.organizationId !== "string" || !job.organizationId) return "job.organizationId is missing";
  if (typeof job.browserProfileRef !== "string" || !job.browserProfileRef) return "job.browserProfileRef is missing";
  if (job.type !== "search" && job.type !== "verify") return `job.type is invalid: ${String(job.type)}`;
  if (job.type === "search" && (typeof job.query !== "string" || !job.query)) return "search job is missing query";
  return null;
}

/** The real work for one job. Every exit path reports a real, honest outcome — never a fabricated success. `onBrowserOpened` lets the caller track the live browser handle so a hard timeout can force-close it. */
async function runJob(job, onBrowserOpened) {
  let opened;
  try {
    opened = await openProfile(job.browserProfileRef, { headless: true });
    state.chromiumLastLaunchOk = true;
  } catch (error) {
    state.chromiumLastLaunchOk = false;
    throw error;
  }
  onBrowserOpened(opened.browser);
  const page = opened.page;

  try {
    if (job.type === "verify") {
      const session = await checkSessionStillValid(page);
      if (session.ok) {
        await reportSession({ organizationId: job.organizationId, status: "ready", username: session.username, profileRef: job.browserProfileRef });
      } else {
        await reportSession({
          organizationId: job.organizationId,
          status: session.reason === "challenged" ? "browser_unavailable" : "session_expired",
          error:
            session.reason === "challenged"
              ? "Instagram is showing a security challenge. Complete it manually (re-run login.mjs), then reconnect."
              : "The saved Instagram session is no longer authenticated. Reconnect to restore discovery.",
        });
      }
      await completeJob(job.id, { status: "completed", candidates: [] });
      return;
    }

    const session = await checkSessionStillValid(page);
    if (!session.ok) {
      logger.warn(`Job ${job.id}: saved session is no longer valid`, { organizationId: job.organizationId, reason: session.reason });
      await reportSession({
        organizationId: job.organizationId,
        status: session.reason === "challenged" ? "browser_unavailable" : "session_expired",
        error: `The saved Instagram session is no longer authenticated. Re-run: node login.mjs --org ${job.organizationId}`,
      }).catch(() => {});
      await completeJob(job.id, { status: "failed", error: "Instagram session is no longer valid — manual re-authentication required." });
      return;
    }

    const candidates = await searchBusinessAccounts(page, job.query, SEARCH_OPTIONS);
    logger.info(`Job ${job.id}: found ${candidates.length} real Instagram account(s)`, { organizationId: job.organizationId });
    const result = await completeJob(job.id, { status: "completed", candidates });
    if (result.status !== 200) {
      logger.error(`Job ${job.id}: completed locally but reporting the result failed`, { status: result.status, data: result.data });
    }
  } finally {
    await opened.browser.close().catch(() => {});
  }
}

/** Wraps runJob with a hard, cancellable timeout: if it fires, the in-flight browser is force-closed (a hung page/navigation is the one failure mode runJob's own try/finally can't unblock on its own) and the job is honestly reported failed. runJob may still finish afterward in the background; completeJob's own "only if still claimed" guard makes a late, duplicate completion a harmless no-op. */
async function runJobWithTimeout(job) {
  let browser = null;
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), JOB_TIMEOUT_MS);
  });

  try {
    const outcome = await Promise.race([runJob(job, (b) => (browser = b)).then(() => ({ timedOut: false })), timeoutPromise]);
    if (outcome.timedOut) {
      logger.error(`Job ${job.id}: exceeded WORKER_JOB_TIMEOUT_MS (${JOB_TIMEOUT_MS}ms) — forcing the browser closed`, { organizationId: job.organizationId });
      await browser?.close().catch(() => {});
      await completeJob(job.id, { status: "failed", error: "The Instagram discovery runtime timed out processing this job." }).catch(() => {});
      throw new Error("job timed out");
    }
  } finally {
    clearTimeout(timer);
  }
}

async function processJob(loopId, job) {
  const invalidReason = validateJob(job);
  if (invalidReason) {
    logger.error("Received a malformed job from the claim endpoint — skipping it", { reason: invalidReason, job });
    if (job && typeof job.id === "string" && job.id) {
      await completeJob(job.id, { status: "failed", error: `Malformed job: ${invalidReason}` }).catch(() => {});
    }
    return;
  }

  logger.info(`[loop ${loopId}] claimed job ${job.id}`, { organizationId: job.organizationId, type: job.type });
  state.currentJobs.set(loopId, { id: job.id, organizationId: job.organizationId, type: job.type, startedAt: new Date().toISOString() });

  try {
    await runJobWithTimeout(job);
    state.lastSuccessfulJobAt = new Date().toISOString();
  } catch (error) {
    state.lastFailedJobAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Job ${job.id} failed`, { organizationId: job.organizationId, error: message });
    await reportSession({ organizationId: job.organizationId, status: "browser_unavailable", error: message }).catch(() => {});
    await completeJob(job.id, { status: "failed", error: message }).catch(() => {});
  } finally {
    state.currentJobs.delete(loopId);
  }
}

/** One independent claim-and-process loop. WORKER_CONCURRENCY starts several of these; the server-side atomic claim (claimNextInstagramDiscoveryJob) guarantees two loops — in this process or another one entirely — can never process the same job. */
async function runLoop(loopId) {
  let consecutiveErrors = 0;

  while (!state.shuttingDown) {
    try {
      const claimed = await claimJob();
      state.businessBadhaoApiReachable = true;
      consecutiveErrors = 0;
      state.consecutiveFailures = 0;

      if (claimed.status === 200 && claimed.data?.job) {
        await processJob(loopId, claimed.data.job);
        continue; // Check immediately for another queued job rather than waiting a full interval.
      }
      if (claimed.status !== 200) {
        logger.error(`[loop ${loopId}] unexpected response claiming a job`, { status: claimed.status, data: claimed.data });
      }
    } catch (error) {
      state.businessBadhaoApiReachable = false;
      consecutiveErrors += 1;
      state.consecutiveFailures = Math.max(state.consecutiveFailures, consecutiveErrors);
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[loop ${loopId}] error while polling for jobs`, { error: message, consecutiveErrors });
      if (consecutiveErrors === MAX_CONSECUTIVE_FAILURES_BEFORE_WARNING) {
        logger.warn(`[loop ${loopId}] ${consecutiveErrors} consecutive failures reaching Business Badhao — backing off`, { maxBackoffMs: MAX_BACKOFF_MS });
      }
    }

    const backoffMs = consecutiveErrors > 0 ? Math.min(BASE_POLL_INTERVAL_MS * 2 ** consecutiveErrors, MAX_BACKOFF_MS) : BASE_POLL_INTERVAL_MS;
    await sleep(backoffMs);
  }

  logger.info(`[loop ${loopId}] stopped (graceful shutdown).`);
}

function setupGracefulShutdown(healthServer) {
  let shuttingDownAlready = false;

  async function shutdown(signal) {
    if (shuttingDownAlready) return;
    shuttingDownAlready = true;
    logger.info(`Received ${signal} — finishing in-flight job(s) and stopping (up to ${SHUTDOWN_GRACE_MS}ms grace period).`);
    state.shuttingDown = true;

    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (state.currentJobs.size > 0 && Date.now() < deadline) {
      await sleep(250);
    }
    if (state.currentJobs.size > 0) {
      logger.warn(`Shutting down with ${state.currentJobs.size} job(s) still in flight past the grace period.`);
    }

    healthServer?.close();
    logger.info("Hermes browser runtime worker stopped.");
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (MAX_RUNTIME_MS > 0) {
    setTimeout(() => shutdown("WORKER_MAX_RUNTIME_MS elapsed"), MAX_RUNTIME_MS).unref();
  }
}

async function main() {
  logger.info("Hermes browser runtime worker starting.", {
    concurrency: CONCURRENCY,
    pollIntervalMs: BASE_POLL_INTERVAL_MS,
    jobTimeoutMs: JOB_TIMEOUT_MS,
    maxRuntimeMs: MAX_RUNTIME_MS || "unbounded",
  });

  const healthServer = startHealthServer(HEALTH_CHECK_PORT, () => {
    // Fire-and-forget refresh for next time — /health itself must stay
    // synchronous, so this request is always served from the cache above.
    getCachedQueueStatus().catch(() => {});
    return buildHealthStatus();
  });

  setupGracefulShutdown(healthServer);

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => runLoop(i)));
}

main().catch((error) => {
  logger.error("Fatal error in worker main()", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
