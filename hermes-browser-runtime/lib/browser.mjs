import path from "node:path";
import puppeteer from "puppeteer-core";

/**
 * Launches a REAL, locally installed Chrome/Chromium binary (CHROMIUM_EXECUTABLE_PATH)
 * via puppeteer-core, using a per-organization user-data-dir as this
 * organization's dedicated, isolated browser profile — Chrome's own native
 * profile-persistence mechanism, so cookies/localStorage/session state
 * genuinely survive between separate runs of this process. Two different
 * `profileRef` values never share a directory, so two organizations' browser
 * state can never mix.
 *
 * This is a real local browser process (Chrome DevTools Protocol over a
 * local pipe/port) — not a cloud browser service, not Playwright's own
 * bundled browser, not a fake HTTP adapter.
 */
/** Organization ids/profile refs are UUIDs in practice, but this is checked explicitly (not assumed) before it ever touches a filesystem path — the one thing standing between "one organization's profile" and a path-traversal escape into another organization's directory (or anywhere else) if a future bug ever let an unexpected value through. */
const SAFE_PROFILE_REF = /^[A-Za-z0-9_-]+$/;

export async function openProfile(profileRef, { headless = true } = {}) {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (!executablePath) {
    throw new Error("CHROMIUM_EXECUTABLE_PATH is not set — point it at a real, locally installed Chrome/Chromium binary (see .env.example).");
  }
  if (!profileRef || !SAFE_PROFILE_REF.test(profileRef)) {
    throw new Error(`Refusing to open an unsafe or missing browser_profile_ref: ${JSON.stringify(profileRef)}`);
  }

  const profilesDir = process.env.PROFILES_DIR || "./profiles";
  const userDataDir = path.resolve(profilesDir, profileRef);

  // CHROMIUM_EXTRA_ARGS (space-separated) is how a containerized deployment
  // opts into flags like --no-sandbox --disable-dev-shm-usage that headless
  // Chromium typically needs under Docker's default seccomp/tmpfs limits —
  // see Dockerfile/docker-compose.yml, which set it explicitly. Left unset
  // on a bare-metal/systemd deployment, where the real OS sandbox should
  // stay on.
  const extraArgs = (process.env.CHROMIUM_EXTRA_ARGS || "").split(/\s+/).filter(Boolean);

  const browser = await puppeteer.launch({
    executablePath,
    userDataDir,
    headless,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled", ...extraArgs],
  });

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await page.setViewport({ width: 1280, height: 900 });

  return { browser, page };
}
