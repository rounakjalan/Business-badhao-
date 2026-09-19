import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUsableInstagramDiscoveryProfileRef } from "@/lib/instagram-discovery/connection";

/**
 * The dispatch/result queue between a real discovery run (running inside
 * this Vercel deployment, synchronously, with a bounded time budget — see
 * TOTAL_REQUEST_BUDGET_MS in campaigns/actions.ts) and a real Hermes browser
 * runtime (hermes-browser-runtime/, a separate Node.js process this
 * application never bundles into its own serverless functions — see
 * instagram_discovery_jobs' own migration for why). By default that process
 * is one Business Badhao itself starts on demand, in its own Vercel Sandbox
 * (see src/lib/instagram-discovery/sandbox-runtime.ts) — not something an
 * operator has to provision or keep running, though running it yourself
 * (Docker/systemd) remains supported (INSTAGRAM_DISCOVERY_SANDBOX_DISABLED).
 * Either way it's the exact same worker.mjs, talking to this same queue.
 *
 * Business Badhao cannot call the runtime directly (Vercel cannot receive an
 * inbound connection to a serverless invocation that's still running, and a
 * Sandbox worker only ever makes outbound calls). Instead:
 *   1. createInstagramDiscoveryJob (a real search) or
 *      createInstagramDiscoveryVerificationJob (Settings' "Test Connection")
 *      writes a `pending` row, and (by default) wakeHermesSandboxRuntime
 *      ensures a real worker is actively polling for it.
 *   2. The runtime polls claimNextInstagramDiscoveryJob (its own bearer-secret
 *      authenticated endpoint, api/instagram-discovery/jobs/claim) for work.
 *   3. The runtime performs the real work (a search, or just re-checking its
 *      saved session) using this organization's own authenticated Chromium
 *      profile and calls completeInstagramDiscoveryJob's endpoint
 *      (jobs/complete) with real, structured results (or a real failure).
 *   4. pollInstagramDiscoveryJobResult (called from InstagramDiscoveryTool
 *      and from the Test Connection server action) reads this same row
 *      back, bounded to a fixed timeout — if the runtime never answers in
 *      time, this honestly reports a failure/timeout, never a fabricated
 *      result.
 *
 * Two job types share this one table (never a second, parallel job schema —
 * see this task's own "reuse existing tables" instruction):
 *   - "search": a real discovery query, exactly as before.
 *   - "verify": Settings' "Test Connection" button — no search, just a real
 *     re-check that the saved session is still authenticated, used to give
 *     an operator an on-demand answer instead of waiting for the next
 *     scheduled discovery run to (maybe) reveal a dead session.
 */

export type InstagramDiscoveryCandidate = {
  username: string;
  profileUrl: string;
  displayName?: string | null;
  bio?: string | null;
  category?: string | null;
  externalUrl?: string | null;
};

type JobCriteria = { type: "search"; query: string } | { type: "verify" };

type JobRow = {
  id: string;
  organization_id: string;
  status: string;
  criteria: JobCriteria;
  candidates: InstagramDiscoveryCandidate[] | null;
  error: string | null;
};

/** How long a dispatched job stays claimable before it's considered abandoned by whatever request created it. Kept well inside a single Vercel invocation's own budget (see module doc comment) since nothing waits longer than that anyway. */
const JOB_TTL_MS = 120_000;

async function insertJob(organizationId: string, criteria: JobCriteria): Promise<{ jobId: string } | null> {
  const admin = createAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("instagram_discovery_jobs")
    .insert({
      organization_id: organizationId,
      criteria,
      expires_at: new Date(Date.now() + JOB_TTL_MS).toISOString(),
    })
    .select("id")
    .maybeSingle();

  if (error || !data) return null;
  return { jobId: data.id };
}

/**
 * Called from InstagramDiscoveryTool.search() — one query in, one job row
 * created. Returns null (never throws) when automation isn't configured in
 * this deployment, the same "degrade to off" convention as every other
 * admin-client-backed function in this codebase.
 */
export function createInstagramDiscoveryJob(organizationId: string, query: string): Promise<{ jobId: string } | null> {
  return insertJob(organizationId, { type: "search", query });
}

/** Called from Settings' "Test Connection" action — a real job the runtime answers by re-checking its saved session, not by searching anything. */
export function createInstagramDiscoveryVerificationJob(organizationId: string): Promise<{ jobId: string } | null> {
  return insertJob(organizationId, { type: "verify" });
}

export type ClaimedInstagramDiscoveryJob =
  | { id: string; organizationId: string; type: "search"; query: string; browserProfileRef: string }
  | { id: string; organizationId: string; type: "verify"; browserProfileRef: string };

/**
 * Marks any `pending`/`claimed` job whose expires_at has already passed as
 * `expired` — the real fix for "jobs cannot remain permanently stuck": a
 * worker that crashes mid-job leaves its claim behind forever otherwise.
 * Uses the job lifecycle's EXISTING `expired` status (see this table's own
 * migration) rather than inventing a new one. Called at the start of every
 * claim attempt so the queue never accumulates dead rows; also safe to call
 * on its own (e.g. from a health check) since it only ever moves already-
 * timed-out rows, never a live one.
 */
export async function reclaimStaleInstagramDiscoveryJobs(): Promise<number> {
  const admin = createAdminClient();
  if (!admin) return 0;

  const { data } = await admin
    .from("instagram_discovery_jobs")
    .update({ status: "expired" })
    .in("status", ["pending", "claimed"])
    .lt("expires_at", new Date().toISOString())
    .select("id");

  return data?.length ?? 0;
}

