"use server";

import { revalidatePath } from "next/cache";
import { detectIntent, mapIntentToBuyingIntent, type IntentDetectionResult } from "@/lib/ai/agents/intent";
import { runFollowUp, type FollowUpResult } from "@/lib/ai/agents/follow-up";
import { getBusinessContext, selectFollowUpContext, selectIntentProductNames } from "@/lib/business-context";
import { checkForReplies, type CheckRepliesResult } from "@/lib/gmail/replies";
import { sendGmailMessage } from "@/lib/gmail/send";
import { resolveLeadIdentity } from "@/lib/lead-names";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import { sendWhatsAppMessage } from "@/lib/whatsapp/send";
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
    const buyingIntent = mapIntentToBuyingIntent(result.analysis.intent);
    await supabase.from("conversations").update({ intent: result.analysis.intent, buying_intent: buyingIntent }).eq("id", conversationId);
    // The Leads list and detail page both show a lead's intent; without
    // this the column has no writer anywhere and stays empty forever.
    await supabase
      .from("leads")
      .update({ intent: result.analysis.intent, buying_intent: buyingIntent })
      .eq("id", context.conversation.lead_id)
      .eq("organization_id", currentOrg.organizationId);
    await supabase.from("conversation_events").insert({
      organization_id: currentOrg.organizationId,
      conversation_id: conversationId,
      event_type: "intent_detected",
      payload: result.analysis as unknown as Json,
    });
    revalidatePath(`/conversations/${conversationId}`);
    revalidatePath("/leads");
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
    // Same reason as intent above: the lead's next action is displayed in
    // two places but was never written by anything.
    await supabase
      .from("leads")
      .update({ next_action: `Follow up ${plan.followUpTiming}` })
      .eq("id", context.conversation.lead_id)
      .eq("organization_id", currentOrg.organizationId);
    revalidatePath(`/conversations/${conversationId}`);
    revalidatePath("/leads");
    revalidatePath("/tasks");
  }

  return result;
}

export type SendMessageResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "empty_message"
        | "not_found"
        | "missing_recipient"
        | "not_connected"
        | "reauth_required"
        | "invalid_recipient"
        | "rate_limited"
        | "outside_window"
        | "send_failed"
        | "network_error"
        | "not_configured";
      message: string;
    };

/**
 * Sends a real reply into this conversation over its actual channel
 * (Gmail for email, WhatsApp Cloud API for whatsapp — see
 * src/lib/gmail/send.ts and src/lib/whatsapp/send.ts, both reused as-is,
 * not reimplemented) and records it. A human sending here takes over the
 * conversation automatically — the AI conversation agent
 * (src/lib/conversation-agent/respond.ts) checks conversations.owner and
 * stops responding the moment it is no longer 'ai', so this one write is
 * the entire takeover mechanism; the explicit Take Over button
 * (takeOverConversation below) exists for taking over before replying.
 */
