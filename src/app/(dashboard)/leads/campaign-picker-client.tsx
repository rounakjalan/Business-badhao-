"use client";

import { useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkCard } from "@/components/dashboard-ui/card";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { CampaignStatusBadge } from "@/components/dashboard-ui/badge";
import { CampaignsIcon, LeadsIcon, SearchIcon } from "@/components/ui/icons";

export type CampaignLeadSummary = {
  id: string;
  name: string;
  status: string;
  leadCount: number;
  qualifiedCount: number;
};

export function CampaignPickerClient({
  campaigns,
  unassignedCount,
}: {
  campaigns: CampaignLeadSummary[];
  unassignedCount: number;
}) {
  const [search, setSearch] = useState("");

  if (campaigns.length === 0 && unassignedCount === 0) {
    return (
      <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
        <PageHeader title="Leads" description="Manage and review leads discovered through your campaigns." />
        <DarkEmptyState
          icon={CampaignsIcon}
          title="No campaigns yet"
          description="Create a campaign to start discovering leads. Once it finds prospects, they'll show up here."
          action={
            <Link href="/campaigns/create">
              <DashButton variant="gradient">Create Campaign</DashButton>
            </Link>
          }
        />
      </div>
    );
  }

  const filtered = campaigns.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col gap-5 p-4 sm:p-6">
      <PageHeader title="Leads" description="Manage and review leads discovered through your campaigns." />

      {campaigns.length > 6 ? (
        <div className="relative max-w-sm">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bb-text-3" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search campaigns..."
            className="w-full rounded-lg border border-bb-border bg-bb-navy-2 py-2 pl-9 pr-4 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo"
          />
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-bb-text-3">No campaigns match &ldquo;{search}&rdquo;.</p>
      ) : (
        <div className="bb-stagger grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((c) => (
            <Link key={c.id} href={`/leads?campaign=${c.id}`} className="bb-stagger-item block">
              <DarkCard className="bb-lift flex h-full flex-col justify-between gap-4 p-5">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-base font-semibold text-bb-text">{c.name}</h3>
                  <CampaignStatusBadge status={c.status} />
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-jetbrains text-2xl font-semibold text-bb-text">{c.leadCount.toLocaleString("en-IN")}</span>
                  <span className="text-xs text-bb-text-3">{c.leadCount === 1 ? "lead" : "leads"}</span>
                </div>
                <div className="flex items-center justify-between border-t border-bb-navy-3 pt-3">
                  <span className="text-xs text-bb-text-3">{c.qualifiedCount.toLocaleString("en-IN")} qualified</span>
                  <span className="bb-press text-sm font-medium text-bb-indigo transition-colors hover:text-bb-indigo-3">View Leads →</span>
                </div>
              </DarkCard>
            </Link>
          ))}
        </div>
      )}

      {unassignedCount > 0 ? (
        <Link href="/leads?campaign=unassigned" className="block">
          <DarkCard className="bb-lift flex items-center justify-between gap-4 p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bb-navy-3 text-bb-text-3">
                <LeadsIcon className="h-4.5 w-4.5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-bb-text">Unassigned Leads</h3>
                <p className="text-xs text-bb-text-3">Not linked to any campaign</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="font-jetbrains text-sm font-semibold text-bb-text">{unassignedCount.toLocaleString("en-IN")}</span>
              <span className="bb-press text-sm font-medium text-bb-indigo transition-colors hover:text-bb-indigo-3">View Leads →</span>
            </div>
          </DarkCard>
        </Link>
      ) : null}
    </div>
  );
}
