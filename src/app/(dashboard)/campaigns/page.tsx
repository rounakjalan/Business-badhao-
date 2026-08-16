import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CampaignsIcon } from "@/components/ui/icons";

export default function CampaignsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Campaigns"
        description="Plan and launch outreach campaigns to acquire new customers."
        action={
          <Button disabled title="Coming soon">
            New campaign
          </Button>
        }
      />
      <EmptyState
        icon={CampaignsIcon}
        title="No campaigns yet"
        description="Campaigns you create will appear here, along with their status and performance."
      />
    </div>
  );
}
