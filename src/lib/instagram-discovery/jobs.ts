import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUsableInstagramDiscoveryProfileRef } from "@/lib/instagram-discovery/connection";

/**
 * The dispatch/result queue between a real discovery run (running inside
 * this Vercel deployment, synchronously, with a bounded time budget — see
 * TOTAL_REQUEST_BUDGET_MS in campaigns/actions.ts) and an organization's own
 * external Hermes browser runtime (hermes-browser-runtime/, a separate,
 * always-available process this application does not host — see
 * instagram_discovery_jobs' own migration for why).
 *
 * Business Badhao cannot call the runtime directly (it isn't a service this
 * deployment has an address for, and Vercel cannot receive an inbound
 * connection to a serverless invocation that's still running). Instead:
 *   1. createInstagramDiscoveryJob writes a `pending` row.
 *   2. The runtime polls claimInstagramDiscoveryJob (its own bearer-secret
 *      authenticated endpoint, api/instagram-discovery/jobs/claim) for work.
 *   3. The runtime performs one real Instagram search using this
 *      organization's own authenticated Chromium profile and calls
 *      completeInstagramDiscoveryJob's endpoint (jobs/complete) with real,
 *      structured results (or a real failure).
 *   4. pollInstagramDiscoveryJobResult (called from InstagramDiscoveryTool,
 *      the DiscoverySearchTool implementation) reads this same row back,
 *      bounded to a fixed timeout — if the runtime never answers in time,
 *      this honestly reports a failure/timeout, never a fabricated result.
 */

export type InstagramDiscoveryCandidate = {
  username: string;
  profileUrl: string;
  displayName?: string | null;
  bio?: string | null;
  category?: string | null;
  externalUrl?: string | null;
};

type JobRow = {
  id: string;
  organization_id: string;
  status: string;
  criteria: { query: string };
  candidates: InstagramDiscoveryCandidate[] | null;
  error: string | null;
};

/** How long a dispatched job stays claimable before it's considered abandoned by whatever request created it. Kept well inside a single Vercel invocation's own budget (see module doc comment) since nothing waits longer than that anyway. */
const JOB_TTL_MS = 120_000;

/**
 * Called from InstagramDiscoveryTool.search() — one query in, one job row
 * created. Returns null (never throws) when automation isn't configured in
 * this deployment, the same "degrade to off" convention as every other
 * admin-client-backed function in this codebase.
 */
export async function createInstagramDiscoveryJob(organizationId: string, query: string): Promise<{ jobId: string } | null> {
  const admin = createAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("instagram_discovery_jobs")
    .insert({
      organization_id: organizationId,
      criteria: { query },
      expires_at: new Date(Date.now() + JOB_TTL_MS).toISOString(),
    })
    .select("id")
    .maybeSingle();

  if (error || !data) return null;
  return { jobId: data.id };
}

export type ClaimedInstagramDiscoveryJob = {
  id: string;
  organizationId: string;
  query: string;
  /** The dedicated local Chromium profile this job's org has authenticated — never a credential itself, just the runtime's own name for its profile directory. Null only if the connection isn't actually usable, which claim excludes below. */
  browserProfileRef: string | null;
};

/**
 * The runtime's own poll loop calls this (via jobs/claim's API route) to get
 * the oldest unclaimed, unexpired job. Real work only — never invents a job
 * for an organization whose connection isn't actually reporting usable
 * ("connected"/"ready"), which excludeConnectionCheck below enforces by
 * re-checking the connection at claim time (not just at job-creation time,
 * since a session can expire in between).
 */
export async function claimNextInstagramDiscoveryJob(): Promise<ClaimedInstagramDiscoveryJob | null> {
  const admin = createAdminClient();
  if (!admin) return null;

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

    const criteria = claimed.criteria as { query: string };
    return { id: claimed.id, organizationId: claimed.organization_id, query: criteria.query, browserProfileRef };
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
 * Bounded polling read for InstagramDiscoveryTool — never blocks longer than
 * timeoutMs regardless of whether the runtime ever answers. A timeout is
 * reported exactly like any other real failure (ok:false); this never
 * fabricates candidates for a job nobody actually completed.
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
