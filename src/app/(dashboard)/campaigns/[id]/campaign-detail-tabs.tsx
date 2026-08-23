"use client";

import { useState } from "react";
import Link from "next/link";
import {
  updateCampaign,
  updateCampaignStatus,
  startLeadDiscoveryAction,
  type DiscoveredLeadRow,
  type DiscoveredProspectSummary,
  type LeadDiscoveryActionResult,
} from "@/app/(dashboard)/campaigns/actions";
import { IcpSchema, type Icp } from "@/lib/ai/agents/icp-schema";
import { DarkAlert } from "@/components/dashboard-ui/alert";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkCard } from "@/components/dashboard-ui/card";
import { CampaignStatusBadge, ConversationStatusBadge, DealStatusBadge } from "@/components/dashboard-ui/badge";
import { DataTable } from "@/components/dashboard-ui/table";
import { DarkEmptyState } from "@/components/dashboard-ui/empty-state";
import { ConversationsIcon, DealsIcon, ProspectsIcon, SparklesIcon } from "@/components/ui/icons";
import type { Json } from "@/types/database.types";
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
type DiscoveryState = {
  lastRun: { status: string; startedAt: string | null; completedAt: string | null; output: Json } | null;
  discoveredLeads: DiscoveredLeadRow[];
};

export function CampaignDetailTabs({
  campaign,
  icp,
  leadCount,
  qualifiedCount,
  conversations,
  deals,
  revenue,
  discovery,
}: {
  campaign: Campaign;
  /** Raw jsonb from ideal_customer_profiles.criteria — validated below, since campaigns created before the ICP step shipped store the old plan-derived shape. */
  icp: unknown;
  leadCount: number;
  qualifiedCount: number;
  conversations: ConversationRow[];
  deals: DealRow[];
  revenue: number;
  discovery: DiscoveryState;
}) {
  const parsedIcp = icp ? IcpSchema.safeParse(icp) : null;
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);

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
          <div className="flex flex-wrap gap-2">
            <DashButton
              variant="ghost"
              onClick={() => {
                setTab("Overview");
                setEditing((e) => !e);
              }}
            >
              {editing ? "Cancel Edit" : "Edit Campaign"}
            </DashButton>
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
          editing ? (
            <CampaignEditForm campaign={campaign} onDone={() => setEditing(false)} />
          ) : (
            <div className="max-w-2xl space-y-4 text-sm text-bb-text-2">
              <DarkCard className="p-5">
                <div className="mb-2 text-xs font-medium text-bb-text-3">OBJECTIVE</div>
                <p>{campaign.objective || "No objective set."}</p>
              </DarkCard>
              <DarkCard className="p-5">
                <div className="mb-2 text-xs font-medium text-bb-text-3">DESCRIPTION</div>
                <p>{campaign.description || "No description added."}</p>
              </DarkCard>
              <DarkCard className="p-5">
                <div className="mb-2 text-xs font-medium text-bb-text-3">TARGET AUDIENCE</div>
                <p>{campaign.target_audience || "No target audience set yet."}</p>
              </DarkCard>
            </div>
          )
        ) : null}

        {tab === "ICP" ? <IcpTab icp={parsedIcp?.success ? parsedIcp.data : null} targetAudience={campaign.target_audience} /> : null}

        {tab === "Lead Discovery" ? <LeadDiscoveryTab campaignId={campaign.id} hasIcp={Boolean(icp)} discovery={discovery} /> : null}

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

function editFieldClass() {
  return "w-full rounded-lg border border-bb-border bg-bb-navy px-4 py-2.5 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo";
}

/**
 * Edits the campaign's own details in place on the Overview tab. Kept to
 * the four fields the wizard collects — status has its own control, and the
 * ICP is generated rather than typed, so neither belongs in this form.
 */
