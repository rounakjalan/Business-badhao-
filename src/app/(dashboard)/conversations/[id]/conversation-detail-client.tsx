"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { detectIntentAction, runFollowUpAction, sendMessage, updateConversationStatus } from "@/app/(dashboard)/conversations/actions";
import type { IntentAnalysis } from "@/lib/ai/agents/intent";
import type { FollowUpPlan } from "@/lib/ai/agents/follow-up";
import { DashButton } from "@/components/dashboard-ui/button";
import { ChannelBadge, ConversationStatusBadge } from "@/components/dashboard-ui/badge";
import { SparklesIcon } from "@/components/ui/icons";
import { formatDate } from "@/lib/format";

type Conversation = { id: string; lead_id: string; channel: string; status: string; intent: string | null; created_at: string };
type Message = {
  id: string;
  direction: string;
  sender_type: string;
  body: string | null;
  subject?: string | null;
  status?: string | null;
  created_at: string;
};

export function ConversationDetailClient({
  conversation,
  contactName,
  contactEmail,
  leadScore,
  messages,
}: {
  conversation: Conversation;
  contactName: string;
  contactEmail: string | null;
  leadScore: number | null;
  messages: Message[];
}) {
  const [reply, setReply] = useState("");
  const [isPending, startTransition] = useTransition();
  const [aiPending, startAiTransition] = useTransition();
  const [sendPending, startSendTransition] = useTransition();
  const [intentResult, setIntentResult] = useState<IntentAnalysis | { error: string } | null>(null);
  const [followUpResult, setFollowUpResult] = useState<FollowUpPlan | { error: string } | null>(null);

  function runDetectIntent() {
    setFollowUpResult(null);
    startAiTransition(async () => {
      const result = await detectIntentAction(conversation.id);
      setIntentResult(result.ok ? result.analysis : { error: result.message });
    });
  }

  function runFollowUpPlan() {
    setIntentResult(null);
    startAiTransition(async () => {
      const result = await runFollowUpAction(conversation.id);
      setFollowUpResult(result.ok ? result.plan : { error: result.message });
    });
  }

  return (
    <div className="bb-animate-fade-in flex h-full flex-1 flex-col">
      <div className="shrink-0 border-b border-bb-border px-4 py-4 sm:px-6">
        <div className="mb-3 flex items-center gap-2 text-sm">
          <Link href="/conversations" className="text-bb-text-3 hover:text-bb-text">
            Conversations
          </Link>
          <span className="text-bb-border">/</span>
          <span className="text-bb-text">{contactName}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-bb-indigo to-bb-violet font-bold text-white">
              {contactName[0]?.toUpperCase()}
            </div>
            <div>
              <div className="font-semibold text-bb-text">{contactName}</div>
              <div className="flex items-center gap-2 text-xs text-bb-text-3">
                {contactEmail ? <span>{contactEmail}</span> : null}
                <ChannelBadge channel={conversation.channel} />
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Link href={`/leads/${conversation.lead_id}`}>
              <DashButton variant="ghost">View Lead</DashButton>
            </Link>
            {conversation.status !== "closed" ? (
              <DashButton
                variant="ghost"
                disabled={isPending}
                onClick={() => startTransition(() => updateConversationStatus(conversation.id, "closed"))}
              >
                Close
              </DashButton>
            ) : (
              <DashButton
                variant="ghost"
                disabled={isPending}
                onClick={() => startTransition(() => updateConversationStatus(conversation.id, "open"))}
              >
                Reopen
              </DashButton>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
            {messages.length === 0 ? (
              <p className="py-16 text-center text-sm text-bb-text-3">No messages yet. Send the first one below.</p>
            ) : (
              messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}>
                  <div className="max-w-lg">
                    <div className={`mb-1 flex items-center gap-2 text-xs text-bb-text-3 ${msg.direction === "outbound" ? "justify-end" : ""}`}>
                      <span className="capitalize">{msg.sender_type}</span>
                      <span>{formatDate(msg.created_at)}</span>
                      {msg.status === "failed" ? <span className="font-medium text-bb-rose">Failed to send</span> : null}
                    </div>
                    <div
                      className={`rounded-2xl px-4 py-3 text-sm leading-relaxed text-bb-text ${
                        msg.status === "failed"
                          ? "rounded-br-sm border border-bb-rose/40 bg-bb-rose/10"
                          : msg.direction === "outbound"
                            ? "rounded-br-sm border border-bb-indigo/30 bg-bb-indigo/15"
                            : "rounded-bl-sm border border-bb-border bg-bb-navy-3"
                      }`}
                    >
                      {msg.subject ? <div className="mb-1 font-medium text-bb-text-2">{msg.subject}</div> : null}
                      {msg.body}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <form
            className="shrink-0 border-t border-bb-border p-4"
          >
            <textarea
              name="body"
              rows={3}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="Write a reply..."
              className="w-full resize-none rounded-xl border border-bb-border bg-bb-navy-3 px-4 py-3 text-sm text-bb-text outline-none placeholder:text-bb-text-3 focus:border-bb-indigo"
            />
            <p className="mt-1.5 text-xs text-bb-text-3">
              This records the message on this conversation. It is not sent over {conversation.channel} — no outreach provider is
              connected yet.
            </p>
            <div className="mt-2 flex justify-end">
              <DashButton
                variant="gradient"
                disabled={sendPending || !reply.trim()}
                onClick={() => {
                  startSendTransition(async () => {
                    const formData = new FormData();
                    formData.set("body", reply);
                    await sendMessage(conversation.id, formData);
                    setReply("");
                  });
                }}
              >
                {sendPending ? "Sending…" : "Send →"}
              </DashButton>
            </div>
          </form>
        </div>

        <div className="hidden w-72 shrink-0 space-y-4 overflow-y-auto border-l border-bb-border p-4 lg:block">
          <div className="rounded-xl border border-bb-border bg-bb-navy-2 p-4">
            <div className="mb-3 text-xs font-medium text-bb-text-3">CONVERSATION</div>
            <Row label="Status" val={<ConversationStatusBadge status={conversation.status} />} />
            <Row label="Intent" val={conversation.intent ?? "—"} />
            <Row label="Started" val={formatDate(conversation.created_at)} />
          </div>
          <div className="rounded-xl border border-bb-border bg-bb-navy-2 p-4">
            <div className="mb-3 text-xs font-medium text-bb-text-3">LEAD</div>
            <Row label="Score" val={leadScore !== null ? String(leadScore) : "—"} />
          </div>

          <div className="rounded-xl border border-bb-border bg-bb-navy-2 p-4">
            <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-bb-text-3">
              <SparklesIcon className="h-3.5 w-3.5 text-bb-indigo" /> AI ASSISTANT
            </div>
            <div className="flex flex-col gap-2">
              <DashButton variant="outline" disabled={aiPending || messages.length === 0} onClick={runDetectIntent}>
                Detect Intent
              </DashButton>
              <DashButton variant="outline" disabled={aiPending || messages.length === 0} onClick={runFollowUpPlan}>
                Suggest Follow-up
              </DashButton>
            </div>

            {aiPending ? <p className="mt-3 text-xs text-bb-text-3">Thinking…</p> : null}

            {intentResult && !aiPending ? (
              "error" in intentResult ? (
                <p className="mt-3 text-xs text-bb-rose">{intentResult.error}</p>
              ) : (
                <div className="mt-3 space-y-2 border-t border-bb-navy-3 pt-3 text-xs">
                  <Row label="Intent" val={intentResult.intent.replaceAll("_", " ")} />
                  <Row label="Confidence" val={intentResult.confidence} />
                  <p className="text-bb-text-2">{intentResult.reasoning}</p>
                  {intentResult.detectedBuyingSignals.length > 0 ? (
                    <p className="text-bb-text-3">Signals: {intentResult.detectedBuyingSignals.join(", ")}</p>
                  ) : null}
                  {intentResult.detectedObjections.length > 0 ? (
                    <p className="text-bb-text-3">Objections: {intentResult.detectedObjections.join(", ")}</p>
                  ) : null}
                  <p className="text-bb-indigo-2">Next: {intentResult.recommendedNextAction}</p>
                </div>
              )
            ) : null}

            {followUpResult && !aiPending ? (
              "error" in followUpResult ? (
                <p className="mt-3 text-xs text-bb-rose">{followUpResult.error}</p>
              ) : (
                <div className="mt-3 space-y-2 border-t border-bb-navy-3 pt-3 text-xs">
                  <Row label="Timing" val={followUpResult.followUpTiming} />
                  <p className="text-bb-text-2">{followUpResult.followUpMessage}</p>
                  <p className="text-bb-text-3">A task was created with this plan.</p>
                </div>
              )
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, val }: { label: string; val: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-bb-text-3">{label}</span>
      <span className="text-xs font-medium text-bb-text-2">{val}</span>
    </div>
  );
}
