import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/gmail/tokens", () => ({
  getValidAccessToken: vi.fn(),
  getLastHistoryId: vi.fn(),
  setLastHistoryId: vi.fn(),
}));
vi.mock("@/lib/outreach/conversation", () => ({ ensureConversation: vi.fn() }));
vi.mock("@/lib/conversation-agent/respond", () => ({ respondToConversation: vi.fn() }));

import { createAdminClient } from "@/lib/supabase/admin";
import { getLastHistoryId, getValidAccessToken, setLastHistoryId } from "@/lib/gmail/tokens";
import { ensureConversation } from "@/lib/outreach/conversation";
import { respondToConversation } from "@/lib/conversation-agent/respond";
import { checkForReplies, extractEmailAddress, extractPlainTextBody } from "@/lib/gmail/replies";

describe("extractEmailAddress", () => {
  it("pulls the address out of a display-name header", () => {
    expect(extractEmailAddress("Priya Sharma <priya@example.com>")).toBe("priya@example.com");
  });

  it("accepts a bare address with no display name", () => {
    expect(extractEmailAddress("priya@example.com")).toBe("priya@example.com");
  });

  it("lowercases the address", () => {
    expect(extractEmailAddress("Priya <Priya@Example.COM>")).toBe("priya@example.com");
  });

  it("returns null for a header with no valid address", () => {
    expect(extractEmailAddress("not an email header")).toBeNull();
  });
});

describe("extractPlainTextBody", () => {
  function b64url(text: string) {
    return Buffer.from(text, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  }

  it("decodes a single text/plain payload", () => {
    const body = extractPlainTextBody({ mimeType: "text/plain", body: { data: b64url("Sounds good, let's proceed.") } });
    expect(body).toBe("Sounds good, let's proceed.");
  });

  it("finds the text/plain part inside a multipart payload", () => {
    const body = extractPlainTextBody({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<p>Sounds good</p>") } },
        { mimeType: "text/plain", body: { data: b64url("Sounds good") } },
      ],
    });
    expect(body).toBe("Sounds good");
  });

  it("recurses into nested multipart parts", () => {
    const body = extractPlainTextBody({
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64url("Nested reply") } }] }],
    });
    expect(body).toBe("Nested reply");
  });
});

type Row = Record<string, unknown>;

function makeAdminClient(config: {
  contactMatch?: Row | null;
  prospectMatch?: Row | null;
  leadMatch?: Row | null;
  existingMessage?: Row | null;
}) {
  const inserted: Row[] = [];
  const updated: { table: string; values: Row }[] = [];

  const from = (table: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (table === "messages") return { data: config.existingMessage ?? null };
            if (table === "contacts") return { data: config.contactMatch ?? null };
            if (table === "prospects") return { data: config.prospectMatch ?? null };
            if (table === "leads") return { data: config.leadMatch ?? null };
            return { data: null };
          },
        }),
      }),
    }),
    insert: (values: Row) => {
      inserted.push(values);
      return Promise.resolve({ data: null, error: null });
    },
    update: (values: Row) => ({
      eq: () => {
        updated.push({ table, values });
        return Promise.resolve({ data: null, error: null });
      },
    }),
  });

  return { from, __inserted: inserted, __updated: updated } as unknown as ReturnType<typeof createAdminClient> & {
    __inserted: Row[];
    __updated: { table: string; values: Row }[];
  };
}

function mockGmailFetch(responses: Record<string, { status: number; body: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const match = Object.keys(responses).find((key) => url.includes(key));
      const response = match ? responses[match] : { status: 404, body: {} };
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        json: async () => response.body,
        text: async () => JSON.stringify(response.body),
      };
    })
  );
}

