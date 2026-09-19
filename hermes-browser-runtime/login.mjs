#!/usr/bin/env node
/**
 * Run ONCE per organization, on this machine, to create/open that
 * organization's dedicated Chromium profile and let a human operator log
 * into that organization's own Instagram account manually — in a real,
 * visible browser window this script opens. This script never sees, reads,
 * asks for, or transmits the password: it only watches for Instagram's own
 * page to change into a logged-in state, then reports that fact (and the
 * detected username) back to Business Badhao.
 *
 * Usage:
 *   node login.mjs --org <organizationId>
 *
 * organizationId must be the exact Business Badhao organization id this
 * Instagram account belongs to (visible in Settings → Integrations once
 * "Connect Instagram Discovery" has been clicked there).
 */
import path from "node:path";
import { openProfile } from "./lib/browser.mjs";
import { waitForManualLogin } from "./lib/instagram.mjs";
import { reportSession } from "./lib/api-client.mjs";
import { pushProfileToSandbox, sandboxPushConfigured } from "./lib/sandbox-push.mjs";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const organizationId = arg("org");
  if (!organizationId) {
    console.error("Usage: node login.mjs --org <organizationId>");
    process.exitCode = 1;
    return;
  }

  console.log(`Opening a real Chromium window for organization ${organizationId}...`);
  const { browser, page } = await openProfile(organizationId, { headless: false });

  await reportSession({ organizationId, status: "connecting" }).catch((error) => console.warn("Could not report 'connecting' status:", error.message));

  console.log("Log in to this organization's dedicated Instagram account in the window that just opened.");
  console.log("This script never reads or transmits the password — it only detects a successful login.");

  const result = await waitForManualLogin(page);

  if (!result.ok) {
    console.error(`Login was not completed: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`);
    await reportSession({
      organizationId,
      status: result.reason === "challenged" ? "browser_unavailable" : "authentication_required",
      error: result.detail ?? "Manual login was not completed.",
    }).catch(() => {});
    await browser.close();
    process.exitCode = 1;
    return;
  }

  console.log(`Detected a successful login as @${result.username}.`);
  const report = await reportSession({ organizationId, status: "connected", username: result.username, profileRef: organizationId });
  if (report.status !== 200) {
    console.error(`Login succeeded locally, but reporting it to Business Badhao failed: HTTP ${report.status}`, report.data);
    process.exitCode = 1;
  } else {
    console.log("Reported the connection to Business Badhao. Settings → Integrations should now show 'Connected'.");
  }

  await browser.close();

  // Optional: push this profile into Business Badhao's own shared, on-demand
  // Sandbox runtime (see lib/sandbox-push.mjs's own doc comment) so it's
  // usable there too, not only by a worker.mjs run on this exact machine.
  // Silently skipped when VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID
  // aren't set — see README.md's "Connecting to the on-demand Sandbox
  // runtime" section.
  if (sandboxPushConfigured()) {
    const profileDir = path.resolve(process.env.PROFILES_DIR || "./profiles", organizationId);
    console.log("Pushing this profile to Business Badhao's on-demand Sandbox runtime...");
    try {
      const pushed = await pushProfileToSandbox(organizationId, profileDir);
      console.log(`Pushed ${pushed.fileCount} profile file(s) to the Sandbox runtime. It will use this session on its next discovery run.`);
    } catch (error) {
      console.error("Could not push this profile to the Sandbox runtime:", error instanceof Error ? error.message : error);
      console.error("This machine's own worker.mjs (if you run one) can still use this profile directly.");
    }
  } else {
    console.log("You can close this browser window.");
    console.log("worker.mjs will reuse this saved profile for future discovery jobs — either run here, or (if this deployment uses the");
    console.log("on-demand Sandbox runtime) set VERCEL_TOKEN/VERCEL_TEAM_ID/VERCEL_PROJECT_ID and re-run this command to push it there.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
