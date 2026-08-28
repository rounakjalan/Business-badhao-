import { BuyingIntentListClient, type BuyingIntentRow } from "@/app/(dashboard)/buying-intent/buying-intent-list-client";
import { loadLatestIntentSnapshots } from "@/lib/intent-history";
import { resolveLeadIdentities } from "@/lib/lead-names";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function BuyingIntentPage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, buying_intent, current_score, qualification_status, status, prospect_id, created_at")
    .eq("organization_id", currentOrg.organizationId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  const leadRows = leads ?? [];
  const leadIds = leadRows.map((l) => l.id);
  const prospectIds = [...new Set(leadRows.map((l) => l.prospect_id).filter((id): id is string => Boolean(id)))];

  const [identities, prospects, conversations, deals] = await Promise.all([
    resolveLeadIdentities(supabase, leadIds),
    prospectIds.length ? supabase.from("prospects").select("id, company_name").in("id", prospectIds) : Promise.resolve({ data: [] as { id: string; company_name: string | null }[] }),
    leadIds.length
      ? supabase.from("conversations").select("id, lead_id, channel, status, last_message_at, created_at").in("lead_id", leadIds)
      : Promise.resolve({ data: [] as { id: string; lead_id: string; channel: string; status: string; last_message_at: string | null; created_at: string }[] }),
    // Most recently created deal per lead, across every stage — used both
    // to show the current deal stage and to decide whether "Create Deal"
    // should be offered at all.
    leadIds.length
      ? supabase.from("deals").select("id, lead_id, status, created_at").in("lead_id", leadIds).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as { id: string; lead_id: string; status: string; created_at: string }[] }),
  ]);

  const companyByProspect = new Map((prospects.data ?? []).map((p) => [p.id, p.company_name]));

  const conversationsByLead = new Map<string, (typeof conversations.data)>();
  for (const c of conversations.data ?? []) {
    const arr = conversationsByLead.get(c.lead_id) ?? [];
    arr.push(c);
    conversationsByLead.set(c.lead_id, arr);
  }

  // Latest intent-detection confidence across ANY of a lead's
  // conversations — leads.buying_intent is written by whichever
  // conversation was last analyzed, not necessarily the most recently
  // active one, so confidence has to be looked up the same way.
  const allConversationIds = (conversations.data ?? []).map((c) => c.id);
  const latestSnapshotByConversation = await loadLatestIntentSnapshots(supabase, allConversationIds, currentOrg.organizationId);

  const dealByLead = new Map<string, { id: string; status: string }>();
  for (const d of deals.data ?? []) {
    if (d.lead_id && !dealByLead.has(d.lead_id)) dealByLead.set(d.lead_id, { id: d.id, status: d.status });
  }

  const rows: BuyingIntentRow[] = leadRows.map((l) => {
    const identity = identities.get(l.id);
    const leadConversations = conversationsByLead.get(l.id) ?? [];

    const latestConversation = [...leadConversations].sort(
      (a, b) => new Date(b.last_message_at ?? b.created_at).getTime() - new Date(a.last_message_at ?? a.created_at).getTime()
    )[0];

    let confidence: "low" | "medium" | "high" | null = null;
    let confidenceAt: string | null = null;
    for (const c of leadConversations) {
      const snap = latestSnapshotByConversation.get(c.id);
      if (snap && (!confidenceAt || snap.at > confidenceAt)) {
        confidence = snap.confidence;
        confidenceAt = snap.at;
      }
    }

    const deal = dealByLead.get(l.id) ?? null;

    return {
      id: l.id,
      name: identity?.name ?? "Unnamed lead",
      companyName: l.prospect_id ? (companyByProspect.get(l.prospect_id) ?? null) : null,
      email: identity?.email ?? null,
      phone: identity?.phone ?? null,
      buyingIntent: l.buying_intent,
      confidence,
      qualificationStatus: l.qualification_status,
      score: l.current_score,
      latestConversation: latestConversation
        ? { id: latestConversation.id, channel: latestConversation.channel, status: latestConversation.status, at: latestConversation.last_message_at ?? latestConversation.created_at }
        : null,
      dealId: deal?.id ?? null,
      dealStatus: deal?.status ?? null,
      createdAt: l.created_at,
    };
  });

  return <BuyingIntentListClient rows={rows} />;
}