export async function sendMessage(conversationId: string, formData: FormData): Promise<SendMessageResult> {
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return { ok: false, code: "empty_message", message: "Write a message before sending." };

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, code: "not_found", message: "Sign in to a workspace to send a message." };

  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("channel, lead_id")
    .eq("id", conversationId)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!conversation) return { ok: false, code: "not_found", message: "Conversation not found." };

  const identity = await resolveLeadIdentity(supabase, conversation.lead_id);
  const recipient = conversation.channel === "email" ? identity.email : conversation.channel === "whatsapp" ? identity.phone : null;
  if (!recipient) {
    return {
      ok: false,
      code: "missing_recipient",
      message: conversation.channel === "email" ? "No email address is on file for this lead." : conversation.channel === "whatsapp" ? "No phone number is on file for this lead." : `Sending over ${conversation.channel} isn't supported yet.`,
    };
  }

  await supabase.from("conversations").update({ owner: "human" }).eq("id", conversationId);

  const { data: lastSubjectRow } =
    conversation.channel === "email"
      ? await supabase.from("messages").select("subject").eq("conversation_id", conversationId).not("subject", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle()
      : { data: null };
  const subject = conversation.channel === "email" ? (lastSubjectRow?.subject ? (lastSubjectRow.subject.startsWith("Re: ") ? lastSubjectRow.subject : `Re: ${lastSubjectRow.subject}`) : "Re: your message") : null;

  const { data: reserved, error: reserveError } = await supabase
    .from("messages")
    .insert({
      organization_id: currentOrg.organizationId,
      conversation_id: conversationId,
      lead_id: conversation.lead_id,
      direction: "outbound",
      channel: conversation.channel,
      sender_type: "human",
      body,
      subject,
      to_address: recipient,
      send_idempotency_key: crypto.randomUUID(),
    })
    .select("id")
    .single();

  if (reserveError || !reserved) {
    return { ok: false, code: "send_failed", message: reserveError?.message ?? "Could not record this message." };
  }

  const sendResult =
    conversation.channel === "email"
      ? await sendGmailMessage({ organizationId: currentOrg.organizationId, to: recipient, subject: subject ?? "Re: your message", body })
      : conversation.channel === "whatsapp"
        ? await sendWhatsAppMessage({ organizationId: currentOrg.organizationId, to: recipient, body })
        : null;

  if (!sendResult) {
    await supabase.from("messages").update({ status: "failed", metadata: { error: "No real send integration exists for this channel yet." } as unknown as Json }).eq("id", reserved.id);
    revalidatePath(`/conversations/${conversationId}`);
    return { ok: false, code: "not_configured", message: `Sending over ${conversation.channel} isn't supported yet.` };
  }

  if (!sendResult.ok) {
    await supabase.from("messages").update({ status: "failed", metadata: { error: sendResult.message, code: sendResult.code } as unknown as Json }).eq("id", reserved.id);
    revalidatePath(`/conversations/${conversationId}`);
    return { ok: false, code: sendResult.code, message: sendResult.message };
  }

  await supabase
    .from("messages")
    .update({ status: "sent", from_address: conversation.channel === "email" ? recipient : null, external_id: sendResult.messageId })
    .eq("id", reserved.id);

  await supabase.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);

  revalidatePath(`/conversations/${conversationId}`);
  return { ok: true };
}

/**
 * Explicit human takeover — silences the AI conversation agent for this
 * conversation immediately, before the human has necessarily replied yet
 * (e.g. they want to think first). See sendMessage above for the other
 * way a conversation becomes human-owned.
 */
export async function takeOverConversation(conversationId: string) {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return;

  const supabase = await createClient();
  await supabase.from("conversations").update({ owner: "human" }).eq("id", conversationId).eq("organization_id", currentOrg.organizationId);
  await supabase.from("conversation_events").insert({
    organization_id: currentOrg.organizationId,
    conversation_id: conversationId,
    event_type: "human_takeover",
    payload: {} as unknown as Json,
  });

  revalidatePath(`/conversations/${conversationId}`);
}

/** Symmetric to takeOverConversation — hands the conversation back to the AI agent. */
export async function handBackToAi(conversationId: string) {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return;

  const supabase = await createClient();
  await supabase.from("conversations").update({ owner: "ai" }).eq("id", conversationId).eq("organization_id", currentOrg.organizationId);
  await supabase.from("conversation_events").insert({
    organization_id: currentOrg.organizationId,
    conversation_id: conversationId,
    event_type: "ai_resumed",
    payload: {} as unknown as Json,
  });

  revalidatePath(`/conversations/${conversationId}`);
}

export async function updateConversationStatus(conversationId: string, status: "open" | "pending" | "resolved" | "closed") {
  const supabase = await createClient();
  await supabase.from("conversations").update({ status }).eq("id", conversationId);
  revalidatePath(`/conversations/${conversationId}`);
  revalidatePath("/conversations");
}

/**
 * Polls the connected Gmail account for new replies and stores any that
 * match a known lead's email into that lead's conversation. Manually
 * triggered rather than automatic — see the comment on checkForReplies for
 * why this is the deliberately smallest foundation for inbound mail
 * rather than a real-time push subscription.
 */
export async function checkForRepliesAction(): Promise<CheckRepliesResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return { ok: false, code: "not_connected", message: "Sign in to a workspace to check for replies." };

  const result = await checkForReplies(currentOrg.organizationId);
  if (result.ok && result.newReplies > 0) {
    revalidatePath("/conversations");
  }
  return result;
}
