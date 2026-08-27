import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/lead-names", () => ({ resolveLeadIdentity: vi.fn() }));
vi.mock("@/lib/gmail/send", () => ({ sendGmailMessage: vi.fn() }));
vi.mock("@/lib/whatsapp/send", () => ({ sendWhatsAppMessage: vi.fn() }));
vi.mock("@/lib/ai/agents/conversation-reply", () => ({ generateConversationReply: vi.fn() }));
vi.mock("@/lib/ai/tracking/agent-runs", () => ({ createAgentRun: vi.fn(), completeAgentRun: vi.fn(), recordAgentAction: vi.fn() }));
vi.mock("@/lib/business-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/business-context")>();
  return { ...actual, getBusinessContext: vi.fn() };
});
vi.mock("@/lib/ai/agents/intent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/agents/intent")>();
  return { ...actual, detectIntent: vi.fn() };
});

import { resolveLeadIdentity } from "@/lib/lead-names";
import { sendGmailMessage } from "@/lib/gmail/send";
import { sendWhatsAppMessage } from "@/lib/whatsapp/send";
import { generateConversationReply } from "@/lib/ai/agents/conversation-reply";
import { createAgentRun } from "@/lib/ai/tracking/agent-runs";
import { getBusinessContext } from "@/lib/business-context";
import { detectIntent } from "@/lib/ai/agents/intent";
import { respondToConversation } from "@/lib/conversation-agent/respond";

const IDENTITY = { name: "Priya Sharma", email: "priya@example.com", phone: "+919876543210" };
const EMPTY_BUSINESS_CONTEXT = { businessProfile: null, productsServices: [], valueProposition: { keySellingPoints: [], productBenefits: [] }, faqs: [], policies: [], aiCommunicationRules: null, mediaReferences: [] };
const VALID_REPLY = { message: "Thanks for reaching out! Here's more info.", recommendHandoff: false, handoffReason: null };

type Row = Record<string, unknown>;
/** Every queued item is exactly what the mocked call should resolve to, e.g. { data: {...} } or { data: [...] }. */
type Queued = { data: unknown };

function makeAdminClient(queues: { conversations?: Queued[]; messages?: Queued[]; campaigns?: Queued[] } = {}) {
  const tableQueues: Record<string, Queued[]> = {
    conversations: [...(queues.conversations ?? [])],
    messages: [...(queues.messages ?? [])],
    campaigns: [...(queues.campaigns ?? [])],
  };
  const inserted: { table: string; values: Row }[] = [];
  const updated: { table: string; values: Row }[] = [];
  const touchedTables: string[] = [];

  function chain(table: string): Record<string, unknown> {
    touchedTables.push(table);
    const next = (): Queued => tableQueues[table]?.shift() ?? { data: null };
    const obj: Record<string, unknown> = {
      select: () => obj,
      eq: () => obj,
      order: () => obj,
      limit: () => obj,
      not: () => obj,
      maybeSingle: async () => next(),
      single: async () => next(),
      insert: (values: Row) => {
        inserted.push({ table, values });
        return { select: () => ({ single: async () => next() }) };
      },
      update: (values: Row) => {
        updated.push({ table, values });
        const updateChain: Record<string, unknown> = {
          eq: () => updateChain,
          then: (resolve: (value: Queued) => void) => resolve({ data: null }),
        };
        return updateChain;
      },
      then: (resolve: (value: Queued) => void) => resolve(next()),
    };
    return obj;
  }

  const supabase = { from: (table: string) => chain(table) } as unknown as Parameters<typeof respondToConversation>[0];
  return { supabase, inserted, updated, touchedTables };
}

const PARAMS = { organizationId: "org-1", conversationId: "conv-1", leadId: "lead-1" };

function conversationRow(overrides: Partial<{ channel: string; owner: string; campaign_id: string | null; buying_intent: string | null }> = {}): Queued {
  return { data: { id: "conv-1", channel: "email", owner: "ai", campaign_id: null, buying_intent: null, ...overrides } };
}

