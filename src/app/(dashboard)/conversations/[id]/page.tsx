import { notFound } from "next/navigation";
import { ConversationDetailClient } from "@/app/(dashboard)/conversations/[id]/conversation-detail-client";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function ConversationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, lead_id, channel, status, intent, created_at")
    .eq("id", id)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!conversation) notFound();

  const [contact, lead, messages] = await Promise.all([
    supabase.from("contacts").select("full_name, email").eq("lead_id", conversation.lead_id).eq("is_primary", true).maybeSingle(),
    supabase.from("leads").select("current_score").eq("id", conversation.lead_id).maybeSingle(),
    supabase
      .from("messages")
      .select("id, direction, sender_type, body, created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true }),
  ]);

  return (
    <ConversationDetailClient
      conversation={conversation}
      contactName={contact.data?.full_name ?? "Unnamed lead"}
      contactEmail={contact.data?.email ?? null}
      leadScore={lead.data?.current_score ?? null}
      messages={messages.data ?? []}
    />
  );
}
