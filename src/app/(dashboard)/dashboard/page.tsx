import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { DashboardIcon } from "@/components/ui/icons";
import { getDashboardStats } from "@/lib/dashboard";
import { formatCurrency } from "@/lib/format";
import { getCurrentOrg } from "@/lib/organizations";

export default async function DashboardPage() {
  const currentOrg = await getCurrentOrg();
  // The layout above already redirects to /onboarding when there is no
  // organization, so this is only a type-narrowing guard.
  if (!currentOrg) {
    return null;
  }

  const stats = await getDashboardStats(currentOrg.organizationId);
  const hasAnyActivity = stats.totalLeads > 0 || stats.openDeals > 0 || stats.wonDeals > 0;

  const statCards = [
    { label: "Total leads", value: stats.totalLeads.toLocaleString("en-IN") },
    { label: "Qualified leads", value: stats.qualifiedLeads.toLocaleString("en-IN") },
    { label: "Active conversations", value: stats.activeConversations.toLocaleString("en-IN") },
    { label: "Open deals", value: stats.openDeals.toLocaleString("en-IN") },
    { label: "Won deals", value: stats.wonDeals.toLocaleString("en-IN") },
    { label: "Open pipeline value", value: formatCurrency(stats.openPipelineValue, stats.currency) },
  ];

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description={`A snapshot of ${currentOrg.organizationName}'s customer acquisition activity.`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {statCards.map((stat) => (
          <Card key={stat.label} className="p-5">
            <p className="text-sm text-slate-500">{stat.label}</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{stat.value}</p>
          </Card>
        ))}
      </div>

      {!hasAnyActivity ? (
        <EmptyState
          icon={DashboardIcon}
          title="Nothing to show yet"
          description="Once you add leads and launch a campaign, your activity will appear here."
        />
      ) : null}
    </div>
  );
}
