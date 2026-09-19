#!/usr/bin/env node
/**
 * Long-running process: polls Business Badhao for pending Instagram
 * discovery jobs and, for each one, opens that organization's own already-
 * authenticated Chromium profile and performs one REAL Instagram search —
 * never fabricated, never simulated. Run this persistently (pm2, systemd,
 * a plain `nohup`/tmux session, or a container on your own always-available
 * machine) — see README.md for exact setup. This is the "Hermes runtime" the
 * discover architecture diagram refers to; it is intentionally NOT deployed
 * on Vercel (see this repo's own architecture notes on why a persistent
 * authenticated browser cannot live inside a serverless request).
 */
import { openProfile } from "./lib/browser.mjs";
import { checkSessionStillValid, searchBusinessAccounts } from "./lib/instagram.mjs";
import { claimJob, completeJob, reportSession } from "./lib/api-client.mjs";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS) || 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processJob(job) {
  console.log(`[job ${job.id}] claimed for org ${job.organizationId}: "${job.query}"`);
  let browser;
  try {
    const opened = await openProfile(job.browserProfileRef, { headless: true });
    browser = opened.browser;
    const page = opened.page;

    const session = await checkSessionStillValid(page);
    if (!session.ok) {
      console.warn(`[job ${job.id}] saved session is no longer valid (${session.reason}).`);
      await reportSession({
        organizationId: job.organizationId,
        status: session.reason === "challenged" ? "browser_unavailable" : "session_expired",
        error: "The saved Instagram session is no longer authenticated. Re-run: node login.mjs --org " + job.organizationId,
      }).catch(() => {});
      await completeJob(job.id, { status: "failed", error: "Instagram session is no longer valid — manual re-authentication required." });
      return;
    }

    const candidates = await searchBusinessAccounts(page, job.query);
    console.log(`[job ${job.id}] found ${candidates.length} real Instagram account(s).`);
    const result = await completeJob(job.id, { status: "completed", candidates });
    if (result.status !== 200) {
      console.error(`[job ${job.id}] completed locally but reporting the result failed: HTTP ${result.status}`, result.data);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[job ${job.id}] failed:`, message);
    await reportSession({ organizationId: job.organizationId, status: "browser_unavailable", error: message }).catch(() => {});
    await completeJob(job.id, { status: "failed", error: message }).catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  console.log("Hermes browser runtime worker starting. Polling Business Badhao for Instagram discovery jobs...");
  for (;;) {
    try {
      const claimed = await claimJob();
      if (claimed.status === 200 && claimed.data?.job) {
        await processJob(claimed.data.job);
        continue; // Check immediately for another queued job rather than waiting a full interval.
      }
      if (claimed.status !== 200) {
        console.error(`Unexpected response claiming a job: HTTP ${claimed.status}`, claimed.data);
      }
    } catch (error) {
      console.error("Error while polling for jobs:", error instanceof Error ? error.message : error);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

main();
