import Link from "next/link";
import { DarkCard } from "@/components/dashboard-ui/card";
import { LeadStatusBadge, ScorePill, TaskStatusBadge, DealStatusBadge } from "@/components/dashboard-ui/badge";
import { AnalyticsIcon, CampaignsIcon, ConversationsIcon, KnowledgeIcon, LeadsIcon } from "@/components/ui/icons";
import {
  getAcquisitionFunnel,
  getDashboardStats,
  getOpenDeals,
  getRecentActivity,
  getRecentLeads,
  getUpcomingTasks,
} from "@/lib/dashboard";
import { formatCurrency, formatDate, formatRelativeTime } from "@/lib/format";
import { getCurrentOrg } from "@/lib/organizations";

const QUICK_ACTIONS = [
  { label: "Create Campaign", icon: CampaignsIcon, href: "/campaigns/create" },
  { label: "Review Leads", icon: LeadsIcon, href: "/leads" },
  { label: "Conversations", icon: ConversationsIcon, href: "/conversations" },
  { label: "Add Knowledge", icon: KnowledgeIcon, href: "/knowledge" },
  { label: "Analytics", icon: AnalyticsIcon, href: "/analytics" },
];

export default async function DashboardPage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const [stats, funnel, recentLeads, tasks, openDeals, activity] = await Promise.all([
    getDashboardStats(currentOrg.organizationId),
    getAcquisitionFunnel(currentOrg.organizationId),
    getRecentLeads(currentOrg.organizationId),
    getUpcomingTasks(currentOrg.organizationId),
    getOpenDeals(currentOrg.organizationId),
    getRecentActivity(currentOrg.organizationId),
  ]);

  const metrics = [
    { label: "Total Prospects", value: stats.totalProspects.toLocaleString("en-IN") },
    { label: "Qualified Leads", value: stats.qualifiedLeads.toLocaleString("en-IN") },
    { label: "Active Conversations", value: stats.activeConversations.toLocaleString("en-IN") },
    { label: "Follow-ups Due", value: stats.followUpsDue.toLocaleString("en-IN") },
    { label: "Open Deals", value: stats.openDeals.toLocaleString("en-IN"), sub: formatCurrency(stats.openPipelineValue, stats.currency) },
    { label: "Won This Month", value: stats.wonThisMonth.toLocaleString("en-IN"), sub: formatCurrency(stats.wonRevenueThisMonth, stats.currency) },
    { label: "Lost This Month", value: stats.lostThisMonth.toLocaleString("en-IN") },
    { label: "Conversion Rate", value: `${stats.conversionRate.toFixed(1)}%` },
  ];

  const funnelMax = Math.max(...funnel.map((f) => f.count), 1);

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-xl font-semibold text-bb-text">Command Center</h2>
        <p className="text-sm text-bb-text-3">Your customer acquisition at a glance, {currentOrg.organizationName}.</p>
      </div>

      <div className="flex flex-wrap gap-3">
        {QUICK_ACTIONS.map((action) => (
          <Link
            key={action.label}
            href={action.href}
            className="flex items-center gap-2 rounded-lg border border-bb-border bg-white/5 px-4 py-2 text-sm font-medium text-bb-text-2 transition-all hover:bg-white/10"
          >
            <action.icon className="h-4 w-4 text-bb-indigo" />
            {action.label}
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((m) => (
          <DarkCard key={m.label} className="p-4">
            <div className="text-xs text-bb-text-3">{m.label}</div>
            <div className="font-jetbrains mt-2 text-2xl font-bold text-bb-text">{m.value}</div>
            {m.sub ? <div className="mt-1 text-xs text-bb-text-3">{m.sub}</div> : null}
          </DarkCard>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <DarkCard className="p-5 lg:col-span-2">
          <div className="mb-5 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-bb-text">Acquisition Pipeline</h3>
            <Link href="/analytics" className="text-xs text-bb-indigo-2 hover:underline">
              View analytics →
            </Link>
          </div>
          <div className="space-y-2">
            {funnel.map((f, i) => (
              <div key={f.stage} className="flex items-center gap-3">
                <div className="w-24 shrink-0 text-right text-xs text-bb-text-3">{f.stage}</div>
                <div className="h-7 flex-1 overflow-hidden rounded-md bg-bb-navy-3">
                  <div
                    className="font-jetbrains flex h-full min-w-[48px] items-center rounded-md border border-bb-indigo/30 bg-gradient-to-r from-bb-indigo/25 to-bb-indigo/40 px-3 text-xs font-semibold text-bb-indigo-2"
                    style={{ width: `${Math.max((f.count / funnelMax) * 100, 6)}%` }}
                  >
                    {f.count.toLocaleString("en-IN")}
                  </div>
                </div>
                <div className="w-12 shrink-0 text-right text-xs text-bb-text-3">
                  {i > 0 && funnel[i - 1].count > 0 ? `${((f.count / funnel[i - 1].count) * 100).toFixed(0)}%` : ""}
                </div>
              </div>
            ))}
          </div>
        </DarkCard>

        <DarkCard className="p-5">
          <h3 className="mb-4 text-sm font-semibold text-bb-text">Recent Activity</h3>
          {activity.length === 0 ? (
            <p className="text-sm text-bb-text-3">Nothing yet — activity will show up here as your organization gets moving.</p>
          ) : (
            <div className="space-y-3">
              {activity.map((a) => (
                <div key={`${a.entity}-${a.id}`} className="flex items-start gap-2.5">
                  <div className="mt-0.5 h-6 w-6 shrink-0 rounded-full bg-bb-indigo/15 text-center text-xs leading-6 text-bb-indigo-2">•</div>
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium text-bb-text-2">{a.label}</div>
                    <div className="text-xs text-bb-text-3">{formatRelativeTime(a.createdAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DarkCard>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <DarkCard className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-bb-border px-5 py-4">
            <h3 className="text-sm font-semibold text-bb-text">Recent Leads</h3>
            <Link href="/leads" className="text-xs text-bb-indigo-2 hover:underline">
              View all →
            </Link>
          </div>
          {recentLeads.length === 0 ? (
            <p className="px-5 py-6 text-sm text-bb-text-3">No leads yet.</p>
          ) : (
            <div>
              {recentLeads.map((lead) => (
                <Link
                  key={lead.id}
                  href={`/leads/${lead.id}`}
                  className="flex items-center gap-3 border-b border-bb-border/50 px-5 py-3 transition-colors last:border-0 hover:bg-white/3"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-bb-indigo to-bb-violet text-xs font-semibold text-white">
                    {lead.name[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-bb-text">{lead.name}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <ScorePill score={lead.currentScore} />
                    <LeadStatusBadge status={lead.status} />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </DarkCard>

        <DarkCard className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-bb-border px-5 py-4">
            <h3 className="text-sm font-semibold text-bb-text">Tasks</h3>
            <Link href="/tasks" className="text-xs text-bb-indigo-2 hover:underline">
              View all →
            </Link>
          </div>
          {tasks.length === 0 ? (
            <p className="px-5 py-6 text-sm text-bb-text-3">No open tasks.</p>
          ) : (
            <div>
              {tasks.map((task) => (
                <div key={task.id} className="flex items-center gap-3 border-b border-bb-border/50 px-5 py-3 last:border-0">
                  <div className="h-4 w-4 shrink-0 rounded-full border-2 border-bb-border" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-bb-text">{task.title}</div>
                    <div className="text-xs text-bb-text-3">Due {formatDate(task.dueAt)}</div>
                  </div>
                  <TaskStatusBadge status={task.status} />
                </div>
              ))}
            </div>
          )}
        </DarkCard>
      </div>

      <DarkCard className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-bb-border px-5 py-4">
          <h3 className="text-sm font-semibold text-bb-text">Open Deals</h3>
          <Link href="/deals" className="text-xs text-bb-indigo-2 hover:underline">
            View pipeline →
          </Link>
        </div>
        {openDeals.length === 0 ? (
          <p className="px-5 py-6 text-sm text-bb-text-3">No open deals yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-bb-border">
                  {["Deal", "Value", "Stage", "Expected Close", ""].map((h) => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-medium text-bb-text-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {openDeals.map((deal) => (
                  <tr key={deal.id} className="border-b border-bb-border/50 transition-colors last:border-0 hover:bg-white/3">
                    <td className="px-5 py-3 font-medium text-bb-text">{deal.title}</td>
                    <td className="font-jetbrains px-5 py-3 font-semibold text-bb-emerald">{formatCurrency(deal.value, deal.currency)}</td>
                    <td className="px-5 py-3">
                      <DealStatusBadge status={deal.status} />
                    </td>
                    <td className="px-5 py-3 text-xs text-bb-text-3">{formatDate(deal.expectedCloseDate)}</td>
                    <td className="px-5 py-3">
                      <Link href={`/deals/${deal.id}`} className="rounded-lg border border-bb-indigo/25 px-3 py-1.5 text-xs text-bb-indigo-2 hover:bg-white/5">
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DarkCard>
    </div>
  );
}
