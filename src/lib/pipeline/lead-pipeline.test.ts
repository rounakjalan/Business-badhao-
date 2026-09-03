import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Proves researchLead — the single function behind both the manual "Run AI
// Research" button (leads/actions.ts) and the automatic pipeline
// (finishPendingLeads) — actually writes leads.research_status/research_error
// correctly around the real AI call, against a real (not per-call-scripted)
// fake Supabase client and real OpenRouter request/response shapes. This is
// what makes automatic research safe to run unattended: a lead the automatic
// sweep already researched must never look "never attempted" to a later
// sweep, and a lead it genuinely failed on must be visibly, durably failed
// rather than silently indistinguishable from "pending".

import { DEFAULT_OPENROUTER_MODEL } from "@/lib/ai/providers/openrouter";
import { researchLead } from "@/lib/pipeline/lead-pipeline";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Same generic in-memory Supabase stand-in as scheduled-pipeline.test.ts —
// implements the slice of the real query-builder chain this pipeline
// actually uses against real in-memory tables, rather than a per-call
// scripted mock that would hide a wiring bug behind an answer it already
// knew was "right". Duplicated here rather than shared/exported, matching
// this codebase's existing convention of a small local fake per test file
// (see deals/actions.quick-task.test.ts).
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

function createFakeSupabase(tables: Tables, leadUpdateLog: Record<string, unknown>[] = []) {
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
        if (table === "leads") leadUpdateLog.push(pendingUpdate);
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

const VALID_RESEARCH = {
  companySummary: "A small web design studio serving local businesses in Pune.",
  likelyNeeds: ["A modern, mobile-friendly website"],
  possiblePainPoints: ["Outdated online presence"],
  relevantProductsOrServices: ["Website design"],
  buyingSignals: [],
  personalizationOpportunities: ["Mention their Pune location"],
  potentialObjections: ["Budget"],
  confidence: "medium",
  verifiedInformation: ["Company: Bright Pixel"],
  businessFactsReferenced: [],
  inferredInformation: [],
  unavailableInformation: ["Team size"],
};

const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "AI_PROVIDER", "AI_FALLBACK_PROVIDER"] as const;
const savedEnv: Record<string, string | undefined> = {};

function seedTables(overrides: Partial<Row> = {}): Tables {
  return {
    leads: [
      {
        id: "lead-1",
        organization_id: "org-1",
        status: "new",
        qualification_status: "pending",
        current_score: null,
        campaign_id: "campaign-1",
        prospect_id: "prospect-1",
        research_status: "pending",
        research_error: null,
        ...overrides,
      },
    ],
    prospects: [{ id: "prospect-1", company_name: "Bright Pixel", website: "brightpixel.in", title: null }],
    campaigns: [{ id: "campaign-1", name: "Pune Web Design Push", objective: "Find web design agencies", ideal_customer_profile_id: null }],
  };
}

describe("researchLead — automatic-research status tracking", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.OPENROUTER_MODEL;
    delete process.env.AI_PROVIDER;
    delete process.env.AI_FALLBACK_PROVIDER;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.unstubAllGlobals();
  });

  it("a successful run marks the lead completed, clears any prior error, and writes exactly one real lead_research row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === OPENROUTER_URL) return openRouterResponse(VALID_RESEARCH);
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );

    const tables = seedTables({ research_status: "failed", research_error: "a previous attempt failed" });
    const supabase = createFakeSupabase(tables);

    const result = await researchLead(supabase, "org-1", "lead-1");

    expect(result.ok).toBe(true);
    const lead = (tables.leads as (Row & { research_status: string; research_error: string | null })[])[0];
    expect(lead.research_status).toBe("completed");
    expect(lead.research_error).toBeNull();

    const research = tables.lead_research as (Row & { lead_id: string; summary: string | null })[];
    expect(research).toHaveLength(1);
    expect(research[0].lead_id).toBe("lead-1");
    expect(research[0].summary).toBe(VALID_RESEARCH.companySummary);
  });

  it("passes through 'researching' before landing on the terminal status — a page load mid-run would see it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => openRouterResponse(VALID_RESEARCH))
    );

    const tables = seedTables();
    const updateLog: Record<string, unknown>[] = [];
    const supabase = createFakeSupabase(tables, updateLog);

    await researchLead(supabase, "org-1", "lead-1");

    const statusesWritten = updateLog.map((u) => u.research_status);
    expect(statusesWritten).toEqual(["researching", "completed"]);
  });

  it("a genuine failure marks the lead failed with the real provider message, and writes no lead_research row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === OPENROUTER_URL) return new Response("Service Unavailable", { status: 503 });
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );

    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    const result = await researchLead(supabase, "org-1", "lead-1");

    expect(result.ok).toBe(false);
    const lead = (tables.leads as (Row & { research_status: string; research_error: string | null })[])[0];
    expect(lead.research_status).toBe("failed");
    expect(lead.research_error).toBeTruthy();
    if (!result.ok) expect(lead.research_error).toBe(result.message);
    expect(tables.lead_research ?? []).toHaveLength(0);
  });

  it("the manual retry path is never blocked by a prior failure — a lead already 'failed' can still be researched successfully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => openRouterResponse(VALID_RESEARCH))
    );

    const tables = seedTables({ research_status: "failed", research_error: "the site was unreachable" });
    const supabase = createFakeSupabase(tables);

    // This is exactly what runLeadResearchAction (the "Run AI Research"
    // button's backend) does — call researchLead directly, regardless of
    // the lead's current research_status.
    const result = await researchLead(supabase, "org-1", "lead-1");

    expect(result.ok).toBe(true);
    const lead = (tables.leads as (Row & { research_status: string; research_error: string | null })[])[0];
    expect(lead.research_status).toBe("completed");
    expect(lead.research_error).toBeNull();
  });
});
