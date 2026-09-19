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
export async function openProfile(profileRef, { headless = true } = {}) {
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (!executablePath) {
    throw new Error("CHROMIUM_EXECUTABLE_PATH is not set — point it at a real, locally installed Chrome/Chromium binary (see .env.example).");
  }
  if (!profileRef) {
    throw new Error("A browser_profile_ref is required to open an organization's dedicated Chromium profile.");
  }

  const profilesDir = process.env.PROFILES_DIR || "./profiles";
  const userDataDir = path.resolve(profilesDir, profileRef);

  const browser = await puppeteer.launch({
    executablePath,
    userDataDir,
    headless,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
  });

  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await page.setViewport({ width: 1280, height: 900 });

  return { browser, page };
}
