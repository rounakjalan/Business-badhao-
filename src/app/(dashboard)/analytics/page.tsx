import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { AnalyticsIcon } from "@/components/ui/icons";

export default function AnalyticsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Analytics"
        description="Understand how your campaigns and pipeline are performing."
      />
      <EmptyState
        icon={AnalyticsIcon}
        title="No data yet"
        description="Insights and performance charts will appear here once you have activity to measure."
      />
    </div>
  );
}
