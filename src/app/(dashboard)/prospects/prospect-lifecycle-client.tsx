"use client";

import { useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/dashboard-ui/badge";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { DataTable } from "@/components/dashboard-ui/table";
import { ProspectsIcon, SearchIcon } from "@/components/ui/icons";
import { formatRelativeTime } from "@/lib/format";
import { PROSPECT_STAGE_ICON, PROSPECT_STAGE_LABEL, PROSPECT_STAGE_ORDER, countProspectStages, type ProspectStage } from "@/lib/prospect-lifecycle";

export type ProspectRow = {
  id: string;
  companyName: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  sourceUrl: string | null;
  stage: ProspectStage;
  createdAt: string;
  /** The lead record created for this prospect by the existing Prospect → Lead workflow — null only if that hasn't happened yet (should be rare/transient; every accepted prospect gets one). */
  leadId: string | null;
};

const STAGE_COLOR: Record<ProspectStage, "blue" | "amber" | "emerald" | "rose" | "slate"> = {
  new: "blue",
  researching: "amber",
  qualified: "emerald",
  disqualified: "rose",
  needs_review: "slate",
};

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function StageBadge({ stage }: { stage: ProspectStage }) {
  return (
    <Badge color={STAGE_COLOR[stage]}>
      {PROSPECT_STAGE_ICON[stage]} {PROSPECT_STAGE_LABEL[stage]}
    </Badge>
  );
}

export function ProspectLifecycleClient({
  campaignName,
  backHref,
  prospects,
}: {
  campaignName: string;
  backHref: string;
  prospects: ProspectRow[];
}) {
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<ProspectStage | "all">("all");

  const stageCounts = countProspectStages(prospects.map((p) => p.stage));

  const filtered = prospects.filter((p) => {
    if (stageFilter !== "all" && p.stage !== stageFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (p.companyName ?? "").toLowerCase().includes(q) || (p.contactName ?? "").toLowerCase().includes(q) || (p.email ?? "").toLowerCase().includes(q);
  });

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <div>
        <Link href={backHref} className="bb-press inline-block text-sm text-bb-indigo transition-colors hover:text-bb-indigo-3">
          ← Back to Campaigns
        </Link>
      </div>
      <PageHeader title={campaignName} description={`${prospects.length.toLocaleString("en-IN")} ${prospects.length === 1 ? "prospect" : "prospects"}`} />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-48 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bb-text-3" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search prospects..."
            className="w-full rounded-lg border border-bb-border bg-bb-navy-2 py-2 pl-9 pr-4 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo"
          />
        </div>
        <button
          onClick={() => setStageFilter("all")}
          className={`bb-press rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
            stageFilter === "all" ? "border-bb-indigo bg-bb-indigo/20 text-bb-indigo-2" : "border-bb-border bg-bb-navy-3 text-bb-text-3 hover:bg-bb-navy-4"
          }`}
        >
          All ({prospects.length})
        </button>
        {PROSPECT_STAGE_ORDER.map((stage) => (
          <button
            key={stage}
            onClick={() => setStageFilter(stage)}
            className={`bb-press rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
              stageFilter === stage ? "border-bb-indigo bg-bb-indigo/20 text-bb-indigo-2" : "border-bb-border bg-bb-navy-3 text-bb-text-3 hover:bg-bb-navy-4"
            }`}
          >
            {PROSPECT_STAGE_ICON[stage]} {PROSPECT_STAGE_LABEL[stage]} ({stageCounts[stage]})
          </button>
        ))}
      </div>

      {prospects.length === 0 ? (
        <DarkEmptyState
          icon={ProspectsIcon}
          title="No prospects yet"
          description="Prospects discovered for this campaign will show up here, each one already linked to the lead record created for it."
        />
      ) : filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-bb-text-3">
          {search ? `No prospects match "${search}".` : `No prospects are currently ${PROSPECT_STAGE_LABEL[stageFilter as ProspectStage]}.`}
        </p>
      ) : (
        <DataTable
          columns={[
            {
              header: "Prospect",
              cell: (p: ProspectRow) => (
                <div>
                  <div className="font-medium text-bb-text">{p.companyName ?? p.contactName ?? "Unnamed prospect"}</div>
                  {p.contactName && p.companyName ? <div className="text-xs text-bb-text-3">{p.contactName}</div> : null}
                </div>
              ),
            },
            {
              header: "Status",
              cell: (p: ProspectRow) => <StageBadge stage={p.stage} />,
            },
            {
              header: "Contact",
              cell: (p: ProspectRow) => (
                <div className="text-xs">
                  <div className="text-bb-text-2">{p.email ?? "—"}</div>
                  {p.phone ? <div className="text-bb-text-3">{p.phone}</div> : null}
                </div>
              ),
            },
            {
              header: "Found via",
              cell: (p: ProspectRow) =>
                p.sourceUrl ? (
                  <a
                    href={p.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={p.sourceUrl}
                    className="inline-block max-w-40 truncate rounded-full bg-bb-navy-3 px-2.5 py-1 text-xs text-bb-text-3 transition-colors hover:bg-bb-navy-4 hover:text-bb-indigo-2"
                  >
                    {hostnameOf(p.sourceUrl)}
                  </a>
                ) : (
                  <span className="text-xs text-bb-text-3">—</span>
                ),
            },
            { header: "Added", cell: (p: ProspectRow) => <span className="text-xs">{formatRelativeTime(p.createdAt)}</span> },
            {
              header: "",
              cell: (p: ProspectRow) =>
                p.leadId ? (
                  <Link
                    href={`/leads/${p.leadId}`}
                    className="bb-press rounded-lg border border-bb-indigo/25 px-3 py-1.5 text-xs text-bb-indigo-2 transition-colors hover:bg-bb-navy-3"
                  >
                    Open Lead
                  </Link>
                ) : null,
            },
          ]}
          rows={filtered}
          getRowKey={(p) => p.id}
        />
      )}
    </div>
  );
}
