"use server";

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { getDashboardStats, getOpenDeals, getRecentLeads, getUpcomingTasks } from "@/lib/dashboard";
import { formatCurrency } from "@/lib/format";
import { getCurrentOrg } from "@/lib/organizations";

const SYSTEM_PROMPT =
  "You are the AI sidekick embedded in Business Badhao, a customer-acquisition CRM for small and growing " +
  "Indian businesses. You are given a real snapshot of the signed-in user's workspace. Reply with ONE short, " +
  "specific, actionable suggestion (2-3 sentences max) about what they should focus on next. Reference the " +
  "actual numbers or names given — never invent data that isn't in the snapshot. You may call lookup_lead, " +
  "search_leads, or lookup_deal if the snapshot doesn't have enough detail to give a specific suggestion — " +
  "use them only when genuinely useful, not on every request. Plain text only, no markdown, no headers, no " +
  "bullet points.";

export type AskAiResult = {
  suggestion: string;
  isLive: boolean;
};

export async function getAskAiSuggestion(): Promise<AskAiResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    return { suggestion: "Sign in to a workspace to get suggestions based on your real data.", isLive: false };
  }

  const [stats, recentLeads, openDeals, tasks] = await Promise.all([
    getDashboardStats(currentOrg.organizationId),
    getRecentLeads(currentOrg.organizationId),
    getOpenDeals(currentOrg.organizationId),
    getUpcomingTasks(currentOrg.organizationId),
  ]);

  const topLeads = recentLeads
    .filter((lead) => (lead.currentScore ?? 0) >= 70)
    .map((lead) => `${lead.name} (score ${lead.currentScore})`);

  const snapshot = [
    `Organization: ${currentOrg.organizationName}`,
    `Qualified leads: ${stats.qualifiedLeads}`,
    `Active conversations: ${stats.activeConversations}`,
    `Follow-ups due: ${stats.followUpsDue}`,
    `Open deals: ${stats.openDeals} worth ${formatCurrency(stats.openPipelineValue, stats.currency)}`,
    `Won this month: ${stats.wonThisMonth} (${formatCurrency(stats.wonRevenueThisMonth, stats.currency)})`,
    `High-scoring leads not yet converted: ${topLeads.length > 0 ? topLeads.join(", ") : "none"}`,
    `Upcoming tasks: ${tasks.length > 0 ? tasks.map((t) => t.title).join("; ") : "none"}`,
    `Open deal titles: ${openDeals.length > 0 ? openDeals.map((d) => d.title).join(", ") : "none"}`,
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: currentOrg.organizationId,
    agentType: "ask_ai_sidekick",
    taskType: "GENERAL_CHAT",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: snapshot,
    maxTokens: 500,
    enableTools: true,
  });

  if (!result.ok) {
    return { suggestion: result.message, isLive: false };
  }

  return { suggestion: result.text, isLive: true };
}
