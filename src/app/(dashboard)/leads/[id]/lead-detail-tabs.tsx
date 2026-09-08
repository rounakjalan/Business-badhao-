"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import {
  addContactForLead,
  findLeadContactAction,
  generateLeadOutreachAction,
  quickCreateDealForLead,
  quickCreateTaskForLead,
  runLeadQualificationAction,
  runLeadResearchAction,
  sendLeadOutreachAction,
  updateLeadNotes,
  type SendOutreachResult,
} from "@/app/(dashboard)/leads/actions";
import type { LeadQualification } from "@/lib/ai/agents/qualification";
import type { OutreachDraft } from "@/lib/ai/agents/outreach";
import { ProspectResearchSchema } from "@/lib/ai/agents/prospect-research-schema";
import { DashButton } from "@/components/dashboard-ui/button";
import { DarkCard } from "@/components/dashboard-ui/card";
import { BuyingIntentBadge, LeadStatusBadge, QualificationBadge, ScorePill, TaskStatusBadge, ConversationStatusBadge, DealStatusBadge } from "@/components/dashboard-ui/badge";
import { SparklesIcon } from "@/components/ui/icons";
import { formatDate } from "@/lib/format";
import type { ProspectContact, ProspectContactField, ProspectRawData } from "@/lib/prospects";

const SEND_ERROR_LABELS: Record<string, string> = {
  not_connected: "Gmail isn't connected for this organization yet.",
  not_configured: "Gmail isn't configured for this deployment yet.",
  reauth_required: "Gmail authorization has expired — reconnect it in Settings.",
  invalid_recipient: "Gmail rejected the recipient address.",
  rate_limited: "Gmail is rate-limiting this account right now — try again shortly.",
};

const TABS = ["Overview", "Company", "Research", "Conversations", "Tasks", "Deals", "Notes"] as const;

type Lead = {
  id: string;
  status: string;
  qualification_status: string;
  current_score: number | null;
  intent: string | null;
  buying_intent: "low" | "medium" | "high" | null;
  next_action: string | null;
  notes: string | null;
  research_status: "pending" | "researching" | "completed" | "failed";
  research_error: string | null;
  created_at: string;
};
type Contact = { id: string; full_name: string | null; email: string | null; phone: string | null; role_title: string | null; is_primary: boolean };
type Research = { id: string; summary: string | null; findings: unknown; source: string; created_at: string };
type ConversationRow = { id: string; channel: string; status: string; created_at: string };
type TaskRow = { id: string; title: string; status: string; due_at: string | null };
type DealRow = { id: string; title: string; status: string; value: number; currency: string };

