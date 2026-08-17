"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  generateLeadOutreachAction,
  quickCreateDealForLead,
  quickCreateTaskForLead,
  runLeadQualificationAction,
  runLeadResearchAction,
  updateLeadNotes,
} from "@/app/(dashboard)/leads/actions";
import type { LeadQualification } from "@/lib/ai/agents/qualification";
import type { OutreachDraft } from "@/lib/ai/agents/outreach";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkCard } from "@/components/dashboard-ui/card";
import { LeadStatusBadge, QualificationBadge, ScorePill, TaskStatusBadge, ConversationStatusBadge, DealStatusBadge } from "@/components/dashboard-ui/badge";
import { SparklesIcon } from "@/components/ui/icons";
import { formatDate } from "@/lib/format";

const TABS = ["Overview", "Company", "Research", "Conversations", "Tasks", "Deals", "Notes"] as const;

type Lead = {
  id: string;
  status: string;
  qualification_status: string;
  current_score: number | null;
  intent: string | null;
  next_action: string | null;
  notes: string | null;
  created_at: string;
};
type Contact = { id: string; full_name: string | null; email: string | null; phone: string | null; role_title: string | null; is_primary: boolean };
type Research = { id: string; summary: string | null; source: string; created_at: string };
type ConversationRow = { id: string; channel: string; status: string; created_at: string };
type TaskRow = { id: string; title: string; status: string; due_at: string | null };
type DealRow = { id: string; title: string; status: string; value: number; currency: string };

