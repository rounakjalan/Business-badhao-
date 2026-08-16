import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LeadsIcon } from "@/components/ui/icons";

export default function LeadsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Leads"
        description="Prospects discovered or imported into your workspace."
        action={
          <Button disabled title="Coming soon">
            Add lead
          </Button>
        }
      />
      <EmptyState
        icon={LeadsIcon}
        title="No leads yet"
        description="Leads you add or discover will show up here with their contact details and status."
      />
    </div>
  );
}
