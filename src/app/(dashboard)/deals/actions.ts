"use server";

import { revalidatePath } from "next/cache";
import { runDealAgent, type DealAgentResult } from "@/lib/ai/agents/deal-agent";
import { runLossAnalysis, type LossAnalysisResult } from "@/lib/ai/agents/loss-analysis";
import { getBusinessContext, selectDealContext, selectLossAnalysisContext } from "@/lib/business-context";
import { isClosedDealStage, isOpenDealStage } from "@/lib/deals";
import { resolveLeadIdentity } from "@/lib/lead-names";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database.types";

export type DealActionResult = { ok: true } | { ok: false; message: string };

async function loadDealContext(dealId: string, organizationId: string) {
  const supabase = await createClient();

  const { data: deal } = await supabase
    .from("deals")
    .select("id, title, status, value, currency, loss_reason, lead_id, campaign_id")
    .eq("id", dealId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!deal) return null;

  const [identity, campaign, conversation] = await Promise.all([
    deal.lead_id ? resolveLeadIdentity(supabase, deal.lead_id) : Promise.resolve(null),
    deal.campaign_id ? supabase.from("campaigns").select("objective").eq("id", deal.campaign_id).maybeSingle() : Promise.resolve({ data: null }),
    deal.lead_id
      ? supabase
          .from("conversations")
          .select("id, channel")
          .eq("lead_id", deal.lead_id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  let messages: { direction: string; senderType: string; body: string }[] = [];
  if (conversation.data?.id) {
    const { data } = await supabase
      .from("messages")
      .select("direction, sender_type, body")
      .eq("conversation_id", conversation.data.id)
      .order("created_at", { ascending: true });
    messages = (data ?? []).map((m) => ({ direction: m.direction, senderType: m.sender_type, body: m.body ?? "" }));
  }

  return {
    deal,
    leadName: identity?.name ?? "the lead",
    campaignObjective: campaign.data?.objective ?? null,
    channel: conversation.data?.channel ?? null,
    messages,
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
    businessContext: selectLossAnalysisContext(businessContext),
  });

  if (result.ok) {
    const supabase = await createClient();
    const a = result.analysis;
    const details: Json = {
      primaryReason: a.primaryReason,
      secondaryReasons: a.secondaryReasons,
      rootCause: a.rootCause,
      lessons: a.lessons,
      recommendedCampaignChanges: a.recommendedCampaignChanges,
      recommendedIcpChanges: a.recommendedIcpChanges,
      recommendedOutreachChanges: a.recommendedOutreachChanges,
    };

    const { data: existing } = await supabase
      .from("loss_analysis")
      .select("id")
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
