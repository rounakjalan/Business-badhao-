import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ConversationsIcon } from "@/components/ui/icons";
import { SimpleTable } from "@/components/ui/simple-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate, shortId } from "@/lib/format";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function ConversationsPage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("conversations")
    .select("id, channel, status, intent, last_message_at, created_at")
    .eq("organization_id", currentOrg.organizationId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  const conversations = data ?? [];

  return (
    <div className="flex flex-1 flex-col gap-6">
      <PageHeader
        title="Conversations"
        description="Messages exchanged with your leads across every channel."
      />
      {conversations.length === 0 ? (
        <EmptyState
          icon={ConversationsIcon}
          title="No conversations yet"
          description="Once leads start engaging, their conversations will appear here in one unified inbox."
        />
      ) : (
        <SimpleTable
          columns={[
            { header: "Conversation", cell: (c) => <span className="font-mono text-xs text-slate-500">{shortId(c.id)}</span> },
            { header: "Channel", cell: (c) => <StatusBadge status={c.channel} /> },
            { header: "Status", cell: (c) => <StatusBadge status={c.status} /> },
            { header: "Intent", cell: (c) => c.intent || "—" },
            { header: "Last activity", cell: (c) => formatDate(c.last_message_at ?? c.created_at) },
          ]}
          rows={conversations}
          getRowKey={(c) => c.id}
        />
      )}
    </div>
  );
}
