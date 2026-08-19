"use client";

import { useState } from "react";
import Link from "next/link";
import { updateCampaignStatus } from "@/app/(dashboard)/campaigns/actions";
import { IcpSchema, type Icp } from "@/lib/ai/agents/icp-schema";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkCard } from "@/components/dashboard-ui/card";
import { CampaignStatusBadge, ConversationStatusBadge, DealStatusBadge } from "@/components/dashboard-ui/badge";
import { DataTable } from "@/components/dashboard-ui/table";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { ConversationsIcon, DealsIcon, SparklesIcon } from "@/components/ui/icons";
import { formatCurrency, formatDate } from "@/lib/format";

const TABS = ["Overview", "ICP", "Lead Discovery", "Conversations", "Deals", "Activity"] as const;

type Campaign = {
  id: string;
  name: string;
  objective: string | null;
  description: string | null;
  target_audience: string | null;
  status: string;
  created_at: string;
};

type ConversationRow = { id: string; channel: string; status: string; intent: string | null; created_at: string };
type DealRow = { id: string; title: string; status: string; value: number; currency: string; created_at: string };

export function CampaignDetailTabs({
  campaign,
  icp,
  leadCount,
  qualifiedCount,
  conversations,
  deals,
  revenue,
}: {
  campaign: Campaign;
  /** Raw jsonb from ideal_customer_profiles.criteria — validated below, since campaigns created before the ICP step shipped store the old plan-derived shape. */
  icp: unknown;
  leadCount: number;
  qualifiedCount: number;
  conversations: ConversationRow[];
  deals: DealRow[];
  revenue: number;
}) {
  const parsedIcp = icp ? IcpSchema.safeParse(icp) : null;
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [pending, setPending] = useState(false);

  const togglePause = async () => {
    setPending(true);
    await updateCampaignStatus(campaign.id, campaign.status === "paused" ? "active" : "paused");
    setPending(false);
  };

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col">
      <div className="border-b border-bb-border px-4 py-5 sm:px-6">
        <div className="mb-3 flex items-center gap-2 text-sm">
          <Link href="/campaigns" className="text-bb-text-3 hover:text-bb-text">
            Campaigns
          </Link>
          <span className="text-bb-border">/</span>
          <span className="text-bb-text">{campaign.name}</span>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-3">
              <h2 className="font-display text-xl font-semibold text-bb-text">{campaign.name}</h2>
              <CampaignStatusBadge status={campaign.status} />
            </div>
            <div className="text-sm text-bb-text-3">
              {campaign.objective ?? "No objective set"} · Created {formatDate(campaign.created_at)}
            </div>
          </div>
          <div className="flex gap-2">
            <DashButton variant="ghost" onClick={togglePause} disabled={pending || campaign.status === "won"}>
              {campaign.status === "paused" ? "Resume Campaign" : "Pause Campaign"}
            </DashButton>
            <DashButton variant="gradient" onClick={() => setTab("Lead Discovery")}>
              Find Leads
            </DashButton>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Leads", val: leadCount },
            { label: "Qualified", val: qualifiedCount },
            { label: "Conversations", val: conversations.length },
            { label: "Revenue", val: revenue > 0 ? formatCurrency(revenue, "INR") : "—" },
          ].map((m) => (
            <div key={m.label} className="rounded-lg bg-bb-navy-3 p-3 text-center">
              <div className="mb-1 text-xs text-bb-text-3">{m.label}</div>
              <div className="font-jetbrains text-sm font-semibold text-bb-text">{m.val}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-bb-border px-4 py-3 sm:px-6">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
              tab === t ? "bg-bb-indigo/15 text-bb-indigo-2" : "text-bb-text-3 hover:text-bb-text"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 p-4 sm:p-6">
        {tab === "Overview" ? (
          <div className="max-w-2xl space-y-4 text-sm text-bb-text-2">
            <DarkCard className="p-5">
              <div className="mb-2 text-xs font-medium text-bb-text-3">DESCRIPTION</div>
              <p>{campaign.description || "No description added."}</p>
            </DarkCard>
            <DarkCard className="p-5">
              <div className="mb-2 text-xs font-medium text-bb-text-3">TARGET AUDIENCE</div>
              <p>{campaign.target_audience || "No target audience set yet."}</p>
            </DarkCard>
          </div>
        ) : null}

        {tab === "ICP" ? <IcpTab icp={parsedIcp?.success ? parsedIcp.data : null} targetAudience={campaign.target_audience} /> : null}

        {tab === "Lead Discovery" ? <LeadDiscoveryPreview /> : null}

        {tab === "Conversations" ? (
          conversations.length === 0 ? (
            <DarkEmptyState icon={ConversationsIcon} title="No conversations yet" description="Conversations linked to this campaign will show up here." />
          ) : (
            <DataTable
              columns={[
                { header: "Channel", cell: (c) => <span className="capitalize">{c.channel}</span> },
                { header: "Status", cell: (c) => <ConversationStatusBadge status={c.status} /> },
                { header: "Intent", cell: (c) => c.intent ?? "—" },
                { header: "Started", cell: (c) => formatDate(c.created_at) },
              ]}
              rows={conversations}
              getRowKey={(c) => c.id}
            />
          )
        ) : null}

        {tab === "Deals" ? (
          deals.length === 0 ? (
            <DarkEmptyState icon={DealsIcon} title="No deals yet" description="Deals linked to this campaign will show up here." />
          ) : (
            <DataTable
              columns={[
                { header: "Deal", cell: (d) => d.title },
                { header: "Status", cell: (d) => <DealStatusBadge status={d.status} /> },
                { header: "Value", cell: (d) => formatCurrency(Number(d.value), d.currency) },
                { header: "Created", cell: (d) => formatDate(d.created_at) },
              ]}
              rows={deals}
              getRowKey={(d) => d.id}
            />
          )
        ) : null}

        {tab === "Activity" ? <div className="py-16 text-center text-sm text-bb-text-3">Activity history is coming soon.</div> : null}
      </div>
    </div>
  );
}

