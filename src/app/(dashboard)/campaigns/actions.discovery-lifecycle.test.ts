import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// STEP 7 — target-based, durable, resumable discovery. Proves the rewritten
// startLeadDiscoveryAction: a run stores its own target, a later invocation
// resumes the SAME run (never a duplicate row) toward the leftover distance
// to that target, a target already met skips discovery entirely, a
// transient provider outage leaves the run "running" for a later retry
// rather than permanently failing it, and only a genuinely unrecoverable
// configuration problem (no search provider) is a real terminal failure.
// Complements discovery-run.test.ts (pure decision logic) and
// discovery-batch.test.ts (the existing, untouched per-invocation batching
// loop this reuses via its own targetNewLeads param).

vi.mock("@/lib/organizations", () => ({ getCurrentOrg: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import { startLeadDiscoveryAction } from "@/app/(dashboard)/campaigns/actions";
import { DEFAULT_OPENROUTER_MODEL } from "@/lib/ai/providers/openrouter";
import { DEFAULT_DISCOVERY_TARGET } from "@/lib/pipeline/discovery-run";

const ORG = { organizationId: "org-1", organizationName: "Acme", role: "owner" as const };
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TAVILY_URL = "https://api.tavily.com/search";

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

// Same generic in-memory Supabase stand-in as
// actions.discovery-research.test.ts, extended with gte/contains — the two
// query builder methods the new resumable-run lookups (discovery-run.ts)
// use that file's fake didn't need.
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
  companySummary: "A small business.",
  likelyNeeds: [],
  possiblePainPoints: [],
  relevantProductsOrServices: [],
  buyingSignals: [],
  personalizationOpportunities: [],
  potentialObjections: [],
  confidence: "medium",
  verifiedInformation: [],
  businessFactsReferenced: [],
  inferredInformation: [],
  unavailableInformation: [],
};

const VALID_QUALIFICATION = {
  qualificationScore: 70,
  fitScore: 70,
  intentScore: 70,
  confidence: "medium",
  positiveReasons: ["Matches ICP"],
  negativeReasons: [],
  missingInformation: [],
  recommendedStatus: "qualifying",
};

/** One unique, real-shaped candidate per call — distinct company/website/dedupe key each time, so successive batches or invocations always contribute genuinely NEW leads instead of accidentally deduping against each other. */
function makeCandidate(n: number) {
  const hit = { title: `Directory ${n}`, url: `https://directory.example/company-${n}`, content: `Company ${n} is a small business in Pune.` };
  const candidate = {
    companyName: `Company ${n}`,
    website: `company${n}.example`,
    location: "Pune",
    industry: "Retail",
    businessType: "Store",
    email: null,
    phone: null,
    matchedIcpCriteria: ["location: Pune"],
    evidenceSnippet: hit.content,
    sourceUrl: hit.url,
    searchQuery: `retail businesses Pune ${n}`,
  };
  return { hit, candidate };
}

/**
 * Stubs the full real pipeline (Tavily -> Nemotron extraction -> Independent
 * Hermes Reviewer -> research -> qualification), handing out ONE fresh,
 * unique candidate per query and stopping ("no more results") once
 * `available` candidates have all been served — a deliberately small,
 * controllable stand-in for a real search space, so a test can assert
 * exactly how many genuinely new leads one call reaches.
 */
function stubPipeline(available: number) {
  let served = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === OPENROUTER_URL) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const systemPrompt = String(body.messages?.[0]?.content ?? "");
        const userPrompt = String(body.messages?.[1]?.content ?? "");
        if (systemPrompt.includes("AI research agent")) return openRouterResponse(VALID_RESEARCH);
        if (systemPrompt.includes("AI lead-qualification engine")) return openRouterResponse(VALID_QUALIFICATION);
        if (userPrompt.includes("CANDIDATE PROSPECTS TO REVIEW")) {
          const match = userPrompt.match(/"companyName"\s*:\s*"([^"]+)"/);
          const name = match ? match[1] : "Company";
          const n = Number(name.replace("Company ", "")) || 1;
          return openRouterResponse({ accepted: [makeCandidate(n).candidate] }, "nousresearch/hermes-4-70b");
        }
        if (userPrompt.includes("REAL SEARCH RESULTS")) {
          const match = userPrompt.match(/"url"\s*:\s*"https:\/\/directory\.example\/company-(\d+)"/);
          const n = match ? Number(match[1]) : served;
          return openRouterResponse({ prospects: [makeCandidate(n).candidate] });
        }
        return openRouterResponse({ queries: [`retail businesses Pune ${served + 1}`] });
      }
      if (url === TAVILY_URL) {
        if (served >= available) return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
        served += 1;
        const { hit } = makeCandidate(served);
        return new Response(JSON.stringify({ results: [hit] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("https://company")) return new Response("Not Found", { status: 404 });
      throw new Error(`unexpected fetch url in lifecycle test: ${url}`);
    })
  );
}

