import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/outreach/conversation", () => ({ ensureConversation: vi.fn() }));
vi.mock("@/lib/conversation-agent/respond", () => ({ respondToConversation: vi.fn() }));
vi.mock("@/lib/whatsapp/tokens", () => ({ findOrgByPhoneNumberId: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { ensureConversation } from "@/lib/outreach/conversation";
import { respondToConversation } from "@/lib/conversation-agent/respond";
import { findOrgByPhoneNumberId } from "@/lib/whatsapp/tokens";
import { GET, POST } from "@/app/api/whatsapp/webhook/route";

const WEBHOOK_URL = "https://business-badhao.example.com/api/whatsapp/webhook";

type Row = Record<string, unknown>;

function makeAdminClient(config: { contacts?: Row[]; prospects?: Row[]; leadForProspect?: Row | null; existingMessage?: Row | null }) {
  const inserted: { table: string; values: Row }[] = [];
  const updated: { table: string; values: Row }[] = [];

  const from = (table: string) => {
    if (table === "contacts") {
      return { select: () => ({ eq: () => ({ not: async () => ({ data: config.contacts ?? [] }) }) }) };
    }
    if (table === "prospects") {
      return { select: () => ({ eq: () => ({ not: async () => ({ data: config.prospects ?? [] }) }) }) };
    }
    if (table === "leads") {
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: config.leadForProspect ?? null }) }) }) }) };
    }
    if (table === "messages") {
      return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: config.existingMessage ?? null }) }) }) }),
        insert: (values: Row) => {
          inserted.push({ table, values });
          return Promise.resolve({ data: null, error: null });
        },
      };
    }
    return {
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
      insert: (values: Row) => {
        inserted.push({ table, values });
        return Promise.resolve({ data: null, error: null });
      },
      update: (values: Row) => ({
        eq: () => {
          updated.push({ table, values });
          return Promise.resolve({ data: null, error: null });
        },
      }),
    };
  };

  return { from, __inserted: inserted, __updated: updated } as unknown as ReturnType<typeof createAdminClient> & {
    __inserted: { table: string; values: Row }[];
    __updated: { table: string; values: Row }[];
  };
}

function textMessagePayload(overrides?: Partial<{ phoneNumberId: string; from: string; body: string; messageId: string; type: string }>) {
  return {
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: overrides?.phoneNumberId ?? "111222333" },
              messages: [
                {
                  from: overrides?.from ?? "919876543210",
                  id: overrides?.messageId ?? "wamid.ABC123",
                  type: overrides?.type ?? "text",
                  text: overrides?.type === "image" ? undefined : { body: overrides?.body ?? "Tell me more about pricing" },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe("WhatsApp webhook GET (verification handshake)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  });

  it("echoes hub.challenge when the mode and verify token match", async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "correct-secret";
    const url = `${WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token=correct-secret&hub.challenge=challenge-123`;
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-123");
  });

  it("rejects with 403 when the verify token does not match", async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "correct-secret";
    const url = `${WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token=wrong-secret&hub.challenge=challenge-123`;
    const response = await GET(new Request(url));
    expect(response.status).toBe(403);
  });

  it("reports 503 when no verify token is configured for this deployment, rather than a fake success", async () => {
    const url = `${WEBHOOK_URL}?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=challenge-123`;
    const response = await GET(new Request(url));
    expect(response.status).toBe(503);
  });
});

