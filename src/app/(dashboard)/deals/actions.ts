"use server";

import { revalidatePath } from "next/cache";
import { runDealAgent, type DealAgentResult } from "@/lib/ai/agents/deal-agent";
import type { BuyingIntentSnapshot } from "@/lib/ai/agents/intent";
import { runLossAnalysis, type LossAnalysisResult } from "@/lib/ai/agents/loss-analysis";
import { getBusinessContext, selectDealContext, selectLossAnalysisContext } from "@/lib/business-context";
import { isClosedDealStage, isOpenDealStage } from "@/lib/deals";
import { loadBuyingIntentHistory } from "@/lib/intent-history";
import { resolveLeadIdentity } from "@/lib/lead-names";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database.types";

export type DealActionResult = { ok: true } | { ok: false; message: string };

async function loadDealContext(dealId: string, organizationId: string) {
  const supabase = await createClient();

  const { data: deal } = await supabase
    .from("deals")
    .select("id, title, status, value, currency, loss_reason, lead_id, campaign_id, conversation_id")
    .eq("id", dealId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!deal) return null;

  const [identity, campaign, conversation] = await Promise.all([
    deal.lead_id ? resolveLeadIdentity(supabase, deal.lead_id) : Promise.resolve(null),
    deal.campaign_id ? supabase.from("campaigns").select("objective").eq("id", deal.campaign_id).maybeSingle() : Promise.resolve({ data: null }),
    // Prefer the specific conversation this deal was created from; fall
    // back to the lead's most recent one for deals created before that
    // link existed.
    deal.conversation_id
      ? supabase.from("conversations").select("id, channel, buying_intent").eq("id", deal.conversation_id).maybeSingle()
      : deal.lead_id
        ? supabase
            .from("conversations")
            .select("id, channel, buying_intent")
            .eq("lead_id", deal.lead_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
  ]);

  let messages: { direction: string; senderType: string; body: string }[] = [];
  let buyingIntentHistory: BuyingIntentSnapshot[] = [];
  if (conversation.data?.id) {
    const [messagesRes, history] = await Promise.all([
      supabase
        .from("messages")
        .select("direction, sender_type, body")
        .eq("conversation_id", conversation.data.id)
        .order("created_at", { ascending: true }),
      loadBuyingIntentHistory(supabase, conversation.data.id, organizationId),
    ]);
    messages = (messagesRes.data ?? []).map((m) => ({ direction: m.direction, senderType: m.sender_type, body: m.body ?? "" }));
    buyingIntentHistory = history;
  }

  return {
    deal,
    leadName: identity?.name ?? "the lead",
    campaignObjective: campaign.data?.objective ?? null,
    channel: conversation.data?.channel ?? null,
    messages,
    buyingIntentHistory,
    currentBuyingIntent: conversation.data?.buying_intent ?? null,
  };
}

export async function runDealAgentAction(dealId: string): Promise<DealAgentResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to run the deal agent." };

  const context = await loadDealContext(dealId, currentOrg.organizationId);
  if (!context) return { ok: false, message: "Deal not found." };

  const businessContext = await getBusinessContext(currentOrg.organizationId);

  const result = await runDealAgent({
    organizationId: currentOrg.organizationId,
    dealTitle: context.deal.title,
    value: context.deal.value,
    currency: context.deal.currency,
    status: context.deal.status,
    leadName: context.leadName,
    channel: context.channel,
    messages: context.messages,
    businessContext: selectDealContext(businessContext),
  });

  if (result.ok) {
    const supabase = await createClient();
    await supabase.from("deal_events").insert({
      organization_id: currentOrg.organizationId,
      deal_id: dealId,
      event_type: "ai_recommendation",
      payload: result.recommendation as unknown as Json,
    });
    revalidatePath(`/deals/${dealId}`);
  }

  return result;
}

