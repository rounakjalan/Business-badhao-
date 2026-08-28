import { notFound } from "next/navigation";
import { ConversationDetailClient } from "@/app/(dashboard)/conversations/[id]/conversation-detail-client";
import { loadBuyingIntentHistory } from "@/lib/intent-history";
import { resolveLeadIdentity } from "@/lib/lead-names";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function ConversationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, lead_id, channel, status, intent, owner, buying_intent, created_at")
    .eq("id", id)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!conversation) notFound();

  const [identity, lead, messages, buyingIntentHistory] = await Promise.all([
    resolveLeadIdentity(supabase, conversation.lead_id),
    supabase.from("leads").select("current_score").eq("id", conversation.lead_id).maybeSingle(),
    supabase
      .from("messages")
      .select("id, direction, sender_type, body, subject, status, created_at")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true }),
    loadBuyingIntentHistory(supabase, id, currentOrg.organizationId),
  ]);

  return (
    <ConversationDetailClient
      conversation={conversation}
      contactName={identity.name}
      contactEmail={identity.email}
      leadScore={lead.data?.current_score ?? null}
      messages={messages.data ?? []}
      buyingIntentHistory={buyingIntentHistory}
    />
  );
}
