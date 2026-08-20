"use server";

import { revalidatePath } from "next/cache";
import { runDealAgent, type DealAgentResult } from "@/lib/ai/agents/deal-agent";
import { runLossAnalysis, type LossAnalysisResult } from "@/lib/ai/agents/loss-analysis";
import { getBusinessContext, selectDealContext, selectLossAnalysisContext } from "@/lib/business-context";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database.types";

async function loadDealContext(dealId: string, organizationId: string) {
  const supabase = await createClient();

  const { data: deal } = await supabase
    .from("deals")
    .select("id, title, status, value, currency, loss_reason, lead_id, campaign_id")
    .eq("id", dealId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!deal) return null;

  const [contact, campaign, conversation] = await Promise.all([
    deal.lead_id
      ? supabase.from("contacts").select("full_name").eq("lead_id", deal.lead_id).eq("is_primary", true).maybeSingle()
      : Promise.resolve({ data: null }),
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
    leadName: contact.data?.full_name ?? "the lead",
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

export async function markDealWon(dealId: string) {
  const supabase = await createClient();
  const { data: deal } = await supabase.from("deals").select("organization_id").eq("id", dealId).maybeSingle();
  await supabase.from("deals").update({ status: "won", won_at: new Date().toISOString() }).eq("id", dealId);

  if (deal) {
    await supabase.from("deal_events").insert({ organization_id: deal.organization_id, deal_id: dealId, event_type: "won" });
  }

  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals");
  revalidatePath("/dashboard");
}

export async function markDealLost(dealId: string, lossReason: string) {
  const supabase = await createClient();
  const { data: deal } = await supabase.from("deals").select("organization_id").eq("id", dealId).maybeSingle();

  await supabase
    .from("deals")
    .update({ status: "lost", lost_at: new Date().toISOString(), loss_reason: lossReason || null })
    .eq("id", dealId);

  if (deal) {
    await supabase.from("deal_events").insert({ organization_id: deal.organization_id, deal_id: dealId, event_type: "lost" });
    if (lossReason) {
      await supabase.from("loss_analysis").insert({
        organization_id: deal.organization_id,
        deal_id: dealId,
        reason_category: lossReason,
      });
    }
  }

  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals");
  revalidatePath("/dashboard");
}

export async function updateDealStage(dealId: string, status: "open" | "negotiation" | "won" | "lost") {
  const supabase = await createClient();
  await supabase.from("deals").update({ status }).eq("id", dealId);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals");
}
