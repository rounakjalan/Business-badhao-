import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { KnowledgeIcon } from "@/components/ui/icons";

export default function KnowledgePage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Knowledge"
        description="Documents and sources your business uses to inform customer conversations."
        action={
          <Button disabled title="Coming soon">
            Add source
          </Button>
        }
      />
      <EmptyState
        icon={KnowledgeIcon}
        title="No knowledge sources yet"
        description="Upload documents or connect sources to build your knowledge base."
      />
    </div>
  );
}
