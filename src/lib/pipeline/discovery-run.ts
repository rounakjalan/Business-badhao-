import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

type Client = SupabaseClient<Database>;

/**
 * STEP 7 — target-based, durable, auto-completing discovery.
 *
 * "Start Discovery" no longer means "run whatever a single serverless
 * request's own time budget allows." It means "find this many genuinely new,
 * valid, persisted leads for this campaign, research them, then finish" —
 * and that target survives across however many separate invocations it
 * takes to reach it (a request hitting the platform's own execution limit,
 * a deploy, a retry). This module is the shared piece both
 * startLeadDiscoveryAction (campaigns/actions.ts) and runDiscoveryForCampaign
 * (scheduled-pipeline.ts) use for that: deciding whether an existing run
 * should be continued rather than restarted, and computing that run's real
 * progress from persisted state rather than an in-memory counter that a new
 * invocation would start over from zero.
 *
 * Nothing here changes discovery's own AI/provider architecture — Hermes,
 * Nemotron, Tavily/Exa, the Independent Hermes Reviewer, the Deterministic
 * Validator, and runBatchedDiscovery's own per-batch loop are untouched.
 * This only changes how many NEW leads one invocation is asked to find
 * (the remaining distance to the target, not a fixed number) and what
 * happens to the run's status once that invocation ends.
 */

/**
 * How many genuinely new, valid, persisted leads one "Start Discovery" run
 * is asked to reach before it finishes. Configurable, not a hard ceiling:
 * raising it later (10 -> 25 -> 50) means changing this one number (or,
 * later, threading a per-campaign override into the same `targetLeads`
 * field this module already reads/writes) — never touching the lifecycle
 * logic itself.
 */
export const DEFAULT_DISCOVERY_TARGET = 10;

/**
 * How long a "running" lead_discovery run can sit before it is treated as
 * dead (its serverless function died mid-flight: timeout, deploy, crash)
 * rather than genuinely still in flight. Shared by every reader/writer of a
 * run's liveness — the duplicate-run guard, the stale-run display healer,
 * and the scheduled sweep's own equivalent check — so "how stale is too
 * stale" is answered in exactly one place.
 */
export const STALE_RUN_AFTER_MS = 15 * 60 * 1000;

export type LatestDiscoveryRun = {
  id: string;
  status: string;
  startedAt: string | null;
  targetLeads: number;
  /** A genuinely unrecoverable reason (no search provider configured) — resuming would just fail identically, so this is the one case a fresh run's own hard failure is never retried automatically. */
  hardFailure: boolean;
};

/** The campaign's most recent lead_discovery run, or null if it has never had one. */
export async function getLatestDiscoveryRun(supabase: Client, organizationId: string, campaignId: string): Promise<LatestDiscoveryRun | null> {
  const { data: run } = await supabase
    .from("agent_runs")
    .select("id, status, started_at, input, output")
    .eq("organization_id", organizationId)
    .eq("agent_type", "lead_discovery")
    .contains("input", { campaignId })
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!run) return null;

  const input = (run.input ?? null) as { targetLeads?: number } | null;
  const output = (run.output ?? null) as { code?: string } | null;

  return {
    id: run.id,
    status: run.status,
    startedAt: run.started_at,
    targetLeads: input?.targetLeads ?? DEFAULT_DISCOVERY_TARGET,
    hardFailure: run.status === "failed" && output?.code === "not_configured",
  };
}

/** Whether a "running" run this old should still block a new invocation from starting — a genuine concurrency guard, not a liveness guess about anything past this window. */
export function isRunGenuinelyActive(run: LatestDiscoveryRun | null, now: number = Date.now()): boolean {
  if (!run || run.status !== "running") return false;
  const startedAtMs = run.startedAt ? Date.parse(run.startedAt) : NaN;
  return !Number.isNaN(startedAtMs) && now - startedAtMs <= STALE_RUN_AFTER_MS;
}

/**
 * The run to continue toward its own stored target, or null if a brand new
 * one should be started instead. A run already fully finished (completed/
 * partially_completed) or dead for a genuinely unrecoverable reason (no
 * search provider configured) is never resumed — everything else,
 * including one still marked "running" from an invocation that died
 * mid-flight, or "failed" for a transient reason (a provider outage, a rate
 * limit), picks up toward the same stored target instead of losing progress
 * or creating a second, duplicate run for the same campaign.
 *
 * Returns the run itself (not a boolean) deliberately: `false` from a
 * boolean-returning predicate over `LatestDiscoveryRun | null` reads to
 * TypeScript's control-flow analysis as "therefore null," which is untrue
 * here (a non-null, non-resumable run is a real, common case) and silently
 * mis-narrows every caller. Returning the value itself keeps every caller's
 * types honest.
 */
export function getResumableRun(run: LatestDiscoveryRun | null): LatestDiscoveryRun | null {
  if (!run) return null;
  if (run.status === "completed" || run.status === "partially_completed") return null;
  if (run.hardFailure) return null;
  return run;
}

/** Convenience boolean form of getResumableRun, for callers that only need the decision, not the value (e.g. tests). */
export function isResumable(run: LatestDiscoveryRun | null): boolean {
  return getResumableRun(run) !== null;
}

export type DiscoveryRunProgress = {
  targetLeads: number;
  /** Genuinely new, persisted leads belonging to THIS run — never the campaign's total, and never an in-memory count. Computed from leads created at or after this run's own startedAt, so a resumed invocation reads the truth left by an earlier one instead of starting over. */
  validLeadCount: number;
  researchedCount: number;
  researchFailedCount: number;
  /** Still "pending"/"researching" — not yet at a terminal research outcome. */
  researchPendingCount: number;
};

/**
 * A run's real progress, read straight from the leads it has actually
 * persisted so far — never trusted from a variable that would reset to zero
 * on a fresh invocation. Scoped to leads created at or after `runStartedAt`
 * so a campaign's pre-existing backlog (found by an earlier, already-
 * finished run) never counts toward this run's own target.
 */
export async function getRunProgress(
  supabase: Client,
  organizationId: string,
  campaignId: string,
  runStartedAt: string,
  targetLeads: number
): Promise<DiscoveryRunProgress> {
  const { data: leads } = await supabase
    .from("leads")
    .select("research_status")
    .eq("organization_id", organizationId)
    .eq("campaign_id", campaignId)
    .gte("created_at", runStartedAt);

  const rows = leads ?? [];
  const researchedCount = rows.filter((l) => l.research_status === "completed").length;
  const researchFailedCount = rows.filter((l) => l.research_status === "failed").length;

  return {
    targetLeads,
    validLeadCount: rows.length,
    researchedCount,
    researchFailedCount,
    researchPendingCount: rows.length - researchedCount - researchFailedCount,
  };
}

/**
 * Target reached AND every one of this run's own leads has reached a
 * terminal research outcome (succeeded or genuinely failed) — never just
 * "this invocation's own time ran out." A run that hasn't met this stays
 * "running" for a later invocation to continue, per the discovery-lifecycle
 * fix this backs: TARGET REACHED + REQUIRED RESEARCH FINISHED, not TIME
 * EXPIRED.
 */
export function isRunComplete(progress: DiscoveryRunProgress): boolean {
  return progress.validLeadCount >= progress.targetLeads && progress.researchPendingCount === 0;
}
