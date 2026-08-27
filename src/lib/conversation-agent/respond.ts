import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { generateConversationReply } from "@/lib/ai/agents/conversation-reply";
import { detectIntent, mapIntentToBuyingIntent } from "@/lib/ai/agents/intent";
import { getBusinessContext, selectConversationContext, selectIntentProductNames } from "@/lib/business-context";
import { sendGmailMessage } from "@/lib/gmail/send";
import { resolveLeadIdentity } from "@/lib/lead-names";
import { completeAgentRun, createAgentRun, recordAgentAction } from "@/lib/ai/tracking/agent-runs";
import { sendWhatsAppMessage } from "@/lib/whatsapp/send";
import type { Database, Json } from "@/types/database.types";

type Client = SupabaseClient<Database>;

export type RespondReason = "human_owned" | "not_found" | "no_recipient" | "reply_generation_failed" | "send_failed";

export type RespondToConversationResult = { ok: true; replied: true; messageId: string } | { ok: true; replied: false; reason: RespondReason };

/**
 * The single place that turns "a new inbound message just landed" into a
 * real, sent AI reply — shared by the Gmail reply-poll path
 * (src/lib/gmail/replies.ts) and the WhatsApp webhook
 * (src/app/api/whatsapp/webhook/route.ts) so the two channels behave
 * identically instead of each reimplementing this. Never runs while a
 * human owns the conversation (conversations.owner) — that is the whole
 * mechanism behind human takeover: flipping owner to 'human' is enough to
 * silence the AI here, no separate "pause" flag needed.
 *
 * Always uses the admin client — both callers run outside a signed-in
 * user's session (a webhook, a background-triggered poll), so every query
 * here is scoped by organization_id/conversation_id explicitly, the same
 * discipline replies.ts already follows.
 */