export function LeadDetailTabs({
  lead,
  leadName,
  primaryContact,
  recipientEmail,
  gmailStatus,
  hasBusinessKnowledge,
  contacts,
  companyName,
  website,
  discovery,
  campaignName,
  latestQualificationReason,
  research,
  conversations,
  tasks,
  deals,
}: {
  lead: Lead;
  leadName: string;
  primaryContact: Contact | null;
  recipientEmail: string | null;
  gmailStatus: { connected: boolean; emailAddress: string | null };
  hasBusinessKnowledge: boolean;
  contacts: Contact[];
  companyName: string | null;
  website: string | null;
  discovery: ProspectRawData;
  campaignName: string | null;
  latestQualificationReason: string | null;
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
  const [editedSubject, setEditedSubject] = useState("");
  const [editedBody, setEditedBody] = useState("");
  const [sendPending, startSendTransition] = useTransition();
  const [sendResult, setSendResult] = useState<SendOutreachResult | null>(null);
  const [showAddContact, setShowAddContact] = useState(false);
  const [addContactPending, startAddContactTransition] = useTransition();

  // Contact channels read from the company's own website. Seeded from what
  // discovery already saved, and replaced in place when the user asks for a
  // fresh read — so the card updates without a reload.
  const [contact, setContact] = useState<ProspectContact | null>(discovery.contact);
  const [findingContact, setFindingContact] = useState(false);
  const [contactMessage, setContactMessage] = useState<string | null>(null);

  async function findContact() {
    setFindingContact(true);
    setContactMessage(null);
    const result = await findLeadContactAction(lead.id);
    setFindingContact(false);

    if (!result.ok) {
      setContactMessage(result.message);
      return;
    }
    if (!result.found) {
      // An honest empty result, not a failure: the site was read and simply
      // did not publish anything reachable.
      setContactMessage("Read the website but found no published contact details.");
      return;
    }
    setContact(result.contact);
  }

  function submitAddContact(formData: FormData) {
    startAddContactTransition(async () => {
      await addContactForLead(lead.id, formData);
      setShowAddContact(false);
    });
  }

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
    setSendResult(null);
    startAiTransition(async () => {
      const result = await generateLeadOutreachAction(lead.id, channel);
      setOutreachDraft(result.ok ? result.draft : { error: result.message });
      if (result.ok) {
        setEditedSubject(result.draft.subject ?? "");
        setEditedBody(result.draft.message);
      }
    });
  }

  function cancelOutreach() {
    setOutreachDraft(null);
    setEditedSubject("");
    setEditedBody("");
    setSendResult(null);
  }

  function sendOutreach() {
    if (!recipientEmail) return;
    setSendResult(null);
    startSendTransition(async () => {
      const idempotencyKey = crypto.randomUUID();
      const result = await sendLeadOutreachAction(lead.id, { subject: editedSubject, body: editedBody, idempotencyKey });
      setSendResult(result);
      if (result.ok) {
        setOutreachDraft(null);
        setEditedSubject("");
        setEditedBody("");
      }
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
                {companyName && companyName !== leadName ? <span>{companyName}</span> : null}
                {primaryContact?.email ? <span>{primaryContact.email}</span> : null}
                {primaryContact?.phone ? <span>{primaryContact.phone}</span> : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <ScorePill score={lead.current_score} />
                <LeadStatusBadge status={lead.status} />
                <QualificationBadge status={lead.qualification_status} />
                {lead.buying_intent ? <BuyingIntentBadge intent={lead.buying_intent} /> : null}
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
                <div className="mb-3 flex items-center justify-between border-b border-bb-border pb-3">
                  <h4 className="text-sm font-semibold text-bb-text">Contact Information</h4>
                  {/*
                    Not gated on `website` — discoverProspectContacts (see
                    findLeadContactAction) falls back to bounded Tavily/Exa
                    search evidence precisely when there is no website on
                    file, which is a normal outcome of search-based Lead
                    Discovery, not an edge case. Hiding this button for
                    exactly the leads with no website meant the one leads
                    that most needed a second attempt could never get one.
                  */}
                  <DashButton variant="outline" disabled={findingContact} onClick={findContact}>
                    {findingContact ? "Reading site…" : "Find Contact Info"}
                  </DashButton>
                </div>
                <ContactChannels
                  contact={contact}
                  email={recipientEmail}
                  phone={primaryContact?.phone ?? null}
                  website={website}
                  location={discovery.location}
                />
                <div className="mt-2 border-t border-bb-border pt-2">
                  <Row label="Company" val={companyName ?? "—"} />
                  <Row label="Industry" val={discovery.industry ?? "—"} />
                  <Row label="Campaign" val={campaignName ?? "—"} />
                </div>
                {contactMessage ? <p className="mt-3 text-xs text-bb-text-3">{contactMessage}</p> : null}
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
                ) : latestQualificationReason ? (
                  <div className="mt-3 border-t border-bb-border pt-3 text-xs">
                    <p className="mb-1 text-bb-text-3">From the last qualification run:</p>
                    <p className="text-bb-text-2">{latestQualificationReason}</p>
                  </div>
                ) : null}
              </DarkCard>

              <DarkCard className="p-5">
                <div className="mb-3 flex items-center justify-between border-b border-bb-border pb-3">
                  <h4 className="flex items-center gap-1.5 text-sm font-semibold text-bb-text">
                    <SparklesIcon className="h-4 w-4 text-bb-indigo" /> AI Outreach
                  </h4>
                  {!outreachDraft ? (
                    <DashButton variant="outline" disabled={aiPending} onClick={() => runOutreach("email")}>
                      {aiPending ? "Drafting…" : "Generate"}
                    </DashButton>
                  ) : null}
                </div>

                {!outreachDraft ? (
                  <div className="space-y-2">
                    <p className="text-sm text-bb-text-3">
                      Drafts a personalized email from real research and qualification on file, for you to review, edit and send
                      through Gmail. Never sent automatically.
                    </p>
                    {hasBusinessKnowledge ? (
                      <p className="text-xs text-bb-text-3">Business Knowledge is on file and will ground this draft.</p>
                    ) : (
                      <p className="text-xs text-bb-amber">
                        No Business Knowledge is on file yet — drafts will be generic until you fill in{" "}
                        <Link href="/knowledge" className="underline">
                          the Knowledge tab
                        </Link>
                        .
                      </p>
                    )}
                  </div>
                ) : "error" in outreachDraft ? (
                  <div className="space-y-2">
                    <p className="text-sm text-bb-rose">{outreachDraft.error}</p>
                    <DashButton variant="outline" disabled={aiPending} onClick={() => runOutreach("email")}>
                      Try again
                    </DashButton>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <Row label="To" val={recipientEmail ?? "No email on file"} />
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Subject</label>
                      <input
                        value={editedSubject}
                        onChange={(e) => setEditedSubject(e.target.value)}
                        placeholder="(no subject)"
                        className="w-full rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-bb-text-2">Message</label>
                      <textarea
                        value={editedBody}
                        onChange={(e) => setEditedBody(e.target.value)}
                        rows={7}
                        className="w-full resize-none rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                      />
                    </div>

                    {!recipientEmail ? (
                      <p className="text-xs text-bb-rose">No email address on file for this lead — add one before sending.</p>
                    ) : !gmailStatus.connected ? (
                      <p className="text-xs text-bb-amber">
                        Gmail isn&apos;t connected.{" "}
                        <Link href="/settings?tab=Integrations" className="underline">
                          Connect it in Settings
                        </Link>{" "}
                        to send.
                      </p>
                    ) : (
                      <p className="text-xs text-bb-text-3">Will send from {gmailStatus.emailAddress}.</p>
                    )}

                    {sendResult && !sendResult.ok ? (
                      <p className="text-xs text-bb-rose">{SEND_ERROR_LABELS[sendResult.code] ?? sendResult.message}</p>
                    ) : null}

                    <div className="flex flex-wrap gap-2 pt-1">
                      <DashButton
                        variant="gradient"
                        disabled={sendPending || !recipientEmail || !gmailStatus.connected || !editedBody.trim()}
                        onClick={sendOutreach}
                      >
                        {sendPending ? "Sending…" : "Send"}
                      </DashButton>
                      <DashButton variant="outline" disabled={aiPending || sendPending} onClick={() => runOutreach("email")}>
                        {aiPending ? "Regenerating…" : "Regenerate"}
                      </DashButton>
                      <DashButton variant="ghost" disabled={sendPending} onClick={cancelOutreach}>
                        Cancel
                      </DashButton>
                    </div>
                  </div>
                )}

                {sendResult?.ok ? (
                  <div className="mt-3 rounded-lg border border-bb-emerald/25 bg-bb-emerald/10 p-3 text-sm text-bb-emerald">
                    Sent to {sendResult.sentTo}.{" "}
                    {sendResult.conversationId ? (
                      <Link href={`/conversations/${sendResult.conversationId}`} className="underline">
                        View conversation →
                      </Link>
                    ) : null}
                  </div>
                ) : null}
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
              <Row label="Location" val={discovery.location ?? "—"} />
              <Row label="Industry" val={discovery.industry ?? "—"} />
              <Row label="Business type" val={discovery.businessType ?? "—"} />
            </DarkCard>
            {discovery.evidenceSnippet || discovery.matchedIcpCriteria.length > 0 ? (
              <DarkCard className="p-5">
                <h4 className="mb-3 text-sm font-semibold text-bb-text">Discovery Evidence</h4>
                {discovery.evidenceSnippet ? (
                  <p className="mb-2 text-sm text-bb-text-2">&ldquo;{discovery.evidenceSnippet}&rdquo;</p>
                ) : null}
                {discovery.sourceUrl ? (
                  <a href={discovery.sourceUrl} target="_blank" rel="noreferrer" className="mb-3 inline-block text-xs text-bb-indigo-2 hover:underline">
                    View source →
                  </a>
                ) : null}
                {discovery.matchedIcpCriteria.length > 0 ? (
                  <div className="mt-2 border-t border-bb-border pt-3">
                    <p className="mb-1.5 text-xs font-medium text-bb-text-2">Matched ICP criteria</p>
                    <ul className="list-inside list-disc space-y-0.5 text-xs text-bb-text-3">
                      {discovery.matchedIcpCriteria.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {discovery.discoveredAt ? (
                  <p className="mt-3 text-xs text-bb-text-3">
                    Discovered {formatDate(discovery.discoveredAt)}
                    {discovery.discoverySource ? ` via ${discovery.discoverySource}` : ""}
                  </p>
                ) : null}
              </DarkCard>
            ) : null}
            <DarkCard className="p-5">
              <div className="mb-3 flex items-center justify-between border-b border-bb-border pb-3">
                <h4 className="text-sm font-semibold text-bb-text">Contacts</h4>
                {/* Not gated on `website` — see the matching comment on the Overview tab's identical button. */}
                <DashButton variant="outline" disabled={findingContact} onClick={findContact}>
                  {findingContact ? "Reading site…" : "Find Contact Info"}
                </DashButton>
              </div>
              {/*
                AI-discovered contact channels — the same data the Overview
                tab shows. This card used to check only the human-entered
                People list below, so a lead with real, sourced channels here
                could still read "No contacts recorded yet" a few lines away
                from where they were actually shown. One data source, shown
                consistently everywhere it appears.
              */}
              <ContactChannels
                contact={contact}
                email={recipientEmail}
                phone={primaryContact?.phone ?? null}
                website={website}
                location={discovery.location}
              />
              {contactMessage ? <p className="mt-2 text-xs text-bb-text-3">{contactMessage}</p> : null}

              <div className="mt-4 flex items-center justify-between border-t border-bb-border pt-3">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-bb-text-3">People</h5>
                {!showAddContact ? (
                  <DashButton variant="outline" onClick={() => setShowAddContact(true)}>
                    + Add Contact
                  </DashButton>
                ) : null}
              </div>
              {contacts.length === 0 ? (
                <p className="mb-3 mt-2 text-sm text-bb-text-3">No named contacts added yet.</p>
              ) : (
                <div className="mb-3 mt-2 space-y-3">
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
              {showAddContact ? (
                <form action={submitAddContact} className="space-y-2 border-t border-bb-border pt-3">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <input
                      name="fullName"
                      placeholder="Full name"
                      className="w-full rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                    />
                    <input
                      name="email"
                      type="email"
                      placeholder="Email"
                      className="w-full rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                    />
                    <input
                      name="phone"
                      placeholder="Phone (optional)"
                      className="w-full rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                    />
                    <input
                      name="roleTitle"
                      placeholder="Role / title (optional)"
                      className="w-full rounded-lg border border-bb-border bg-bb-navy-3 px-3 py-2 text-sm text-bb-text outline-none focus:border-bb-indigo"
                    />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <DashButton type="submit" variant="gradient" disabled={addContactPending}>
                      {addContactPending ? "Saving…" : "Save Contact"}
                    </DashButton>
                    <DashButton variant="ghost" disabled={addContactPending} onClick={() => setShowAddContact(false)}>
                      Cancel
                    </DashButton>
                  </div>
                </form>
              ) : null}
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
            {researchError ? (
              <p className="text-xs text-bb-rose">{researchError}</p>
            ) : !aiPending && lead.research_status === "failed" && lead.research_error ? (
              // A newly discovered lead is researched automatically; this is
              // what that attempt (or an earlier manual one) left behind when
              // it genuinely failed. Not retried automatically — see
              // finishPendingLeads — so it stays visible until a human
              // presses Run AI Research again.
              <p className="text-xs text-bb-rose">
                The research attempt failed and was not retried automatically: {lead.research_error}
              </p>
            ) : null}
            {research.length === 0 ? (
              <p className="py-16 text-center text-sm text-bb-text-3">
                {aiPending || lead.research_status === "researching"
                  ? "Researching…"
                  : lead.research_status === "failed"
                    ? "Research failed — see above. It will not be retried automatically."
                    : "No research recorded for this lead yet. New leads are researched automatically shortly after discovery."}
              </p>
            ) : (
              research.map((r) => <ResearchCard key={r.id} research={r} discovery={discovery} companyName={companyName} website={website} />)
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

/**
 * One contact channel, as a link where a link makes sense.
 *
 * The source URL is rendered as a title attribute rather than as visible
 * text: the point of storing it is that every value on this card can be
 * traced back to the page it was read from, without turning the card into a
 * wall of URLs.
 */
function ContactRow({ label, field, href, display }: { label: string; field: ProspectContactField; href?: string; display?: string }) {
  const text = display ?? field.value;
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="shrink-0 text-xs text-bb-text-3">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={`Found on ${field.source}`}
          className="truncate text-right text-sm text-bb-indigo-2 hover:underline"
        >
          {text}
        </a>
      ) : (
        <span title={`Found on ${field.source}`} className="truncate text-right text-sm text-bb-text-2">
          {text}
        </span>
      )}
    </div>
  );
}

/** Shortens a URL to its host + first path segment, so a social link reads as a handle rather than a query string. */
function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "");
    return `${parsed.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}

/**
 * Every contact channel actually on file for this lead.
 *
 * Only channels that exist are rendered — a lead with no LinkedIn simply has
 * no LinkedIn row, rather than a row reading "—". The one deliberate
 * exception is the all-empty case, which says so in words instead of showing
 * an empty card.
 *
 * A contact form counts as a real, usable channel: a business that publishes
 * only a form is still reachable, and showing "Contact form available" with a
 * working link is the honest way to say that — far better than the dash this
 * card used to show while the research evidence held a perfectly good way in.
 */
function ContactChannels({
  contact,
  email,
  phone,
  website,
  location,
}: {
  contact: ProspectContact | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  location: string | null;
}) {
  // A contact row entered by a human, or an address already on the prospect,
  // outranks anything re-read from the website.
  const emailField: ProspectContactField | null = email
    ? { value: email, source: contact?.email?.source ?? "on file", confidence: contact?.email?.confidence ?? "high" }
    : (contact?.email ?? null);
  const phoneField: ProspectContactField | null = phone
    ? { value: phone, source: contact?.phone?.source ?? "on file", confidence: contact?.phone?.confidence ?? "high" }
    : (contact?.phone ?? null);
  const addressField: ProspectContactField | null =
    contact?.address ?? (location ? { value: location, source: "discovery", confidence: "medium" } : null);

  const hasDirectContact = Boolean(emailField || phoneField || contact?.whatsapp);
  const rows = [
    emailField ? <ContactRow key="email" label="Email" field={emailField} href={`mailto:${emailField.value}`} /> : null,
    phoneField ? <ContactRow key="phone" label="Phone" field={phoneField} href={`tel:${phoneField.value.replace(/\s+/g, "")}`} /> : null,
    contact?.whatsapp ? (
      <ContactRow key="whatsapp" label="WhatsApp" field={contact.whatsapp} href={contact.whatsapp.value} display="Open chat" />
    ) : null,
    contact?.contactPageUrl ? (
      <ContactRow key="contact-page" label="Contact page" field={contact.contactPageUrl} href={contact.contactPageUrl.value} display="Open" />
    ) : null,
    contact?.contactFormUrl ? (
      <ContactRow
        key="contact-form"
        label="Contact form"
        field={contact.contactFormUrl}
        href={contact.contactFormUrl.value}
        display={hasDirectContact ? "Open form" : "Contact form available"}
      />
    ) : null,
    contact?.instagram ? (
      <ContactRow key="instagram" label="Instagram" field={contact.instagram} href={contact.instagram.value} display={shortenUrl(contact.instagram.value)} />
    ) : null,
    contact?.linkedin ? (
      <ContactRow key="linkedin" label="LinkedIn" field={contact.linkedin} href={contact.linkedin.value} display={shortenUrl(contact.linkedin.value)} />
    ) : null,
    contact?.facebook ? (
      <ContactRow key="facebook" label="Facebook" field={contact.facebook} href={contact.facebook.value} display={shortenUrl(contact.facebook.value)} />
    ) : null,
    website ? (
      <ContactRow
        key="website"
        label="Website"
        field={{ value: website, source: website, confidence: "high" }}
        href={website}
        display={shortenUrl(website)}
      />
    ) : null,
    addressField ? <ContactRow key="address" label="Address" field={addressField} /> : null,
  ].filter(Boolean);

  if (rows.length === 0) {
    // A completed search that genuinely found nothing is different from one
    // that never ran — worth saying so, rather than one flat, ambiguous line.
    return (
      <p className="py-2 text-sm text-bb-text-3">
        {contact?.contactStatus === "not_found"
          ? "Searched the business's website and public search results — no verified contact channel found."
          : "No contact details on file yet."}
      </p>
    );
  }

  return <div>{rows}</div>;
}

function Row({ label, val }: { label: string; val: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-bb-text-3">{label}</span>
      <span className="text-sm text-bb-text-2">{val}</span>
    </div>
  );
}

const CONFIDENCE_BADGE: Record<string, string> = {
  low: "bg-bb-rose/15 text-bb-rose",
  medium: "bg-bb-amber/15 text-bb-amber",
  high: "bg-bb-emerald/15 text-bb-emerald",
};

function ConfidenceBadge({ confidence }: { confidence: string }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${CONFIDENCE_BADGE[confidence] ?? "bg-bb-navy-3 text-bb-text-3"}`}>
      {confidence} confidence
    </span>
  );
}

/** One labeled section of the Research tab's A-F structure — a consistent header plus spacing, never one giant undifferentiated paragraph. */
function ResearchSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-bb-border pt-3 first:border-t-0 first:pt-0">
      <div className="mb-1.5 text-xs font-medium tracking-wide text-bb-text-3">{title}</div>
      {children}
    </div>
  );
}

/**
 * The Research tab's per-run card, restructured into distinct sections
 * (Summary / Verified Company Info / Evidence & Sources / Buying Signals /
 * Missing Information / AI Recommendation) rather than one dense paragraph.
 * confidence is whatever classifyResearchConfidence (research-confidence.ts)
 * computed and stored at research time — never re-derived here — so this
 * card only ever displays the same deterministic judgment already on file.
 *
 * Evidence & Sources deliberately never invents a source per verified-claim
 * string: the model's verifiedInformation/businessFactsReferenced arrays
 * carry no source link of their own, so they're shown attributed to the
 * real, on-file evidence above them (the discovery snippet + each contact
 * field's own source) rather than assigning them fabricated citations.
 */
function ResearchCard({
  research: r,
  discovery,
  companyName,
  website,
}: {
  research: { id: string; summary: string | null; findings: unknown; source: string; created_at: string };
  discovery: ProspectRawData;
  companyName: string | null;
  website: string | null;
}) {
  const parsed = ProspectResearchSchema.safeParse(r.findings);
  const findings = parsed.success ? parsed.data : null;

  const verifiedClaims = findings ? [...findings.verifiedInformation, ...findings.businessFactsReferenced] : [];
  const keyOpportunity = findings?.buyingSignals[0] ?? findings?.likelyNeeds[0] ?? null;

  const companyRows = [
    companyName ? { label: "Company", value: companyName } : null,
    website ? { label: "Website", value: website } : null,
    discovery.industry ? { label: "Industry", value: discovery.industry } : null,
    discovery.location ? { label: "Location", value: discovery.location } : null,
    discovery.businessType ? { label: "Business type", value: discovery.businessType } : null,
    discovery.contact?.email ? { label: "Email (verified)", value: discovery.contact.email.value } : null,
    discovery.contact?.phone ? { label: "Phone (verified)", value: discovery.contact.phone.value } : null,
  ].filter((row): row is { label: string; value: string } => row !== null);

  const sourceEntries: { label: string; found: string; sourceUrl: string | null }[] = [];
  if (discovery.sourceUrl && discovery.evidenceSnippet) {
    sourceEntries.push({ label: "How this lead was discovered", found: discovery.evidenceSnippet, sourceUrl: discovery.sourceUrl });
  }
  for (const [label, field] of [
    ["Email", discovery.contact?.email ?? null],
    ["Phone", discovery.contact?.phone ?? null],
    ["WhatsApp", discovery.contact?.whatsapp ?? null],
  ] as [string, ProspectContactField | null][]) {
    if (field) sourceEntries.push({ label, found: field.value, sourceUrl: /^https?:\/\//.test(field.source) ? field.source : null });
  }

  return (
    <DarkCard className="space-y-4 p-5">
      <div className="flex items-center justify-between text-xs text-bb-text-3">
        <span className="capitalize">{r.source} research</span>
        <span>{formatDate(r.created_at)}</span>
      </div>

      <ResearchSection title="RESEARCH SUMMARY">
        {findings ? (
          <div className="mb-2">
            <ConfidenceBadge confidence={findings.confidence} />
          </div>
        ) : null}
        <p className="text-sm text-bb-text-2">{r.summary ?? findings?.companySummary ?? "No summary."}</p>
        {discovery.matchedIcpCriteria.length > 0 ? (
          <p className="mt-2 text-xs text-bb-text-3">Matches this campaign&apos;s ICP on: {discovery.matchedIcpCriteria.join(", ")}</p>
        ) : null}
        {keyOpportunity ? <p className="mt-2 text-xs text-bb-emerald">Key opportunity: {keyOpportunity}</p> : null}
      </ResearchSection>

      {companyRows.length > 0 ? (
        <ResearchSection title="VERIFIED COMPANY INFORMATION">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {companyRows.map((row) => (
              <div key={row.label}>
                <div className="text-xs text-bb-text-3">{row.label}</div>
                <div className="text-sm text-bb-text-2">{row.value}</div>
              </div>
            ))}
          </div>
        </ResearchSection>
      ) : null}

      <ResearchSection title="EVIDENCE & SOURCES">
        {sourceEntries.length > 0 ? (
          <div className="space-y-1.5">
            {sourceEntries.map((entry, i) => (
              <p key={i} className="text-xs">
                <span className="text-bb-text-2">{entry.label}: </span>
                <span className="text-bb-text-3">{entry.found}</span>
                {entry.sourceUrl ? (
                  <>
                    {" — "}
                    <a href={entry.sourceUrl} target="_blank" rel="noreferrer" className="text-bb-indigo-2 hover:underline">
                      source
                    </a>
                  </>
                ) : null}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-xs text-bb-text-3">No sourced evidence on file for this lead yet.</p>
        )}
        {verifiedClaims.length > 0 ? (
          <p className="mt-2 text-xs text-bb-emerald">
            The AI confirmed, from the evidence above and any Business Knowledge on file: {verifiedClaims.join("; ")}
          </p>
        ) : null}
        {findings && findings.inferredInformation.length > 0 ? (
          <p className="mt-2 text-xs text-bb-text-3">Inferred, not directly verified: {findings.inferredInformation.join("; ")}</p>
        ) : null}
      </ResearchSection>

      <ResearchSection title="BUYING / OPPORTUNITY SIGNALS">
        {findings && findings.buyingSignals.length > 0 ? (
          <ul className="list-disc space-y-1 pl-4 text-xs text-bb-text-2">
            {findings.buyingSignals.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-bb-text-3">Not verified — no buying signal is supported by the evidence on file yet.</p>
        )}
      </ResearchSection>

      <ResearchSection title="MISSING INFORMATION">
        {findings && findings.unavailableInformation.length > 0 ? (
          <p className="text-xs text-bb-amber">{findings.unavailableInformation.join("; ")}</p>
        ) : (
          <p className="text-xs text-bb-text-3">Nothing flagged as missing.</p>
        )}
      </ResearchSection>

      {findings ? (
        <ResearchSection title="AI RECOMMENDATION">
          <div className="space-y-1.5 text-xs">
            {findings.likelyNeeds.length > 0 ? <p className="text-bb-text-2">Likely needs: {findings.likelyNeeds.join("; ")}</p> : null}
            {findings.possiblePainPoints.length > 0 ? (
              <p className="text-bb-text-2">Possible pain points: {findings.possiblePainPoints.join("; ")}</p>
            ) : null}
            {findings.relevantProductsOrServices.length > 0 ? (
              <p className="text-bb-text-2">Relevant offering: {findings.relevantProductsOrServices.join("; ")}</p>
            ) : null}
            {findings.personalizationOpportunities.length > 0 ? (
              <p className="text-bb-indigo-2">Suggested outreach angle: {findings.personalizationOpportunities.join("; ")}</p>
            ) : null}
            {findings.potentialObjections.length > 0 ? (
              <p className="text-bb-text-3">Be ready for: {findings.potentialObjections.join("; ")}</p>
            ) : null}
          </div>
        </ResearchSection>
      ) : null}
    </DarkCard>
  );
}
