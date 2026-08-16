"use server";

import { revalidatePath } from "next/cache";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

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
