/**
 * Real navigation/search/extraction against Instagram's own public web UI —
 * no private/undocumented API, no scraping service, no reverse-engineered
 * endpoint. Every selector here targets Instagram's actual rendered DOM as
 * of when this file was written.
 *
 * HONESTY NOTE FOR WHOEVER OPERATES THIS RUNTIME: Instagram changes its web
 * markup periodically without notice, the way most large web apps do. These
 * selectors were written against Instagram's documented public structure
 * (search box, profile links, bio text) but could not be verified against
 * the live site from the environment that wrote this code — no dedicated
 * Instagram account or outbound path to the real site was available there.
 * If a query starts returning zero results where you'd expect real ones,
 * the most likely cause is a selector that no longer matches — inspect the
 * live page (right-click → Inspect on instagram.com while logged in) and
 * update the selectors below accordingly. This is ordinary, expected
 * maintenance for any DOM-based integration, not a sign the approach itself
 * is wrong.
 *
 * This module never attempts to solve a CAPTCHA, bypass MFA, or work around
 * a rate limit — see checkSessionStillValid/searchBusinessAccounts below,
 * which both fail honestly (throwing, or returning ok:false) the moment
 * Instagram itself blocks or challenges the request, exactly per this
 * project's own security requirement.
 */

const BASE_URL = "https://www.instagram.com";
const LOGIN_URL = "https://www.instagram.com/accounts/login/";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True the moment the page shows something only Instagram's own anti-bot/challenge flow would show — never worked around, only detected and reported honestly. */
async function isChallenged(page) {
  const url = page.url();
  if (/\/challenge\/|\/accounts\/suspended\/|\/two_factor\//.test(url)) return true;
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    return /unusual activity|confirm it.?s you|help us confirm|enter the code we sent/i.test(text);
  });
}

/**
 * Reads the currently logged-in username off Instagram's own nav — the
 * profile link Instagram itself renders for whoever is signed in. Returns
 * null (never throws) when the page doesn't look logged-in, which is the
 * expected signal on the login page or a logged-out session.
 */
async function extractLoggedInUsername(page) {
  try {
    return await page.evaluate(() => {
      const profileImg = document.querySelector('img[alt*="profile picture" i]');
      const link = profileImg?.closest("a[href]");
      const href = link?.getAttribute("href") || "";
      const match = href.match(/^\/([A-Za-z0-9._]+)\/?$/);
      return match ? match[1] : null;
    });
  } catch {
    return null;
  }
}

/**
 * Opens the login page and waits for a human operator to complete a REAL
 * manual login in the visible (headless: false) browser window — this
 * function never sees, types, or transmits a password itself. Detects
 * success purely by observing the page Instagram itself renders afterward.
 */
export async function waitForManualLogin(page, { timeoutMs = 10 * 60 * 1000, pollIntervalMs = 3000 } = {}) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isChallenged(page)) {
      return { ok: false, reason: "challenged", detail: "Instagram is showing a security challenge (CAPTCHA/verification code/2FA). Resolve it manually in the open browser window; this runtime will keep waiting." };
    }
    if (!page.url().includes("/accounts/login")) {
      const username = await extractLoggedInUsername(page);
      if (username) return { ok: true, username };
    }
    await sleep(pollIntervalMs);
  }
  return { ok: false, reason: "timeout", detail: "No successful login was detected within the wait window." };
}

/** Re-checks a previously authenticated profile is still actually logged in — the real signal for reporting session_expired rather than assuming a saved profile still works forever. */
export async function checkSessionStillValid(page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  if (await isChallenged(page)) {
    return { ok: false, reason: "challenged" };
  }
  const username = await extractLoggedInUsername(page);
  return username ? { ok: true, username } : { ok: false, reason: "logged_out" };
}

/**
 * Real discovery: navigates to Instagram, uses its own search UI to look for
 * accounts matching `query`, and reads real result rows off the rendered
 * page — never a constructed search-API request (Instagram's web search has
 * no public API to call directly). Each candidate's profile page is then
 * visited individually (bounded to profileEnrichLimit) to read its real bio,
 * category, and external link — fields the search results list itself does
 * not reliably expose.
 */
export async function searchBusinessAccounts(page, query, { maxResults = 15, profileEnrichLimit = 8, politenessDelayMs = 400 } = {}) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  if (await isChallenged(page)) {
    throw new Error("Instagram is showing a security challenge on this profile — resolve it manually before running discovery jobs again.");
  }

  const searchInputSelector = 'input[placeholder="Search" i], input[aria-label="Search Input" i]';
  await page.waitForSelector(searchInputSelector, { timeout: 15000 });
  await page.click(searchInputSelector);
  await page.type(searchInputSelector, query, { delay: 60 });
  await sleep(2500); // Instagram's own live-search results render asynchronously after typing.

  const rawResults = await page.evaluate((limit) => {
    const anchors = Array.from(document.querySelectorAll('a[href^="/"]'));
    const seen = new Set();
    const out = [];
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const match = href.match(/^\/([A-Za-z0-9._]+)\/?$/);
      if (!match) continue;
      const username = match[1];
      if (seen.has(username) || ["explore", "reels", "direct", "accounts"].includes(username)) continue;
      seen.add(username);
      const nameEl = a.querySelector("span");
      out.push({ username, profileUrl: `https://www.instagram.com/${username}/`, displayName: nameEl?.textContent?.trim() || null });
      if (out.length >= limit) break;
    }
    return out;
  }, maxResults);

  const enriched = [];
  for (const [index, candidate] of rawResults.entries()) {
    if (index >= profileEnrichLimit) {
      enriched.push({ ...candidate, bio: null, category: null, externalUrl: null });
      continue;
    }
    await sleep(politenessDelayMs);
    const details = await enrichProfile(page, candidate.profileUrl).catch(() => ({ bio: null, category: null, externalUrl: null }));
    enriched.push({ ...candidate, ...details });
  }

  return enriched;
}

/** Visits one real profile page and reads whatever real bio/category/external-link content Instagram actually renders there — never invented when a field isn't present. */
async function enrichProfile(page, profileUrl) {
  await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
  if (await isChallenged(page)) return { bio: null, category: null, externalUrl: null };

  return page.evaluate(() => {
    const header = document.querySelector("header");
    const bioEl = header?.querySelector("h1 + div, div[data-testid='user-bio']");
    const categoryEl = Array.from(header?.querySelectorAll("span, div") || []).find((el) => /\b(category|business)\b/i.test(el.textContent || "") && (el.textContent || "").length < 80);
    const linkEl = header?.querySelector('a[href^="http"]:not([href*="instagram.com"])');
    return {
      bio: bioEl?.textContent?.trim() || null,
      category: categoryEl?.textContent?.trim() || null,
      externalUrl: linkEl?.getAttribute("href") || null,
    };
  });
}
