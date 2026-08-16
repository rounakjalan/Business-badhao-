import { createClient } from "@/lib/supabase/server";

export type DashboardStats = {
  totalProspects: number;
  totalLeads: number;
  qualifiedLeads: number;
  activeConversations: number;
  followUpsDue: number;
  openDeals: number;
  openPipelineValue: number;
  wonThisMonth: number;
  wonRevenueThisMonth: number;
  lostThisMonth: number;
  conversionRate: number;
  currency: string;
};

export type FunnelStage = {
  stage: string;
  count: number;
};

/**
 * Aggregate counts are computed as separate `head: true` count queries
 * rather than fetching rows. Currency roll-ups assume one currency per
 * organization — multi-currency roll-up is out of scope for this phase.
 */
export async function getDashboardStats(organizationId: string): Promise<DashboardStats> {
  const supabase = await createClient();
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const now = new Date().toISOString();

  const [
    totalProspects,
    totalLeads,
    qualifiedLeads,
    activeConversations,
    followUpsDue,
    openDeals,
    openDealRows,
    wonThisMonthRows,
    lostThisMonth,
  ] = await Promise.all([
    supabase.from("prospects").select("*", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase.from("leads").select("*", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("qualification_status", "qualified"),
    supabase
      .from("conversations")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "open"),
    supabase
      .from("tasks")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("status", ["pending", "in_progress"])
      .lte("due_at", now),
    supabase
      .from("deals")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .in("status", ["open", "negotiation"]),
    supabase.from("deals").select("value, currency").eq("organization_id", organizationId).in("status", ["open", "negotiation"]),
    supabase
      .from("deals")
      .select("value, currency")
      .eq("organization_id", organizationId)
      .eq("status", "won")
      .gte("won_at", startOfMonth.toISOString()),
    supabase
      .from("deals")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "lost")
      .gte("lost_at", startOfMonth.toISOString()),
  ]);

  const firstError = [
    totalProspects,
    totalLeads,
    qualifiedLeads,
    activeConversations,
    followUpsDue,
    openDeals,
    openDealRows,
    wonThisMonthRows,
    lostThisMonth,
  ].find((result) => result.error)?.error;
  if (firstError) {
    throw new Error(firstError.message);
  }

  const openPipelineValue = (openDealRows.data ?? []).reduce((sum, row) => sum + Number(row.value), 0);
  const wonThisMonth = wonThisMonthRows.data?.length ?? 0;
  const wonRevenueThisMonth = (wonThisMonthRows.data ?? []).reduce((sum, row) => sum + Number(row.value), 0);

  const { count: totalWonDeals } = await supabase
    .from("deals")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("status", "won");

  const conversionRate = totalLeads.count && totalLeads.count > 0 ? ((totalWonDeals ?? 0) / totalLeads.count) * 100 : 0;

  return {
    totalProspects: totalProspects.count ?? 0,
    totalLeads: totalLeads.count ?? 0,
    qualifiedLeads: qualifiedLeads.count ?? 0,
    activeConversations: activeConversations.count ?? 0,
    followUpsDue: followUpsDue.count ?? 0,
    openDeals: openDeals.count ?? 0,
    openPipelineValue,
    wonThisMonth,
    wonRevenueThisMonth,
    lostThisMonth: lostThisMonth.count ?? 0,
    conversionRate,
    currency: openDealRows.data?.[0]?.currency ?? wonThisMonthRows.data?.[0]?.currency ?? "INR",
  };
}

/**
 * A simplified acquisition funnel built from real counts across the
 * pipeline. Each stage is a superset of leads reaching at least that
 * point, not a strict cohort — good enough for a directional funnel view
 * without needing event-sourced stage history.
 */
