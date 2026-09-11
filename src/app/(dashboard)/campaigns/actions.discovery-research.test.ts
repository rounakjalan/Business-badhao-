import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Proves the manual "Start Discovery" action (startLeadDiscoveryAction)
// automatically researches every newly discovered lead — via the bounded
// worker pool (lead-worker-pool.ts) discovery's own onLeadPersisted callback
// feeds live, the same mechanism the hourly cron sweep's finishPendingLeads
// now shares — without anyone opening a lead or pressing "Run AI Research".
// This is the manual counterpart to scheduled-pipeline.test.ts's proof for
// the hourly cron path; both go through the one real researchLead
// (lead-pipeline.ts), which is what tracks research_status/research_error.

vi.mock("@/lib/organizations", () => ({ getCurrentOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import { startLeadDiscoveryAction } from "@/app/(dashboard)/campaigns/actions";
import { DEFAULT_OPENROUTER_MODEL } from "@/lib/ai/providers/openrouter";

const ORG = { organizationId: "org-1", organizationName: "Acme", role: "owner" as const };
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TAVILY_URL = "https://api.tavily.com/search";

// Same generic in-memory Supabase stand-in as scheduled-pipeline.test.ts /
// lead-pipeline.test.ts, duplicated per this codebase's own convention of a
// small local fake per test file (see deals/actions.quick-task.test.ts).
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
        // Matches (the WHERE clause) are decided once against pre-update
        // row state, exactly like a real UPDATE ... RETURNING — not
        // re-evaluated against the just-written values, which would hide
        // an update whose own new value no longer satisfies its own WHERE
        // (e.g. UPDATE ... SET status = 'x' WHERE status != 'x').
        const update = pendingUpdate;
        const matched = tables[table].filter((row) => filters.every((f) => f(row)));
        tables[table] = tables[table].map((row) => (filters.every((f) => f(row)) ? { ...row, ...update } : row));
        return matched.map((row) => ({ ...row, ...update }));
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
      neq(column: string, value: unknown) {
        filters.push((row) => row[column] !== value);
        return api;
      },
      gte(column: string, value: unknown) {
        filters.push((row) => String(row[column] ?? "") >= String(value));
        return api;
      },
      contains(column: string, value: Record<string, unknown>) {
        filters.push((row) => {
          const target = row[column] as Record<string, unknown> | null | undefined;
          return Boolean(target) && Object.entries(value).every(([k, v]) => target?.[k] === v);
        });
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

  return { from: (table: string) => builder(table) };
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

const DIRECTORY_HIT = {
  title: "Pune Web Design Directory",
  url: "https://directory.example/pune-web-agencies",
  content: "Bright Pixel is a web design studio operating in Pune.",
};

const CANDIDATE = {
  companyName: "Bright Pixel",
  website: "brightpixel.in",
  location: "Pune",
  industry: "Web Design",
  businessType: "Agency",
  email: null,
  phone: null,
  matchedIcpCriteria: ["location: Pune"],
  evidenceSnippet: DIRECTORY_HIT.content,
  sourceUrl: DIRECTORY_HIT.url,
  searchQuery: "web design clients Pune",
};

const VALID_RESEARCH = {
  companySummary: "A small web design studio serving local businesses in Pune.",
  likelyNeeds: ["A modern, mobile-friendly website"],
  possiblePainPoints: ["Outdated online presence"],
  relevantProductsOrServices: ["Website design"],
  buyingSignals: [],
  personalizationOpportunities: ["Mention their Pune location"],
  potentialObjections: ["Budget"],
  confidence: "medium",
  verifiedInformation: [],
  businessFactsReferenced: [],
  inferredInformation: [],
  unavailableInformation: ["Team size"],
};

const VALID_QUALIFICATION = {
  qualificationScore: 72,
  fitScore: 75,
  intentScore: 65,
  confidence: "medium",
  positiveReasons: ["Matches ICP location and industry"],
  negativeReasons: [],
  missingInformation: [],
  recommendedStatus: "qualifying",
};

function stubRealPipeline() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === OPENROUTER_URL) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const systemPrompt = String(body.messages?.[0]?.content ?? "");
        const userPrompt = String(body.messages?.[1]?.content ?? "");
        if (systemPrompt.includes("AI research agent")) return openRouterResponse(VALID_RESEARCH);
        if (systemPrompt.includes("AI lead-qualification engine")) return openRouterResponse(VALID_QUALIFICATION);
        if (userPrompt.includes("CANDIDATE PROSPECTS TO REVIEW")) return openRouterResponse({ accepted: [CANDIDATE] }, "nousresearch/hermes-4-70b");
        if (userPrompt.includes("REAL SEARCH RESULTS")) return openRouterResponse({ prospects: [CANDIDATE] });
        return openRouterResponse({ queries: ["web design clients Pune"] });
      }
      if (url === TAVILY_URL) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const query = String(body.query ?? "");
        if (query === "web design clients Pune") {
          return new Response(JSON.stringify({ results: [DIRECTORY_HIT] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "https://brightpixel.in/") {
        return new Response(`<html><body><footer><a href="mailto:hello@brightpixel.in">Email</a></footer></body></html>`, {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.startsWith("https://brightpixel.in/")) return new Response("Not Found", { status: 404 });
      throw new Error(`unexpected fetch url in integration test: ${url}`);
    })
  );
}

function seedTables(): Tables {
  return {
    campaigns: [
      {
        id: "campaign-1",
        organization_id: "org-1",
        name: "Pune Web Design Push",
        objective: "Find web design agencies",
        ideal_customer_profile_id: "icp-1",
      },
    ],
    ideal_customer_profiles: [{ id: "icp-1", criteria: { location: "Pune", industry: "Web Design" } }],
  };
}

const ENV_KEYS = ["TAVILY_API_KEY", "EXA_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "AI_PROVIDER", "AI_FALLBACK_PROVIDER"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("startLeadDiscoveryAction — automatic AI research on manual Start Discovery", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.TAVILY_API_KEY = "test-tavily-key";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.OPENROUTER_MODEL;
    delete process.env.AI_PROVIDER;
    delete process.env.AI_FALLBACK_PROVIDER;
    delete process.env.EXA_API_KEY;
    vi.mocked(getCurrentOrg).mockResolvedValue(ORG);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("a lead created by a manual Start Discovery run is automatically researched and qualified in the same request — no button pressed", async () => {
    stubRealPipeline();
    const tables = seedTables();
    const supabase = createFakeSupabase(tables);
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const result = await startLeadDiscoveryAction("campaign-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newLeadsCreated).toBe(1);
    // The exact proof: research (and qualification) genuinely ran against
    // the newly created lead, inside this same action call, before it ever
    // returned — via finishPendingLeads, not a bespoke loop.
    expect(result.research.finished).toBe(1);
    expect(result.research.failed).toBe(0);
    expect(result.research.stillPending).toBe(0);

    const leads = tables.leads as (Row & { research_status: string })[];
    expect(leads).toHaveLength(1);
    expect(leads[0].research_status).toBe("completed");
    expect(tables.lead_research).toHaveLength(1);
  });

  it("a pre-existing pending lead (backlog) and a freshly discovered lead are both researched in the same Start Discovery run — pending-research recovery and fresh discovery are independent; neither one crowds out the other", async () => {
    stubRealPipeline();
    const tables = seedTables();
    // Backlog: a lead an earlier run persisted but never got around to
    // researching (its own time budget ran out first) — exactly the
    // scenario a second "Start Discovery" press must recover from without
    // that recovery replacing fresh discovery.
    tables.prospects = [{ id: "prospect-backlog", company_name: "Old Leads Co", website: "oldleads.example", title: null }];
    tables.leads = [
      {
        id: "lead-backlog",
        organization_id: "org-1",
        campaign_id: "campaign-1",
        prospect_id: "prospect-backlog",
        status: "new",
        qualification_status: "pending",
        research_status: "pending",
        research_error: null,
      },
    ];
    const supabase = createFakeSupabase(tables);
    vi.mocked(createClient).mockResolvedValue(supabase as never);

    const result = await startLeadDiscoveryAction("campaign-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Fresh discovery still found and created a genuinely new lead — the
    // backlog existing does not make this run "just research, zero new
    // leads".
    expect(result.newLeadsCreated).toBe(1);
    // ...and the pre-existing backlog lead was researched in this very same
    // run, alongside the freshly discovered one — recovery ran, too, not
    // instead of discovery.
    expect(result.research.finished).toBe(2);
    expect(result.research.stillPending).toBe(0);

    const leads = tables.leads as (Row & { id: string; research_status: string })[];
    expect(leads.find((l) => l.id === "lead-backlog")?.research_status).toBe("completed");
    expect(leads.some((l) => l.id !== "lead-backlog" && l.research_status === "completed")).toBe(true);
  });
});
