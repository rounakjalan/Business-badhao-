#!/usr/bin/env node
/**
 * Non-interactive counterpart to login.mjs, for Business Badhao's on-demand
 * Sandbox runtime only (see src/lib/instagram-discovery/sandbox-runtime.ts's
 * attemptSandboxCredentialLogin). Vercel Sandbox has no attached display for
 * a human to use the way login.mjs's headless:false + waitForManualLogin
 * assumes, so when an organization connects via Settings' own username/
 * password form, this script — not a human — submits that login.
 *
 * Credentials arrive ONLY as environment variables (never argv, which can
 * appear in a process listing) and this script never writes them to disk,
 * never includes them in its own stdout/stderr, and never returns them —
 * the one line of output on success/failure is a JSON object with a
 * username or a genuinely generic error message, never the password. See
 * lib/instagram.mjs's submitCredentialLogin for where the password is
 * actually used (typed into Instagram's own real login form, exactly once)
 * and lib/logger.mjs's redaction for defense in depth if anything
 * unexpected ever tried to log it anyway.
 *
 * Self-hosted operators (Docker/systemd) never run this — they keep using
 * login.mjs's own human-supervised flow exactly as before; this script is
 * only ever invoked inside the Sandbox this project's own Vercel deployment
 * manages.
 */
import { openProfile } from "./lib/browser.mjs";
import { submitCredentialLogin } from "./lib/instagram.mjs";
import { reportSession } from "./lib/api-client.mjs";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.log(JSON.stringify({ ok: false, message: `${name} is not set` }));
    process.exit(1);
  }
  return value;
}

async function main() {
  const organizationId = requireEnv("INSTAGRAM_LOGIN_ORG_ID");
  const username = requireEnv("INSTAGRAM_LOGIN_USERNAME");
  const password = requireEnv("INSTAGRAM_LOGIN_PASSWORD");

  const { browser, page } = await openProfile(organizationId, { headless: true });
  await reportSession({ organizationId, status: "connecting" }).catch(() => {});

  try {
    const result = await submitCredentialLogin(page, username, password);

    if (!result.ok) {
      await reportSession({
        organizationId,
        status: result.reason === "challenged" ? "browser_unavailable" : "authentication_required",
        error: result.detail,
      }).catch(() => {});
      console.log(JSON.stringify({ ok: false, reason: result.reason, message: result.detail }));
      return;
    }

    const report = await reportSession({ organizationId, status: "connected", username: result.username, profileRef: organizationId });
    if (report.status !== 200) {
      console.log(JSON.stringify({ ok: false, message: "Login succeeded, but reporting the connection back to Business Badhao failed." }));
      return;
    }
    console.log(JSON.stringify({ ok: true, username: result.username }));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(() => {
  // Deliberately generic: an unexpected error's own .message is never
  // included here, since it could in principle echo back page content this
  // script interacted with. Nothing about a genuine failure needs more than
  // this to be reported honestly to the caller (see sandbox-runtime.ts).
  console.log(JSON.stringify({ ok: false, message: "The runtime encountered an unexpected error during login." }));
  process.exitCode = 1;
});
