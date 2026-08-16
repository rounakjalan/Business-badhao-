"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { sendMessage, updateConversationStatus } from "@/app/(dashboard)/conversations/actions";
import { DashButton } from "@/components/dashboard-ui/button";
import { ChannelBadge, ConversationStatusBadge } from "@/components/dashboard-ui/badge";
import { formatDate } from "@/lib/format";

type Conversation = { id: string; lead_id: string; channel: string; status: string; intent: string | null; created_at: string };
type Message = { id: string; direction: string; sender_type: string; body: string | null; created_at: string };

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
                    </div>
                    <div
                      className={`rounded-2xl px-4 py-3 text-sm leading-relaxed text-bb-text ${
                        msg.direction === "outbound"
                          ? "rounded-br-sm border border-bb-indigo/30 bg-bb-indigo/15"
                          : "rounded-bl-sm border border-bb-border bg-bb-navy-3"
                      }`}
                    >
                      {msg.body}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>

          <form
            action={(formData) => {
              sendMessage(conversation.id, formData);
              setReply("");
            }}
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
              <DashButton type="submit" variant="gradient" disabled={!reply.trim()}>
                Send →
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
