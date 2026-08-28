"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  markDealLost,
  markDealWon,
  runDealAgentAction,
  runLossAnalysisAction,
  updateDeal,
  updateDealNotes,
  updateDealStage,
} from "@/app/(dashboard)/deals/actions";
import type { DealRecommendation } from "@/lib/ai/agents/deal-agent";
import type { LossAnalysis } from "@/lib/ai/agents/loss-analysis";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkAlert } from "@/components/dashboard-ui/alert";
import { DarkCard } from "@/components/dashboard-ui/card";
import { DealStatusBadge, ConversationStatusBadge, TaskStatusBadge } from "@/components/dashboard-ui/badge";
import { SparklesIcon } from "@/components/ui/icons";
import { DEAL_STAGE_LABELS, OPEN_DEAL_STAGES, isClosedDealStage } from "@/lib/deals";
import { formatCurrency, formatDate } from "@/lib/format";

const TABS = ["Overview", "Conversation", "Tasks", "Timeline", "Loss Analysis", "Notes"] as const;
const LOSS_REASONS = ["Price", "Timing", "Competitor", "No Budget", "Poor Fit", "No Response", "Other"];

type Deal = {
  id: string;
  title: string;
  status: string;
  value: number;
  currency: string;
  probability: number | null;
  expected_close_date: string | null;
  loss_reason: string | null;
  notes: string | null;
  lead_id: string | null;
  campaign_id: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  created_at: string;
};
type ConversationRow = { id: string; channel: string; status: string } | null;
type ContactRow = { full_name: string | null; email: string | null; phone: string | null; role_title: string | null } | null | undefined;
type TaskRow = { id: string; title: string; status: string; due_at: string | null };
type EventRow = { id: string; event_type: string; created_at: string };
type LossAnalysisRow = { id: string; reason_category: string | null; summary: string | null; created_at: string } | null | undefined;

