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
import { openProfile } from "./lib/browser.mjs";
import { waitForManualLogin } from "./lib/instagram.mjs";
import { reportSession } from "./lib/api-client.mjs";

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
    console.log("You can close this browser window — worker.mjs will reuse this saved profile for future discovery jobs.");
  }

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
