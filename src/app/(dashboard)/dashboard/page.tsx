import { PageHeader } from "@/components/layout/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { DashboardIcon } from "@/components/ui/icons";

const STATS = [
  { label: "Active leads" },
  { label: "Open conversations" },
  { label: "Deals in progress" },
  { label: "Campaigns running" },
];

export default function DashboardPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Dashboard"
        description="A snapshot of your customer acquisition activity."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STATS.map((stat) => (
          <Card key={stat.label} className="p-5">
            <p className="text-sm text-slate-500">{stat.label}</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">—</p>
          </Card>
        ))}
      </div>

      <EmptyState
        icon={DashboardIcon}
        title="Nothing to show yet"
        description="Once you connect your workspace and launch a campaign, your activity will appear here."
      />
    </div>
  );
}