export function DealDetailTabs({
  deal,
  customerName,
  campaignName,
  conversation,
  contact,
  companyName,
  website,
  tasks,
  events,
  lossAnalysis,
}: {
  deal: Deal;
  customerName: string;
  campaignName: string | null;
  conversation: ConversationRow;
  contact: ContactRow;
  companyName: string | null;
  website: string | null;
  tasks: TaskRow[];
  events: EventRow[];
  lossAnalysis: LossAnalysisRow;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [isPending, startTransition] = useTransition();
  const [closeError, setCloseError] = useState<string | null>(null);
  const [selectedReason, setSelectedReason] = useState(deal.loss_reason ?? "");
  const [aiPending, startAiTransition] = useTransition();
  const [recommendation, setRecommendation] = useState<DealRecommendation | { error: string } | null>(null);
  const [lossAnalysisResult, setLossAnalysisResult] = useState<LossAnalysis | { error: string } | null>(null);
  const [stagePending, startStageTransition] = useTransition();
  const [stageError, setStageError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(deal.notes ?? "");
  const isClosed = isClosedDealStage(deal.status);

  function moveStage(stage: string) {
    setStageError(null);
    startStageTransition(async () => {
      const result = await updateDealStage(deal.id, stage);
      if (!result.ok) setStageError(result.message);
    });
  }

  function runDealAgent() {
    startAiTransition(async () => {
      const result = await runDealAgentAction(deal.id);
      setRecommendation(result.ok ? result.recommendation : { error: result.message });
    });
  }

  function runAiLossAnalysis() {
    startAiTransition(async () => {
      const result = await runLossAnalysisAction(deal.id);
      setLossAnalysisResult(result.ok ? result.analysis : { error: result.message });
    });
  }

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col">
      <div className="border-b border-bb-border px-4 py-5 sm:px-6">
        <div className="mb-4 flex items-center gap-2 text-sm">
          <Link href="/deals" className="text-bb-text-3 hover:text-bb-text">
            Deals
          </Link>
          <span className="text-bb-border">/</span>
          <span className="text-bb-text">{deal.title}</span>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <h2 className="font-display text-xl font-semibold text-bb-text">{deal.title}</h2>
              <DealStatusBadge status={deal.status} />
            </div>
            <div className="text-sm text-bb-text-3">
              {customerName}
              {companyName ? ` · ${companyName}` : ""}
              {campaignName ? ` · via ${campaignName}` : ""}
            </div>
          </div>
          <div className="flex gap-2">
            <DashButton variant="ghost" onClick={() => setEditing((e) => !e)}>
              {editing ? "Cancel Edit" : "Edit Deal"}
            </DashButton>
            {!isClosed ? (
              <>
                <DashButton
                  variant="ghost"
                  className="border-bb-emerald/30 text-bb-emerald hover:bg-bb-emerald/10"
                  disabled={isPending}
                  onClick={() =>
                    startTransition(async () => {
                      setCloseError(null);
                      const result = await markDealWon(deal.id);
                      if (!result.ok) setCloseError(result.message);
                    })
                  }
                >
                  Mark Won
                </DashButton>
                <DashButton variant="danger" disabled={isPending} onClick={() => setTab("Loss Analysis")}>
                  Mark Lost
                </DashButton>
              </>
            ) : null}
          </div>
        </div>

        {closeError ? (
          <div className="mt-3">
            <DarkAlert variant="error">{closeError}</DarkAlert>
          </div>
        ) : null}

        {!isClosed ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-bb-text-3">Stage:</span>
            {OPEN_DEAL_STAGES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={stagePending || deal.status === s}
                onClick={() => moveStage(s)}
                className={`bb-press rounded-lg border px-3 py-1.5 text-xs font-medium transition-all disabled:cursor-default ${
                  deal.status === s
                    ? "border-bb-indigo bg-bb-indigo/20 text-bb-indigo-2"
                    : "border-bb-border bg-bb-navy-3 text-bb-text-3 hover:bg-bb-navy-4"
                }`}
              >
                {DEAL_STAGE_LABELS[s]}
              </button>
            ))}
          </div>
        ) : null}
        {stageError ? <p className="mt-2 text-xs text-bb-rose">{stageError}</p> : null}

        {editing ? (
          <div className="mt-4">
            <DealEditForm deal={deal} onDone={() => setEditing(false)} />
          </div>
        ) : null}

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Value", val: formatCurrency(deal.value, deal.currency) },
            { label: "Probability", val: deal.probability !== null ? `${deal.probability}%` : "—" },
            { label: "Expected Close", val: formatDate(deal.expected_close_date) },
            { label: "Created", val: formatDate(deal.created_at) },
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
          <div className="max-w-2xl space-y-4">
            <DarkCard className="p-5">
              <h4 className="mb-4 border-b border-bb-border pb-3 text-sm font-semibold text-bb-text">Acquisition Path</h4>
              <div className="flex flex-wrap items-center gap-2 text-sm text-bb-text-3">
                {["Campaign", "→", "Lead", "→", "Conversation", "→", "Deal"].map((s, i) => (
                  <span key={i} className={s === "→" ? "text-bb-border" : "text-bb-text-2"}>
                    {s}
                  </span>
                ))}
              </div>
              {campaignName ? <div className="mt-3 text-xs text-bb-text-3">Campaign: <span className="text-bb-text-2">{campaignName}</span></div> : null}
            </DarkCard>

            <DarkCard className="p-5">
              <div className="mb-4 flex items-center justify-between border-b border-bb-border pb-3">
                <h4 className="text-sm font-semibold text-bb-text">Company &amp; Contact</h4>
                {deal.lead_id ? (
                  <Link href={`/leads/${deal.lead_id}`} className="text-xs text-bb-indigo-2 hover:underline">
                    View Lead →
                  </Link>
                ) : null}
              </div>
              <div className="space-y-1.5 text-sm">
                <Row label="Company" val={companyName ?? "—"} />
                {website ? <Row label="Website" val={website} /> : null}
                <Row label="Contact" val={contact?.full_name ?? customerName} />
                {contact?.role_title ? <Row label="Role" val={contact.role_title} /> : null}
                <Row label="Email" val={contact?.email ?? "—"} />
                <Row label="Phone" val={contact?.phone ?? "—"} />
              </div>
            </DarkCard>

            <DarkCard className="p-5">
              <div className="mb-4 flex items-center justify-between border-b border-bb-border pb-3">
                <h4 className="flex items-center gap-1.5 text-sm font-semibold text-bb-text">
                  <SparklesIcon className="h-4 w-4 text-bb-indigo" /> AI Deal Agent
                </h4>
                <DashButton variant="outline" disabled={aiPending} onClick={runDealAgent}>
                  {aiPending ? "Analyzing…" : "Analyze Deal"}
                </DashButton>
              </div>
              {!recommendation ? (
                <p className="text-sm text-bb-text-3">
                  Analyzes this deal&apos;s conversation to recommend a next action. Never changes the deal&apos;s status itself.
                </p>
              ) : "error" in recommendation ? (
                <p className="text-sm text-bb-rose">{recommendation.error}</p>
              ) : (
                <div className="space-y-2 text-sm">
                  <Row label="Negotiation state" val={recommendation.negotiationState} />
                  <Row label="Closing readiness" val={recommendation.closingReadiness} />
                  <Row label="Decision maker" val={recommendation.decisionMakerStatus.replaceAll("_", " ")} />
                  {recommendation.objections.length > 0 ? <Row label="Objections" val={recommendation.objections.join(", ")} /> : null}
                  <p className="mt-2 rounded-lg bg-bb-navy-3 p-3 text-bb-indigo-2">{recommendation.recommendedNextAction}</p>
                </div>
              )}
            </DarkCard>
          </div>
        ) : null}

        {tab === "Conversation" ? (
          conversation ? (
            <Link
              href={`/conversations/${conversation.id}`}
              className="flex max-w-2xl items-center justify-between rounded-xl border border-bb-border bg-bb-navy-2 p-4 transition-colors hover:border-bb-indigo/30"
            >
              <span className="text-sm capitalize text-bb-text">{conversation.channel}</span>
              <ConversationStatusBadge status={conversation.status} />
            </Link>
          ) : (
            <p className="py-16 text-center text-sm text-bb-text-3">No conversation linked to this deal&apos;s lead yet.</p>
          )
        ) : null}

        {tab === "Tasks" ? (
          tasks.length === 0 ? (
            <p className="py-16 text-center text-sm text-bb-text-3">No tasks for this deal yet.</p>
          ) : (
            <div className="max-w-2xl space-y-2">
              {tasks.map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-xl border border-bb-border bg-bb-navy-2 p-4">
                  <span className="text-sm text-bb-text">{t.title}</span>
                  <TaskStatusBadge status={t.status} />
                  <span className="text-xs text-bb-text-3">Due {formatDate(t.due_at)}</span>
                </div>
              ))}
            </div>
          )
        ) : null}

        {tab === "Timeline" ? (
          events.length === 0 ? (
            <p className="py-16 text-center text-sm text-bb-text-3">No timeline events recorded yet.</p>
          ) : (
            <div className="max-w-2xl space-y-3">
              {events.map((e) => (
                <div key={e.id} className="flex items-center gap-3 border-b border-bb-border/50 pb-3 last:border-0">
                  <div className="h-1.5 w-1.5 rounded-full bg-bb-indigo" />
                  <div className="flex-1">
                    <div className="text-sm capitalize text-bb-text-2">{e.event_type.replaceAll("_", " ")}</div>
                    <div className="text-xs text-bb-text-3">{formatDate(e.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : null}

        {tab === "Loss Analysis" ? (
          <div className="max-w-2xl space-y-5">
            <DarkCard className="p-5">
              <h4 className="mb-3 text-sm font-semibold text-bb-text">Loss Reason</h4>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {LOSS_REASONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => setSelectedReason(r)}
                    className={`rounded-lg border py-2 text-xs font-medium transition-all ${
                      selectedReason === r ? "border-bb-indigo bg-bb-indigo/15 text-bb-indigo-2" : "border-bb-border bg-bb-navy text-bb-text-3 hover:border-bb-indigo/40"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              {lossAnalysis ? (
                <p className="mt-4 text-xs text-bb-text-3">
                  Recorded reason: <span className="text-bb-text-2">{lossAnalysis.reason_category}</span> on {formatDate(lossAnalysis.created_at)}
                </p>
              ) : null}
            </DarkCard>
            {closeError ? <DarkAlert variant="error">{closeError}</DarkAlert> : null}

            {deal.status !== "lost" ? (
              <DashButton
                variant="danger"
                disabled={isPending || !selectedReason}
                onClick={() =>
                  startTransition(async () => {
                    setCloseError(null);
                    const result = await markDealLost(deal.id, selectedReason);
                    if (!result.ok) setCloseError(result.message);
                  })
                }
              >
                Mark Deal Lost
              </DashButton>
            ) : null}

            {deal.status === "lost" ? (
              <DarkCard className="p-5">
                <div className="mb-4 flex items-center justify-between border-b border-bb-border pb-3">
                  <h4 className="flex items-center gap-1.5 text-sm font-semibold text-bb-text">
                    <SparklesIcon className="h-4 w-4 text-bb-indigo" /> AI Loss Analysis
                  </h4>
                  <DashButton variant="outline" disabled={aiPending} onClick={runAiLossAnalysis}>
                    {aiPending ? "Analyzing…" : "Run AI Analysis"}
                  </DashButton>
                </div>
                {!lossAnalysisResult ? (
                  <p className="text-sm text-bb-text-3">
                    Analyzes this deal&apos;s record and conversation to explain why it was lost and suggest changes.
                  </p>
                ) : "error" in lossAnalysisResult ? (
                  <p className="text-sm text-bb-rose">{lossAnalysisResult.error}</p>
                ) : (
                  <div className="space-y-3 text-sm">
                    <Row label="Primary reason" val={lossAnalysisResult.primaryReason.replaceAll("_", " ")} />
                    <p className="text-bb-text-2">{lossAnalysisResult.summary}</p>
                    <p className="text-xs text-bb-text-3">Root cause: {lossAnalysisResult.rootCause}</p>
                    {lossAnalysisResult.lessons.length > 0 ? (
                      <p className="text-xs text-bb-text-3">Lessons: {lossAnalysisResult.lessons.join("; ")}</p>
                    ) : null}
                    {lossAnalysisResult.recommendedCampaignChanges.length > 0 ? (
                      <p className="text-xs text-bb-indigo-2">
                        Campaign changes: {lossAnalysisResult.recommendedCampaignChanges.join("; ")}
                      </p>
                    ) : null}
                  </div>
                )}
              </DarkCard>
            ) : null}
          </div>
        ) : null}

        {tab === "Notes" ? (
          <form
            action={async (formData) => {
              await updateDealNotes(deal.id, formData);
            }}
            className="max-w-2xl space-y-3"
          >
            <textarea
              name="notes"
              rows={12}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Write notes about this deal..."
              className="w-full resize-y rounded-lg border border-bb-border bg-bb-navy px-4 py-3 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo"
            />
            <DashButton type="submit" variant="gradient">
              Save Notes
            </DashButton>
          </form>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Edits a deal's own core fields. Deliberately excludes stage (the segmented
 * control above owns that) and notes (its own tab) — this only touches what
 * updateDeal accepts.
 */
function DealEditForm({ deal, onDone }: { deal: Deal; onDone: () => void }) {
  const [title, setTitle] = useState(deal.title);
  const [value, setValue] = useState(String(deal.value));
  const [currency, setCurrency] = useState(deal.currency);
  const [expectedCloseDate, setExpectedCloseDate] = useState(deal.expected_close_date ?? "");
  const [probability, setProbability] = useState(deal.probability !== null ? String(deal.probability) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await updateDeal(deal.id, {
      title,
      value: Number(value) || 0,
      currency,
      expectedCloseDate: expectedCloseDate || null,
      probability: probability.trim() ? Number(probability) : null,
    });
    setSaving(false);
    if (result.ok) {
      onDone();
    } else {
      setError(result.message);
    }
  };

  return (
    <DarkCard className="max-w-2xl space-y-4 p-5">
      {error ? <DarkAlert variant="error">{error}</DarkAlert> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="deal-title" className="block text-xs font-medium text-bb-text-3">
            DEAL TITLE
          </label>
          <input id="deal-title" value={title} onChange={(e) => setTitle(e.target.value)} className={editFieldClass()} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="deal-value" className="block text-xs font-medium text-bb-text-3">
            VALUE
          </label>
          <input id="deal-value" type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} className={editFieldClass()} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="deal-currency" className="block text-xs font-medium text-bb-text-3">
            CURRENCY
          </label>
          <input id="deal-currency" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} className={editFieldClass()} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="deal-close-date" className="block text-xs font-medium text-bb-text-3">
            EXPECTED CLOSE DATE
          </label>
          <input
            id="deal-close-date"
            type="date"
            value={expectedCloseDate}
            onChange={(e) => setExpectedCloseDate(e.target.value)}
            className={editFieldClass()}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="deal-probability" className="block text-xs font-medium text-bb-text-3">
            PROBABILITY (%)
          </label>
          <input
            id="deal-probability"
            type="number"
            min="0"
            max="100"
            value={probability}
            onChange={(e) => setProbability(e.target.value)}
            className={editFieldClass()}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-3 pt-1">
        <DashButton variant="gradient" onClick={save} disabled={saving || !title.trim()}>
          {saving ? "Saving..." : "Save changes"}
        </DashButton>
        <DashButton variant="ghost" onClick={onDone} disabled={saving}>
          Cancel
        </DashButton>
      </div>
    </DarkCard>
  );
}

function editFieldClass() {
  return "w-full rounded-lg border border-bb-border bg-bb-navy px-4 py-2.5 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo";
}

function Row({ label, val }: { label: string; val: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="shrink-0 text-xs text-bb-text-3">{label}</span>
      <span className="text-right text-sm text-bb-text-2">{val}</span>
    </div>
  );
}
