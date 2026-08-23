"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ProspectResearchResult } from "@/lib/ai/agents/prospect-research";
import type { LeadQualificationResult } from "@/lib/ai/agents/qualification";
import { generateOutreach, type OutreachGeneratorResult } from "@/lib/ai/agents/outreach";
import { getBusinessContext, selectOutreachContext } from "@/lib/business-context";
import { sendGmailMessage } from "@/lib/gmail/send";
import { getConnectionStatus, type ConnectedAccountStatus } from "@/lib/gmail/tokens";
import { resolveLeadIdentity } from "@/lib/lead-names";
import { ensureConversation } from "@/lib/outreach/conversation";
import { loadLeadContext as loadSharedLeadContext, qualifyLead, researchLead } from "@/lib/pipeline/lead-pipeline";
import { completeAgentRun, createAgentRun, recordAgentAction } from "@/lib/ai/tracking/agent-runs";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database.types";

/** Session-scoped wrapper: the shared pipeline takes an explicit client and org. */
async function loadLeadContext(leadId: string, organizationId: string) {
  const supabase = await createClient();
  return loadSharedLeadContext(supabase, leadId, organizationId);
}

export async function runLeadResearchAction(leadId: string): Promise<ProspectResearchResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to run research." };

  const supabase = await createClient();
  const result = await researchLead(supabase, currentOrg.organizationId, leadId);
  if (result.ok) revalidatePath(`/leads/${leadId}`);
  return result;
}

export async function runLeadQualificationAction(leadId: string): Promise<LeadQualificationResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to run qualification." };

  const supabase = await createClient();
  const result = await qualifyLead(supabase, currentOrg.organizationId, leadId);
  if (result.ok) {
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    revalidatePath("/dashboard");
  }
  return result;
}

export async function generateLeadOutreachAction(leadId: string, channel: string): Promise<OutreachGeneratorResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to generate outreach." };

  const context = await loadLeadContext(leadId, currentOrg.organizationId);
  if (!context) return { ok: false, message: "Lead not found." };

  const supabase = await createClient();
  const { data: latestScore } = await supabase
    .from("lead_scores")
    .select("reason")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const businessContext = await getBusinessContext(currentOrg.organizationId);

  return generateOutreach({
    organizationId: currentOrg.organizationId,
    leadName: context.leadName,
    companyName: context.companyName,
    channel,
    campaignName: context.campaignName,
    campaignObjective: context.campaignObjective,
    researchSummary: context.latestResearchSummary,
    qualificationReasons: latestScore?.reason ? [latestScore.reason] : [],
    businessContext: selectOutreachContext(businessContext),
  });
}

export async function updateLeadNotes(leadId: string, formData: FormData) {
  const notes = String(formData.get("notes") ?? "");
  const supabase = await createClient();
  await supabase.from("leads").update({ notes }).eq("id", leadId);
  revalidatePath(`/leads/${leadId}`);
}

export async function quickCreateDealForLead(leadId: string, leadName: string) {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/onboarding");

  const supabase = await createClient();
  const { data: lead } = await supabase.from("leads").select("campaign_id").eq("id", leadId).maybeSingle();

  const { data: deal, error } = await supabase
    .from("deals")
    .insert({
      organization_id: currentOrg.organizationId,
      lead_id: leadId,
      campaign_id: lead?.campaign_id ?? null,
      title: `Deal with ${leadName}`,
      status: "open",
      value: 0,
    })
    .select("id")
    .single();

  if (error || !deal) return;
  redirect(`/deals/${deal.id}`);
}

export async function quickCreateTaskForLead(leadId: string, leadName: string) {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/onboarding");

  const supabase = await createClient();
  await supabase.from("tasks").insert({
    organization_id: currentOrg.organizationId,
    title: `Follow up with ${leadName}`,
    related_entity_type: "lead",
    related_entity_id: leadId,
  });

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/tasks");
}

export async function getGmailStatusAction(): Promise<ConnectedAccountStatus> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { connected: false, emailAddress: null };
  return getConnectionStatus(currentOrg.organizationId);
}

export type SendOutreachResult =
  | { ok: true; conversationId: string; messageId: string; sentTo: string }
  | {
      ok: false;
      code:
        | "unauthenticated"
        | "empty_message"
        | "missing_email"
        | "not_connected"
        | "reauth_required"
        | "invalid_recipient"
        | "rate_limited"
        | "send_failed"
        | "network_error"
        | "not_configured";
      message: string;
    };