/**
 * The runtime's own poll loop calls this (via jobs/claim's API route) to get
 * the oldest unclaimed, unexpired job. Never claims a job for an organization
 * whose connection isn't actually reporting usable ("connected"/"ready") —
 * getUsableInstagramDiscoveryProfileRef below re-checks the connection at
 * claim time (not just at job-creation time, since a session can expire in
 * between). The organization a claimed job belongs to always comes from this
 * table's own row, never from anything the calling runtime supplies — the
 * claim endpoint takes no organization-scoped input at all (see its own
 * route file), so there is nothing here for an untrusted caller to spoof.
 */
export async function claimNextInstagramDiscoveryJob(): Promise<ClaimedInstagramDiscoveryJob | null> {
  const admin = createAdminClient();
  if (!admin) return null;

  await reclaimStaleInstagramDiscoveryJobs();

  const { data: pending } = await admin
    .from("instagram_discovery_jobs")
    .select("id, organization_id, criteria")
    .eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(10);

  for (const job of pending ?? []) {
    const browserProfileRef = await getUsableInstagramDiscoveryProfileRef(job.organization_id);
    if (!browserProfileRef) continue;

    // Only actually claims if still pending — guards against two concurrent
    // runtime pollers (or a retry) claiming the same job twice.
    const { data: claimed } = await admin
      .from("instagram_discovery_jobs")
      .update({ status: "claimed", claimed_at: new Date().toISOString() })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id, organization_id, criteria")
      .maybeSingle();

    if (!claimed) continue;

    const criteria = claimed.criteria as JobCriteria;
    return criteria.type === "search"
      ? { id: claimed.id, organizationId: claimed.organization_id, type: "search", query: criteria.query, browserProfileRef }
      : { id: claimed.id, organizationId: claimed.organization_id, type: "verify", browserProfileRef };
  }

  return null;
}

export type CompleteInstagramDiscoveryJobInput = {
  jobId: string;
  status: "completed" | "failed";
  candidates?: InstagramDiscoveryCandidate[];
  error?: string;
};

export type CompleteJobResult = { ok: true } | { ok: false; code: "not_configured" | "not_claimed" | "db_error"; message: string };

/** The runtime's report of one job's real outcome (via jobs/complete's API route). Only updates a job still in `claimed` — a report for an already-completed/expired job is rejected rather than silently overwriting a result its own caller may have already given up waiting for. */
export async function completeInstagramDiscoveryJob(input: CompleteInstagramDiscoveryJobInput): Promise<CompleteJobResult> {
  const admin = createAdminClient();
  if (!admin) return { ok: false, code: "not_configured", message: "Automation isn't configured in this deployment." };

  const { data, error } = await admin
    .from("instagram_discovery_jobs")
    .update({
      status: input.status,
      candidates: input.status === "completed" ? (input.candidates ?? []) : null,
      error: input.status === "failed" ? (input.error ?? "Unknown runtime error") : null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", input.jobId)
    .eq("status", "claimed")
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, code: "db_error", message: error.message };
  if (!data) return { ok: false, code: "not_claimed", message: "This job is not currently claimed (already completed, expired, or unknown)." };
  return { ok: true };
}

/**
 * Bounded polling read for InstagramDiscoveryTool and the Test Connection
 * action — never blocks longer than timeoutMs regardless of whether the
 * runtime ever answers. A timeout is reported exactly like any other real
 * failure (ok:false); this never fabricates candidates for a job nobody
 * actually completed.
 */
export async function pollInstagramDiscoveryJobResult(
  jobId: string,
  timeoutMs: number
): Promise<{ ok: true; candidates: InstagramDiscoveryCandidate[] } | { ok: false; message: string }> {
  const admin = createAdminClient();
  if (!admin) return { ok: false, message: "Automation isn't configured in this deployment." };

  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 2_000;

  while (Date.now() < deadline) {
    const { data } = await admin
      .from("instagram_discovery_jobs")
      .select("id, organization_id, status, criteria, candidates, error")
      .eq("id", jobId)
      .maybeSingle<JobRow>();

    if (data?.status === "completed") return { ok: true, candidates: data.candidates ?? [] };
    if (data?.status === "failed") return { ok: false, message: data.error ?? "The Instagram discovery runtime reported a failure." };

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { ok: false, message: "The Instagram discovery runtime did not respond within the allotted time." };
}

export type InstagramDiscoveryQueueStats = {
  pending: number;
  claimed: number;
  completedLast24h: number;
  failedLast24h: number;
  expiredLast24h: number;
};

/**
 * A safe-for-monitoring aggregate — counts only, never a job's own criteria
 * or candidates — for the runtime's own /health endpoint and any future
 * operator-facing dashboard. `pending`/`claimed` are current-state counts
 * (unbounded by time: a stuck job from hours ago is exactly what this needs
 * to surface); the completed/failed/expired counts are bounded to the last
 * 24h so this never scans the table's entire history as it grows.
 */
export async function getInstagramDiscoveryQueueStats(): Promise<InstagramDiscoveryQueueStats | null> {
  const admin = createAdminClient();
  if (!admin) return null;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [{ data: active }, { data: recent }] = await Promise.all([
    admin.from("instagram_discovery_jobs").select("status").in("status", ["pending", "claimed"]),
    admin.from("instagram_discovery_jobs").select("status").gte("created_at", since).in("status", ["completed", "failed", "expired"]),
  ]);

  const activeRows = active ?? [];
  const recentRows = recent ?? [];

  return {
    pending: activeRows.filter((r) => r.status === "pending").length,
    claimed: activeRows.filter((r) => r.status === "claimed").length,
    completedLast24h: recentRows.filter((r) => r.status === "completed").length,
    failedLast24h: recentRows.filter((r) => r.status === "failed").length,
    expiredLast24h: recentRows.filter((r) => r.status === "expired").length,
  };
}