export async function runLossAnalysisAction(dealId: string): Promise<LossAnalysisResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to run loss analysis." };

  const context = await loadDealContext(dealId, currentOrg.organizationId);
  if (!context) return { ok: false, message: "Deal not found." };

  const businessContext = await getBusinessContext(currentOrg.organizationId);

  const result = await runLossAnalysis({
    organizationId: currentOrg.organizationId,
    dealTitle: context.deal.title,
    value: context.deal.value,
    currency: context.deal.currency,
    humanSelectedReason: context.deal.loss_reason,
    leadName: context.leadName,
    campaignObjective: context.campaignObjective,
    messages: context.messages,
    buyingIntentHistory: context.buyingIntentHistory,
    currentBuyingIntent: context.currentBuyingIntent,
    businessContext: selectLossAnalysisContext(businessContext),
  });

  if (result.ok) {
    const supabase = await createClient();
    const a = result.analysis;
    // buyingIntentHistory/currentBuyingIntent are the real recorded data fed
    // into the model above (see loadBuyingIntentHistory) — stored alongside
    // its analysis so the deal page and the aggregate Lost Deal Intelligence
    // view can show them without re-deriving them from conversation_events
    // every render.
    const details: Json = {
      primaryReason: a.primaryReason,
      secondaryReasons: a.secondaryReasons,
      confidence: a.confidence,
      rootCause: a.rootCause,
      objections: a.objections,
      pricingConcerns: a.pricingConcerns,
      productFitConcerns: a.productFitConcerns,
      timingConcerns: a.timingConcerns,
      competitorMentions: a.competitorMentions,
      communicationIssues: a.communicationIssues,
      supportingEvidence: a.supportingEvidence,
      productOrServiceInvolved: a.productOrServiceInvolved,
      recoveryOpportunity: a.recoveryOpportunity,
      lessons: a.lessons,
      recommendedCampaignChanges: a.recommendedCampaignChanges,
      recommendedIcpChanges: a.recommendedIcpChanges,
      recommendedOutreachChanges: a.recommendedOutreachChanges,
      buyingIntentHistory: context.buyingIntentHistory,
      currentBuyingIntent: context.currentBuyingIntent,
    } as unknown as Json;

    const { data: existing } = await supabase
      .from("loss_analysis")
      .select("id")
      .eq("organization_id", currentOrg.organizationId)
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      await supabase.from("loss_analysis").update({ summary: a.summary, details }).eq("id", existing.id);
    } else {
      await supabase.from("loss_analysis").insert({
        organization_id: currentOrg.organizationId,
        deal_id: dealId,
        reason_category: context.deal.loss_reason,
        summary: a.summary,
        details,
      });
    }

    revalidatePath(`/deals/${dealId}`);
    revalidatePath("/deals/lost-intelligence");
  }

  return result;
}

/**
 * Closes a deal as Won. This — and markDealLost below — are the only two
 * places deals.status is ever set to a closed value: the AI deal agent
 * only recommends (runDealAgentAction, above), it never has write access to
 * this table, and updateDealStage (below) explicitly refuses closed stages.
 * Closing a deal is always this human-initiated action.
 */
export async function markDealWon(dealId: string): Promise<DealActionResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to close this deal." };

  const supabase = await createClient();
  const { data: deal } = await supabase
    .from("deals")
    .select("id, status")
    .eq("id", dealId)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!deal) return { ok: false, message: "Deal not found." };
  if (deal.status === "lost") return { ok: false, message: "This deal was already marked Lost." };
  if (deal.status === "won") return { ok: true };

  const { error } = await supabase
    .from("deals")
    .update({ status: "won", won_at: new Date().toISOString() })
    .eq("id", dealId)
    .eq("organization_id", currentOrg.organizationId);
  if (error) return { ok: false, message: error.message };

  await supabase.from("deal_events").insert({ organization_id: currentOrg.organizationId, deal_id: dealId, event_type: "won" });

  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals");
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Closes a deal as Lost. The loss_analysis row this writes is the same
 * record the (separate, not-yet-built) Lost Deal Intelligence phase will
 * read from later — recording it here is preserving this existing
 * behavior, not starting that phase.
 */