const ICP_DISPLAY_FIELDS: { key: keyof Icp; label: string }[] = [
  { key: "targetCustomer", label: "Target Customer / Persona" },
  { key: "ageRange", label: "Age Range" },
  { key: "location", label: "Location / Service Area" },
  { key: "industry", label: "Industry / Category" },
  { key: "businessType", label: "Company / Business Type" },
  { key: "budgetRange", label: "Income / Budget / Purchasing Capacity" },
  { key: "needs", label: "Needs" },
  { key: "painPoints", label: "Pain Points" },
  { key: "buyingSignals", label: "Buying Signals" },
  { key: "decisionFactors", label: "Decision-Making Factors" },
  { key: "disqualifiers", label: "Disqualifiers" },
  { key: "preferredChannels", label: "Preferred Channels" },
  { key: "qualificationCriteria", label: "Qualification Criteria" },
];

function IcpTab({ icp, targetAudience }: { icp: Icp | null; targetAudience: string | null }) {
  if (!icp) {
    return (
      <DarkCard className="max-w-2xl p-5 text-sm text-bb-text-2">
        <div className="mb-2 text-xs font-medium text-bb-text-3">IDEAL CUSTOMER PROFILE</div>
        <p>{targetAudience || "No Ideal Customer Profile was generated for this campaign yet."}</p>
      </DarkCard>
    );
  }

  return (
    <div className="bb-stagger grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2">
      {ICP_DISPLAY_FIELDS.map((f) => {
        const value = icp[f.key];
        const display = Array.isArray(value) ? (value.length > 0 ? value.join(", ") : "—") : (value ?? "Not specified");
        return (
          <div key={f.key} className="bb-stagger-item rounded-lg border border-bb-border bg-bb-navy p-4">
            <div className="mb-1 text-xs font-medium text-bb-indigo-2">{f.label}</div>
            <div className="text-sm text-bb-text-2">{display}</div>
          </div>
        );
      })}
    </div>
  );
}

function LeadDiscoveryPreview() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);

  const start = () => {
    setRunning(true);
    setProgress(0);
    const interval = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) {
          clearInterval(interval);
          setRunning(false);
          return 100;
        }
        return p + 10;
      });
    }, 250);
  };

  return (
    <div className="max-w-2xl space-y-5">
      <DarkCard className="p-5 text-sm text-bb-text-2">
        <p>
          AI-powered lead discovery isn&apos;t connected yet — this is a preview of what running discovery will look like. Add
          leads manually for now.
        </p>
      </DarkCard>
      {running ? (
        <DarkCard className="border-bb-indigo/30 p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium text-bb-indigo-2">
              <span className="bb-animate-pulse-dot h-2 w-2 rounded-full bg-bb-indigo" />
              Discovery running (preview)...
            </div>
            <span className="font-jetbrains text-sm text-bb-text-3">{progress}%</span>
          </div>
          <div className="h-2 rounded-full bg-bb-navy-3">
            <div
              className="h-full rounded-full bg-gradient-to-r from-bb-indigo to-bb-violet transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </DarkCard>
      ) : null}
      <DashButton variant="gradient" onClick={start} disabled={running}>
        <SparklesIcon className="h-3.5 w-3.5" />
        {running ? "Running preview..." : "Preview Discovery"}
      </DashButton>
    </div>
  );
}