export async function respondToConversation(
  admin: Client,
  params: { organizationId: string; conversationId: string; leadId: string }
): Promise<RespondToConversationResult> {
  const { organizationId, conversationId, leadId } = params;

  const { data: conversation } = await admin
    .from("conversations")
    .select("id, channel, owner, campaign_id, buying_intent")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (!conversation) return { ok: true, replied: false, reason: "not_found" };
  if (conversation.owner !== "ai") return { ok: true, replied: false, reason: "human_owned" };

  const [identity, messagesRes, campaignRes] = await Promise.all([
    resolveLeadIdentity(admin, leadId),
    admin.from("messages").select("direction, sender_type, body, subject").eq("conversation_id", conversationId).order("created_at", { ascending: true }),
    conversation.campaign_id ? admin.from("campaigns").select("name").eq("id", conversation.campaign_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  const recipient = conversation.channel === "email" ? identity.email : conversation.channel === "whatsapp" ? identity.phone : null;
  if (!recipient) return { ok: true, replied: false, reason: "no_recipient" };

  const threadMessages = messagesRes.data ?? [];
  const threadForAi = threadMessages.map((m) => ({ direction: m.direction, senderType: m.sender_type, body: m.body ?? "" }));

  const businessContext = await getBusinessContext(organizationId, admin);

  const agentRun = await createAgentRun(organizationId, "conversation_reply", { conversationId, channel: conversation.channel } as unknown as Json, admin);

  // Refresh buying intent for this turn — never blocks the reply itself if
  // it fails; falls back to whatever was already on the conversation.
  let buyingIntent = conversation.buying_intent;
  const intentResult = await detectIntent({
    organizationId,
    leadName: identity.name,
    channel: conversation.channel,
    messages: threadForAi,
    productNames: selectIntentProductNames(businessContext),
  });
  if (intentResult.ok) {
    buyingIntent = mapIntentToBuyingIntent(intentResult.analysis.intent);
    await admin.from("conversations").update({ intent: intentResult.analysis.intent, buying_intent: buyingIntent }).eq("id", conversationId);
    await admin.from("leads").update({ intent: intentResult.analysis.intent, buying_intent: buyingIntent }).eq("id", leadId).eq("organization_id", organizationId);
    await admin.from("conversation_events").insert({
      organization_id: organizationId,
      conversation_id: conversationId,
      event_type: "intent_detected",
      payload: intentResult.analysis as unknown as Json,
    });
  }

  const replyResult = await generateConversationReply({
    organizationId,
    leadName: identity.name,
    channel: conversation.channel,
    campaignName: campaignRes.data?.name ?? null,
    buyingIntent,
    messages: threadForAi,
    businessContext: selectConversationContext(businessContext),
  });

  if (!replyResult.ok) {
    await completeAgentRun(agentRun, "failed", { reason: "reply_generation_failed", message: replyResult.message } as unknown as Json, admin);
    await admin.from("conversation_events").insert({
      organization_id: organizationId,
      conversation_id: conversationId,
      event_type: "ai_reply_failed",
      payload: { message: replyResult.message } as unknown as Json,
    });
    return { ok: true, replied: false, reason: "reply_generation_failed" };
  }

  const priorSubject = [...threadMessages].reverse().find((m) => m.subject)?.subject ?? null;
  const subject = conversation.channel === "email" ? (priorSubject ? (priorSubject.startsWith("Re: ") ? priorSubject : `Re: ${priorSubject}`) : "Re: your message") : null;

  const { data: reserved, error: reserveError } = await admin
    .from("messages")
    .insert({
      organization_id: organizationId,
      conversation_id: conversationId,
      lead_id: leadId,
      direction: "outbound",
      channel: conversation.channel,
      sender_type: "agent",
      body: replyResult.reply.message,
      subject,
      to_address: recipient,
      send_idempotency_key: crypto.randomUUID(),
      metadata: { recommendHandoff: replyResult.reply.recommendHandoff, handoffReason: replyResult.reply.handoffReason } as unknown as Json,
    })
    .select("id")
    .single();

  if (reserveError || !reserved) {
    await completeAgentRun(agentRun, "failed", { reason: "send_failed", message: reserveError?.message ?? "could not reserve message row" } as unknown as Json, admin);
    return { ok: true, replied: false, reason: "send_failed" };
  }

  const sendResult =
    conversation.channel === "email"
      ? await sendGmailMessage({ organizationId, to: recipient, subject: subject ?? "Re: your message", body: replyResult.reply.message })
      : await sendWhatsAppMessage({ organizationId, to: recipient, body: replyResult.reply.message });

  if (!sendResult.ok) {
    await admin
      .from("messages")
      .update({ status: "failed", metadata: { error: sendResult.message, code: sendResult.code, recommendHandoff: replyResult.reply.recommendHandoff, handoffReason: replyResult.reply.handoffReason } as unknown as Json })
      .eq("id", reserved.id);
    await completeAgentRun(agentRun, "failed", { reason: "send_failed", code: sendResult.code, message: sendResult.message } as unknown as Json, admin);
    return { ok: true, replied: false, reason: "send_failed" };
  }

  await admin
    .from("messages")
    .update({
      status: "sent",
      from_address: conversation.channel === "email" ? recipient : null,
      external_id: sendResult.ok && "messageId" in sendResult ? sendResult.messageId : null,
      metadata: { recommendHandoff: replyResult.reply.recommendHandoff, handoffReason: replyResult.reply.handoffReason } as unknown as Json,
    })
    .eq("id", reserved.id);

  await admin.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);

  if (replyResult.reply.recommendHandoff) {
    await admin.from("conversation_events").insert({
      organization_id: organizationId,
      conversation_id: conversationId,
      event_type: "ai_recommended_handoff",
      payload: { reason: replyResult.reply.handoffReason } as unknown as Json,
    });
  }

  await completeAgentRun(agentRun, "completed", { messageId: sendResult.messageId, channel: conversation.channel } as unknown as Json, admin);
  if (agentRun) {
    await recordAgentAction({
      organizationId,
      agentRunId: agentRun.id,
      actionType: "conversation_reply_sent",
      targetEntityType: "conversation",
      targetEntityId: conversationId,
      payload: { channel: conversation.channel, recommendHandoff: replyResult.reply.recommendHandoff } as unknown as Json,
      client: admin,
    });
  }

  return { ok: true, replied: true, messageId: sendResult.messageId };
}
