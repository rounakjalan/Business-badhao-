import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

type Client = SupabaseClient<Database>;

/**
 * Recurring campaign discovery — the scheduling half.
 *
 * A discovery run still does exactly what it always did and stops at exactly
 * the same limit (the existing per-request time budget; see
 * FOLLOW_UP_BUDGET_MS in campaigns/actions.ts and the 300s function ceiling).
 * All this adds is what happens *after* it stops: the campaign books its own
 * next run about an hour out, and the cron sweep that already exists picks it
 * up. Nothing here runs a long-lived process, holds a request open, or loops.
 *
 * Duplicate scheduling is structurally impossible rather than merely guarded:
 * the "next run" is a single column on the campaign row, so booking one is an
 * UPDATE of that one slot. Two runs finishing at once overwrite the same slot
 * with near-identical timestamps instead of queueing two jobs.
 */

/** How long after a run finishes the next one becomes due. */
export const DISCOVERY_INTERVAL_MS = 60 * 60 * 1000;

export type DiscoveryScheduleState = "running" | "scheduled" | "stopped" | "completed" | "failed";

export type CampaignDiscoverySchedule = {
  state: DiscoveryScheduleState;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
};

export type DiscoveryScheduleRow = {
  discovery_state: DiscoveryScheduleState;
  discovery_next_run_at: string | null;
};

/** The timestamp one discovery interval from `from`. */
export function nextDiscoveryRunAt(from: Date = new Date()): string {
  return new Date(from.getTime() + DISCOVERY_INTERVAL_MS).toISOString();
}

/**
 * Whether the sweep should run discovery for this campaign right now.
 *
 * "stopped" is the only state that blocks a run outright — that is what the
 * Stop Discovery button writes, and honouring it here is what makes stopping
 * actually prevent future runs rather than merely pause the UI.
 *
 * "running" is skipped too, but as a liveness check rather than a wish: a
 * process that died mid-run never writes a terminal state, and a campaign
 * stuck at "running" forever would never be discovered again. Past
 * staleAfterMs the row is treated as dead and the campaign becomes due again
 * — the same reasoning (and window) as the agent_runs staleness guard that
 * already protects the manual path.
 *
 * A null nextRunAt means "never scheduled" — every campaign that existed
 * before scheduling was added reads that way, and they stay due exactly as
 * they were before, rather than silently falling out of the sweep.
 */
export function isDiscoveryDue(
  row: DiscoveryScheduleRow & { discovery_last_run_at?: string | null },
  now: Date = new Date(),
  staleAfterMs: number = 15 * 60 * 1000
): boolean {
  if (row.discovery_state === "stopped") return false;

  if (row.discovery_state === "running") {
    const startedAt = row.discovery_last_run_at ? Date.parse(row.discovery_last_run_at) : NaN;
    if (Number.isNaN(startedAt)) return false;
    return now.getTime() - startedAt > staleAfterMs;
  }

  if (!row.discovery_next_run_at) return true;

  const dueAt = Date.parse(row.discovery_next_run_at);
  if (Number.isNaN(dueAt)) return true;

  return now.getTime() >= dueAt;
}

/**
 * Marks a run as in flight. Deliberately does not touch discovery_next_run_at:
 * the slot keeps whatever it held until the run finishes and books the next
 * one, so a crash mid-run leaves a still-meaningful due time behind rather
 * than an empty slot.
 */
export async function markDiscoveryRunning(supabase: Client, campaignId: string, organizationId: string): Promise<void> {
  await supabase
    .from("campaigns")
    .update({ discovery_state: "running", discovery_last_run_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("organization_id", organizationId);
}

/**
 * Books the next run, about an hour out, and records how this one ended.
 *
 * A failed run still books its next attempt — a provider timeout or a rate
 * limit is a reason to try again later, not to silently end the campaign's
 * discovery forever. It writes one slot, the same single slot a successful
 * run writes, so a failure cannot leave two schedules behind.
 *
 * Never revives a stopped campaign: if the user pressed Stop while the run
 * was in flight, that decision wins and no next run is booked.
 */
export async function markDiscoveryFinished(
  supabase: Client,
  campaignId: string,
  organizationId: string,
  outcome: { ok: boolean; error?: string | null }
): Promise<void> {
  const { data: current } = await supabase
    .from("campaigns")
    .select("discovery_state")
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (current?.discovery_state === "stopped") return;

  await supabase
    .from("campaigns")
    .update({
      discovery_state: outcome.ok ? "scheduled" : "failed",
      discovery_next_run_at: nextDiscoveryRunAt(),
      discovery_last_error: outcome.ok ? null : (outcome.error ?? "Discovery failed.").slice(0, 500),
    })
    .eq("id", campaignId)
    .eq("organization_id", organizationId);
}

/** Stop Discovery: clears the pending slot so no future run is scheduled. */
export async function stopCampaignDiscovery(supabase: Client, campaignId: string, organizationId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("campaigns")
    .update({ discovery_state: "stopped", discovery_next_run_at: null })
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  return Boolean(data) && !error;
}

/**
 * Resume Discovery: books the campaign as due now, so the next sweep picks it
 * up rather than making the user wait a full interval for a cycle they just
 * asked to restart.
 */
export async function resumeCampaignDiscovery(supabase: Client, campaignId: string, organizationId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("campaigns")
    .update({ discovery_state: "scheduled", discovery_next_run_at: new Date().toISOString(), discovery_last_error: null })
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .select("id")
    .maybeSingle();

  return Boolean(data) && !error;
}

export async function getCampaignDiscoverySchedule(
  supabase: Client,
  campaignId: string,
  organizationId: string
): Promise<CampaignDiscoverySchedule | null> {
  const { data } = await supabase
    .from("campaigns")
    .select("discovery_state, discovery_next_run_at, discovery_last_run_at, discovery_last_error")
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!data) return null;

  return {
    state: data.discovery_state,
    nextRunAt: data.discovery_next_run_at,
    lastRunAt: data.discovery_last_run_at,
    lastError: data.discovery_last_error,
  };
}

/**
 * How long until the next run, in whole minutes — for the "Next discovery:
 * approximately …" line. Null when nothing is scheduled; 0 when it is already
 * due (the sweep runs hourly, so "due" means "on the next tick", never
 * "overdue" in a way the user needs to act on).
 */
export function minutesUntilNextRun(nextRunAt: string | null, now: Date = new Date()): number | null {
  if (!nextRunAt) return null;
  const dueAt = Date.parse(nextRunAt);
  if (Number.isNaN(dueAt)) return null;
  return Math.max(0, Math.round((dueAt - now.getTime()) / 60_000));
}
