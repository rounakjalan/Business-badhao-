import { afterEach, describe, expect, it, vi } from "vitest";

// Gmail regression coverage for the one behavior change made while building
// automatic WhatsApp outreach: sendLeadOutreachAction (the existing manual,
// human-reviewed Gmail send) now also marks the lead 'contacted' on a real
// send, closing the dedup gap between manual Gmail and automatic WhatsApp —
// a lead a human already emailed must never also receive an automatic
// WhatsApp first-touch from a later scheduled sweep. Everything else about
// the send path (idempotency reservation, Gmail call, message persistence)
// is untouched and not re-verified here.

vi.mock("@/lib/organizations", () => ({ getCurrentOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/gmail/send", () => ({ sendGmailMessage: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import { sendGmailMessage } from "@/lib/gmail/send";
import { sendLeadOutreachAction } from "@/app/(dashboard)/leads/actions";

const ORG = { organizationId: "org-1", organizationName: "Acme", role: "owner" as const };

// Same small local fake used by this pipeline's other test files — supports
// exactly the query-builder chain resolveLeadIdentity/ensureConversation/the
// send path actually use, against real in-memory tables.
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function createFakeSupabase(tables: Tables) {
  let counter = 0;

  function builder(table: string) {
    tables[table] = tables[table] ?? [];
    const filters: ((row: Row) => boolean)[] = [];
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
      return tables[table].filter((row) => filters.every((f) => f(row)));
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
      order() {
        return api;
      },
      limit() {
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

function seedTables(): Tables {
  return {
    leads: [{ id: "lead-1", organization_id: "org-1", status: "new", prospect_id: "prospect-1" }],
    contacts: [],
    prospects: [{ id: "prospect-1", company_name: "Bright Pixel", email: "priya@brightpixel.in", phone: null, contact_name: null }],
    conversations: [],
    messages: [],
  };
}

describe("sendLeadOutreachAction — Gmail regression: marks the lead contacted on a real send", () => {
  afterEach(() => vi.clearAllMocks());

  it("marks the lead 'contacted' once Gmail confirms the send", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(sendGmailMessage).mockResolvedValue({ ok: true, messageId: "gm-1", threadId: "thread-1", fromAddress: "studio@example.com" });

    const tables = seedTables();
    vi.mocked(createClient).mockResolvedValue(createFakeSupabase(tables));

    const result = await sendLeadOutreachAction("lead-1", { subject: "Hello", body: "Hi there", idempotencyKey: "key-1" });

    expect(result.ok).toBe(true);
    const lead = (tables.leads as (Row & { status: string })[])[0];
    expect(lead.status).toBe("contacted");
  });

  it("never marks the lead contacted when the Gmail send itself fails", async () => {
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
    vi.mocked(sendGmailMessage).mockResolvedValue({ ok: false, code: "send_failed", message: "Gmail rejected the request" });

    const tables = seedTables();
    vi.mocked(createClient).mockResolvedValue(createFakeSupabase(tables));

    const result = await sendLeadOutreachAction("lead-1", { subject: "Hello", body: "Hi there", idempotencyKey: "key-2" });

    expect(result.ok).toBe(false);
    const lead = (tables.leads as (Row & { status: string })[])[0];
    expect(lead.status).toBe("new");
  });
});
