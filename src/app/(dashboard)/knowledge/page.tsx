import { PageHeader } from "@/components/layout/page-header";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { KnowledgeIcon, SparklesIcon } from "@/components/ui/icons";

export default function KnowledgePage() {
  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title="Knowledge Base"
        description="Business context used by AI for campaigns, outreach and conversations"
        action={
          <div className="flex gap-2">
            <DashButton variant="ghost" disabled title="Coming soon">
              + Add URL
            </DashButton>
            <DashButton variant="gradient" disabled title="Coming soon">
              ↑ Upload Document
            </DashButton>
          </div>
        }
      />

      <div className="flex items-start gap-3 rounded-xl border border-bb-indigo/20 bg-bb-indigo/8 p-4">
        <SparklesIcon className="mt-0.5 h-5 w-5 shrink-0 text-bb-indigo" />
        <div>
          <div className="mb-1 text-sm font-medium text-bb-indigo-2">AI will use this knowledge automatically</div>
          <div className="text-xs text-bb-text-3">
            Once AI campaign planning, qualification, and conversation replies are connected, they&apos;ll draw on whatever you
            add here for context. Knowledge base management is coming in a future update.
          </div>
        </div>
      </div>

      <DarkEmptyState
        icon={KnowledgeIcon}
        title="Add your business knowledge"
        description="So AI can understand your business, products, pricing, and FAQs — once this feature is connected."
      />
    </div>
  );
}
