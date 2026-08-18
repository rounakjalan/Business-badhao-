import type { AiConfig } from "@/lib/ai/config";
import type { AiTaskType } from "@/lib/ai/router/task-types";
import type { AiProviderName } from "@/lib/ai/types";

/**
 * Default task -> preferred-provider policy. This table is the single
 * place that encodes "what kind of task should prefer which provider" —
 * change it here, never by scattering provider choices through individual
 * agents. Research/reasoning-heavy tasks prefer OpenRouter (our
 * configured deep-reasoning model); fast classification prefers Groq.
 *
 * GENERAL_CHAT is deliberately excluded — it always follows whatever
 * AI_PROVIDER is configured to (see resolveRouting), so Ask AI's existing
 * behavior is untouched by this table.
 *
 * A task's preferred provider is only ever a *preference*. Hermes still
 * checks isConfigured() on every entry in the returned providerOrder and
 * skips ones that aren't usable — this table never bypasses that check.
 */
const TASK_PROVIDER_POLICY: Partial<Record<AiTaskType, AiProviderName>> = {
  CAMPAIGN_PLANNING: "openrouter",
  ICP_GENERATION: "openrouter",
  LEAD_DISCOVERY: "openrouter",
  PROSPECT_RESEARCH: "openrouter",
  LEAD_QUALIFICATION: "openrouter",
  OUTREACH_GENERATION: "openrouter",
  CONVERSATION: "openrouter",
  FOLLOW_UP: "openrouter",
  DEAL_ANALYSIS: "openrouter",
  LOSS_ANALYSIS: "openrouter",
  RECOVERY_ANALYSIS: "openrouter",
  INTENT_DETECTION: "groq",
};

export type RoutingDecision = {
  /**
   * Providers to try, in order. Hermes tries each in turn, skipping any
   * that isn't configured (missing credentials) — identical mechanism to
   * the primary/fallback loop that already existed before this router.
   */
  providerOrder: AiProviderName[];
  /** What this task type prefers, before checking whether it's actually configured. */
  preferredProvider: AiProviderName;
};

/**
 * Decides which provider(s) Hermes should try for a given task, and in
 * what order. Never assumes a provider is actually usable by itself —
 * that check (isConfigured()) stays in Hermes, exactly where it already
 * was.
 *
 * Design choice: if the task's preferred provider isn't the same as the
 * app's configured primary (AI_PROVIDER), the configured primary is
 * always appended as the next candidate. This means a deployment that
 * hasn't configured every provider (e.g. no Groq credentials yet) never
 * breaks — INTENT_DETECTION simply falls through to whatever AI_PROVIDER
 * already is, which is exactly how it behaved before this router existed.
 * Once a provider is actually configured, task-based routing to it kicks
 * in automatically, with no code change required.
 */
export function resolveRouting(taskType: AiTaskType, config: AiConfig): RoutingDecision {
  const preferredProvider = taskType === "GENERAL_CHAT" ? config.provider : TASK_PROVIDER_POLICY[taskType] ?? config.provider;

  const providerOrder: AiProviderName[] = [];
  const add = (name: AiProviderName) => {
    if (!providerOrder.includes(name)) providerOrder.push(name);
  };

  add(preferredProvider);
  add(config.provider);
  if (config.fallbackProvider) add(config.fallbackProvider);

  return { providerOrder, preferredProvider };
}