/**
 * Sends one outreach email to a lead through the organization's connected
 * Gmail account, after the user has previewed/edited the AI draft. This is
 * the only place that actually sends anything — generateLeadOutreachAction
 * only ever drafts, exactly as before.
 *
 * idempotencyKey is generated once per Send click on the client: a
 * duplicate call with the same key (a double click, a retried network
 * request) returns the first attempt's real outcome instead of sending a
 * second email. This is enforced by a unique index on
 * messages.send_idempotency_key, not just this check — see the migration.
 */
export async function sendLeadOutreachAction(
  leadId: string,
  input: { subject: string; body: string; idempotencyKey: string }
): Promise<SendOutreachResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, code: "unauthenticated", message: "Sign in to a workspace to send outreach." };

  const body = input.body.trim();
  if (!body) return { ok: false, code: "empty_message", message: "Write a message before sending." };

  const supabase = await createClient();

  const identity = await resolveLeadIdentity(supabase, leadId);
  if (!identity.email) {
    return { ok: false, code: "missing_email", message: "No email address is on file for this lead — add one before sending." };
  }

  const conversation = await ensureConversation(supabase, currentOrg.organizationId, leadId, "email");
  const conversationId = conversation.ok ? conversation.conversationId : null;

  // Reserve the idempotency key with a row BEFORE calling Gmail — status
  // starts null ("in flight"), resolved to sent/failed below. This is what
  // actually closes the race a plain check-then-send has: two concurrent
  // requests for the same click can't both get past this insert, because
  // the second one collides with the unique index on send_idempotency_key
  // and never reaches Gmail at all.
  const { data: reserved, error: reserveError } = await supabase
    .from("messages")
    .insert({
      organization_id: currentOrg.organizationId,
      conversation_id: conversationId,
      lead_id: leadId,
      direction: "outbound",
      channel: "email",
      sender_type: "human",
      body,
      subject: input.subject || null,
      to_address: identity.email,
      send_idempotency_key: input.idempotencyKey,
      metadata: { aiDrafted: true } as unknown as Json,
    })
    .select("id")
    .single();

  if (reserveError || !reserved) {
    // 23505 = unique_violation: someone already reserved this exact key.
    const { data: existing } = await supabase
      .from("messages")
      .select("id, conversation_id, status, to_address")
      .eq("organization_id", currentOrg.organizationId)
      .eq("send_idempotency_key", input.idempotencyKey)
      .maybeSingle();

    if (existing?.status === "sent" && existing.conversation_id) {
      return { ok: true, conversationId: existing.conversation_id, messageId: existing.id, sentTo: existing.to_address ?? "" };
    }
    if (existing) {
      return {
        ok: false,
        code: "send_failed",
        message: "This send is already in progress or already failed once — regenerate and send again rather than retrying the same attempt.",
      };
    }
    return { ok: false, code: "send_failed", message: reserveError?.message ?? "Could not record this send attempt." };
  }

  const agentRun = await createAgentRun(currentOrg.organizationId, "outreach_send", { leadId, channel: "email" } as unknown as Json);
  const result = await sendGmailMessage({ organizationId: currentOrg.organizationId, to: identity.email, subject: input.subject, body });

  if (!result.ok) {
    await supabase
      .from("messages")
      .update({ status: "failed", metadata: { error: result.message, code: result.code, aiDrafted: true } as unknown as Json })
      .eq("id", reserved.id);
    await completeAgentRun(agentRun, "failed", { code: result.code, message: result.message } as unknown as Json);
    return { ok: false, code: result.code, message: result.message };
  }

  await supabase
    .from("messages")
    .update({
      status: "sent",
      from_address: result.fromAddress,
      external_id: result.messageId,
      metadata: { gmailThreadId: result.threadId, aiDrafted: true } as unknown as Json,
    })
    .eq("id", reserved.id);

  if (conversationId) {
    await supabase.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);
  }

  await completeAgentRun(agentRun, "completed", { messageId: result.messageId, threadId: result.threadId } as unknown as Json);
  if (agentRun) {
    await recordAgentAction({
      organizationId: currentOrg.organizationId,
      agentRunId: agentRun.id,
      actionType: "outreach_sent",
      targetEntityType: "lead",
      targetEntityId: leadId,
      payload: { to: identity.email, subject: input.subject } as unknown as Json,
    });
  }

  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/conversations");
  if (conversationId) revalidatePath(`/conversations/${conversationId}`);

  return { ok: true, conversationId: conversationId ?? "", messageId: reserved.id, sentTo: identity.email };
}
