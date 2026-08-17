"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { LeadStatusBadge, QualificationBadge, ScorePill } from "@/components/dashboard-ui/badge";
import { LeadsIcon, SearchIcon } from "@/components/ui/icons";
import { formatRelativeTime } from "@/lib/format";

export type LeadRow = {
  id: string;
  name: string;
  email: string | null;
  status: string;
  qualificationStatus: string;
  score: number | null;
  intent: string | null;
  nextAction: string | null;
  campaignName: string | null;
  createdAt: string;
};

const STATUS_FILTERS = ["All", "new", "contacted", "qualified", "unqualified", "converted", "lost"];

export function LeadsListClient({ leads }: { leads: LeadRow[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  const filtered = leads.filter(
    (l) =>
      (statusFilter === "All" || l.status === statusFilter) &&
      (l.name.toLowerCase().includes(search.toLowerCase()) || (l.email ?? "").toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title="Leads"
        description="Qualified prospects ready for outreach"
        action={
          <DashButton variant="outline" disabled title="Coming soon">
            Find More Leads
          </DashButton>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bb-text-3" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search leads..."
            className="w-full rounded-lg border border-bb-border bg-bb-navy-2 py-2 pl-9 pr-4 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo"
          />
        </div>
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`bb-press rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-all ${
              statusFilter === s ? "border-bb-indigo bg-bb-indigo/20 text-bb-indigo-2" : "border-bb-border bg-bb-navy-3 text-bb-text-3 hover:bg-bb-navy-4"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {leads.length === 0 ? (
        <DarkEmptyState
          icon={LeadsIcon}
          title="No leads yet"
          description="Leads you add or discover will show up here with their contact details and status."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-bb-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-bb-border bg-bb-navy-2">
                {["Name", "Score", "Intent", "Status", "Qualification", "Campaign", "Next Action", "Added", ""].map((h) => (
                  <th key={h} className="whitespace-nowrap px-4 py-3 text-left text-xs font-medium text-bb-text-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bb-stagger">
              {filtered.map((lead) => (
                <tr
                  key={lead.id}
                  onClick={() => router.push(`/leads/${lead.id}`)}
                  className="bb-stagger-item cursor-pointer border-b border-bb-navy-3 transition-colors last:border-0 hover:bg-bb-navy-3"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-bb-indigo to-bb-violet text-xs font-semibold text-white">
                        {lead.name[0]?.toUpperCase()}
                      </div>
                      <div>
                        <div className="font-medium text-bb-text">{lead.name}</div>
                        <div className="text-xs text-bb-text-3">{lead.email ?? "No email"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <ScorePill score={lead.score} />
                  </td>
                  <td className="px-4 py-3 text-xs text-bb-text-2">{lead.intent ?? "—"}</td>
                  <td className="px-4 py-3">
                    <LeadStatusBadge status={lead.status} />
                  </td>
                  <td className="px-4 py-3">
                    <QualificationBadge status={lead.qualificationStatus} />
                  </td>
                  <td className="px-4 py-3 text-xs text-bb-text-3">{lead.campaignName ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-bb-text-2">{lead.nextAction ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-bb-text-3">{formatRelativeTime(lead.createdAt)}</td>
                  <td className="px-4 py-3">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/leads/${lead.id}`);
                      }}
                      className="bb-press rounded-lg border border-bb-indigo/25 px-3 py-1.5 text-xs text-bb-indigo-2 transition-colors hover:bg-bb-navy-3"
                    >
                      Open
                    </button>
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