describe("checkForReplies", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports not_connected without calling Gmail at all", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ ok: false, code: "not_connected", message: "No Gmail account is connected." });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await checkForReplies("org-1");
    expect(result).toEqual({ ok: false, code: "not_connected", message: "No Gmail account is connected." });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("on the first-ever check, baselines the history cursor and reports zero replies without scanning history", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ ok: true, accessToken: "at", emailAddress: "studio@example.com" });
    vi.mocked(getLastHistoryId).mockResolvedValue(null);
    vi.mocked(createAdminClient).mockReturnValue(makeAdminClient({}));
    mockGmailFetch({ "/profile": { status: 200, body: { emailAddress: "studio@example.com", historyId: "1000" } } });

    const result = await checkForReplies("org-1");
    expect(result).toEqual({ ok: true, newReplies: 0, matchedLeadIds: [], unmatchedSenders: [] });
    expect(setLastHistoryId).toHaveBeenCalledWith("org-1", "1000");
  });

  it("matches a reply from a known contact's email and stores it against that lead's conversation", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ ok: true, accessToken: "at", emailAddress: "studio@example.com" });
    vi.mocked(getLastHistoryId).mockResolvedValue("900");
    vi.mocked(ensureConversation).mockResolvedValue({ ok: true, conversationId: "conv-1" });
    const admin = makeAdminClient({ contactMatch: { lead_id: "lead-1" } });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    mockGmailFetch({
      "/profile": { status: 200, body: { emailAddress: "studio@example.com", historyId: "1000" } },
      "/history": {
        status: 200,
        body: { history: [{ messagesAdded: [{ message: { id: "gm-1", labelIds: ["INBOX"] } }] }], historyId: "1000" },
      },
      "/messages/gm-1": {
        status: 200,
        body: {
          id: "gm-1",
          threadId: "thread-1",
          payload: {
            headers: [
              { name: "From", value: "Priya Sharma <priya@example.com>" },
              { name: "Subject", value: "Re: Website proposal" },
            ],
            mimeType: "text/plain",
            body: { data: Buffer.from("Sounds good, let's proceed.").toString("base64") },
          },
        },
      },
    });

    const result = await checkForReplies("org-1");
    expect(result).toEqual({ ok: true, newReplies: 1, matchedLeadIds: ["lead-1"], unmatchedSenders: [] });
    expect(admin.__inserted).toHaveLength(1);
    expect(admin.__inserted[0]).toMatchObject({ direction: "inbound", sender_type: "lead", lead_id: "lead-1", conversation_id: "conv-1" });
  });

  it("triggers the AI conversation agent for the matched lead's conversation after storing the inbound message", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ ok: true, accessToken: "at", emailAddress: "studio@example.com" });
    vi.mocked(getLastHistoryId).mockResolvedValue("900");
    vi.mocked(ensureConversation).mockResolvedValue({ ok: true, conversationId: "conv-1" });
    vi.mocked(respondToConversation).mockResolvedValue({ ok: true, replied: true, messageId: "wamid-or-gmail-id" });
    vi.mocked(createAdminClient).mockReturnValue(makeAdminClient({ contactMatch: { lead_id: "lead-1" } }));

    mockGmailFetch({
      "/profile": { status: 200, body: { emailAddress: "studio@example.com", historyId: "1000" } },
      "/history": { status: 200, body: { history: [{ messagesAdded: [{ message: { id: "gm-1", labelIds: ["INBOX"] } }] }], historyId: "1000" } },
      "/messages/gm-1": {
        status: 200,
        body: {
          id: "gm-1",
          threadId: "thread-1",
          payload: { headers: [{ name: "From", value: "priya@example.com" }], mimeType: "text/plain", body: { data: Buffer.from("Tell me more").toString("base64") } },
        },
      },
    });

    await checkForReplies("org-1");

    expect(respondToConversation).toHaveBeenCalledWith(expect.anything(), { organizationId: "org-1", conversationId: "conv-1", leadId: "lead-1" });
  });

  it("still records the inbound message even when the AI conversation agent does not reply (e.g. the conversation is human-owned)", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ ok: true, accessToken: "at", emailAddress: "studio@example.com" });
    vi.mocked(getLastHistoryId).mockResolvedValue("900");
    vi.mocked(ensureConversation).mockResolvedValue({ ok: true, conversationId: "conv-1" });
    vi.mocked(respondToConversation).mockResolvedValue({ ok: true, replied: false, reason: "human_owned" });
    const admin = makeAdminClient({ contactMatch: { lead_id: "lead-1" } });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    mockGmailFetch({
      "/profile": { status: 200, body: { emailAddress: "studio@example.com", historyId: "1000" } },
      "/history": { status: 200, body: { history: [{ messagesAdded: [{ message: { id: "gm-1", labelIds: ["INBOX"] } }] }], historyId: "1000" } },
      "/messages/gm-1": {
        status: 200,
        body: {
          id: "gm-1",
          threadId: "thread-1",
          payload: { headers: [{ name: "From", value: "priya@example.com" }], mimeType: "text/plain", body: { data: Buffer.from("Tell me more").toString("base64") } },
        },
      },
    });

    const result = await checkForReplies("org-1");
    expect(result).toEqual({ ok: true, newReplies: 1, matchedLeadIds: ["lead-1"], unmatchedSenders: [] });
    expect(admin.__inserted).toHaveLength(1);
  });

  it("skips a sender that matches no known contact or prospect, without fabricating a lead association", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ ok: true, accessToken: "at", emailAddress: "studio@example.com" });
    vi.mocked(getLastHistoryId).mockResolvedValue("900");
    const admin = makeAdminClient({ contactMatch: null, prospectMatch: null });
    vi.mocked(createAdminClient).mockReturnValue(admin);

    mockGmailFetch({
      "/profile": { status: 200, body: { emailAddress: "studio@example.com", historyId: "1000" } },
      "/history": {
        status: 200,
        body: { history: [{ messagesAdded: [{ message: { id: "gm-2", labelIds: ["INBOX"] } }] }], historyId: "1000" },
      },
      "/messages/gm-2": {
        status: 200,
        body: { id: "gm-2", threadId: "thread-2", payload: { headers: [{ name: "From", value: "stranger@example.com" }] } },
      },
    });

    const result = await checkForReplies("org-1");
    expect(result).toEqual({ ok: true, newReplies: 0, matchedLeadIds: [], unmatchedSenders: ["stranger@example.com"] });
    expect(admin.__inserted).toHaveLength(0);
    expect(ensureConversation).not.toHaveBeenCalled();
  });

  it("re-baselines instead of failing when Gmail reports the history cursor is stale (404)", async () => {
    vi.mocked(getValidAccessToken).mockResolvedValue({ ok: true, accessToken: "at", emailAddress: "studio@example.com" });
    vi.mocked(getLastHistoryId).mockResolvedValue("very-old-id");
    vi.mocked(createAdminClient).mockReturnValue(makeAdminClient({}));

    mockGmailFetch({
      "/profile": { status: 200, body: { emailAddress: "studio@example.com", historyId: "5000" } },
      "/history": { status: 404, body: { error: "startHistoryId too old" } },
    });

    const result = await checkForReplies("org-1");
    expect(result).toEqual({ ok: true, newReplies: 0, matchedLeadIds: [], unmatchedSenders: [] });
    expect(setLastHistoryId).toHaveBeenCalledWith("org-1", "5000");
  });
});
