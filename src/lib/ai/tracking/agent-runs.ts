import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database.types";

/** Scheduled work passes a client that does not depend on a signed-in user. */
type TrackingClient = SupabaseClient<Database>;
import type { Json } from "@/types/database.types";

export type AgentRunHandle = { id: string };

/**
 * Creates a real agent_runs row for an AI execution that is actually
 * happening right now — never call this to fabricate history for UI
 * display. Best-effort: a tracking failure must never break the AI
 * feature itself, so this logs and returns null instead of throwing.
 */
export async function createAgentRun(
  organizationId: string | null,
  agentType: string,
  input: Json,
  client?: TrackingClient,
  /** Overrides the default now()-at-call-time started_at — used by the target-based discovery lifecycle so the exact same timestamp it inserts with is also the one it scopes "leads belonging to this run" from, with no clock-skew gap between the two. */
  startedAt?: string
): Promise<AgentRunHandle | null> {
  if (!organizationId) return null;

  try {
    const supabase = client ?? (await createClient());
    const { data, error } = await supabase
      .from("agent_runs")
      .insert({
        organization_id: organizationId,
        agent_type: agentType,
        status: "running",
        input,
        started_at: startedAt ?? new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("[ai] failed to create agent_run", error);
      return null;
    }
    return { id: data.id };
  } catch (error) {
    console.error("[ai] failed to create agent_run", error);
    return null;
  }
}

export async function completeAgentRun(
  run: AgentRunHandle | null,
  status: "completed" | "failed" | "partially_completed",
  output: Json,
  client?: TrackingClient
): Promise<void> {
  if (!run) return;

  try {
    const supabase = client ?? (await createClient());
    const { error } = await supabase
      .from("agent_runs")
      .update({ status, output, completed_at: new Date().toISOString() })
      .eq("id", run.id);

    if (error) {
      console.error("[ai] failed to complete agent_run", error);
    }
  } catch (error) {
    console.error("[ai] failed to complete agent_run", error);
  }
}

/**
 * Updates a run's own output while it is still genuinely in progress —
 * unlike completeAgentRun, this never touches status or completed_at. Used
 * by the target-based discovery lifecycle (discovery-run.ts) to persist
 * durable progress (validLeadCount, researchPendingCount, …) after an
 * invocation that hasn't yet reached its target, so a later invocation
 * resuming the same run reads the truth from the database instead of
 * starting from zero.
 */
export async function updateAgentRunOutput(run: AgentRunHandle | null, output: Json, client?: TrackingClient): Promise<void> {
  if (!run) return;

  try {
    const supabase = client ?? (await createClient());
    const { error } = await supabase.from("agent_runs").update({ output }).eq("id", run.id);
    if (error) {
      console.error("[ai] failed to update agent_run output", error);
    }
  } catch (error) {
    console.error("[ai] failed to update agent_run output", error);
  }
}

/**
 * Reusable infrastructure for future agents (lead discovery, qualification,
 * outreach, etc.) to record individual actions taken within a run — e.g.
 * "lead_discovered", "message_generated". Not called by anything yet;
 * Ask AI doesn't take actions beyond generating text. Kept here so the
 * next phase's agents have a ready-made, RLS-safe way to record actions
 * without inventing their own insert logic.
 */
export async function recordAgentAction(params: {
  organizationId: string;
  agentRunId: string;
  actionType: string;
  targetEntityType?: string;
  targetEntityId?: string;
  payload?: Json;
  client?: TrackingClient;
}): Promise<void> {
  try {
    const supabase = params.client ?? (await createClient());
    const { error } = await supabase.from("agent_actions").insert({
      organization_id: params.organizationId,
      agent_run_id: params.agentRunId,
      action_type: params.actionType,
      target_entity_type: params.targetEntityType ?? null,
      target_entity_id: params.targetEntityId ?? null,
      payload: params.payload ?? {},
    });

    if (error) {
      console.error("[ai] failed to record agent_action", error);
    }
  } catch (error) {
    console.error("[ai] failed to record agent_action", error);
  }
}