export function LeadDetailTabs({
  lead,
  leadName,
  primaryContact,
  contacts,
  companyName,
  website,
  campaignName,
  research,
  conversations,
  tasks,
  deals,
}: {
  lead: Lead;
  leadName: string;
  primaryContact: Contact | null;
  contacts: Contact[];
  companyName: string | null;
  website: string | null;
  campaignName: string | null;
  research: Research[];
  conversations: ConversationRow[];
  tasks: TaskRow[];
  deals: DealRow[];
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Overview");
  const [isPending, startTransition] = useTransition();
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [aiPending, startAiTransition] = useTransition();
  const [researchError, setResearchError] = useState<string | null>(null);
  const [qualification, setQualification] = useState<LeadQualification | { error: string } | null>(null);
  const [outreachDraft, setOutreachDraft] = useState<OutreachDraft | { error: string } | null>(null);

  function runResearch() {
    setResearchError(null);
    startAiTransition(async () => {
      const result = await runLeadResearchAction(lead.id);
      if (!result.ok) setResearchError(result.message);
    });
  }

  function runQualification() {
    startAiTransition(async () => {
      const result = await runLeadQualificationAction(lead.id);
      setQualification(result.ok ? result.qualification : { error: result.message });
    });
  }

  function runOutreach(channel: string) {
    startAiTransition(async () => {
      const result = await generateLeadOutreachAction(lead.id, channel);
      setOutreachDraft(result.ok ? result.draft : { error: result.message });
    });
  }

  return (
    <div className="bb-animate-fade-in flex flex-1 flex-col">
      <div className="border-b border-bb-border px-4 py-5 sm:px-6">
        <div className="mb-4 flex items-center gap-2 text-sm">
          <Link href="/leads" className="text-bb-text-3 hover:text-bb-text">
            Leads
          </Link>
          <span className="text-bb-border">/</span>
          <span className="text-bb-text">{leadName}</span>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-bb-indigo to-bb-violet text-xl font-bold text-white">
              {leadName[0]?.toUpperCase()}
            </div>
            <div>
              <h2 className="font-display mb-1 text-xl font-semibold text-bb-text">{leadName}</h2>
              <div className="flex flex-wrap items-center gap-3 text-sm text-bb-text-3">
                {companyName ? <span>{companyName}</span> : null}
                {primaryContact?.email ? <span>{primaryContact.email}</span> : null}
                {primaryContact?.phone ? <span>{primaryContact.phone}</span> : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <ScorePill score={lead.current_score} />
                <LeadStatusBadge status={lead.status} />
                <QualificationBadge status={lead.qualification_status} />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <DashButton
              variant="gradient"
              disabled={isPending}
              onClick={() => startTransition(() => quickCreateDealForLead(lead.id, leadName))}
            >
              Create Deal
            </DashButton>
            <DashButton
              variant="ghost"
              disabled={isPending}
              onClick={() => startTransition(() => quickCreateTaskForLead(lead.id, leadName))}
            >
              Add Task
            </DashButton>
          </div>
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
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              <DarkCard className="p-5">
                <h4 className="mb-3 border-b border-bb-border pb-3 text-sm font-semibold text-bb-text">Contact Information</h4>
                <Row label="Email" val={primaryContact?.email ?? "—"} />
                <Row label="Phone" val={primaryContact?.phone ?? "—"} />
                <Row label="Company" val={companyName ?? "—"} />
                <Row label="Campaign" val={campaignName ?? "—"} />
              </DarkCard>
              <DarkCard className="p-5">
                <div className="mb-3 flex items-center justify-between border-b border-bb-border pb-3">
                  <h4 className="text-sm font-semibold text-bb-text">Qualification</h4>
                  <DashButton variant="outline" disabled={aiPending} onClick={runQualification}>
                    {aiPending ? "Analyzing…" : "Run AI Qualification"}
                  </DashButton>
                </div>
                <Row label="Score" val={lead.current_score !== null ? String(lead.current_score) : "Not scored yet"} />
                <Row label="Qualification status" val={lead.qualification_status} />
                <Row label="Next action" val={lead.next_action ?? "—"} />
                {qualification ? (
                  "error" in qualification ? (
                    <p className="mt-3 text-xs text-bb-rose">{qualification.error}</p>
                  ) : (
                    <div className="mt-3 space-y-1.5 border-t border-bb-border pt-3 text-xs">
                      <Row label="Fit score" val={String(qualification.fitScore)} />
                      <Row label="Intent score" val={String(qualification.intentScore)} />
                      {qualification.positiveReasons.length > 0 ? (
                        <p className="text-bb-emerald">+ {qualification.positiveReasons.join("; ")}</p>
                      ) : null}
                      {qualification.negativeReasons.length > 0 ? (
                        <p className="text-bb-rose">− {qualification.negativeReasons.join("; ")}</p>
                      ) : null}
                    </div>
                  )
                ) : null}
              </DarkCard>

              <DarkCard className="p-5">
                <div className="mb-3 flex items-center justify-between border-b border-bb-border pb-3">
                  <h4 className="flex items-center gap-1.5 text-sm font-semibold text-bb-text">
                    <SparklesIcon className="h-4 w-4 text-bb-indigo" /> AI Outreach Draft
                  </h4>
                  <DashButton variant="outline" disabled={aiPending} onClick={() => runOutreach("email")}>
                    Generate
                  </DashButton>
                </div>
                {!outreachDraft ? (
                  <p className="text-sm text-bb-text-3">
                    Drafts a personalized message from real research and qualification on file. Never sent automatically.
                  </p>
                ) : "error" in outreachDraft ? (
                  <p className="text-sm text-bb-rose">{outreachDraft.error}</p>
                ) : (
                  <div className="space-y-2 text-sm">
                    {outreachDraft.subject ? <div className="font-medium text-bb-text">{outreachDraft.subject}</div> : null}
                    <p className="whitespace-pre-wrap rounded-lg bg-bb-navy-3 p-3 text-bb-text-2">{outreachDraft.message}</p>
                    <p className="text-xs text-bb-text-3">Draft only — copy and send manually; no channel is connected yet.</p>
                  </div>
                )}
              </DarkCard>
            </div>
            <DarkCard className="p-5">
              <h4 className="mb-3 text-sm font-semibold text-bb-text">Intent</h4>
              <div className="py-2 text-center">
                <div className="font-display mb-1 text-2xl font-semibold text-bb-indigo-2">{lead.intent ?? "Unknown"}</div>
                <p className="text-xs text-bb-text-3">Detected from conversations, when available.</p>
              </div>
            </DarkCard>
          </div>
        ) : null}

        {tab === "Company" ? (
          <div className="max-w-2xl space-y-4">
            <DarkCard className="p-5">
              <Row label="Company" val={companyName ?? "—"} />
              <Row label="Website" val={website ?? "—"} />
            </DarkCard>
            <DarkCard className="p-5">
              <h4 className="mb-3 text-sm font-semibold text-bb-text">Contacts</h4>
              {contacts.length === 0 ? (
                <p className="text-sm text-bb-text-3">No contacts recorded yet.</p>
              ) : (
                <div className="space-y-3">
                  {contacts.map((c) => (
                    <div key={c.id} className="flex items-center justify-between border-b border-bb-border/50 pb-2 last:border-0">
                      <div>
                        <div className="text-sm font-medium text-bb-text">{c.full_name ?? "Unnamed"}</div>
                        <div className="text-xs text-bb-text-3">
                          {c.role_title ?? "—"} · {c.email ?? "no email"}
                        </div>
                      </div>
                      {c.is_primary ? <span className="text-xs text-bb-indigo-2">Primary</span> : null}
                    </div>
                  ))}
                </div>
              )}
            </DarkCard>
          </div>
        ) : null}

        {tab === "Research" ? (
          <div className="max-w-2xl space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-bb-text-3">
                Reasons over information already on file for this lead — no web access, nothing fabricated.
              </p>
              <DashButton variant="outline" disabled={aiPending} onClick={runResearch}>
                {aiPending ? "Researching…" : "Run AI Research"}
              </DashButton>
            </div>
            {researchError ? <p className="text-xs text-bb-rose">{researchError}</p> : null}
            {research.length === 0 ? (
              <p className="py-16 text-center text-sm text-bb-text-3">No research recorded for this lead yet.</p>
            ) : (
              research.map((r) => (
                <DarkCard key={r.id} className="p-4">
                  <div className="mb-1 flex items-center justify-between text-xs text-bb-text-3">
                    <span className="capitalize">{r.source}</span>
                    <span>{formatDate(r.created_at)}</span>
                  </div>
                  <p className="text-sm text-bb-text-2">{r.summary ?? "No summary."}</p>
                </DarkCard>
              ))
            )}
          </div>
        ) : null}

        {tab === "Conversations" ? (
          conversations.length === 0 ? (
            <p className="py-16 text-center text-sm text-bb-text-3">No conversations with this lead yet.</p>
          ) : (
            <div className="space-y-2">
              {conversations.map((c) => (
                <Link
                  key={c.id}
                  href={`/conversations/${c.id}`}
                  className="flex items-center justify-between rounded-xl border border-bb-border bg-bb-navy-2 p-4 transition-colors hover:border-bb-indigo/30"
                >
                  <span className="text-sm capitalize text-bb-text">{c.channel}</span>
                  <ConversationStatusBadge status={c.status} />
                  <span className="text-xs text-bb-text-3">{formatDate(c.created_at)}</span>
                </Link>
              ))}
            </div>
          )
        ) : null}

        {tab === "Tasks" ? (
          tasks.length === 0 ? (
            <p className="py-16 text-center text-sm text-bb-text-3">No tasks for this lead yet.</p>
          ) : (
            <div className="space-y-2">
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

        {tab === "Deals" ? (
          deals.length === 0 ? (
            <p className="py-16 text-center text-sm text-bb-text-3">No deals for this lead yet.</p>
          ) : (
            <div className="space-y-2">
              {deals.map((d) => (
                <Link
                  key={d.id}
                  href={`/deals/${d.id}`}
                  className="flex items-center justify-between rounded-xl border border-bb-border bg-bb-navy-2 p-4 transition-colors hover:border-bb-indigo/30"
                >
                  <span className="text-sm font-medium text-bb-text">{d.title}</span>
                  <DealStatusBadge status={d.status} />
                </Link>
              ))}
            </div>
          )
        ) : null}

        {tab === "Notes" ? (
          <form
            action={(formData) => updateLeadNotes(lead.id, formData)}
            className="max-w-2xl space-y-3"
          >
            <textarea
              name="notes"
              rows={8}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Write notes about this lead..."
              className="w-full resize-none rounded-lg border border-bb-border bg-bb-navy-2 px-4 py-3 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo"
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

function Row({ label, val }: { label: string; val: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-bb-text-3">{label}</span>
      <span className="text-sm text-bb-text-2">{val}</span>
    </div>
  );
}
