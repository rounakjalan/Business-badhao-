"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  updateCampaign,
  updateCampaignStatus,
  startLeadDiscoveryAction,
  getLeadDiscoveryProgressAction,
  type DiscoveryProgress,
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

export type LeadStatusCounts = {
  pending: number;
  qualifying: number;
  qualified: number;
  disqualified: number;
};

export function CampaignDetailTabs({
  campaign,
  icp,
  leadCount,
  scoredCount,
  leadStatusCounts,
  conversations,
  deals,
  revenue,
  discovery,
  discoveryConfigured,
}: {
  campaign: Campaign;
  /** Raw jsonb from ideal_customer_profiles.criteria — validated below, since campaigns created before the ICP step shipped store the old plan-derived shape. */
  icp: unknown;
  leadCount: number;
  /** Leads that have been through qualification — anything not still "pending". */
  scoredCount: number;
  leadStatusCounts: LeadStatusCounts;
  conversations: ConversationRow[];
  deals: DealRow[];
  revenue: number;
  discovery: DiscoveryState;
  /** getDiscoveryProvider().isConfigured() — whether a real search provider (TAVILY_API_KEY) is actually connected. */
  discoveryConfigured: boolean;
}) {
  const parsedIcp = icp ? IcpSchema.safeParse(icp) : null;

  // criteria defaults to an empty object, and {} is truthy — so a plain
  // Boolean(icp) offered Start Discovery on a campaign the server would
  // then reject with no_icp. Match what startLeadDiscoveryAction actually
  // requires: an object with something in it.
  const hasUsableIcp = Boolean(icp && typeof icp === "object" && Object.keys(icp as object).length > 0);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const router = useRouter();

  // Discovery tracking lives here rather than in the Lead Discovery tab,
  // because a run outlives the tab that started it and the user may well be
  // looking at Overview when it finishes. Kept at page level, the tab strip
  // can flag a run in flight from any tab, and polling is not torn down
  // just because the user clicked away.
  const [discoveryResult, setDiscoveryResult] = useState<LeadDiscoveryActionResult | null>(null);
  const [progress, setProgress] = useState<DiscoveryProgress | null>(null);
  const [justFinished, setJustFinished] = useState(false);

  // Whether a run is in flight is a fact about the server, not this
  // component — so it is read from the last run's status and refreshed by
  // polling. Correct after a reload, in a second tab, or on another device.
  const liveStatus = progress?.status ?? discovery.lastRun?.status ?? null;
  const isDiscoveryRunning = liveStatus === "running";

  const startDiscovery = () => {
    if (isDiscoveryRunning) return;
    setDiscoveryResult(null);
    setJustFinished(false);
    requestNotificationPermission();
    // Deliberately not awaited: the run continues server-side regardless of
    // this tab, so blocking the UI on it would make a closed tab look like
    // a cancelled run. Only an immediate refusal is surfaced from here; the
    // outcome comes from polling.
    void startLeadDiscoveryAction(campaign.id).then((r) => {
      if (!r.ok) setDiscoveryResult(r);
    });
    setProgress((p) => ({
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      leadsCreated: p?.leadsCreated ?? 0,
      researched: p?.researched ?? 0,
      scored: p?.scored ?? 0,
      followUp: null,
      message: null,
    }));
  };

  useEffect(() => {
    if (!isDiscoveryRunning) return;

    let cancelled = false;
    const tick = async () => {
      const next = await getLeadDiscoveryProgressAction(campaign.id);
      if (cancelled) return;
      setProgress(next);
      if (next.status && next.status !== "running") {
        setJustFinished(true);
        notifyDiscoveryFinished(next);
        router.refresh();
      }
    };

    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isDiscoveryRunning, campaign.id, router]);

  const setStatus = async (status: "active" | "paused" | "completed" | "archived") => {
    setPending(true);
    setStatusError(null);
    const result = await updateCampaignStatus(campaign.id, status);
    setPending(false);
    if (!result.ok) setStatusError(result.message);
  };

  // A campaign starts as "draft" (or "planning" from the older wizard).
  // Those need a way to go live directly — previously the only control was
  // a pause/resume toggle, so launching a draft meant pausing it first and
  // then resuming, which made no sense. "completed" and "archived" were
  // unreachable entirely despite the campaigns list offering filters for
  // them.
  const notYetLive = campaign.status === "draft" || campaign.status === "planning";
  const isClosed = campaign.status === "completed" || campaign.status === "archived";

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
            {notYetLive ? (
              <DashButton variant="ghost" onClick={() => setStatus("active")} disabled={pending}>
                Launch Campaign
              </DashButton>
            ) : campaign.status === "paused" ? (
              <DashButton variant="ghost" onClick={() => setStatus("active")} disabled={pending}>
                Resume Campaign
              </DashButton>
            ) : campaign.status === "active" ? (
              <DashButton variant="ghost" onClick={() => setStatus("paused")} disabled={pending}>
                Pause Campaign
              </DashButton>
            ) : null}

            {campaign.status === "active" || campaign.status === "paused" ? (
              <DashButton variant="ghost" onClick={() => setStatus("completed")} disabled={pending}>
                Mark Complete
              </DashButton>
            ) : null}

            {campaign.status === "completed" ? (
              <DashButton variant="ghost" onClick={() => setStatus("archived")} disabled={pending}>
                Archive
              </DashButton>
            ) : null}

            {isClosed ? (
              <DashButton variant="ghost" onClick={() => setStatus("active")} disabled={pending}>
                Reopen
              </DashButton>
            ) : null}

            <DashButton variant="gradient" onClick={() => setTab("Lead Discovery")}>
              Find Leads
            </DashButton>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Leads", val: leadCount },
            { label: "Scored", val: scoredCount },
            { label: "Conversations", val: conversations.length },
            { label: "Revenue", val: revenue > 0 ? formatCurrency(revenue, "INR") : "—" },
          ].map((m) => (
            <div key={m.label} className="rounded-lg bg-bb-navy-3 p-3 text-center">
              <div className="mb-1 text-xs text-bb-text-3">{m.label}</div>
              <div className="font-jetbrains text-sm font-semibold text-bb-text">{m.val}</div>
            </div>
          ))}
        </div>

        {statusError ? (
          <div className="mt-3">
            <DarkAlert variant="error">{statusError}</DarkAlert>
          </div>
        ) : null}

        {leadCount > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-bb-text-3">
            {(
              [
                { key: "qualified", label: "Qualified" },
                { key: "qualifying", label: "Qualifying" },
                { key: "disqualified", label: "Disqualified" },
                { key: "pending", label: "Not yet scored" },
              ] as const
            ).map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className="font-jetbrains font-semibold text-bb-text-2">{leadStatusCounts[s.key]}</span>
                {s.label}
              </span>
            ))}
          </div>
        ) : null}
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
            {t === "Lead Discovery" && isDiscoveryRunning ? (
              <span className="ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-bb-indigo align-middle" />
            ) : null}
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

        {tab === "Lead Discovery" ? (
          <LeadDiscoveryTab
            hasIcp={hasUsableIcp}
            discoveryConfigured={discoveryConfigured}
            discovery={discovery}
            isRunning={isDiscoveryRunning}
            progress={progress}
            justFinished={justFinished}
            result={discoveryResult}
            onStart={startDiscovery}
          />
        ) : null}

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
              onRowClick={(c) => router.push(`/conversations/${c.id}`)}
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
              onRowClick={(d) => router.push(`/deals/${d.id}`)}
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