function seedTables(): Tables {
  return {
    campaigns: [{ id: "campaign-1", organization_id: "org-1", name: "Retail Push", objective: "Find retail businesses", ideal_customer_profile_id: "icp-1" }],
    ideal_customer_profiles: [{ id: "icp-1", criteria: { location: "Pune", industry: "Retail" } }],
  };
}

const ENV_KEYS = ["TAVILY_API_KEY", "EXA_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "AI_PROVIDER", "AI_FALLBACK_PROVIDER"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("startLeadDiscoveryAction — target-based, durable, resumable discovery (STEP 7)", () => {
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

  it("a fresh campaign's first Start Discovery press creates a run with the default target of 10 genuinely new leads", async () => {
    stubPipeline(1);
    const tables = seedTables();
    vi.mocked(createClient).mockResolvedValue(createFakeSupabase(tables) as never);

    const result = await startLeadDiscoveryAction("campaign-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetLeads).toBe(DEFAULT_DISCOVERY_TARGET);
    expect(DEFAULT_DISCOVERY_TARGET).toBe(10);

    const runs = tables.agent_runs as (Row & { agent_type: string; input: { targetLeads?: number } })[];
    const discoveryRuns = runs.filter((r) => r.agent_type === "lead_discovery");
    expect(discoveryRuns).toHaveLength(1);
    expect(discoveryRuns[0].input.targetLeads).toBe(10);
  });

  it("resumes an existing incomplete run toward its own stored target instead of starting a new one — no duplicate run row — and reaches 'completed' once the target and its research are both done", async () => {
    stubPipeline(1); // exactly one more candidate available — the run needs exactly 1 more to hit target=10
    const tables = seedTables();
    const runStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // stale enough that the concurrency guard allows a new invocation
    tables.agent_runs = [
      { id: "run-existing", organization_id: "org-1", agent_type: "lead_discovery", status: "running", started_at: runStartedAt, completed_at: null, input: { campaignId: "campaign-1", targetLeads: 10 }, output: {} },
    ];
    // 9 leads this SAME run already found and fully researched/qualified in an earlier invocation that died before reaching the 10th.
    tables.prospects = Array.from({ length: 9 }, (_, i) => ({
      id: `prospect-old-${i}`,
      organization_id: "org-1",
      campaign_id: "campaign-1",
      company_name: `Existing Co ${i}`,
      website: `existing${i}.example`,
      created_at: new Date(Date.parse(runStartedAt) + 1000).toISOString(),
    }));
    tables.leads = Array.from({ length: 9 }, (_, i) => ({
      id: `lead-old-${i}`,
      organization_id: "org-1",
      campaign_id: "campaign-1",
      prospect_id: `prospect-old-${i}`,
      status: "new",
      qualification_status: "qualified", // not "pending" — excluded from backlog re-seeding, exactly as an already-finished lead should be
      research_status: "completed",
      created_at: new Date(Date.parse(runStartedAt) + 1000).toISOString(),
    }));
    vi.mocked(createClient).mockResolvedValue(createFakeSupabase(tables) as never);

    const result = await startLeadDiscoveryAction("campaign-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No duplicate run: exactly the one row, same id as the pre-existing one.
    const discoveryRuns = (tables.agent_runs as (Row & { agent_type: string; id: string })[]).filter((r) => r.agent_type === "lead_discovery");
    expect(discoveryRuns).toHaveLength(1);
    expect(discoveryRuns[0].id).toBe("run-existing");

    expect(result.targetLeads).toBe(10);
    expect(result.validLeadCount).toBe(10); // 9 pre-existing + exactly 1 genuinely new
    expect(result.status).toBe("completed");
    expect(result.researchPendingCount).toBe(0);
  });

  it("a target already fully met skips discovery entirely — never re-discovers once 10 valid leads already exist for the run — and still finishes any of its own leads still awaiting research", async () => {
    const tavilyCalls = { count: 0 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === TAVILY_URL) {
          tavilyCalls.count += 1;
          throw new Error("Tavily must never be called once the run's target is already met");
        }
        if (url === OPENROUTER_URL) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          const systemPrompt = String(body.messages?.[0]?.content ?? "");
          if (systemPrompt.includes("AI research agent")) return openRouterResponse(VALID_RESEARCH);
          if (systemPrompt.includes("AI lead-qualification engine")) return openRouterResponse(VALID_QUALIFICATION);
          throw new Error("no discovery-stage AI call should happen once the target is already met");
        }
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );

    const tables = seedTables();
    const runStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    tables.agent_runs = [
      { id: "run-existing", organization_id: "org-1", agent_type: "lead_discovery", status: "running", started_at: runStartedAt, completed_at: null, input: { campaignId: "campaign-1", targetLeads: 10 }, output: {} },
    ];
    tables.prospects = Array.from({ length: 10 }, (_, i) => ({
      id: `prospect-${i}`,
      organization_id: "org-1",
      campaign_id: "campaign-1",
      company_name: `Co ${i}`,
      website: `co${i}.example`,
      created_at: new Date(Date.parse(runStartedAt) + 1000).toISOString(),
    }));
    tables.leads = Array.from({ length: 10 }, (_, i) => ({
      id: `lead-${i}`,
      organization_id: "org-1",
      campaign_id: "campaign-1",
      prospect_id: `prospect-${i}`,
      status: "new",
      // The 10th lead is the one this run's own budget didn't reach last time — still needs research.
      qualification_status: i < 9 ? "qualified" : "pending",
      research_status: i < 9 ? "completed" : "pending",
      created_at: new Date(Date.parse(runStartedAt) + 1000).toISOString(),
    }));
    vi.mocked(createClient).mockResolvedValue(createFakeSupabase(tables) as never);

    const result = await startLeadDiscoveryAction("campaign-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(tavilyCalls.count).toBe(0);
    expect(result.batchesRun).toBe(0);
    expect(result.stoppedReason).toBe("target_reached");
    expect(result.status).toBe("completed");
    expect(result.validLeadCount).toBe(10);
    expect(result.researchPendingCount).toBe(0);
  });

  it("a transient provider outage (Tavily and OpenRouter both genuinely down) leaves the run 'running' for a later retry — never permanently failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === TAVILY_URL || url === OPENROUTER_URL) return new Response("internal server error", { status: 500 });
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );
    const tables = seedTables();
    vi.mocked(createClient).mockResolvedValue(createFakeSupabase(tables) as never);

    const result = await startLeadDiscoveryAction("campaign-1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("running");
    expect(result.stoppedReason).toBe("provider_error");

    const discoveryRuns = (tables.agent_runs as (Row & { agent_type: string; status: string })[]).filter((r) => r.agent_type === "lead_discovery");
    expect(discoveryRuns).toHaveLength(1);
    expect(discoveryRuns[0].status).toBe("running"); // never "failed" — a provider outage must not permanently kill the run
  });

  it("a genuinely unrecoverable configuration problem (no search provider configured) is a real, terminal failure", async () => {
    delete process.env.TAVILY_API_KEY;
    const tables = seedTables();
    vi.mocked(createClient).mockResolvedValue(createFakeSupabase(tables) as never);

    const result = await startLeadDiscoveryAction("campaign-1");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_configured");

    const discoveryRuns = (tables.agent_runs as (Row & { agent_type: string; status: string })[]).filter((r) => r.agent_type === "lead_discovery");
    expect(discoveryRuns).toHaveLength(1);
    expect(discoveryRuns[0].status).toBe("failed");
  });
});
