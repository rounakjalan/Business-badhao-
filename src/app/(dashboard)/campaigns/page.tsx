import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { CampaignsIcon } from "@/components/ui/icons";
import { SimpleTable } from "@/components/ui/simple-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate } from "@/lib/format";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function CampaignsPage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("campaigns")
    .select("id, name, objective, status, created_at")
    .eq("organization_id", currentOrg.organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const campaigns = data ?? [];

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
      {campaigns.length === 0 ? (
        <EmptyState
          icon={CampaignsIcon}
          title="No campaigns yet"
          description="Campaigns you create will appear here, along with their status and performance."
        />
      ) : (
        <SimpleTable
          columns={[
            { header: "Name", cell: (c) => <span className="font-medium text-slate-900">{c.name}</span> },
            { header: "Objective", cell: (c) => c.objective || "—" },
            { header: "Status", cell: (c) => <StatusBadge status={c.status} /> },
            { header: "Created", cell: (c) => formatDate(c.created_at) },
          ]}
          rows={campaigns}
          getRowKey={(c) => c.id}
        />
      )}
    </div>
  );
}
