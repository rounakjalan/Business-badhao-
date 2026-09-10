import { PageHeader } from "@/components/layout/page-header";
import { AnimatedBar } from "@/components/dashboard-ui/animated-bar";
import { DarkCard } from "@/components/dashboard-ui/card";
import { getCampaignPerformance, getLeadSourcePerformance, getOverallTotals } from "@/lib/analytics";
import { getAcquisitionFunnel } from "@/lib/dashboard";
import { formatCurrency } from "@/lib/format";
import { getCurrentOrg } from "@/lib/organizations";

export default async function AnalyticsPage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  // Each of these is aggregated in Postgres (see src/lib/analytics.ts) —
  // one row per campaign/lead source, not every lead/conversation/deal/
  // prospect row for the organization grouped here the way this page used
  // to.
  const [funnel, campaignPerf, sourcePerf, overallTotals] = await Promise.all([
    getAcquisitionFunnel(currentOrg.organizationId),
    getCampaignPerformance(currentOrg.organizationId),
    getLeadSourcePerformance(currentOrg.organizationId),
    getOverallTotals(currentOrg.organizationId),
  ]);

  const funnelMax = Math.max(...funnel.map((f) => f.count), 1);
  const { totalWon, totalRevenue } = overallTotals;

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-6 p-4 sm:p-6">
      <PageHeader title="Analytics" description="Complete acquisition funnel performance" />

      <DarkCard className="p-6">
        <div className="mb-5 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-bb-text">Acquisition Funnel</h3>
          <span className="text-xs text-bb-text-3">Share of all prospects</span>
        </div>
        <div className="bb-stagger space-y-2.5">
          {funnel.map((f, i) => (
            <div key={f.stage} className="bb-stagger-item flex items-center gap-4">
              <div className="w-24 shrink-0 text-right text-xs font-medium text-bb-text-3">{f.stage}</div>
              <div className="h-8 flex-1 overflow-hidden rounded-lg bg-bb-navy-3">
                <AnimatedBar
                  widthPercent={Math.max((f.count / funnelMax) * 100, 8)}
                  className="font-jetbrains flex h-full min-w-[64px] items-center rounded-lg border border-bb-indigo/40 bg-gradient-to-r from-bb-indigo/30 to-bb-indigo/50 px-4 text-xs font-semibold text-bb-indigo-2"
                >
                  {f.count.toLocaleString("en-IN")}
                </AnimatedBar>
              </div>
              <div className="w-16 shrink-0 text-right text-xs text-bb-text-3">
                {i === 0 ? "100%" : funnel[0].count > 0 ? `${((f.count / funnel[0].count) * 100).toFixed(1)}%` : "—"}
              </div>
            </div>
          ))}
        </div>
      </DarkCard>

      <DarkCard className="overflow-hidden">
        <div className="border-b border-bb-border bg-bb-navy-2 px-5 py-4">
          <h3 className="text-sm font-semibold text-bb-text">Campaign Performance</h3>
        </div>
        {campaignPerf.length === 0 ? (
          <p className="px-5 py-6 text-sm text-bb-text-3">No campaigns yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-bb-border">
                  {["Campaign", "Leads", "Qualified", "Conversations", "Deals", "Won", "Revenue", "Conv. Rate"].map((h) => (
                    <th key={h} className="whitespace-nowrap px-5 py-3 text-left text-xs font-medium text-bb-text-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bb-stagger">
                {campaignPerf.map((c) => (
                  <tr key={c.name} className="bb-stagger-item border-b border-bb-navy-3 transition-colors last:border-0 hover:bg-bb-navy-3">
                    <td className="px-5 py-3 font-medium text-bb-text">{c.name}</td>
                    <td className="font-jetbrains px-5 py-3 text-bb-text-2">{c.leads}</td>
                    <td className="font-jetbrains px-5 py-3 text-bb-indigo-2">{c.qualified}</td>
                    <td className="font-jetbrains px-5 py-3 text-bb-text-2">{c.conversations}</td>
                    <td className="font-jetbrains px-5 py-3 text-bb-violet">{c.deals}</td>
                    <td className="font-jetbrains px-5 py-3 font-semibold text-bb-emerald">{c.won}</td>
                    <td className="font-jetbrains px-5 py-3 font-semibold text-bb-emerald">{formatCurrency(c.revenue, "INR")}</td>
                    <td className="font-jetbrains px-5 py-3 text-bb-amber">{c.cr}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DarkCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <DarkCard className="overflow-hidden">
          <div className="border-b border-bb-border bg-bb-navy-2 px-5 py-4">
            <h3 className="text-sm font-semibold text-bb-text">Lead Source Performance</h3>
          </div>
          {sourcePerf.length === 0 ? (
            <p className="px-5 py-6 text-sm text-bb-text-3">No lead sources recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-bb-border">
                  {["Source", "Prospects", "Leads"].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-bb-text-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="bb-stagger">
                {sourcePerf.map((s) => (
                  <tr key={s.source} className="bb-stagger-item border-b border-bb-navy-3 transition-colors last:border-0 hover:bg-bb-navy-3">
                    <td className="px-4 py-3 font-medium text-bb-text">{s.source}</td>
                    <td className="font-jetbrains px-4 py-3 text-xs text-bb-text-2">{s.prospects}</td>
                    <td className="font-jetbrains px-4 py-3 text-xs text-bb-indigo-2">{s.leads}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DarkCard>

        <DarkCard className="p-5">
          <h3 className="mb-4 text-sm font-semibold text-bb-text">Overall Performance</h3>
          <div className="bb-stagger space-y-3">
            {[
              { label: "Total Deals Won", val: totalWon.toString() },
              { label: "Total Revenue", val: formatCurrency(totalRevenue, "INR") },
              { label: "Campaigns", val: campaignPerf.length.toString() },
              { label: "Lead Sources", val: sourcePerf.length.toString() },
            ].map((m) => (
              <div key={m.label} className="bb-stagger-item flex items-center justify-between border-b border-bb-navy-3 py-1.5 last:border-0">
                <span className="text-sm text-bb-text-2">{m.label}</span>
                <span className="font-jetbrains font-semibold text-bb-text">{m.val}</span>
              </div>
            ))}
          </div>
        </DarkCard>
      </div>
    </div>
  );
}