/**
 * Tells the user a run finished when they are not looking at this tab.
 * A discovery run takes minutes, so the realistic case is that they went
 * elsewhere — a browser notification is the only way to reach them there.
 *
 * Entirely best-effort: no permission is ever requested here, and nothing
 * breaks where the API is missing, blocked, or denied. The page itself
 * always shows the outcome regardless.
 */
function notifyDiscoveryFinished(progress: DiscoveryProgress) {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted") return;
    if (typeof document !== "undefined" && document.visibilityState === "visible") return;

    const leads = progress.followUp
      ? (progress.followUp.researchSucceeded ?? 0)
      : progress.scored;
    new Notification("Lead discovery finished", {
      body:
        progress.status === "failed"
          ? "The run did not complete. Open the campaign to see why."
          : `${progress.leadsCreated} leads found, ${leads} researched and scored.`,
      tag: "bb-lead-discovery",
    });
  } catch {
    // A notification is a courtesy — never let it interfere with the page.
  }
}

/** Asked for only when the user starts a run, so the prompt has obvious context. */
function requestNotificationPermission() {
  try {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") void Notification.requestPermission();
  } catch {
    // Ignore: some browsers throw on the promise-less legacy signature.
  }
}

const DISCOVERY_ERROR_TITLES: Record<string, string> = {
  unauthorized: "Sign-in required",
  no_icp: "No Ideal Customer Profile yet",
  already_running: "Discovery already running",
  not_configured: "Search provider not configured",
  provider_error: "Discovery run failed",
};

type FollowUpSummary = {
  researchAttempted?: number;
  researchSucceeded?: number;
  researchFailed?: number;
  qualified?: number;
  disqualified?: number;
  qualifying?: number;
  deferred?: number;
};

type LastRunOutput = {
  message?: string;
  prospectsFound?: number;
  newLeadsCreated?: number;
  duplicatesSkipped?: number;
  queriesRun?: string[];
  queriesFailed?: string[];
  followUp?: FollowUpSummary;
};

/**
 * What happened to the leads a run created, after they were saved. Without
 * this the run reports only how many leads it found, so leads left
 * unresearched because the run ran out of time budget are invisible — they
 * just sit at "pending" with nothing explaining why.
 */
