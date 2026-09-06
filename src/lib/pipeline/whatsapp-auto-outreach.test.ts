import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Proves sendAutomaticWhatsAppOutreach — the function finishPendingLeads
// calls right after a lead qualifies (see scheduled-pipeline.ts) — actually
// sends real WhatsApp API requests (mocked at the HTTP boundary, not the
// function under test) and gets every safety property right: no duplicate
// initial message across repeated scheduler runs, a bounded retry after a
// real failure, org isolation, and honest reporting of why a lead was left
// unmessaged. getWhatsAppAutomationConfig/getWhatsAppCredentials and Gmail's
// getConnectionStatus are the only things mocked — both are thin
// admin-client reads with no logic of their own to verify; everything this
// file actually exists to prove (channel selection, dedup, retry, send
// outcome handling, status transitions) runs for real against the fake
// Supabase tables and real OpenRouter/WhatsApp Graph API request shapes.

vi.mock("@/lib/whatsapp/tokens", () => ({ getWhatsAppAutomationConfig: vi.fn(), getWhatsAppCredentials: vi.fn() }));
vi.mock("@/lib/gmail/tokens", () => ({ getConnectionStatus: vi.fn() }));

import { DEFAULT_OPENROUTER_MODEL } from "@/lib/ai/providers/openrouter";
import { getConnectionStatus as getGmailConnectionStatus } from "@/lib/gmail/tokens";
import { sendAutomaticWhatsAppOutreach } from "@/lib/pipeline/lead-pipeline";
import { getWhatsAppAutomationConfig, getWhatsAppCredentials } from "@/lib/whatsapp/tokens";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const WHATSAPP_MESSAGES_URL = "https://graph.facebook.com/v20.0/1234567890/messages";

const CONNECTED_WITH_TEMPLATE = { connected: true, templateName: "first_outreach", templateLanguage: "en_US" };
const VALID_CREDENTIALS = { ok: true as const, credentials: { organizationId: "org-1", phoneNumberId: "1234567890", accessToken: "wa-token" } };

