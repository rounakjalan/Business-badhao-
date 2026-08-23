import Link from "next/link";
import { CheckRepliesButton } from "@/app/(dashboard)/conversations/check-replies-button";
import { PageHeader } from "@/components/layout/page-header";
import { DarkCard } from "@/components/dashboard-ui/card";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { ChannelBadge, ConversationStatusBadge } from "@/components/dashboard-ui/badge";
import { ConversationsIcon } from "@/components/ui/icons";
import { formatRelativeTime } from "@/lib/format";
import { resolveLeadIdentities } from "@/lib/lead-names";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function ConversationsPage() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();
  const { data: conversations, error } = await supabase
    .from("conversations")
    .select("id, lead_id, channel, status, intent, last_message_at, created_at")
    .eq("organization_id", currentOrg.organizationId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  const leadIds = [...new Set((conversations ?? []).map((c) => c.lead_id))];
  const identities = await resolveLeadIdentities(supabase, leadIds);

  const rows = (conversations ?? []).map((c) => ({ ...c, contactName: identities.get(c.lead_id)?.name ?? "Unnamed lead" }));

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader title="Conversations" description="Customer communication center" action={<CheckRepliesButton />} />

      {rows.length === 0 ? (
        <DarkEmptyState
          icon={ConversationsIcon}
          title="No customer conversations yet"
          description="Start outreach to your qualified leads to begin conversations."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((cv) => (
            <Link key={cv.id} href={`/conversations/${cv.id}`}>
              <DarkCard className="p-5 transition-colors hover:border-bb-indigo/30">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-bb-indigo to-bb-violet font-bold text-white">
                    {cv.contactName[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-bb-text">{cv.contactName}</span>
                        <ChannelBadge channel={cv.channel} />
                      </div>
                      <span className="text-xs text-bb-text-3">{formatRelativeTime(cv.last_message_at ?? cv.created_at)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <ConversationStatusBadge status={cv.status} />
                      {cv.intent ? <span className="text-xs text-bb-text-2">Intent: {cv.intent}</span> : null}
                    </div>
                  </div>
                </div>
              </DarkCard>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