describe("WhatsApp webhook POST (inbound messages)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.WHATSAPP_APP_SECRET;
  });

  function postRequest(body: unknown, headers: Record<string, string> = {}) {
    return new Request(WEBHOOK_URL, { method: "POST", headers, body: JSON.stringify(body) });
  }

  it("rejects a payload with an invalid X-Hub-Signature-256 when WHATSAPP_APP_SECRET is configured", async () => {
    process.env.WHATSAPP_APP_SECRET = "app-secret";
    const response = await POST(postRequest(textMessagePayload(), { "x-hub-signature-256": "sha256=deadbeef" }));
    expect(response.status).toBe(401);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("accepts a payload with a valid X-Hub-Signature-256", async () => {
    process.env.WHATSAPP_APP_SECRET = "app-secret";
    vi.mocked(findOrgByPhoneNumberId).mockResolvedValue({ organizationId: "org-1", phoneNumberId: "111222333", accessToken: "tok" });
    vi.mocked(ensureConversation).mockResolvedValue({ ok: true, conversationId: "conv-1" });
    vi.mocked(respondToConversation).mockResolvedValue({ ok: true, replied: true, messageId: "wamid.reply" });
    vi.mocked(createAdminClient).mockReturnValue(makeAdminClient({ contacts: [{ lead_id: "lead-1", phone: "+91 98765 43210" }] }));

    const rawBody = JSON.stringify(textMessagePayload());
    const validSignature = "sha256=" + crypto.createHmac("sha256", "app-secret").update(rawBody).digest("hex");
    const response = await POST(new Request(WEBHOOK_URL, { method: "POST", headers: { "x-hub-signature-256": validSignature }, body: rawBody }));

    expect(response.status).toBe(200);
  });

  it("skips signature verification entirely when WHATSAPP_APP_SECRET is not set, rather than blocking the feature", async () => {
    vi.mocked(findOrgByPhoneNumberId).mockResolvedValue({ organizationId: "org-1", phoneNumberId: "111222333", accessToken: "tok" });
    vi.mocked(ensureConversation).mockResolvedValue({ ok: true, conversationId: "conv-1" });
    vi.mocked(respondToConversation).mockResolvedValue({ ok: true, replied: true, messageId: "wamid.reply" });
    vi.mocked(createAdminClient).mockReturnValue(makeAdminClient({ contacts: [{ lead_id: "lead-1", phone: "+91 98765 43210" }] }));

    const response = await POST(postRequest(textMessagePayload()));
    expect(response.status).toBe(200);
  });

  it("matches an inbound sender to a contact's phone number after normalizing formatting differences, stores the message, and triggers the AI conversation agent", async () => {
    vi.mocked(findOrgByPhoneNumberId).mockResolvedValue({ organizationId: "org-1", phoneNumberId: "111222333", accessToken: "tok" });
    vi.mocked(ensureConversation).mockResolvedValue({ ok: true, conversationId: "conv-1" });
    vi.mocked(respondToConversation).mockResolvedValue({ ok: true, replied: true, messageId: "wamid.reply" });
    const admin = makeAdminClient({ contacts: [{ lead_id: "lead-1", phone: "+91 98765-43210" }] });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const response = await POST(postRequest(textMessagePayload({ from: "919876543210", body: "What's the price?" })));

    expect(response.status).toBe(200);
    expect(admin.__inserted).toHaveLength(1);
    expect(admin.__inserted[0]).toMatchObject({ table: "messages", values: expect.objectContaining({ direction: "inbound", sender_type: "lead", lead_id: "lead-1", conversation_id: "conv-1", body: "What's the price?" }) });
    expect(respondToConversation).toHaveBeenCalledWith(expect.anything(), { organizationId: "org-1", conversationId: "conv-1", leadId: "lead-1" });
  });

  it("skips the payload silently when phone_number_id matches no connected organization, without fabricating one", async () => {
    vi.mocked(findOrgByPhoneNumberId).mockResolvedValue(null);
    const admin = makeAdminClient({});
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const response = await POST(postRequest(textMessagePayload()));
    expect(response.status).toBe(200);
    expect(admin.__inserted).toHaveLength(0);
    expect(ensureConversation).not.toHaveBeenCalled();
  });

  it("skips a sender phone that matches no known contact or prospect, without fabricating a lead association", async () => {
    vi.mocked(findOrgByPhoneNumberId).mockResolvedValue({ organizationId: "org-1", phoneNumberId: "111222333", accessToken: "tok" });
    const admin = makeAdminClient({ contacts: [], prospects: [] });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const response = await POST(postRequest(textMessagePayload({ from: "911111111111" })));
    expect(response.status).toBe(200);
    expect(admin.__inserted).toHaveLength(0);
    expect(ensureConversation).not.toHaveBeenCalled();
  });

  it("does not insert a duplicate message for an external_id already stored", async () => {
    vi.mocked(findOrgByPhoneNumberId).mockResolvedValue({ organizationId: "org-1", phoneNumberId: "111222333", accessToken: "tok" });
    const admin = makeAdminClient({ contacts: [{ lead_id: "lead-1", phone: "919876543210" }], existingMessage: { id: "existing-row" } });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const response = await POST(postRequest(textMessagePayload()));
    expect(response.status).toBe(200);
    expect(admin.__inserted).toHaveLength(0);
    expect(respondToConversation).not.toHaveBeenCalled();
  });

  it("stores a non-text message with an honest placeholder instead of inventing a transcription, and does not trigger an AI reply for it", async () => {
    vi.mocked(findOrgByPhoneNumberId).mockResolvedValue({ organizationId: "org-1", phoneNumberId: "111222333", accessToken: "tok" });
    vi.mocked(ensureConversation).mockResolvedValue({ ok: true, conversationId: "conv-1" });
    const admin = makeAdminClient({ contacts: [{ lead_id: "lead-1", phone: "919876543210" }] });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    const response = await POST(postRequest(textMessagePayload({ type: "image" })));

    expect(response.status).toBe(200);
    expect(admin.__inserted[0].values.body).toBe("[Received a image message — not yet supported]");
    expect(respondToConversation).not.toHaveBeenCalled();
  });
});