describe("respondToConversation", () => {
  afterEach(() => vi.clearAllMocks());

  it("does nothing when the conversation is human-owned — the entire takeover mechanism", async () => {
    const { supabase } = makeAdminClient({ conversations: [conversationRow({ owner: "human" })] });

    const result = await respondToConversation(supabase, PARAMS);

    expect(result).toEqual({ ok: true, replied: false, reason: "human_owned" });
    expect(resolveLeadIdentity).not.toHaveBeenCalled();
    expect(generateConversationReply).not.toHaveBeenCalled();
  });

  it("reports not_found when the conversation does not exist for this organization", async () => {
    // No conversations row queued at all — maybeSingle resolves to { data: null }.
    const { supabase } = makeAdminClient({});
    const result = await respondToConversation(supabase, PARAMS);
    expect(result).toEqual({ ok: true, replied: false, reason: "not_found" });
  });

  it("reports no_recipient when the channel is email and the lead has no email on file", async () => {
    vi.mocked(resolveLeadIdentity).mockResolvedValue({ ...IDENTITY, email: null });
    const { supabase } = makeAdminClient({
      conversations: [conversationRow()],
      messages: [{ data: [] }],
    });

    const result = await respondToConversation(supabase, PARAMS);
    expect(result).toEqual({ ok: true, replied: false, reason: "no_recipient" });
  });

  it("generates a reply, sends it through Gmail for an email conversation, and returns the real message id", async () => {
    vi.mocked(resolveLeadIdentity).mockResolvedValue(IDENTITY);
    vi.mocked(getBusinessContext).mockResolvedValue(EMPTY_BUSINESS_CONTEXT);
    vi.mocked(detectIntent).mockResolvedValue({ ok: true, analysis: { intent: "HIGH_INTENT", confidence: "high", reasoning: "Asked for pricing", detectedObjections: [], detectedBuyingSignals: ["asked for pricing"], recommendedNextAction: "Send price" } });
    vi.mocked(generateConversationReply).mockResolvedValue({ ok: true, reply: VALID_REPLY });
    vi.mocked(sendGmailMessage).mockResolvedValue({ ok: true, messageId: "gmail-msg-1", threadId: "thread-1", fromAddress: "studio@example.com" });
    vi.mocked(createAgentRun).mockResolvedValue({ id: "run-1" });

    const { supabase, inserted, updated, touchedTables } = makeAdminClient({
      conversations: [conversationRow()],
      messages: [{ data: [] }, { data: { id: "reserved-msg-1" } }],
    });

    const result = await respondToConversation(supabase, PARAMS);

    expect(result).toEqual({ ok: true, replied: true, messageId: "gmail-msg-1" });
    expect(sendGmailMessage).toHaveBeenCalledWith(expect.objectContaining({ to: "priya@example.com", body: VALID_REPLY.message }));
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();

    const reservedInsert = inserted.find((i) => i.table === "messages");
    expect(reservedInsert?.values).toMatchObject({ direction: "outbound", channel: "email", sender_type: "agent", body: VALID_REPLY.message });

    const conversationUpdates = updated.filter((u) => u.table === "conversations");
    expect(conversationUpdates.some((u) => (u.values as { buying_intent?: string }).buying_intent === "high")).toBe(true);
    const leadUpdates = updated.filter((u) => u.table === "leads");
    expect(leadUpdates.some((u) => (u.values as { buying_intent?: string }).buying_intent === "high")).toBe(true);

    // The AI conversation agent has no path to the deals table at all — a
    // "high" buying intent updates the conversation/lead record only;
    // marking a deal WON stays a human action via the Deals UI.
    expect(touchedTables).not.toContain("deals");
  });

  it("sends through WhatsApp instead of Gmail for a whatsapp conversation", async () => {
    vi.mocked(resolveLeadIdentity).mockResolvedValue(IDENTITY);
    vi.mocked(getBusinessContext).mockResolvedValue(EMPTY_BUSINESS_CONTEXT);
    vi.mocked(detectIntent).mockResolvedValue({ ok: false, message: "not configured" });
    vi.mocked(generateConversationReply).mockResolvedValue({ ok: true, reply: VALID_REPLY });
    vi.mocked(sendWhatsAppMessage).mockResolvedValue({ ok: true, messageId: "wamid-1" });
    vi.mocked(createAgentRun).mockResolvedValue({ id: "run-1" });

    const { supabase } = makeAdminClient({
      conversations: [conversationRow({ channel: "whatsapp", buying_intent: "medium" })],
      messages: [{ data: [] }, { data: { id: "reserved-msg-1" } }],
    });

    const result = await respondToConversation(supabase, PARAMS);

    expect(result).toEqual({ ok: true, replied: true, messageId: "wamid-1" });
    expect(sendWhatsAppMessage).toHaveBeenCalledWith(expect.objectContaining({ to: "+919876543210", body: VALID_REPLY.message }));
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

  it("never inserts an outbound message when reply generation fails", async () => {
    vi.mocked(resolveLeadIdentity).mockResolvedValue(IDENTITY);
    vi.mocked(getBusinessContext).mockResolvedValue(EMPTY_BUSINESS_CONTEXT);
    vi.mocked(detectIntent).mockResolvedValue({ ok: false, message: "not configured" });
    vi.mocked(generateConversationReply).mockResolvedValue({ ok: false, message: "The AI provider returned an unexpected response." });
    vi.mocked(createAgentRun).mockResolvedValue({ id: "run-1" });

    const { supabase, inserted } = makeAdminClient({
      conversations: [conversationRow()],
      messages: [{ data: [] }],
    });

    const result = await respondToConversation(supabase, PARAMS);

    expect(result).toEqual({ ok: true, replied: false, reason: "reply_generation_failed" });
    expect(inserted.some((i) => i.table === "messages")).toBe(false);
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

  it("marks the reserved message failed, and reports send_failed, when the reply was generated but the channel send failed", async () => {
    vi.mocked(resolveLeadIdentity).mockResolvedValue(IDENTITY);
    vi.mocked(getBusinessContext).mockResolvedValue(EMPTY_BUSINESS_CONTEXT);
    vi.mocked(detectIntent).mockResolvedValue({ ok: false, message: "not configured" });
    vi.mocked(generateConversationReply).mockResolvedValue({ ok: true, reply: VALID_REPLY });
    vi.mocked(sendGmailMessage).mockResolvedValue({ ok: false, code: "reauth_required", message: "Reconnect Gmail." });
    vi.mocked(createAgentRun).mockResolvedValue({ id: "run-1" });

    const { supabase, updated } = makeAdminClient({
      conversations: [conversationRow()],
      messages: [{ data: [] }, { data: { id: "reserved-msg-1" } }],
    });

    const result = await respondToConversation(supabase, PARAMS);

    expect(result).toEqual({ ok: true, replied: false, reason: "send_failed" });
    const failedUpdate = updated.find((u) => u.table === "messages");
    expect(failedUpdate?.values).toMatchObject({ status: "failed" });
  });

  it("still generates and sends a reply when intent detection itself fails, falling back to the conversation's existing buying_intent", async () => {
    vi.mocked(resolveLeadIdentity).mockResolvedValue(IDENTITY);
    vi.mocked(getBusinessContext).mockResolvedValue(EMPTY_BUSINESS_CONTEXT);
    vi.mocked(detectIntent).mockResolvedValue({ ok: false, message: "The AI provider is rate-limiting requests right now — try again shortly." });
    vi.mocked(generateConversationReply).mockResolvedValue({ ok: true, reply: VALID_REPLY });
    vi.mocked(sendGmailMessage).mockResolvedValue({ ok: true, messageId: "gmail-msg-2", threadId: "thread-1", fromAddress: "studio@example.com" });
    vi.mocked(createAgentRun).mockResolvedValue({ id: "run-1" });

    const { supabase } = makeAdminClient({
      conversations: [conversationRow({ buying_intent: "low" })],
      messages: [{ data: [] }, { data: { id: "reserved-msg-1" } }],
    });

    const result = await respondToConversation(supabase, PARAMS);

    expect(result).toEqual({ ok: true, replied: true, messageId: "gmail-msg-2" });
    expect(generateConversationReply).toHaveBeenCalledWith(expect.objectContaining({ buyingIntent: "low" }));
  });
});
