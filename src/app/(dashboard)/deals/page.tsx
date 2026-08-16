import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DealsIcon } from "@/components/ui/icons";

export default function DealsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Deals"
        description="Track opportunities as they move through your pipeline."
        action={
          <Button disabled title="Coming soon">
            New deal
          </Button>
        }
      />
      <EmptyState
        icon={DealsIcon}
        title="No deals yet"
        description="Deals created from your conversations and leads will be tracked here."
      />
    </div>
  );
}