function FollowUpSummaryView({ followUp }: { followUp: FollowUpSummary }) {
  const researched = followUp.researchSucceeded ?? 0;
  const researchFailed = followUp.researchFailed ?? 0;
  const deferred = followUp.deferred ?? 0;

  return (
    <div className="mt-4 border-t border-bb-border pt-3">
      <div className="mb-2 text-xs font-medium text-bb-text-3">AFTER DISCOVERY</div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-bb-text-3">
        <span className="flex items-center gap-1.5">
          <span className="font-jetbrains font-semibold text-bb-text-2">{researched}</span> researched
        </span>
        <span className="flex items-center gap-1.5">
          <span className="font-jetbrains font-semibold text-bb-text-2">{followUp.qualified ?? 0}</span> qualified
        </span>
        <span className="flex items-center gap-1.5">
          <span className="font-jetbrains font-semibold text-bb-text-2">{followUp.qualifying ?? 0}</span> qualifying
        </span>
        <span className="flex items-center gap-1.5">
          <span className="font-jetbrains font-semibold text-bb-text-2">{followUp.disqualified ?? 0}</span> disqualified
        </span>
      </div>

      {deferred > 0 ? (
        <p className="mt-2 text-xs text-bb-amber">
          {deferred} {deferred === 1 ? "lead was" : "leads were"} saved but not researched — this run reached its time
          limit. {deferred === 1 ? "It is" : "They are"} waiting under Discovered Leads below; open{" "}
          {deferred === 1 ? "it" : "any of them"} and use Run Research, then Run Qualification.
        </p>
      ) : null}

      {researchFailed > 0 ? (
        <p className="mt-2 text-xs text-bb-amber">
          Research failed for {researchFailed} {researchFailed === 1 ? "lead" : "leads"}, so {researchFailed === 1 ? "it was" : "they were"}{" "}
          left unscored rather than judged on search results alone. You can retry from the lead&apos;s page.
        </p>
      ) : null}
    </div>
  );
}

function LeadDiscoveryTab({
  hasIcp,
  discoveryConfigured,
  discovery,
  isRunning,
  progress,
  justFinished,
  result,
  onStart,
}: {
  hasIcp: boolean;
  discoveryConfigured: boolean;
  discovery: DiscoveryState;
  isRunning: boolean;
  progress: DiscoveryProgress | null;
  justFinished: boolean;
  result: LeadDiscoveryActionResult | null;
  onStart: () => void;
}) {
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
          <DashButton variant="gradient" onClick={onStart} disabled={isRunning || !discoveryConfigured}>
            <SparklesIcon className="h-3.5 w-3.5" />
            {isRunning ? "Discovery running..." : "Start Discovery"}
          </DashButton>
        </div>
      </DarkCard>

      {!discoveryConfigured ? (
        <DarkAlert variant="error">
          <span className="font-medium">Search provider not configured.</span> Lead Discovery needs TAVILY_API_KEY set in the
          environment before it can search for real prospects.
        </DarkAlert>
      ) : null}

      {isRunning ? (
        <DarkCard className="border-bb-indigo/30 p-5 text-sm">
          <div className="flex items-center gap-2 font-medium text-bb-indigo-2">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-bb-indigo/30 border-t-bb-indigo" />
            Discovery is running
          </div>
          <p className="mt-2 text-xs text-bb-text-3">
            This keeps running on our servers — you can close this tab or shut your laptop and it will finish. Come back
            here any time to see how it went.
          </p>
          {progress && progress.leadsCreated > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-bb-text-3">
              <span className="flex items-center gap-1.5">
                <span className="font-jetbrains font-semibold text-bb-text-2">{progress.leadsCreated}</span> leads found
              </span>
              <span className="flex items-center gap-1.5">
                <span className="font-jetbrains font-semibold text-bb-text-2">{progress.researched}</span> researched
              </span>
              <span className="flex items-center gap-1.5">
                <span className="font-jetbrains font-semibold text-bb-text-2">{progress.scored}</span> scored
              </span>
            </div>
          ) : (
            <p className="mt-3 text-xs text-bb-text-3">Searching for prospects…</p>
          )}
        </DarkCard>
      ) : null}

      {justFinished && progress && !isRunning ? (
        <DarkAlert variant={progress.status === "failed" ? "error" : "success"}>
          {progress.status === "failed"
            ? progress.message ?? "The discovery run did not complete."
            : `Discovery finished — ${progress.leadsCreated} leads found, ${progress.scored} researched and scored.`}
        </DarkAlert>
      ) : null}

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
          {result.followUp ? <FollowUpSummaryView followUp={result.followUp} /> : null}
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
          {lastRunOutput?.followUp ? <FollowUpSummaryView followUp={lastRunOutput.followUp} /> : null}
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
