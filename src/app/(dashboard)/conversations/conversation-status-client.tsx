"use client";

import { useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { DarkCard } from "@/components/dashboard-ui/card";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { ChannelBadge, ConversationStatusBadge, OwnerBadge, BuyingIntentBadge } from "@/components/dashboard-ui/badge";
import { ConversationsIcon, SearchIcon } from "@/components/ui/icons";
import { formatRelativeTime } from "@/lib/format";

export type ConversationStatus = "open" | "pending" | "resolved" | "closed";

export type ConversationRow = {
  id: string;
  contactName: string;
  channel: string;
  status: ConversationStatus;
  owner: "ai" | "human";
  intent: string | null;
  buyingIntent: "low" | "medium" | "high" | null;
  lastActivityAt: string;
};

const STATUS_ORDER: ConversationStatus[] = ["open", "pending", "resolved", "closed"];
const STATUS_LABEL: Record<ConversationStatus, string> = { open: "Open", pending: "Pending", resolved: "Resolved", closed: "Closed" };

/** "READY_TO_BUY" -> "READY TO BUY" — same underscore-to-space treatment the rest of the app already applies to enum-like labels (see formatLabel in badge.tsx). */
function formatIntentLabel(intent: string) {
  return intent.replaceAll("_", " ");
}

export function ConversationStatusClient({
  campaignName,
  backHref,
  conversations,
}: {
  campaignName: string;
  backHref: string;
  conversations: ConversationRow[];
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ConversationStatus | "all">("all");

  const counts: Record<ConversationStatus, number> = { open: 0, pending: 0, resolved: 0, closed: 0 };
  for (const c of conversations) counts[c.status] += 1;

  const filtered = conversations.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (!search) return true;
    return c.contactName.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <div>
        <Link href={backHref} className="bb-press inline-block text-sm text-bb-indigo transition-colors hover:text-bb-indigo-3">
          ← Back to Campaigns
        </Link>
      </div>
      <PageHeader
        title={campaignName}
        description={`${conversations.length.toLocaleString("en-IN")} ${conversations.length === 1 ? "conversation" : "conversations"}`}
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bb-text-3" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations..."
            className="w-full rounded-lg border border-bb-border bg-bb-navy-2 py-2 pl-9 pr-4 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo"
          />
        </div>
        <button
          onClick={() => setStatusFilter("all")}
          className={`bb-press rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
            statusFilter === "all" ? "border-bb-indigo bg-bb-indigo/20 text-bb-indigo-2" : "border-bb-border bg-bb-navy-3 text-bb-text-3 hover:bg-bb-navy-4"
          }`}
        >
          All ({conversations.length})
        </button>
        {STATUS_ORDER.map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={`bb-press rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
              statusFilter === status ? "border-bb-indigo bg-bb-indigo/20 text-bb-indigo-2" : "border-bb-border bg-bb-navy-3 text-bb-text-3 hover:bg-bb-navy-4"
            }`}
          >
            {STATUS_LABEL[status]} ({counts[status]})
          </button>
        ))}
      </div>

      {conversations.length === 0 ? (
        <DarkEmptyState
          icon={ConversationsIcon}
          title="No conversations yet"
          description="Conversations for this campaign will show up here once outreach begins or a lead replies."
        />
      ) : filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-bb-text-3">
          {search ? `No conversations match "${search}".` : `No conversations are currently ${STATUS_LABEL[statusFilter as ConversationStatus]}.`}
        </p>
      ) : (
        <div className="bb-stagger space-y-3">
          {filtered.map((cv) => (
            <Link key={cv.id} href={`/conversations/${cv.id}`} className="bb-stagger-item block">
              <DarkCard className="bb-lift p-5 transition-colors hover:border-bb-indigo/30">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-bb-indigo to-bb-violet font-bold text-white">
                    {cv.contactName[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-bb-text">{cv.contactName}</span>
                        <ChannelBadge channel={cv.channel} />
                      </div>
                      <span className="shrink-0 text-xs text-bb-text-3">{formatRelativeTime(cv.lastActivityAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <ConversationStatusBadge status={cv.status} />
                      <OwnerBadge owner={cv.owner} />
                      {cv.buyingIntent ? <BuyingIntentBadge intent={cv.buyingIntent} /> : null}
                      {cv.intent ? <span className="text-xs text-bb-text-3">{formatIntentLabel(cv.intent)}</span> : null}
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
