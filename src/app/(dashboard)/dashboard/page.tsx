import Link from "next/link";
import { AnimatedBar } from "@/components/dashboard-ui/animated-bar";
import { DarkCard } from "@/components/dashboard-ui/card";
import { LeadStatusBadge, ScorePill, TaskStatusBadge, DealStatusBadge } from "@/components/dashboard-ui/badge";
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
  { label: "Create Campaign", href: "/campaigns/create", accent: "#bcfe90" },
  { label: "Review Leads", href: "/leads", accent: "#abf0ff" },
  { label: "Conversations", href: "/conversations", accent: "#ffd8b8" },
  { label: "Add Knowledge", href: "/knowledge", accent: "#eddff7" },
  { label: "Analytics", href: "/analytics", accent: "#e7ecff" },
];

const ACTIVITY_ACCENTS: Record<string, string> = {
  lead: "#bcfe90",
  deal: "#abf0ff",
  conversation: "#ffd8b8",
  campaign: "#eddff7",
  task: "#e7ecff",
};

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
    { label: "Total Prospects", value: stats.totalProspects.toLocaleString("en-IN"), accent: "#bcfe90" },
    { label: "Qualified Leads", value: stats.qualifiedLeads.toLocaleString("en-IN"), accent: "#abf0ff" },
    { label: "Active Conversations", value: stats.activeConversations.toLocaleString("en-IN"), accent: "#ffd8b8" },
    { label: "Follow-ups Due", value: stats.followUpsDue.toLocaleString("en-IN"), accent: "#eddff7" },
    {
      label: "Open Deals",
      value: stats.openDeals.toLocaleString("en-IN"),
      sub: formatCurrency(stats.openPipelineValue, stats.currency),
      accent: "#e7ecff",
    },
    {
      label: "Won This Month",
      value: stats.wonThisMonth.toLocaleString("en-IN"),
      sub: formatCurrency(stats.wonRevenueThisMonth, stats.currency),
      accent: "#d1faff",
    },
    { label: "Lost This Month", value: stats.lostThisMonth.toLocaleString("en-IN"), accent: "#fcd0f8" },
    { label: "Conversion Rate", value: `${stats.conversionRate.toFixed(1)}%`, accent: "#93beff" },
  ];

  const funnelMax = Math.max(...funnel.map((f) => f.count), 1);

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-[-0.36px] text-bb-text">Command Center</h2>
        <p className="text-sm text-bb-text-2">Your customer acquisition at a glance, {currentOrg.organizationName}.</p>
      </div>

      <div className="bb-stagger flex flex-wrap gap-2.5">
        {QUICK_ACTIONS.map((action) => (
          <Link
            key={action.label}
            href={action.href}
            className="bb-stagger-item bb-press bb-lift bb-shadow-pill flex items-center gap-2 rounded-full bg-bb-navy-2 px-4.5 py-2.5 text-sm font-medium text-bb-text transition-colors hover:bg-bb-navy-3"
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: action.accent }} />
            {action.label}
          </Link>
        ))}
      </div>

      <div className="bb-stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((m) => (
          <DarkCard key={m.label} className="bb-stagger-item bb-lift p-5">
            <div className="mb-3.5 flex items-center justify-between">
              <span className="text-[13px] text-bb-text-2">{m.label}</span>
              <span className="h-7 w-7 shrink-0 rounded-lg transition-transform duration-200 hover:scale-110" style={{ background: m.accent }} />
            </div>
            <div className="font-jetbrains text-[26px] font-semibold tracking-[-0.3px] text-bb-text">{m.value}</div>
            {m.sub ? <div className="mt-1 text-xs text-bb-text-3">{m.sub}</div> : null}
          </DarkCard>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <DarkCard className="p-6 lg:col-span-2">
          <div className="mb-4.5 flex items-center justify-between">
            <h3 className="text-[15px] font-semibold text-bb-text">Acquisition Pipeline</h3>
            <Link href="/analytics" className="bb-press inline-block text-sm text-bb-indigo transition-colors hover:text-bb-indigo-3">
              View analytics →
            </Link>
          </div>
          <div className="bb-stagger space-y-2.5">
            {funnel.map((f, i) => (
              <div key={f.stage} className="bb-stagger-item flex items-center gap-3">
                <div className="w-25 shrink-0 text-right text-xs text-bb-text-2">{f.stage}</div>
                <div className="h-7 flex-1 overflow-hidden rounded-lg bg-bb-navy-3">
                  <AnimatedBar
                    widthPercent={Math.max((f.count / funnelMax) * 100, 8)}
                    className="font-jetbrains flex h-full min-w-12 items-center rounded-lg px-3 text-xs font-semibold text-white"
                    style={{
                      background: "linear-gradient(90deg, color-mix(in srgb, var(--color-bb-indigo) 80%, transparent), var(--color-bb-indigo))",
                    }}
                  >
                    {f.count.toLocaleString("en-IN")}
                  </AnimatedBar>
                </div>
                <div className="w-11 shrink-0 text-right text-xs text-bb-text-3">
                  {i > 0 && funnel[0].count > 0 ? `${((f.count / funnel[0].count) * 100).toFixed(0)}%` : ""}
                </div>
              </div>
            ))}
          </div>
        </DarkCard>

        <DarkCard className="p-6">
          <h3 className="mb-4 text-[15px] font-semibold text-bb-text">Recent Activity</h3>
          {activity.length === 0 ? (
            <p className="text-sm text-bb-text-3">Nothing yet — activity will show up here as your organization gets moving.</p>
          ) : (
            <div className="bb-stagger space-y-3.5">
              {activity.map((a) => (
                <div key={`${a.entity}-${a.id}`} className="bb-stagger-item flex items-start gap-2.5">
                  <span
                    className="mt-0.5 h-5.5 w-5.5 shrink-0 rounded-full transition-transform duration-200 hover:scale-125"
                    style={{ background: ACTIVITY_ACCENTS[a.entity] ?? "#e7ecff" }}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-bb-text">{a.label}</div>
                    <div className="mt-0.5 text-xs text-bb-text-3">{formatRelativeTime(a.createdAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DarkCard>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <DarkCard className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-bb-navy-3 px-6 py-5">
            <h3 className="text-[15px] font-semibold text-bb-text">Recent Leads</h3>
            <Link href="/leads" className="bb-press inline-block text-sm text-bb-indigo transition-colors hover:text-bb-indigo-3">
              View all →
            </Link>
          </div>
          {recentLeads.length === 0 ? (
            <p className="px-6 py-6 text-sm text-bb-text-3">No leads yet.</p>
          ) : (
            <div className="bb-stagger">
              {recentLeads.map((lead) => (
                <Link
                  key={lead.id}
                  href={`/leads/${lead.id}`}
                  className="bb-stagger-item bb-press group flex items-center gap-3 border-b border-bb-navy-3 px-6 py-3.5 transition-colors last:border-0 hover:bg-bb-navy-3"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-bb-indigo to-bb-violet text-xs font-semibold text-white transition-transform duration-200 group-hover:scale-105">
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
          <div className="flex items-center justify-between border-b border-bb-navy-3 px-6 py-5">
            <h3 className="text-[15px] font-semibold text-bb-text">Tasks</h3>
            <Link href="/tasks" className="bb-press inline-block text-sm text-bb-indigo transition-colors hover:text-bb-indigo-3">
              View all →
            </Link>
          </div>
          {tasks.length === 0 ? (
            <p className="px-6 py-6 text-sm text-bb-text-3">No open tasks.</p>
          ) : (
            <div className="bb-stagger">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="bb-stagger-item flex items-center gap-3 border-b border-bb-navy-3 px-6 py-3.5 transition-colors last:border-0 hover:bg-bb-navy-3"
                >
                  <div className="h-4 w-4 shrink-0 rounded-full border-2 border-bb-border transition-colors hover:border-bb-indigo" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-bb-text">{task.title}</div>
                    <div className="mt-0.5 text-xs text-bb-text-3">Due {formatDate(task.dueAt)}</div>
                  </div>
                  <TaskStatusBadge status={task.status} />
                </div>
              ))}
            </div>
          )}
        </DarkCard>
      </div>

      <DarkCard className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-bb-navy-3 px-6 py-5">
          <h3 className="text-[15px] font-semibold text-bb-text">Open Deals</h3>
          <Link href="/deals" className="bb-press inline-block text-sm text-bb-indigo transition-colors hover:text-bb-indigo-3">
            View pipeline →
          </Link>
        </div>
        {openDeals.length === 0 ? (
          <p className="px-6 py-6 text-sm text-bb-text-3">No open deals yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  {["Deal", "Value", "Stage", "Expected Close", ""].map((h) => (
                    <th key={h} className="border-b border-bb-navy-3 px-6 py-3 text-left text-xs font-medium text-bb-text-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bb-stagger">
                {openDeals.map((deal) => (
                  <tr key={deal.id} className="bb-stagger-item border-b border-bb-navy-3 transition-colors last:border-0 hover:bg-bb-navy-3">
                    <td className="px-6 py-3.5 font-medium text-bb-text">{deal.title}</td>
                    <td className="font-jetbrains px-6 py-3.5 font-semibold text-[#2a5c4e]">{formatCurrency(deal.value, deal.currency)}</td>
                    <td className="px-6 py-3.5">
                      <DealStatusBadge status={deal.status} />
                    </td>
                    <td className="px-6 py-3.5 text-xs text-bb-text-3">{formatDate(deal.expectedCloseDate)}</td>
                    <td className="px-6 py-3.5">
                      <Link
                        href={`/deals/${deal.id}`}
                        className="bb-press inline-block rounded-full border border-[#dbdbff] px-3.5 py-1.5 text-xs font-medium text-bb-indigo transition-colors hover:bg-bb-navy-3"
                      >
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