function CampaignEditForm({ campaign, onDone }: { campaign: Campaign; onDone: () => void }) {
  const [name, setName] = useState(campaign.name);
  const [objective, setObjective] = useState(campaign.objective ?? "");
  const [description, setDescription] = useState(campaign.description ?? "");
  const [targetAudience, setTargetAudience] = useState(campaign.target_audience ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await updateCampaign(campaign.id, { name, objective, description, targetAudience });
    setSaving(false);
    if (result.ok) {
      onDone();
    } else {
      setError(result.message);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      {error ? <DarkAlert variant="error">{error}</DarkAlert> : null}

      <DarkCard className="space-y-4 p-5">
        <div className="space-y-1.5">
          <label htmlFor="campaign-name" className="block text-xs font-medium text-bb-text-3">
            CAMPAIGN NAME
          </label>
          <input
            id="campaign-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={editFieldClass()}
            placeholder="e.g. Pune Local Business Websites"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="campaign-objective" className="block text-xs font-medium text-bb-text-3">
            OBJECTIVE
          </label>
          <input
            id="campaign-objective"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            className={editFieldClass()}
            placeholder="What should this campaign achieve?"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="campaign-description" className="block text-xs font-medium text-bb-text-3">
            DESCRIPTION
          </label>
          <textarea
            id="campaign-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className={`${editFieldClass()} resize-y`}
            placeholder="What is this campaign about?"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="campaign-audience" className="block text-xs font-medium text-bb-text-3">
            TARGET AUDIENCE
          </label>
          <input
            id="campaign-audience"
            value={targetAudience}
            onChange={(e) => setTargetAudience(e.target.value)}
            className={editFieldClass()}
            placeholder="e.g. Small local businesses · Pune"
          />
        </div>

        <div className="flex flex-wrap gap-3 pt-1">
          <DashButton variant="gradient" onClick={save} disabled={saving || !name.trim()}>
            {saving ? "Saving..." : "Save changes"}
          </DashButton>
          <DashButton variant="ghost" onClick={onDone} disabled={saving}>
            Cancel
          </DashButton>
        </div>

        <p className="text-xs text-bb-text-3">
          Changing the target audience here does not rewrite this campaign&apos;s Ideal Customer Profile — Lead Discovery
          still searches using the saved ICP on the ICP tab.
        </p>
      </DarkCard>
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

const DISCOVERY_ERROR_TITLES: Record<string, string> = {
  unauthorized: "Sign-in required",
  no_icp: "No Ideal Customer Profile yet",
  already_running: "Discovery already running",
  not_configured: "Search provider not configured",
  provider_error: "Discovery run failed",
};

type LastRunOutput = {
  message?: string;
  prospectsFound?: number;
  newLeadsCreated?: number;
  duplicatesSkipped?: number;
  queriesRun?: string[];
  queriesFailed?: string[];
};

function LeadDiscoveryTab({
  campaignId,
  hasIcp,
  discovery,
}: {
  campaignId: string;
  hasIcp: boolean;
  discovery: DiscoveryState;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<LeadDiscoveryActionResult | null>(null);

  // Guards against duplicate discovery runs from a double-click, and against
  // starting a second run while the server already reports one in flight.
  const alreadyRunning = discovery.lastRun?.status === "running";

  const start = async () => {
    if (submitting || alreadyRunning) return;
    setSubmitting(true);
    setResult(null);
    try {
      setResult(await startLeadDiscoveryAction(campaignId));
    } finally {
      setSubmitting(false);
    }
  };

  if (!hasIcp) {
    return (
      <DarkEmptyState
        icon={ProspectsIcon}
        title="No Ideal Customer Profile yet"
        description="Lead Discovery searches for real prospects that match this campaign's saved ICP. Generate or save an ICP on the ICP tab first."
      />
    );
  }

  const lastRunOutput = (discovery.lastRun?.output ?? null) as LastRunOutput | null;

  return (
    <div className="max-w-3xl space-y-5">
      <DarkCard className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-bb-text-2">
            <p className="font-medium text-bb-text">Real prospect search, grounded in this campaign&apos;s ICP.</p>
            <p className="mt-1 text-bb-text-3">
              Every result is backed by an actual search result — company, source link, and the exact evidence found. Nothing
              here is invented.
            </p>
          </div>
          <DashButton variant="gradient" onClick={start} disabled={submitting || alreadyRunning}>
            <SparklesIcon className="h-3.5 w-3.5" />
            {submitting ? "Running discovery..." : alreadyRunning ? "Discovery in progress..." : "Start Discovery"}
          </DashButton>
        </div>
      </DarkCard>

      {result && !result.ok ? (
        <DarkAlert variant="error">
          <span className="font-medium">{DISCOVERY_ERROR_TITLES[result.code] ?? "Discovery failed"}.</span> {result.message}
        </DarkAlert>
      ) : null}

      {result && result.ok ? (
        <DarkCard className="border-bb-indigo/30 p-5 text-sm">
          <div className="mb-3 flex items-center gap-2 font-medium text-bb-indigo-2">
            <span className="h-2 w-2 rounded-full bg-bb-indigo" />
            {result.status === "completed" ? "Discovery completed" : "Discovery partially completed"}
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <DiscoveryStat label="Found" value={result.prospectsFound} />
            <DiscoveryStat label="New leads" value={result.newLeadsCreated} />
            <DiscoveryStat label="Duplicates skipped" value={result.duplicatesSkipped} />
          </div>
          {result.queriesFailed.length > 0 ? (
            <p className="mt-3 text-xs text-bb-amber">
              {result.queriesFailed.length} of {result.queriesRun.length + result.queriesFailed.length} search queries failed —
              results below are from the queries that succeeded.
            </p>
          ) : null}
          {result.prospects.length > 0 ? (
            <div className="mt-4 space-y-3">
              {result.prospects.map((p, i) => (
                <ProspectCard key={`${p.sourceUrl}-${i}`} prospect={p} />
              ))}
            </div>
          ) : (
            <p className="mt-3 text-bb-text-3">No new matching prospects were found this run.</p>
          )}
        </DarkCard>
      ) : null}

      {!result && discovery.lastRun ? (
        <DarkCard className="p-5 text-sm text-bb-text-2">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-medium text-bb-text">Last run:</span>
            <span className="capitalize">{discovery.lastRun.status.replace(/_/g, " ")}</span>
            {discovery.lastRun.completedAt ? <span className="text-bb-text-3">· {formatDate(discovery.lastRun.completedAt)}</span> : null}
          </div>
          {lastRunOutput?.message ? <p className="text-bb-text-3">{lastRunOutput.message}</p> : null}
          {lastRunOutput?.prospectsFound !== undefined ? (
            <div className="mt-3 grid grid-cols-3 gap-3 text-center">
              <DiscoveryStat label="Found" value={lastRunOutput.prospectsFound ?? 0} />
              <DiscoveryStat label="New leads" value={lastRunOutput.newLeadsCreated ?? 0} />
              <DiscoveryStat label="Duplicates skipped" value={lastRunOutput.duplicatesSkipped ?? 0} />
            </div>
          ) : null}
        </DarkCard>
      ) : null}

      {discovery.discoveredLeads.length > 0 ? (
        <div>
          <div className="mb-2 text-xs font-medium text-bb-text-3">DISCOVERED LEADS ({discovery.discoveredLeads.length})</div>
          <div className="space-y-3">
            {discovery.discoveredLeads.map((lead) => (
              <DiscoveredLeadCard key={lead.leadId} lead={lead} />
            ))}
          </div>
        </div>
      ) : !result && !discovery.lastRun ? (
        <DarkEmptyState
          icon={ProspectsIcon}
          title="No discovery runs yet"
          description="Start Discovery to search for real prospects matching this campaign's ICP."
        />
      ) : null}
    </div>
  );
}

function DiscoveryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-bb-navy-3 p-3">
      <div className="font-jetbrains text-sm font-semibold text-bb-text">{value}</div>
      <div className="mt-0.5 text-xs text-bb-text-3">{label}</div>
    </div>
  );
}

function normalizeHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

function ProspectCard({ prospect }: { prospect: DiscoveredProspectSummary }) {
  return (
    <div className="rounded-lg border border-bb-border bg-bb-navy p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-bb-text">{prospect.companyName}</span>
        {prospect.website ? (
          <a href={normalizeHref(prospect.website)} target="_blank" rel="noreferrer" className="text-xs text-bb-indigo-2 hover:underline">
            {prospect.website}
          </a>
        ) : null}
      </div>
      <div className="mt-1 text-xs text-bb-text-3">
        {[prospect.industry, prospect.location].filter(Boolean).join(" · ") || "No additional details found"}
      </div>
      <p className="mt-2 text-xs text-bb-text-2">&ldquo;{prospect.evidenceSnippet}&rdquo;</p>
      <a href={prospect.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-bb-indigo-2 hover:underline">
        View source →
      </a>
    </div>
  );
}

function DiscoveredLeadCard({ lead }: { lead: DiscoveredLeadRow }) {
  return (
    <Link href={`/leads/${lead.leadId}`} className="block rounded-lg border border-bb-border bg-bb-navy p-4 text-sm transition-colors hover:border-bb-indigo/30">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-bb-text">{lead.companyName ?? "Unnamed prospect"}</span>
        <span className="text-xs capitalize text-bb-text-3">{lead.leadStatus}</span>
      </div>
      <div className="mt-1 text-xs text-bb-text-3">{[lead.industry, lead.location].filter(Boolean).join(" · ") || "No additional details"}</div>
      {lead.evidenceSnippet ? <p className="mt-2 text-xs text-bb-text-2">&ldquo;{lead.evidenceSnippet}&rdquo;</p> : null}
      {lead.discoveredAt ? <p className="mt-2 text-xs text-bb-text-3">Discovered {formatDate(lead.discoveredAt)}</p> : null}
    </Link>
  );
}
