import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ConversationsIcon } from "@/components/ui/icons";

export default function ConversationsPage() {
  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Conversations"
        description="Messages exchanged with your leads across every channel."
      />
      <EmptyState
        icon={ConversationsIcon}
        title="No conversations yet"
        description="Once leads start engaging, their conversations will appear here in one unified inbox."
      />
    </div>
  );
}
