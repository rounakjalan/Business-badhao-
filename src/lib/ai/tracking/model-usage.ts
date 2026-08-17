import { createClient } from "@/lib/supabase/server";

/**
 * Records real token usage for a completed AI call. Best-effort: a
 * tracking failure must never break the AI feature itself.
 *
 * The model_usage table's input_tokens/output_tokens columns are NOT NULL
 * with a default of 0 (existing schema — not changed here), so when a
 * provider doesn't report usage we store 0 rather than fabricating a
 * number. cost_usd is left at its column default (0) since no provider
 * adapter currently computes a real cost figure; wire that in once pricing
 * data is actually available per provider, rather than guessing here.
 */
export async function recordModelUsage(params: {
  organizationId: string | null;
  agentRunId: string | null;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}): Promise<void> {
  if (!params.organizationId) return;

  try {
    const supabase = await createClient();
    const { error } = await supabase.from("model_usage").insert({
      organization_id: params.organizationId,
      agent_run_id: params.agentRunId,
      provider: params.provider,
      model: params.model,
      input_tokens: params.inputTokens ?? 0,
      output_tokens: params.outputTokens ?? 0,
    });

    if (error) {
      console.error("[ai] failed to record model_usage", error);
    }
  } catch (error) {
    console.error("[ai] failed to record model_usage", error);
  }
}
