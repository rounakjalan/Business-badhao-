import { ConversationCampaignPickerClient } from "@/app/(dashboard)/conversations/campaign-picker-client";
import { ConversationStatusClient, type ConversationRow } from "@/app/(dashboard)/conversations/conversation-status-client";
import { resolveLeadIdentities } from "@/lib/lead-names";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

const UNASSIGNED_ID = "unassigned";

/**
 * Conversations are organized by campaign first, then by the conversation's
 * own authoritative status (open/pending/resolved/closed — the existing
 * `conversations.status` column, already rendered elsewhere via
 * ConversationStatusBadge) — never an invented parallel state machine.
 * Buying intent and AI/human ownership are real, separate dimensions
 * (conversations.buying_intent, conversations.owner) shown alongside status,
 * not folded into it.
 *
 * Two flat, org-scoped queries (campaigns, conversations) joined in memory,
 * plus resolveLeadIdentities scoped to only the selected view's leads —
 * never a per-campaign query, and never resolving every org lead's identity
 * just to render campaign cards.
 */
export default async function ConversationsPage({ searchParams }: { searchParams: Promise<{ campaign?: string }> }) {
  const { campaign: selectedCampaignId } = await searchParams;
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();

  const [{ data: campaigns, error: campaignsError }, { data: conversations, error: conversationsError }] = await Promise.all([
    supabase.from("campaigns").select("id, name, status").eq("organization_id", currentOrg.organizationId).order("created_at", { ascending: false }),
    supabase
      .from("conversations")
      .select("id, lead_id, campaign_id, channel, status, intent, owner, buying_intent, last_message_at, created_at")
      .eq("organization_id", currentOrg.organizationId)
      .order("created_at", { ascending: false }),
  ]);

  if (campaignsError) throw new Error(campaignsError.message);
  if (conversationsError) throw new Error(conversationsError.message);

  const campaignRows = campaigns ?? [];
  const conversationRows = conversations ?? [];

  const conversationsByCampaign = new Map<string, typeof conversationRows>();
  const unassignedConversations: typeof conversationRows = [];
  for (const cv of conversationRows) {
    if (!cv.campaign_id) {
      unassignedConversations.push(cv);
      continue;
    }
    const bucket = conversationsByCampaign.get(cv.campaign_id) ?? [];
    bucket.push(cv);
    conversationsByCampaign.set(cv.campaign_id, bucket);
  }

  const campaignById = new Map(campaignRows.map((c) => [c.id, c]));
  // Only campaigns that have actually generated at least one conversation —
  // unlike Leads/Prospects, a campaign with zero conversations is expected
  // and common (most discovered leads never reply), so listing every
  // campaign here would mostly be empty noise rather than useful signal.
  const campaignSummaries = campaignRows
    .map((c) => {
      const campaignConversations = conversationsByCampaign.get(c.id) ?? [];
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        conversationCount: campaignConversations.length,
        openCount: campaignConversations.filter((cv) => cv.status === "open").length,
      };
    })
    .filter((c) => c.conversationCount > 0);

  const selectedCampaign = selectedCampaignId ? campaignById.get(selectedCampaignId) : undefined;
  const selected =
    selectedCampaignId === UNASSIGNED_ID
      ? { name: "Unassigned Conversations", conversations: unassignedConversations }
      : selectedCampaign
        ? { name: selectedCampaign.name, conversations: conversationsByCampaign.get(selectedCampaign.id) ?? [] }
        : null;

  // No selection, or an id that doesn't belong to this organization (or has
  // no conversations) — show the campaign picker rather than guessing or
  // leaking another org's data.
  if (!selected) {
    return <ConversationCampaignPickerClient campaigns={campaignSummaries} unassignedCount={unassignedConversations.length} />;
  }

  const leadIds = [...new Set(selected.conversations.map((c) => c.lead_id))];
  const identities = await resolveLeadIdentities(supabase, leadIds);

  const rows: ConversationRow[] = selected.conversations.map((c) => ({
    id: c.id,
    contactName: identities.get(c.lead_id)?.name ?? "Unnamed lead",
    channel: c.channel,
    status: c.status,
    owner: c.owner,
    intent: c.intent,
    buyingIntent: c.buying_intent,
    lastActivityAt: c.last_message_at ?? c.created_at,
  }));

  return <ConversationStatusClient campaignName={selected.name} backHref="/conversations" conversations={rows} />;
}