// Same generic in-memory Supabase stand-in used across this pipeline's other
// test files (lead-pipeline.test.ts, scheduled-pipeline.test.ts) — a small
// local fake per file is this codebase's existing convention. Extended here
// with .in(), which resolveLeadIdentity (lead-names.ts) needs and the other
// files' copies don't.
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function createFakeSupabase(tables: Tables) {
  let counter = 0;

  function builder(table: string) {
    tables[table] = tables[table] ?? [];
    const filters: ((row: Row) => boolean)[] = [];
    let orderSpec: { column: string; ascending: boolean } | null = null;
    let limitN: number | null = null;
    let pendingInsert: Row | Row[] | null = null;
    let pendingUpdate: Row | null = null;

    function execute(): Row[] {
      if (pendingInsert) {
        const items = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        const inserted = items.map((item) => ({ id: `${table}-${++counter}`, created_at: new Date().toISOString(), ...item }));
        tables[table].push(...inserted);
        return inserted;
      }
      if (pendingUpdate) {
        const update = pendingUpdate;
        tables[table] = tables[table].map((row) => (filters.every((f) => f(row)) ? { ...row, ...update } : row));
        return tables[table].filter((row) => filters.every((f) => f(row)));
      }
      let rows = tables[table].filter((row) => filters.every((f) => f(row)));
      if (orderSpec) {
        const { column, ascending } = orderSpec;
        rows = [...rows].sort((a, b) => {
          const av = String(a[column] ?? "");
          const bv = String(b[column] ?? "");
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }

    const api = {
      select() {
        return api;
      },
      insert(payload: Row | Row[]) {
        pendingInsert = payload;
        return api;
      },
      update(payload: Row) {
        pendingUpdate = payload;
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return api;
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.includes(row[column]));
        return api;
      },
      order(column: string, opts?: { ascending?: boolean }) {
        orderSpec = { column, ascending: opts?.ascending ?? true };
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      async maybeSingle() {
        const rows = execute();
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        const rows = execute();
        return rows[0] ? { data: rows[0], error: null } : { data: null, error: { message: "no matching row" } };
      },
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        resolve({ data: execute(), error: null });
      },
    };

    return api;
  }

  return { from: (table: string) => builder(table) } as never;
}

function openRouterResponse(body: unknown, model = DEFAULT_OPENROUTER_MODEL) {
  return new Response(
    JSON.stringify({
      id: "req-1",
      model,
      choices: [{ message: { content: JSON.stringify(body) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

const VALID_DRAFT = {
  subject: null,
  message: "Hi Bright Pixel — we help studios like yours modernize client-facing sites. Want a quick look at what we'd change?",
  talkingPoints: ["Modernize the site"],
  personalizationUsed: ["Company name"],
};

/** Combines outreach-generation and WhatsApp send mocking — every test needing a real send needs both. */
function stubOutreachAndSend(sendResponse: { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === OPENROUTER_URL) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const systemPrompt = String(body.messages?.[0]?.content ?? "");
        if (systemPrompt.includes("AI outreach writer")) return openRouterResponse(VALID_DRAFT);
        throw new Error(`unexpected OpenRouter call: ${systemPrompt.slice(0, 80)}`);
      }
      if (url === WHATSAPP_MESSAGES_URL) {
        return {
          ok: sendResponse.status >= 200 && sendResponse.status < 300,
          status: sendResponse.status,
          json: async () => sendResponse.body,
          text: async () => JSON.stringify(sendResponse.body),
        };
      }
      throw new Error(`unexpected fetch url in this test: ${url}`);
    })
  );
}

function seedTables(overrides: Partial<Row> = {}): Tables {
  return {
    leads: [
      {
        id: "lead-1",
        organization_id: "org-1",
        status: "new",
        campaign_id: "campaign-1",
        prospect_id: "prospect-1",
        ...overrides,
      },
    ],
    contacts: [],
    prospects: [{ id: "prospect-1", company_name: "Bright Pixel", website: "brightpixel.in", title: null, email: null, phone: "+91 98765 43210", contact_name: null }],
    campaigns: [
      {
        id: "campaign-1",
        organization_id: "org-1",
        name: "Pune Web Design Push",
        objective: "Find web design agencies",
        ideal_customer_profile_id: null,
        whatsapp_auto_outreach_enabled: true,
      },
    ],
    messages: [],
  };
}

const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "AI_PROVIDER", "AI_FALLBACK_PROVIDER"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("sendAutomaticWhatsAppOutreach", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.OPENROUTER_MODEL;
    delete process.env.AI_PROVIDER;
    delete process.env.AI_FALLBACK_PROVIDER;
    vi.mocked(getGmailConnectionStatus).mockResolvedValue({ connected: false, emailAddress: null });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("first send: generates, sends via the approved template, marks the lead contacted, and persists a real outbound message", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    stubOutreachAndSend({ status: 200, body: { messages: [{ id: "wamid.first" }] } });

    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");

    expect(result).toEqual({ attempted: true, ok: true, channel: "whatsapp", messageId: "wamid.first" });

    const lead = (tables.leads as (Row & { status: string })[])[0];
    expect(lead.status).toBe("contacted");

    const messages = tables.messages as (Row & { channel: string; direction: string; status: string; body: string; to_address: string })[];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ channel: "whatsapp", direction: "outbound", status: "sent", to_address: "919876543210" });
    expect(messages[0].body).toBe(VALID_DRAFT.message);

    const conversations = tables.conversations as (Row & { channel: string; lead_id: string })[];
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ channel: "whatsapp", lead_id: "lead-1" });
  });

  it("repeated scheduler execution: a lead already contacted is never messaged again — nothing is even fetched from OpenRouter/WhatsApp", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const tables = seedTables({ status: "contacted" });
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");

    expect(result).toEqual({ attempted: false, channel: "none", reason: "already_contacted" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("duplicate scheduler execution before the status flip: a prior 'sent' message for this lead+channel blocks a second send even if status somehow lagged", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const tables = seedTables();
    tables.messages = [
      { id: "msg-1", organization_id: "org-1", lead_id: "lead-1", channel: "whatsapp", direction: "outbound", status: "sent", metadata: { automationKind: "initial_outreach" } },
    ];
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");

    expect(result).toEqual({ attempted: false, channel: "none", reason: "already_sent" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("API/network failure: records a failed message, never marks the lead contacted, and reports the real code — never claims sent", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === OPENROUTER_URL) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          if (String(body.messages?.[0]?.content ?? "").includes("AI outreach writer")) return openRouterResponse(VALID_DRAFT);
        }
        if (url === WHATSAPP_MESSAGES_URL) throw new Error("fetch failed: network timeout");
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );

    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");

    expect(result).toMatchObject({ attempted: true, ok: false, channel: "whatsapp", code: "network_error" });
    const lead = (tables.leads as (Row & { status: string })[])[0];
    expect(lead.status).toBe("new");
    const messages = tables.messages as (Row & { status: string })[];
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("failed");
  });

  it("a provider rejection (e.g. Meta's real error) is recorded as failed, not silently treated as sent", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    stubOutreachAndSend({ status: 500, body: { error: { message: "Internal error", code: 1 } } });

    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");

    expect(result).toMatchObject({ attempted: true, ok: false, channel: "whatsapp", code: "send_failed" });
    const lead = (tables.leads as (Row & { status: string })[])[0];
    expect(lead.status).toBe("new");
  });

  it("retry after a prior failure: a later sweep succeeds and the lead ends up with exactly one failed and one sent message, never two sent", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);

    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    stubOutreachAndSend({ status: 500, body: { error: { message: "temporary", code: 1 } } });
    const firstAttempt = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");
    expect(firstAttempt).toMatchObject({ attempted: true, ok: false });

    stubOutreachAndSend({ status: 200, body: { messages: [{ id: "wamid.retry" }] } });
    const secondAttempt = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");
    expect(secondAttempt).toEqual({ attempted: true, ok: true, channel: "whatsapp", messageId: "wamid.retry" });

    const lead = (tables.leads as (Row & { status: string })[])[0];
    expect(lead.status).toBe("contacted");
    const messages = tables.messages as (Row & { status: string })[];
    expect(messages.filter((m) => m.status === "failed")).toHaveLength(1);
    expect(messages.filter((m) => m.status === "sent")).toHaveLength(1);
  });

  it("bounded retry: after the maximum recorded failures, a later sweep stops trying instead of retrying forever", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const tables = seedTables();
    tables.messages = [1, 2, 3].map((n) => ({
      id: `msg-${n}`,
      organization_id: "org-1",
      lead_id: "lead-1",
      channel: "whatsapp",
      direction: "outbound",
      status: "failed",
      metadata: { automationKind: "initial_outreach" },
    }));
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");

    expect(result).toEqual({ attempted: false, channel: "none", reason: "max_attempts_reached" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("duplicate lead: two different leads sharing the same phone number are each sent to independently, exactly once each", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    stubOutreachAndSend({ status: 200, body: { messages: [{ id: "wamid.dup" }] } });

    const tables = seedTables();
    tables.leads.push({ id: "lead-2", organization_id: "org-1", status: "new", campaign_id: "campaign-1", prospect_id: "prospect-2" });
    tables.prospects.push({ id: "prospect-2", company_name: "Bright Pixel Two", website: null, title: null, email: null, phone: "+91 98765 43210", contact_name: null });
    const supabase = createFakeSupabase(tables);

    const r1 = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");
    const r2 = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-2");

    expect(r1).toMatchObject({ attempted: true, ok: true });
    expect(r2).toMatchObject({ attempted: true, ok: true });
    const messages = tables.messages as (Row & { lead_id: string })[];
    expect(messages.filter((m) => m.lead_id === "lead-1")).toHaveLength(1);
    expect(messages.filter((m) => m.lead_id === "lead-2")).toHaveLength(1);
  });

  it("missing phone: falls through to reporting gmail_manual (never invented, never sent) when no phone is on file and Gmail is connected", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    vi.mocked(getGmailConnectionStatus).mockResolvedValue({ connected: true, emailAddress: "studio@example.com" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const tables = seedTables();
    (tables.prospects[0] as Row).phone = null;
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");

    expect(result).toEqual({ attempted: false, channel: "gmail_manual", reason: "invalid_or_missing_phone" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("invalid phone: a too-short/garbage phone string is never treated as a valid WhatsApp contact", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const tables = seedTables();
    (tables.prospects[0] as Row).phone = "12345";
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");

    expect(result).toEqual({ attempted: false, channel: "none", reason: "invalid_or_missing_phone" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("disconnected WhatsApp integration: never attempted, and never fabricated as sent", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue({ connected: false, templateName: null, templateLanguage: "en_US" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");

    expect(result).toEqual({ attempted: false, channel: "none", reason: "not_connected" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("connected but no approved template configured: reported distinctly from 'not connected', never sent as free text", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue({ connected: true, templateName: null, templateLanguage: "en_US" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");

    expect(result).toEqual({ attempted: false, channel: "none", reason: "template_not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("campaign opted out: whatsapp_auto_outreach_enabled=false blocks automatic outreach even with WhatsApp fully configured", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const tables = seedTables();
    tables.campaigns[0].whatsapp_auto_outreach_enabled = false;
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");

    expect(result).toEqual({ attempted: false, channel: "none", reason: "campaign_disabled" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("AI generation failure: no message is sent or persisted, and the lead is left for a later sweep to retry", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    vi.mocked(getWhatsAppCredentials).mockResolvedValue(VALID_CREDENTIALS);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === OPENROUTER_URL) return new Response("Service Unavailable", { status: 503 });
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );

    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-1", "lead-1");

    expect(result).toEqual({ attempted: false, channel: "none", reason: "generation_failed" });
    const lead = (tables.leads as (Row & { status: string })[])[0];
    expect(lead.status).toBe("new");
    expect(tables.messages ?? []).toHaveLength(0);
  });

  it("organization isolation: a lead id that exists but belongs to a different organization is never touched", async () => {
    vi.mocked(getWhatsAppAutomationConfig).mockResolvedValue(CONNECTED_WITH_TEMPLATE);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    const result = await sendAutomaticWhatsAppOutreach(supabase, "org-2", "lead-1");

    expect(result).toEqual({ attempted: false, channel: "none", reason: "not_found" });
    expect(fetchSpy).not.toHaveBeenCalled();
    const lead = (tables.leads as (Row & { status: string; organization_id: string })[])[0];
    expect(lead.status).toBe("new");
  });
});
