/**
 * Thin client for the three server-to-server endpoints this runtime calls on
 * Business Badhao's own deployment — all bearer-secret authenticated with
 * the same INSTAGRAM_DISCOVERY_RUNTIME_TOKEN the deployment itself is
 * configured with. This file makes no assumption about what Business Badhao
 * does with these calls; it only knows the three real, already-implemented
 * routes:
 *   - POST /api/instagram-discovery/session-report  (login.mjs, and worker.mjs
 *     when it discovers a saved session no longer works)
 *   - POST /api/instagram-discovery/jobs/claim       (worker.mjs's poll loop)
 *   - POST /api/instagram-discovery/jobs/complete    (worker.mjs, after a real
 *     search)
 */

function baseUrl() {
  const url = process.env.BUSINESS_BADHAO_API_URL;
  if (!url) throw new Error("BUSINESS_BADHAO_API_URL is not set — see .env.example.");
  return url.replace(/\/$/, "");
}

function token() {
  const value = process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
  if (!value) throw new Error("INSTAGRAM_DISCOVERY_RUNTIME_TOKEN is not set — see .env.example.");
  return value;
}

async function post(path, body) {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

/** organizationId (required), status, and optionally username/profileRef/error — see connection.ts's InstagramDiscoveryRuntimeReport for the exact accepted shape. */
export function reportSession(report) {
  return post("/api/instagram-discovery/session-report", report);
}

/** Polls for the next pending job. `data.job` is null when there is nothing to do right now — not an error. */
export function claimJob() {
  return post("/api/instagram-discovery/jobs/claim", {});
}

/** outcome is either {status:"completed", candidates:[...]} or {status:"failed", error:"..."}. */
export function completeJob(jobId, outcome) {
  return post("/api/instagram-discovery/jobs/complete", { jobId, ...outcome });
}