export async function markDealLost(dealId: string, lossReason: string): Promise<DealActionResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to close this deal." };
  if (!lossReason.trim()) return { ok: false, message: "Select a loss reason first." };

  const supabase = await createClient();
  const { data: deal } = await supabase
    .from("deals")
    .select("id, status")
    .eq("id", dealId)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!deal) return { ok: false, message: "Deal not found." };
  if (deal.status === "won") return { ok: false, message: "This deal was already marked Won." };

  const { error } = await supabase
    .from("deals")
    .update({ status: "lost", lost_at: new Date().toISOString(), loss_reason: lossReason })
    .eq("id", dealId)
    .eq("organization_id", currentOrg.organizationId);
  if (error) return { ok: false, message: error.message };

  await supabase.from("deal_events").insert({ organization_id: currentOrg.organizationId, deal_id: dealId, event_type: "lost" });
  await supabase.from("loss_analysis").insert({ organization_id: currentOrg.organizationId, deal_id: dealId, reason_category: lossReason });

  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals");
  revalidatePath("/dashboard");
  return { ok: true };
}

/**
 * Moves a deal between the four open stages (New, Qualified, Proposal /
 * Product Info, Payment Pending). Deliberately cannot reach Won or Lost —
 * closing a deal always goes through markDealWon/markDealLost, which
 * record the outcome timestamp a plain stage move wouldn't.
 */
export async function updateDealStage(dealId: string, stage: string): Promise<DealActionResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to move this deal." };
  if (!isOpenDealStage(stage)) {
    return { ok: false, message: "Use Mark Won or Mark Lost to close a deal." };
  }

  const supabase = await createClient();
  const { data: deal } = await supabase
    .from("deals")
    .select("id, status")
    .eq("id", dealId)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!deal) return { ok: false, message: "Deal not found." };
  if (isClosedDealStage(deal.status)) return { ok: false, message: "This deal is already closed." };

  const { error } = await supabase
    .from("deals")
    .update({ status: stage })
    .eq("id", dealId)
    .eq("organization_id", currentOrg.organizationId);
  if (error) return { ok: false, message: error.message };

  await supabase
    .from("deal_events")
    .insert({ organization_id: currentOrg.organizationId, deal_id: dealId, event_type: "stage_changed", payload: { to: stage } as unknown as Json });

  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals");
  return { ok: true };
}