export async function getAcquisitionFunnel(organizationId: string): Promise<FunnelStage[]> {
  const supabase = await createClient();

  const [prospects, leads, contacted, qualified, conversations, deals, won] = await Promise.all([
    supabase.from("prospects").select("*", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase.from("leads").select("*", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .not("status", "eq", "new"),
    supabase
      .from("leads")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("qualification_status", "qualified"),
    supabase.from("conversations").select("*", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase.from("deals").select("*", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase
      .from("deals")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "won"),
  ]);

  return [
    { stage: "Prospects", count: prospects.count ?? 0 },
    { stage: "Leads", count: leads.count ?? 0 },
    { stage: "Contacted", count: contacted.count ?? 0 },
    { stage: "Qualified", count: qualified.count ?? 0 },
    { stage: "Conversations", count: conversations.count ?? 0 },
    { stage: "Deals", count: deals.count ?? 0 },
    { stage: "Won", count: won.count ?? 0 },
  ];
}

export type RecentLead = {
  id: string;
  name: string;
  status: string;
  currentScore: number | null;
  createdAt: string;
};

export async function getRecentLeads(organizationId: string, limit = 4): Promise<RecentLead[]> {
  const supabase = await createClient();
  const { data: leads } = await supabase
    .from("leads")
    .select("id, status, current_score, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (!leads || leads.length === 0) return [];

  const { data: contacts } = await supabase
    .from("contacts")
    .select("lead_id, full_name")
    .in(
      "lead_id",
      leads.map((l) => l.id)
    )
    .eq("is_primary", true);

  const nameByLead = new Map((contacts ?? []).map((c) => [c.lead_id, c.full_name]));

  return leads.map((l) => ({
    id: l.id,
    name: nameByLead.get(l.id) ?? "Unnamed lead",
    status: l.status,
    currentScore: l.current_score,
    createdAt: l.created_at,
  }));
}

export type UpcomingTask = {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
};

export async function getUpcomingTasks(organizationId: string, limit = 4): Promise<UpcomingTask[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("tasks")
    .select("id, title, status, due_at")
    .eq("organization_id", organizationId)
    .in("status", ["pending", "in_progress"])
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(limit);

  return (data ?? []).map((t) => ({ id: t.id, title: t.title, status: t.status, dueAt: t.due_at }));
}

export type OpenDealRow = {
  id: string;
  title: string;
  status: string;
  value: number;
  currency: string;
  probability: number | null;
  expectedCloseDate: string | null;
};

export async function getOpenDeals(organizationId: string, limit = 5): Promise<OpenDealRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("deals")
    .select("id, title, status, value, currency, probability, expected_close_date")
    .eq("organization_id", organizationId)
    .in("status", ["open", "negotiation"])
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    status: d.status,
    value: Number(d.value),
    currency: d.currency,
    probability: d.probability,
    expectedCloseDate: d.expected_close_date,
  }));
}

export type ActivityItem = {
  id: string;
  entity: "lead" | "deal" | "conversation" | "campaign";
  label: string;
  createdAt: string;
};

export async function getRecentActivity(organizationId: string, limit = 5): Promise<ActivityItem[]> {
  const supabase = await createClient();
  const [leads, deals, conversations, campaigns] = await Promise.all([
    supabase.from("leads").select("id, created_at").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(limit),
    supabase.from("deals").select("id, title, created_at").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(limit),
    supabase
      .from("conversations")
      .select("id, channel, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase.from("campaigns").select("id, name, created_at").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(limit),
  ]);

  const items: ActivityItem[] = [
    ...(leads.data ?? []).map((l) => ({ id: l.id, entity: "lead" as const, label: "New lead added", createdAt: l.created_at })),
    ...(deals.data ?? []).map((d) => ({ id: d.id, entity: "deal" as const, label: `Deal created: ${d.title}`, createdAt: d.created_at })),
    ...(conversations.data ?? []).map((c) => ({
      id: c.id,
      entity: "conversation" as const,
      label: `Conversation started (${c.channel})`,
      createdAt: c.created_at,
    })),
    ...(campaigns.data ?? []).map((c) => ({ id: c.id, entity: "campaign" as const, label: `Campaign created: ${c.name}`, createdAt: c.created_at })),
  ];

  return items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
}
