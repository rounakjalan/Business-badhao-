"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { quickCreateDealForLead } from "@/app/(dashboard)/leads/actions";
import { PageHeader } from "@/components/layout/page-header";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { BuyingIntentBadge, ChannelBadge, DealStatusBadge } from "@/components/dashboard-ui/badge";
import { BuyingIntentIcon, SearchIcon } from "@/components/ui/icons";
import { formatRelativeTime } from "@/lib/format";

export type BuyingIntentRow = {
  id: string;
  name: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  buyingIntent: "low" | "medium" | "high" | null;
  confidence: "low" | "medium" | "high" | null;
  qualificationStatus: string;
  score: number | null;
  latestConversation: { id: string; channel: string; status: string; at: string } | null;
  dealId: string | null;
  dealStatus: string | null;
  createdAt: string;
};

const INTENT_TABS = ["All", "high", "medium", "low"] as const;
const INTENT_TAB_LABEL: Record<(typeof INTENT_TABS)[number], string> = { All: "All", high: "High Intent", medium: "Medium Intent", low: "Low Intent" };
const INTENT_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

type SortKey = "intent" | "score" | "activity" | "name";
const SORT_LABEL: Record<SortKey, string> = { intent: "Buying Intent", score: "Score", activity: "Latest Activity", name: "Name" };

export function BuyingIntentListClient({ rows }: { rows: BuyingIntentRow[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<(typeof INTENT_TABS)[number]>("All");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("intent");
  const [creatingDealFor, setCreatingDealFor] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const counts = useMemo(
    () => ({
      high: rows.filter((r) => r.buyingIntent === "high").length,
      medium: rows.filter((r) => r.buyingIntent === "medium").length,
      low: rows.filter((r) => r.buyingIntent === "low").length,
    }),
    [rows]
  );

  const filtered = useMemo(() => {
    let list = rows;
    if (tab !== "All") list = list.filter((r) => r.buyingIntent === tab);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (r) => r.name.toLowerCase().includes(q) || (r.companyName ?? "").toLowerCase().includes(q) || (r.email ?? "").toLowerCase().includes(q)
      );
    }

    return [...list].sort((a, b) => {
      if (sort === "intent") return (INTENT_RANK[b.buyingIntent ?? ""] ?? 0) - (INTENT_RANK[a.buyingIntent ?? ""] ?? 0);
      if (sort === "score") return (b.score ?? -1) - (a.score ?? -1);
      if (sort === "activity") return new Date(b.latestConversation?.at ?? 0).getTime() - new Date(a.latestConversation?.at ?? 0).getTime();
      return a.name.localeCompare(b.name);
    });
  }, [rows, tab, search, sort]);

  function createDeal(row: BuyingIntentRow) {
    setCreatingDealFor(row.id);
    startTransition(() => quickCreateDealForLead(row.id, row.name));
  }

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title="Buying Intent"
        description="Leads grouped by AI-detected buying intent — updated automatically as the Conversation Agent analyzes new messages."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["high", "medium", "low"] as const).map((level) => (
          <button
            key={level}
            onClick={() => setTab(level)}
            className={`bb-press rounded-lg p-3 text-center transition-all ${tab === level ? "bg-bb-indigo/15 ring-1 ring-bb-indigo/40" : "bg-bb-navy-3 hover:bg-bb-navy-4"}`}
          >
            <div className="mb-1 text-xs text-bb-text-3">{INTENT_TAB_LABEL[level]}</div>
            <div className="font-jetbrains text-lg font-semibold text-bb-text">{counts[level]}</div>
          </button>
        ))}
        <button
          onClick={() => setTab("All")}
          className={`bb-press rounded-lg p-3 text-center transition-all ${tab === "All" ? "bg-bb-indigo/15 ring-1 ring-bb-indigo/40" : "bg-bb-navy-3 hover:bg-bb-navy-4"}`}
        >
          <div className="mb-1 text-xs text-bb-text-3">All Leads</div>
          <div className="font-jetbrains text-lg font-semibold text-bb-text">{rows.length}</div>
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex overflow-hidden rounded-lg border border-bb-border">
          {INTENT_TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`bb-press px-4 py-2 text-xs font-medium transition-all ${
                tab === t ? "bg-bb-indigo/20 text-bb-indigo-2" : "text-bb-text-3 hover:bg-bb-navy-3"
              }`}
            >
              {INTENT_TAB_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bb-text-3" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search leads or companies..."
            className="w-full rounded-lg border border-bb-border bg-bb-navy-2 py-2 pl-9 pr-4 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          className="rounded-lg border border-bb-border bg-bb-navy-2 px-3 py-2 text-xs text-bb-text-2 outline-none focus:border-bb-indigo"
        >
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
            <option key={k} value={k}>
              Sort: {SORT_LABEL[k]}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <DarkEmptyState
          icon={BuyingIntentIcon}
          title={rows.length === 0 ? "No leads yet" : "No leads match"}
          description={
            rows.length === 0
              ? "Once conversations happen and the AI detects buying intent, leads will show up here grouped by High, Medium, and Low."
              : "Try a different tab, search term, or clear your filters."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-bb-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-bb-border bg-bb-navy-2">
                {["Lead", "Contact", "Buying Intent", "Confidence", "Latest Activity", "Deal Stage", ""].map((h) => (
                  <th key={h} className="whitespace-nowrap px-4 py-3 text-left text-xs font-medium text-bb-text-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bb-stagger">
              {filtered.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => router.push(`/leads/${row.id}`)}
                  className="bb-stagger-item cursor-pointer border-b border-bb-navy-3 transition-colors last:border-0 hover:bg-bb-navy-3"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-bb-indigo to-bb-violet text-xs font-semibold text-white">
                        {row.name[0]?.toUpperCase()}
                      </div>
                      <div>
                        <div className="font-medium text-bb-text">{row.name}</div>
                        {row.companyName && row.companyName !== row.name ? <div className="text-xs text-bb-text-3">{row.companyName}</div> : null}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-bb-text-2">
                    <div>{row.email ?? "No email"}</div>
                    {row.phone ? <div className="text-bb-text-3">{row.phone}</div> : null}
                  </td>
                  <td className="px-4 py-3">{row.buyingIntent ? <BuyingIntentBadge intent={row.buyingIntent} /> : <span className="text-xs text-bb-text-3">Not assessed</span>}</td>
                  <td className="px-4 py-3 text-xs capitalize text-bb-text-3">{row.confidence ?? "—"}</td>
                  <td className="px-4 py-3">
                    {row.latestConversation ? (
                      <div className="flex items-center gap-2">
                        <ChannelBadge channel={row.latestConversation.channel} />
                        <span className="text-xs text-bb-text-3">{formatRelativeTime(row.latestConversation.at)}</span>
                      </div>
                    ) : (
                      <span className="text-xs text-bb-text-3">No conversation yet</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {row.dealId && row.dealStatus ? <DealStatusBadge status={row.dealStatus} /> : <span className="text-xs text-bb-text-3">No deal yet</span>}
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {row.dealId ? (
                      <button
                        onClick={() => router.push(`/deals/${row.dealId}`)}
                        className="bb-press rounded-lg border border-bb-border px-3 py-1.5 text-xs text-bb-text-2 transition-colors hover:bg-bb-navy-3"
                      >
                        View Deal
                      </button>
                    ) : (
                      <DashButton
                        variant={row.buyingIntent === "high" ? "gradient" : "ghost"}
                        disabled={isPending && creatingDealFor === row.id}
                        onClick={() => createDeal(row)}
                      >
                        {isPending && creatingDealFor === row.id ? "Creating…" : "Create Deal"}
                      </DashButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
