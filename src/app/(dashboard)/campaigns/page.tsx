import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkCard } from "@/components/dashboard-ui/card";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { CampaignStatusBadge } from "@/components/dashboard-ui/badge";
import { CampaignsIcon } from "@/components/ui/icons";
import { formatCurrency, formatRelativeTime } from "@/lib/format";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/types/database.types";

const CAMPAIGN_STATUSES: Tables<"campaigns">["status"][] = ["draft", "planning", "active", "paused", "completed", "archived"];

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: statusFilter } = await searchParams;
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  let query = supabase
    .from("campaigns")
    .select("id, name, objective, target_audience, status, created_at")
    .eq("organization_id", currentOrg.organizationId)
    .order("created_at", { ascending: false });

  if (statusFilter && CAMPAIGN_STATUSES.includes(statusFilter as Tables<"campaigns">["status"])) {
    query = query.eq("status", statusFilter as Tables<"campaigns">["status"]);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const campaigns = data ?? [];

  const campaignIds = campaigns.map((c) => c.id);
  const [leadRows, conversationRows, dealRows] = campaignIds.length
    ? await Promise.all([
        supabase.from("leads").select("id, campaign_id, qualification_status").in("campaign_id", campaignIds),
        supabase.from("conversations").select("id, campaign_id").in("campaign_id", campaignIds),
        supabase.from("deals").select("id, campaign_id, value, status").in("campaign_id", campaignIds),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];

  const statsByCampaign = new Map<string, { leads: number; qualified: number; conversations: number; deals: number; revenue: number }>();
  for (const id of campaignIds) statsByCampaign.set(id, { leads: 0, qualified: 0, conversations: 0, deals: 0, revenue: 0 });
  for (const l of leadRows.data ?? []) {
    const s = statsByCampaign.get(l.campaign_id!);
    if (!s) continue;
    s.leads += 1;
    if (l.qualification_status === "qualified") s.qualified += 1;
  }
  for (const c of conversationRows.data ?? []) {
    const s = statsByCampaign.get(c.campaign_id!);
    if (s) s.conversations += 1;
  }
  for (const d of dealRows.data ?? []) {
    const s = statsByCampaign.get(d.campaign_id!);
    if (!s) continue;
    s.deals += 1;
    if (d.status === "won") s.revenue += Number(d.value);
  }

  const statuses = ["all", "draft", "planning", "active", "paused", "completed", "archived"];

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title="Campaigns"
        description="Your customer acquisition projects"
        action={
          <Link href="/campaigns/create">
            <DashButton variant="gradient">+ Create Campaign</DashButton>
          </Link>
        }
      />

      <div className="bb-stagger flex flex-wrap gap-2">
        {statuses.map((s) => (
          <Link
            key={s}
            href={s === "all" ? "/campaigns" : `/campaigns?status=${s}`}
            className={`bb-stagger-item bb-press rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-all ${
              (statusFilter ?? "all") === s
                ? "border-bb-indigo bg-bb-indigo/20 text-bb-indigo-2"
                : "border-bb-border bg-bb-navy-3 text-bb-text-3 hover:bg-bb-navy-4"
            }`}
          >
            {s}
          </Link>
        ))}
      </div>

      {campaigns.length === 0 ? (
        <DarkEmptyState
          icon={CampaignsIcon}
          title="No campaigns yet"
          description="Create your first campaign to start finding customers."
          action={
            <Link href="/campaigns/create">
              <DashButton variant="gradient">Create Campaign</DashButton>
            </Link>
          }
        />
      ) : (
        <div className="bb-stagger space-y-4">
          {campaigns.map((c) => {
            const stats = statsByCampaign.get(c.id) ?? { leads: 0, qualified: 0, conversations: 0, deals: 0, revenue: 0 };
            return (
              <Link key={c.id} href={`/campaigns/${c.id}`} className="bb-stagger-item block">
                <DarkCard className="bb-lift p-5">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <div>
                      <div className="mb-1 flex flex-wrap items-center gap-3">
                        <h3 className="text-base font-semibold text-bb-text">{c.name}</h3>
                        <CampaignStatusBadge status={c.status} />
                      </div>
                      <div className="text-sm text-bb-text-3">
                        {c.objective ?? "No objective set"}
                        {c.target_audience ? ` · ${c.target_audience}` : ""}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                    {[
                      { label: "Leads", val: stats.leads },
                      { label: "Qualified", val: stats.qualified },
                      { label: "Conversations", val: stats.conversations },
                      { label: "Deals", val: stats.deals },
                      { label: "Revenue", val: stats.revenue > 0 ? formatCurrency(stats.revenue, "INR") : "—" },
                    ].map((m) => (
                      <div key={m.label}>
                        <div className="mb-1 text-xs text-bb-text-3">{m.label}</div>
                        <div className="font-jetbrains text-sm font-semibold text-bb-text">{m.val}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 text-xs text-bb-text-3">Created {formatRelativeTime(c.created_at)}</div>
                </DarkCard>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
