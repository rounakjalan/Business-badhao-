"use server";

import { revalidatePath } from "next/cache";
import { detectIntent, type IntentDetectionResult } from "@/lib/ai/agents/intent";
import { runFollowUp, type FollowUpResult } from "@/lib/ai/agents/follow-up";
import { getBusinessContext, selectFollowUpContext, selectIntentProductNames } from "@/lib/business-context";
import { resolveLeadIdentity } from "@/lib/lead-names";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database.types";

async function loadConversationContext(conversationId: string, organizationId: string) {
  const supabase = await createClient();

  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, lead_id, channel, intent")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!conversation) return null;

  const [identity, messagesRes] = await Promise.all([
    resolveLeadIdentity(supabase, conversation.lead_id),
    supabase
      .from("messages")
      .select("direction, sender_type, body")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true }),
  ]);

  const messages = (messagesRes.data ?? []).map((m) => ({ direction: m.direction, senderType: m.sender_type, body: m.body ?? "" }));

  return { conversation, leadName: identity.name, messages };
}

export async function detectIntentAction(conversationId: string): Promise<IntentDetectionResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to detect intent." };

  const context = await loadConversationContext(conversationId, currentOrg.organizationId);
  if (!context) return { ok: false, message: "Conversation not found." };

  const businessContext = await getBusinessContext(currentOrg.organizationId);

  const result = await detectIntent({
    organizationId: currentOrg.organizationId,
    leadName: context.leadName,
    channel: context.conversation.channel,
    messages: context.messages,
    productNames: selectIntentProductNames(businessContext),
  });

  if (result.ok) {
    const supabase = await createClient();
    await supabase.from("conversations").update({ intent: result.analysis.intent }).eq("id", conversationId);
    await supabase.from("conversation_events").insert({
      organization_id: currentOrg.organizationId,
      conversation_id: conversationId,
      event_type: "intent_detected",
      payload: result.analysis as unknown as Json,
    });
    revalidatePath(`/conversations/${conversationId}`);
  }

  return result;
}

export async function runFollowUpAction(conversationId: string): Promise<FollowUpResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, message: "Sign in to a workspace to generate a follow-up." };

  const context = await loadConversationContext(conversationId, currentOrg.organizationId);
  if (!context) return { ok: false, message: "Conversation not found." };

  const businessContext = await getBusinessContext(currentOrg.organizationId);

  const result = await runFollowUp({
    organizationId: currentOrg.organizationId,
    leadName: context.leadName,
    channel: context.conversation.channel,
    detectedIntent: context.conversation.intent,
    messages: context.messages,
    businessContext: selectFollowUpContext(businessContext),
  });

  if (result.ok) {
    const supabase = await createClient();
    const plan = result.plan;
    await supabase.from("tasks").insert({
      organization_id: currentOrg.organizationId,
      title: `Follow up with ${context.leadName}`,
      description: [
        `Suggested timing: ${plan.followUpTiming}`,
        `Draft message: ${plan.followUpMessage}`,
        plan.educationalContentSuggestion ? `Educational content: ${plan.educationalContentSuggestion}` : null,
        plan.objectionHandling.length > 0 ? `Objection handling: ${plan.objectionHandling.join("; ")}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      related_entity_type: "conversation",
      related_entity_id: conversationId,
    });
    revalidatePath(`/conversations/${conversationId}`);
    revalidatePath("/tasks");
  }

  return result;
}

/**
 * Records a message against the conversation. This does not send
 * anything over WhatsApp/email/etc — no outreach provider is connected
 * yet. It's an internal record of what was said, the same way a note
 * would be.
 */
export async function sendMessage(conversationId: string, formData: FormData) {
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return;

  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("channel, lead_id")
    .eq("id", conversationId)
    .maybeSingle();

  if (!conversation) return;

  await supabase.from("messages").insert({
    organization_id: currentOrg.organizationId,
    conversation_id: conversationId,
    lead_id: conversation.lead_id,
    direction: "outbound",
    channel: conversation.channel,
    sender_type: "human",
    body,
  });

  await supabase.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);

  revalidatePath(`/conversations/${conversationId}`);
}

export async function updateConversationStatus(conversationId: string, status: "open" | "pending" | "resolved" | "closed") {
  const supabase = await createClient();
  await supabase.from("conversations").update({ status }).eq("id", conversationId);
  revalidatePath(`/conversations/${conversationId}`);
  revalidatePath("/conversations");
}