/** Edits a deal's own core fields — does not touch stage, notes, or the acquisition-path links. */
export async function updateDeal(
  dealId: string,
  input: { title: string; value: number; currency: string; expectedCloseDate: string | null; probability: number | null }
): Promise<DealActionResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to edit this deal." };

  const title = input.title.trim();
  if (!title) return { ok: false, message: "Deal title is required." };
  if (!Number.isFinite(input.value) || input.value < 0) return { ok: false, message: "Value must be zero or greater." };
  if (input.probability !== null && (input.probability < 0 || input.probability > 100)) {
    return { ok: false, message: "Probability must be between 0 and 100." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("deals")
    .update({
      title,
      value: input.value,
      currency: input.currency.trim() || "INR",
      expected_close_date: input.expectedCloseDate || null,
      probability: input.probability,
    })
    .eq("id", dealId)
    .eq("organization_id", currentOrg.organizationId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, message: error.message };
  if (!data) return { ok: false, message: "Deal not found." };

  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals");
  return { ok: true };
}

export async function updateDealNotes(dealId: string, formData: FormData): Promise<DealActionResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to save notes." };

  const notes = String(formData.get("notes") ?? "");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("deals")
    .update({ notes: notes || null })
    .eq("id", dealId)
    .eq("organization_id", currentOrg.organizationId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, message: error.message };
  if (!data) return { ok: false, message: "Deal not found." };

  revalidatePath(`/deals/${dealId}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Recovery attempts. A recovery_attempts row is a human's record of trying
// (or planning to try) to re-engage a lost customer — a call they made, an
// email they sent by hand, a follow-up they're planning. Nothing here ever
// contacts anyone: there is no send path, no channel, no message body. The
// AI's only involvement anywhere near this is loss-analysis's
// recoveryOpportunity field, which is advisory text a human reads, not an
// action it can trigger.
// ---------------------------------------------------------------------------

export type RecoveryAttemptStatus = "planned" | "in_progress" | "succeeded" | "failed";
const RECOVERY_ATTEMPT_STATUSES: readonly RecoveryAttemptStatus[] = ["planned", "in_progress", "succeeded", "failed"];

export async function createRecoveryAttempt(dealId: string, notes: string): Promise<DealActionResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to log a recovery attempt." };

  const supabase = await createClient();
  const { data: deal } = await supabase
    .from("deals")
    .select("id, status")
    .eq("id", dealId)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!deal) return { ok: false, message: "Deal not found." };
  if (deal.status !== "lost") return { ok: false, message: "Recovery attempts can only be logged on a deal marked Lost." };

  const { data: lossAnalysis } = await supabase
    .from("loss_analysis")
    .select("id")
    .eq("organization_id", currentOrg.organizationId)
    .eq("deal_id", dealId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from("recovery_attempts").insert({
    organization_id: currentOrg.organizationId,
    deal_id: dealId,
    loss_analysis_id: lossAnalysis?.id ?? null,
    status: "planned",
    notes: notes.trim() || null,
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals/lost-intelligence");
  return { ok: true };
}

export async function updateRecoveryAttemptStatus(attemptId: string, dealId: string, rawStatus: string): Promise<DealActionResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to update this recovery attempt." };
  if (!RECOVERY_ATTEMPT_STATUSES.includes(rawStatus as RecoveryAttemptStatus)) {
    return { ok: false, message: "Not a valid recovery attempt status." };
  }
  const status = rawStatus as RecoveryAttemptStatus;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("recovery_attempts")
    .update(status === "planned" ? { status } : { status, attempted_at: new Date().toISOString() })
    .eq("id", attemptId)
    .eq("deal_id", dealId)
    .eq("organization_id", currentOrg.organizationId)
    .select("id")
    .maybeSingle();

  if (error) return { ok: false, message: error.message };
  if (!data) return { ok: false, message: "Recovery attempt not found." };

  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals/lost-intelligence");
  return { ok: true };
}

/**
 * One-click follow-up task for a deal — the same "quick add" pattern
 * quickCreateTaskForLead (leads/actions.ts) already uses, extended to the
 * one entity type that was missing it. The deal detail page's Tasks tab
 * already reads tasks with related_entity_type "deal" (see deals/[id]/page.tsx)
 * but had no writer, so it was always empty. Deliberately not automatic:
 * this app has no precedent for a system event silently creating a task —
 * even the AI-suggested follow-up on a conversation only becomes a task
 * when a human clicks for it (runFollowUpAction, conversations/actions.ts).
 */
export async function quickCreateTaskForDeal(dealId: string, dealTitle: string): Promise<DealActionResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to add a task." };

  const supabase = await createClient();
  const { data: deal } = await supabase.from("deals").select("id").eq("id", dealId).eq("organization_id", currentOrg.organizationId).maybeSingle();
  if (!deal) return { ok: false, message: "Deal not found." };

  const { error } = await supabase.from("tasks").insert({
    organization_id: currentOrg.organizationId,
    title: `Follow up on ${dealTitle}`,
    related_entity_type: "deal",
    related_entity_id: dealId,
  });
  if (error) return { ok: false, message: error.message };

  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/tasks");
  return { ok: true };
}
