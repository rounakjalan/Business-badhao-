import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { getLastHistoryId, getValidAccessToken, setLastHistoryId } from "@/lib/gmail/tokens";
import { ensureConversation } from "@/lib/outreach/conversation";
import type { Json } from "@/types/database.types";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Smallest clean foundation for inbound mail, not the full autonomous
 * conversation agent: a manually-triggered poll rather than a Cloud
 * Pub/Sub push subscription. Real-time push needs its own Google Cloud
 * project setup (a Pub/Sub topic, a public push endpoint, a users.watch()
 * registration renewed every 7 days) that can't be verified without the
 * user provisioning it — this reuses only the OAuth token already
 * required for sending, so it works the moment Gmail is connected, with
 * no extra external setup. A later phase can add the push subscription
 * on top of the same matching/storage logic below without changing it.
 */

export function extractEmailAddress(fromHeader: string): string | null {
  const angleMatch = fromHeader.match(/<([^>]+)>/);
  const candidate = (angleMatch ? angleMatch[1] : fromHeader).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate.toLowerCase() : null;
}

type GmailMessagePart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
};

export function extractPlainTextBody(payload: GmailMessagePart): string {
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/plain" && part.body?.data) return decodeBase64Url(part.body.data);
  }
  for (const part of payload.parts ?? []) {
    const nested = extractPlainTextBody(part);
    if (nested) return nested;
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return "";
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Buffer.from(base64, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

type GmailFetchResult<T> = { ok: true; data: T } | { ok: false; status: number | null; message: string };

async function gmailGet<T>(path: string, accessToken: string): Promise<GmailFetchResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    return { ok: false, status: null, message: cause instanceof Error ? cause.message : "Network error contacting Gmail." };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, status: response.status, message: `HTTP ${response.status}: ${text.slice(0, 300)}` };
  }
  try {
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, status: response.status, message: "Response could not be parsed." };
  }
}

type GmailProfile = { emailAddress: string; historyId: string };
type GmailHistoryList = { history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; historyId?: string };
type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  payload?: { headers?: { name: string; value: string }[] } & GmailMessagePart;
};

export type CheckRepliesResult =
  | { ok: true; newReplies: number; matchedLeadIds: string[]; unmatchedSenders: string[] }
  | { ok: false; code: "not_connected" | "reauth_required" | "not_configured" | "network_error"; message: string };

/**
 * Polls the connected mailbox for messages added since the last check,
 * matches each sender against a known contact/prospect email in this
 * organization, and stores a match as an inbound message on that lead's
 * conversation. A sender that doesn't match any known lead is skipped
 * entirely — this never guesses or fabricates which lead a reply belongs
 * to, and never creates a conversation for an unknown sender.
 */
export async function checkForReplies(organizationId: string): Promise<CheckRepliesResult> {
  const token = await getValidAccessToken(organizationId);
  if (!token.ok) {
    if (token.code === "not_connected") return { ok: false, code: "not_connected", message: token.message };
    if (token.code === "not_configured") return { ok: false, code: "not_configured", message: token.message };
    return { ok: false, code: "reauth_required", message: token.message };
  }

  const profileResult = await gmailGet<GmailProfile>("/profile", token.accessToken);
  if (!profileResult.ok) {
    return { ok: false, code: "network_error", message: `Could not read the connected mailbox's status: ${profileResult.message}` };
  }

  const lastHistoryId = await getLastHistoryId(organizationId);

  // First check ever for this connection: establish a baseline and start
  // watching from here — this deliberately does not retroactively import
  // the whole inbox's history.
  if (!lastHistoryId) {
    await setLastHistoryId(organizationId, profileResult.data.historyId);
    return { ok: true, newReplies: 0, matchedLeadIds: [], unmatchedSenders: [] };
  }

  const historyResult = await gmailGet<GmailHistoryList>(
    `/history?startHistoryId=${encodeURIComponent(lastHistoryId)}&historyTypes=messageAdded`,
    token.accessToken
  );

  // Gmail only retains a rolling window of history; an old startHistoryId
  // 404s. Re-baseline rather than fail outright — the next check resumes
  // normally, at the honest cost of not seeing whatever arrived in the gap.
  if (!historyResult.ok) {
    if (historyResult.status === 404) {
      await setLastHistoryId(organizationId, profileResult.data.historyId);
      return { ok: true, newReplies: 0, matchedLeadIds: [], unmatchedSenders: [] };
    }
    return { ok: false, code: "network_error", message: `Could not read mailbox history: ${historyResult.message}` };
  }

  const candidateIds = new Set(
    (historyResult.data.history ?? [])
      .flatMap((h) => h.messagesAdded ?? [])
      .filter((m) => (m.message.labelIds ?? []).includes("INBOX") && !(m.message.labelIds ?? []).includes("SENT"))
      .map((m) => m.message.id)
  );

  const admin = createAdminClient();
  if (!admin) return { ok: false, code: "not_configured", message: "Automation isn't configured in this deployment." };

  const matchedLeadIds: string[] = [];
  const unmatchedSenders: string[] = [];

  for (const messageId of candidateIds) {
    // Already-stored (a previous check partially succeeded, or the same
    // message surfaced twice in one history window) — skip, never insert twice.
    const { data: existing } = await admin.from("messages").select("id").eq("organization_id", organizationId).eq("external_id", messageId).maybeSingle();
    if (existing) continue;

    const messageResult = await gmailGet<GmailMessage>(`/messages/${messageId}?format=full`, token.accessToken);
    if (!messageResult.ok) continue;

    const headers = messageResult.data.payload?.headers ?? [];
    const fromHeader = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
    const subjectHeader = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? null;
    const senderEmail = extractEmailAddress(fromHeader);
    if (!senderEmail) continue;

    const leadId = await findLeadByEmail(admin, organizationId, senderEmail);
    if (!leadId) {
      unmatchedSenders.push(senderEmail);
      continue;
    }

    const conversation = await ensureConversation(admin, organizationId, leadId, "email");
    if (!conversation.ok) continue;

    const body = messageResult.data.payload ? extractPlainTextBody(messageResult.data.payload) : "";

    await admin.from("messages").insert({
      organization_id: organizationId,
      conversation_id: conversation.conversationId,
      lead_id: leadId,
      direction: "inbound",
      channel: "email",
      sender_type: "lead",
      body,
      subject: subjectHeader,
      from_address: senderEmail,
      external_id: messageResult.data.id,
      metadata: { gmailThreadId: messageResult.data.threadId } as unknown as Json,
    });

    await admin.from("conversations").update({ last_message_at: new Date().toISOString(), status: "open" }).eq("id", conversation.conversationId);

    matchedLeadIds.push(leadId);
  }

  await setLastHistoryId(organizationId, historyResult.data.historyId ?? profileResult.data.historyId);

  return { ok: true, newReplies: matchedLeadIds.length, matchedLeadIds, unmatchedSenders };
}

async function findLeadByEmail(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  organizationId: string,
  email: string
): Promise<string | null> {
  const { data: contact } = await admin.from("contacts").select("lead_id").eq("organization_id", organizationId).eq("email", email).maybeSingle();
  if (contact) return contact.lead_id;

  const { data: prospect } = await admin.from("prospects").select("id").eq("organization_id", organizationId).eq("email", email).maybeSingle();
  if (!prospect) return null;

  const { data: lead } = await admin.from("leads").select("id").eq("organization_id", organizationId).eq("prospect_id", prospect.id).maybeSingle();
  return lead?.id ?? null;
}
