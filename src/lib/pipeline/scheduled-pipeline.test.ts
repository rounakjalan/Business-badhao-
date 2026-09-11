import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This file proves automatic contact discovery is genuinely wired into the
// REAL runDiscoveryForCampaign — not merely that discoverProspectContacts
// works in isolation (contact-enrichment.test.ts already proves that).
// Nothing about the function under test is mocked; only its two real
// boundaries are: the network (fetch — real OpenRouter/Tavily/website HTTP
// shapes, exactly as production sends them) and the database (a small,
// generic in-memory Supabase stand-in below, not a per-call scripted stub —
// a wiring bug that skipped a step or read the wrong table would show up as
// a wrong row in the fake tables, not be hidden by a mock that already knew
// the "right" answer).

import { DEFAULT_OPENROUTER_MODEL } from "@/lib/ai/providers/openrouter";
import { finishPendingLeads, runDiscoveryForCampaign } from "@/lib/pipeline/scheduled-pipeline";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TAVILY_URL = "https://api.tavily.com/search";

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

// ---------------------------------------------------------------------------
// Generic in-memory Supabase stand-in. Deliberately not a per-call scripted
// mock: it implements the small slice of the real query-builder chain this
// pipeline actually uses (select/insert/update/eq/contains/order/limit/
// maybeSingle/single, plus being awaitable directly the way supabase-js
// query builders are) against real in-memory tables. Any table not seeded
// simply behaves as empty, which is exactly right for getBusinessContext's
// six lookups — none of them are seeded, and the real function already
// handles "nothing on file" gracefully.
// ---------------------------------------------------------------------------

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
      not() {
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
      // Query builders in the real client are themselves awaitable when no
      // terminal method is called (e.g. `await ...order().limit(1)`), which
      // runDiscoveryForCampaign's own "recent runs" check relies on.
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

const ENV_KEYS = ["TAVILY_API_KEY", "EXA_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "AI_PROVIDER", "AI_FALLBACK_PROVIDER"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("runDiscoveryForCampaign — real automatic contact discovery wiring", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.TAVILY_API_KEY = "test-tavily-key";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.OPENROUTER_MODEL;
    delete process.env.AI_PROVIDER;
    delete process.env.AI_FALLBACK_PROVIDER;
    delete process.env.EXA_API_KEY;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.unstubAllGlobals();
  });

  const DIRECTORY_HIT = {
    title: "Pune Web Design Directory",
    url: "https://directory.example/pune-web-agencies",
    content: "Bright Pixel and Triverse are web design studios operating in Pune.",
  };

  /** Two real, grounded candidates from one real discovery search: one with a website, one without — exactly the Triverse-shaped production case. */
  const CANDIDATE_WITH_WEBSITE = {
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

  const CANDIDATE_NO_WEBSITE = {
    companyName: "Triverse",
    website: null,
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

  function stubRealPipeline() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === OPENROUTER_URL) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          const systemPrompt = String(body.messages?.[0]?.content ?? "");
          const userPrompt = String(body.messages?.[1]?.content ?? "");
          // finishPendingLeads's own two calls (researchLead, then
          // qualifyLead), distinguished by their real, distinct system
          // prompts — checked first since neither ever contains the
          // discovery-stage markers below.
          if (systemPrompt.includes("AI research agent")) {
            return openRouterResponse(VALID_RESEARCH);
          }
          if (systemPrompt.includes("AI lead-qualification engine")) {
            return openRouterResponse(VALID_QUALIFICATION);
          }
          if (userPrompt.includes("CANDIDATE PROSPECTS TO REVIEW")) {
            return openRouterResponse({ accepted: [CANDIDATE_WITH_WEBSITE, CANDIDATE_NO_WEBSITE] }, "nousresearch/hermes-4-70b");
          }
          if (userPrompt.includes("REAL SEARCH RESULTS")) {
            return openRouterResponse({ prospects: [CANDIDATE_WITH_WEBSITE, CANDIDATE_NO_WEBSITE] });
          }
          return openRouterResponse({ queries: ["web design clients Pune"] });
        }

        if (url === TAVILY_URL) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          const query = String(body.query ?? "");

          // The discovery step's own search — the one Hermes/Nemotron actually asked for.
          if (query === "web design clients Pune") {
            return new Response(JSON.stringify({ results: [DIRECTORY_HIT] }), { status: 200, headers: { "Content-Type": "application/json" } });
          }

          // Triverse has no website, so contact-search.ts's real fallback
          // fires — a genuinely different query shape, built from the
          // company name and location, not the discovery query above.
          if (query.includes('"Triverse"') && query.includes("contact email phone")) {
            return new Response(
              JSON.stringify({
                results: [
                  {
                    title: "Triverse Studio — Contact",
                    url: "https://triverse.studio/contact",
                    content: "Reach Triverse at hello@triverse.studio or call +91 98765 43210.",
                  },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }

          return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

        // Bright Pixel's own real website — the website-crawl stage of
        // contact discovery, fetched directly, no search involved.
        if (url === "https://brightpixel.in/") {
          return new Response(`<html><body><footer><a href="mailto:hello@brightpixel.in">Email</a><a href="tel:+911234567890">Call</a></footer></body></html>`, {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }

        // Any /contact, /about etc. sub-page probe on Bright Pixel's site — nothing extra there.
        if (url.startsWith("https://brightpixel.in/")) {
          return new Response("Not Found", { status: 404 });
        }

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
          discovery_state: "scheduled",
          discovery_next_run_at: null,
        },
      ],
      ideal_customer_profiles: [{ id: "icp-1", criteria: { location: "Pune", industry: "Web Design" } }],
    };
  }

  it("a real scheduled discovery run automatically finds and persists real, sourced contact info for both a website prospect and a no-website prospect — the exact Triverse-shaped case", async () => {
    stubRealPipeline();
    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    const result = await runDiscoveryForCampaign(supabase, "org-1", "campaign-1", Date.now(), 240_000);

    expect(result.ran).toBe(true);
    expect(result.newLeads).toBe(2);

    const prospects = tables.prospects as (Row & { company_name: string; email: string | null; raw_data: { contact?: Record<string, unknown> } })[];
    expect(prospects).toHaveLength(2);

    const brightPixel = prospects.find((p) => p.company_name === "Bright Pixel")!;
    const triverse = prospects.find((p) => p.company_name === "Triverse")!;

    // Bright Pixel: real website reached, real mailto/tel extracted — the
    // website stage of discoverProspectContacts actually ran inside the
    // real function, not a stub standing in for it.
    expect(brightPixel.email).toBe("hello@brightpixel.in");
    expect(brightPixel.raw_data.contact?.email).toMatchObject({ value: "hello@brightpixel.in", source: "https://brightpixel.in/" });
    expect(brightPixel.raw_data.contact?.phone).toMatchObject({ value: "+911234567890" });
    expect(brightPixel.raw_data.contact?.contactStatus).toBe("found");

    // Triverse: no website at all — proves the REAL search fallback
    // (contact-search.ts's actual Tavily call, not a mock of
    // discoverProspectContacts) executed inside the real pipeline function.
    expect(triverse.website).toBeNull();
    expect(triverse.email).toBe("hello@triverse.studio");
    expect(triverse.raw_data.contact?.email).toMatchObject({ value: "hello@triverse.studio", source: "https://triverse.studio/contact" });
    // contact-search.ts's plain-text extraction only ever populates phone —
    // WhatsApp detection (contact-extraction.ts) requires an explicit wa.me/
    // api.whatsapp.com link, which a Tavily text snippet never has.
    expect(triverse.raw_data.contact?.phone).toMatchObject({ value: "+91 98765 43210", source: "https://triverse.studio/contact" });
    expect(triverse.raw_data.contact?.contactStatus).toBe("found");

    // Both leads exist, correctly linked to their own prospect.
    const leads = tables.leads as (Row & { prospect_id: string })[];
    expect(leads).toHaveLength(2);
    expect(new Set(leads.map((l) => l.prospect_id))).toEqual(new Set([brightPixel.id, triverse.id]));
  });

  it("a real scheduled discovery run persists per-stage AI telemetry (query generation, extraction, Independent Reviewer) into the SAME client it was given — reproduces and fixes the cron telemetry gap: previously only the parent lead_discovery row was written, because runHermesCompletion's own tracking always fell back to the cookie-based client, which has no session under cron and is silently rejected by RLS", async () => {
    stubRealPipeline();
    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    const result = await runDiscoveryForCampaign(supabase, "org-1", "campaign-1", Date.now(), 240_000);

    expect(result.ran).toBe(true);

    const agentRuns = tables.agent_runs as (Row & { agent_type: string; status: string; output: Record<string, unknown> })[];
    const byType = (agentType: string) => agentRuns.filter((r) => r.agent_type === agentType);

    // Parent row — this one already worked before the fix, since
    // runDiscoveryForCampaign passes its own client to createAgentRun
    // directly. It's the baseline every other row below is compared against.
    const parentRuns = byType("lead_discovery");
    expect(parentRuns).toHaveLength(1);
    // STEP 7: the run's own target (DEFAULT_DISCOVERY_TARGET = 10) is far
    // more than this mock scenario ever produces, so the run correctly
    // stays "running" — durable and resumable — rather than being marked
    // terminal just because this one invocation stopped. Status is
    // incidental to what this test actually verifies (per-stage telemetry
    // client-threading, below); see discovery-run.test.ts for lifecycle
    // coverage.
    expect(parentRuns[0].status).toBe("running");

    // The three AI stages inside discover() — before this fix these never
    // appeared in the caller's own client/tables at all under a
    // no-session/cron-style invocation, because runHermesCompletion had no
    // way to receive the client runDiscoveryForCampaign already holds.
    //
    // Batched discovery (discovery-batch.ts) calls discover() more than once
    // when a later batch keeps turning up the same, now-duplicate prospects
    // — this mock always returns the same two — so exactly how many rows
    // exist depends on how many batches ran before the "no more results"
    // stop condition tripped; never hardcode to 1. What must hold regardless
    // is the actual fix under test: one row per stage per batch, all landing
    // in the SAME client/tables this test owns.
    const queryGenRuns = byType("lead_discovery_query_generation");
    const extractionRuns = byType("lead_discovery_extraction");
    const reviewerRuns = byType("lead_discovery_hermes_review");
    expect(queryGenRuns.length).toBeGreaterThan(0);
    expect(extractionRuns.length).toBe(queryGenRuns.length);
    expect(reviewerRuns.length).toBe(queryGenRuns.length);
    for (const run of [...queryGenRuns, ...extractionRuns, ...reviewerRuns]) {
      expect(run.status).toBe("completed");
    }

    // Every AI telemetry row must separate what was requested from what
    // actually served it — never silently equate the two.
    for (const run of [...queryGenRuns, ...extractionRuns]) {
      expect(run.output).toMatchObject({ requestedProvider: "openrouter", requestedModel: DEFAULT_OPENROUTER_MODEL });
    }
    for (const run of reviewerRuns) {
      expect(run.output).toMatchObject({ requestedProvider: "openrouter", requestedModel: "nousresearch/hermes-3-llama-3.1-70b" });
    }

    // Search + the Deterministic Validator's own result live inside the
    // parent row's telemetry — one entry per batch this run made (they are
    // not separate AI calls) — real Tavily activity and real accept/reject
    // counts, not zeros.
    const telemetry = parentRuns[0].output.telemetry as { tavily?: { requests?: number } }[] | undefined;
    const totalTavilyRequests = (telemetry ?? []).reduce((sum, batch) => sum + (batch.tavily?.requests ?? 0), 0);
    expect(totalTavilyRequests).toBeGreaterThan(0);
    expect(parentRuns[0].output).toMatchObject({ prospectsFound: expect.any(Number) });
  });

  it("existing leads are never re-enriched by a later scheduled run — only genuinely new prospects reach contact discovery", async () => {
    stubRealPipeline();
    const tables = seedTables();
    // Bright Pixel already exists from an earlier run, with its own contact
    // already on file — the cross-run dedup key (website match) must
    // exclude it from this run entirely, before contact discovery is ever
    // considered for it.
    tables.prospects = [
      {
        id: "prospect-existing",
        organization_id: "org-1",
        company_name: "Bright Pixel",
        website: "brightpixel.in",
        email: "already-on-file@brightpixel.in",
        raw_data: { contact: { email: { value: "already-on-file@brightpixel.in", source: "https://brightpixel.in/contact", confidence: "high" }, contactStatus: "found" } },
      },
    ];

    const supabase = createFakeSupabase(tables);
    const result = await runDiscoveryForCampaign(supabase, "org-1", "campaign-1", Date.now(), 240_000);

    expect(result.ran).toBe(true);
    // Only Triverse is genuinely new; Bright Pixel is correctly deduplicated away.
    expect(result.newLeads).toBe(1);

    const prospects = tables.prospects as (Row & { company_name: string; email: string | null })[];
    const brightPixel = prospects.find((p) => p.company_name === "Bright Pixel")!;
    // Untouched — still the original value, never re-enriched or overwritten.
    expect(brightPixel.email).toBe("already-on-file@brightpixel.in");
    expect(prospects.filter((p) => p.company_name === "Bright Pixel")).toHaveLength(1);
  });

  it("one prospect's contact-discovery failure does not lose that lead or block the other prospect in the same run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === OPENROUTER_URL) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          const userPrompt = String(body.messages?.[1]?.content ?? "");
          if (userPrompt.includes("CANDIDATE PROSPECTS TO REVIEW")) {
            return openRouterResponse({ accepted: [CANDIDATE_WITH_WEBSITE, CANDIDATE_NO_WEBSITE] }, "nousresearch/hermes-4-70b");
          }
          if (userPrompt.includes("REAL SEARCH RESULTS")) {
            return openRouterResponse({ prospects: [CANDIDATE_WITH_WEBSITE, CANDIDATE_NO_WEBSITE] });
          }
          return openRouterResponse({ queries: ["web design clients Pune"] });
        }
        if (url === TAVILY_URL) {
          const body = JSON.parse(String(init?.body ?? "{}"));
          const query = String(body.query ?? "");
          if (query === "web design clients Pune") {
            return new Response(JSON.stringify({ results: [DIRECTORY_HIT] }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          // Triverse's contact search genuinely fails (a real provider outage) rather than throwing.
          if (query.includes('"Triverse"')) return new Response("Service Unavailable", { status: 503 });
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        // Bright Pixel's site is unreachable this run.
        if (url === "https://brightpixel.in/") throw new Error("simulated network failure");
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );

    const tables = seedTables();
    const supabase = createFakeSupabase(tables);
    const result = await runDiscoveryForCampaign(supabase, "org-1", "campaign-1", Date.now(), 240_000);

    // Both leads still exist — a contact-discovery failure degrades to
    // "not_found", it never loses the lead or aborts the batch.
    expect(result.ran).toBe(true);
    expect(result.newLeads).toBe(2);

    const prospects = tables.prospects as (Row & { company_name: string; raw_data: { contact?: Record<string, unknown> } })[];
    expect(prospects).toHaveLength(2);
    for (const prospect of prospects) {
      expect(prospect.raw_data.contact?.contactStatus).toBe("not_found");
      expect(prospect.raw_data.contact?.email).toBeNull();
    }
    expect(tables.leads).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Automatic AI Research: finishPendingLeads is the REAL function the cron
  // route (src/app/api/cron/lead-pipeline/route.ts) calls immediately after
  // runDiscoveryForCampaign, in the same sweep — that composition is what
  // makes research automatic for a newly discovered lead with nobody opening
  // it or pressing "Run AI Research". These tests prove finishPendingLeads
  // itself is safe to run unattended, every hour, forever: a lead already
  // researched is never re-researched, a lead that genuinely failed is never
  // silently retried forever, and one lead's failure never blocks another.
  //
  // Nested inside the same describe (rather than a sibling) so it shares
  // stubRealPipeline/seedTables/CANDIDATE_* — the exact discovery-stage
  // setup already proven above — for the two tests that compose real
  // discovery with real automatic research.
  // ---------------------------------------------------------------------------
  describe("finishPendingLeads — automatic AI research wiring", () => {
  const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "AI_PROVIDER", "AI_FALLBACK_PROVIDER"] as const;
  const savedEnv: Record<string, string | undefined> = {};

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

  function stubResearchAndQualification() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url !== OPENROUTER_URL) throw new Error(`unexpected fetch url: ${url}`);
        const body = JSON.parse(String(init?.body ?? "{}"));
        const systemPrompt = String(body.messages?.[0]?.content ?? "");
        if (systemPrompt.includes("AI research agent")) return openRouterResponse(VALID_RESEARCH);
        if (systemPrompt.includes("AI lead-qualification engine")) return openRouterResponse(VALID_QUALIFICATION);
        throw new Error(`unexpected OpenRouter call: ${systemPrompt.slice(0, 80)}`);
      })
    );
  }

  function seedLead(overrides: Partial<Row> & { id?: string } = {}): Row {
    const suffix = overrides.id ?? "1";
    return {
      organization_id: "org-1",
      campaign_id: "campaign-1",
      prospect_id: `prospect-${suffix}`,
      status: "new",
      qualification_status: "pending",
      current_score: null,
      research_status: "pending",
      research_error: null,
      created_at: new Date().toISOString(),
      ...overrides,
      id: `lead-${suffix}`,
    };
  }

  it("a genuinely new pending lead is automatically researched and then qualified — no button pressed", async () => {
    stubResearchAndQualification();
    const tables: Tables = {
      leads: [seedLead({ id: "1" })],
      prospects: [{ id: "prospect-1", company_name: "Bright Pixel", website: "brightpixel.in", title: null }],
    };
    const supabase = createFakeSupabase(tables);

    const result = await finishPendingLeads(supabase, "org-1", "campaign-1", Date.now(), 60_000);

    expect(result).toEqual({ finished: 1, failed: 0, outreach: { whatsappSent: 0, whatsappFailed: 0, gmailManualPending: 0, noChannelAvailable: 0 } });
    const lead = (tables.leads as (Row & { research_status: string; qualification_status: string })[])[0];
    expect(lead.research_status).toBe("completed");
    expect(lead.qualification_status).toBe("qualifying");
    expect(tables.lead_research).toHaveLength(1);
  });

  it("a lead already researched successfully is never re-researched — only qualification is retried", async () => {
    stubResearchAndQualification();
    const tables: Tables = {
      leads: [seedLead({ id: "1", research_status: "completed" })],
      prospects: [{ id: "prospect-1", company_name: "Bright Pixel", website: "brightpixel.in", title: null }],
      lead_research: [{ id: "existing-research", lead_id: "lead-1", organization_id: "org-1", summary: "Already researched.", findings: {}, source: "ai" }],
    };
    const supabase = createFakeSupabase(tables);

    const result = await finishPendingLeads(supabase, "org-1", "campaign-1", Date.now(), 60_000);

    expect(result).toEqual({ finished: 1, failed: 0, outreach: { whatsappSent: 0, whatsappFailed: 0, gmailManualPending: 0, noChannelAvailable: 0 } });
    // Still exactly one row — the pre-existing one. A wiring bug that called
    // researchLead anyway would leave two.
    expect(tables.lead_research).toHaveLength(1);
    const lead = (tables.leads as (Row & { qualification_status: string })[])[0];
    expect(lead.qualification_status).toBe("qualifying");
  });

  it("a lead already known to have failed research is excluded from the automatic sweep entirely, left for manual retry", async () => {
    stubResearchAndQualification();
    const tables: Tables = {
      leads: [seedLead({ id: "1", research_status: "failed", research_error: "a previous attempt failed" })],
      prospects: [{ id: "prospect-1", company_name: "Bright Pixel", website: "brightpixel.in", title: null }],
    };
    const supabase = createFakeSupabase(tables);

    const result = await finishPendingLeads(supabase, "org-1", "campaign-1", Date.now(), 60_000);

    // Not even attempted this run — excluded by the query itself.
    expect(result).toEqual({ finished: 0, failed: 0, outreach: { whatsappSent: 0, whatsappFailed: 0, gmailManualPending: 0, noChannelAvailable: 0 } });
    const lead = (tables.leads as (Row & { research_status: string; research_error: string | null; qualification_status: string })[])[0];
    expect(lead.research_status).toBe("failed");
    expect(lead.research_error).toBe("a previous attempt failed");
    expect(lead.qualification_status).toBe("pending");
    expect(tables.lead_research ?? []).toHaveLength(0);
  });

  it("one lead's research failure does not stop another lead in the same run from being researched and qualified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url !== OPENROUTER_URL) throw new Error(`unexpected fetch url: ${url}`);
        const body = JSON.parse(String(init?.body ?? "{}"));
        const systemPrompt = String(body.messages?.[0]?.content ?? "");
        const userPrompt = String(body.messages?.[1]?.content ?? "");
        if (systemPrompt.includes("AI research agent")) {
          if (userPrompt.includes("Company: FailCo")) return new Response("Service Unavailable", { status: 503 });
          return openRouterResponse(VALID_RESEARCH);
        }
        if (systemPrompt.includes("AI lead-qualification engine")) return openRouterResponse(VALID_QUALIFICATION);
        throw new Error(`unexpected OpenRouter call: ${systemPrompt.slice(0, 80)}`);
      })
    );

    const tables: Tables = {
      leads: [seedLead({ id: "1", prospect_id: "prospect-fail" }), seedLead({ id: "2", prospect_id: "prospect-good" })],
      prospects: [
        { id: "prospect-fail", company_name: "FailCo", website: null, title: null },
        { id: "prospect-good", company_name: "GoodCo", website: "goodco.example", title: null },
      ],
    };
    const supabase = createFakeSupabase(tables);

    const result = await finishPendingLeads(supabase, "org-1", "campaign-1", Date.now(), 60_000);

    expect(result).toEqual({ finished: 1, failed: 1, outreach: { whatsappSent: 0, whatsappFailed: 0, gmailManualPending: 0, noChannelAvailable: 0 } });
    const leads = tables.leads as (Row & { id: string; research_status: string; qualification_status: string })[];
    const failLead = leads.find((l) => l.id === "lead-1")!;
    const goodLead = leads.find((l) => l.id === "lead-2")!;
    expect(failLead.research_status).toBe("failed");
    expect(failLead.qualification_status).toBe("pending");
    expect(goodLead.research_status).toBe("completed");
    expect(goodLead.qualification_status).toBe("qualifying");
  });

  it("runDiscoveryForCampaign itself already researches and qualifies the leads it just discovered — via its own concurrent worker pool, not deferred to a later finishPendingLeads pass", async () => {
    // stubRealPipeline already answers every stage's real system prompt —
    // discovery's own queries/extraction/review AND researchLead's/
    // qualifyLead's — because the pool now runs those DURING this call,
    // concurrently with discovery's own batches, not only afterward.
    stubRealPipeline();
    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    const discovered = await runDiscoveryForCampaign(supabase, "org-1", "campaign-1", Date.now(), 240_000);
    expect(discovered.newLeads).toBe(2);

    // Already researched and qualified — no separate call needed.
    const leads = tables.leads as (Row & { research_status: string; qualification_status: string })[];
    expect(leads).toHaveLength(2);
    expect(leads.every((l) => l.research_status === "completed")).toBe(true);
    expect(leads.every((l) => l.qualification_status !== "pending")).toBe(true);
    expect(tables.lead_research).toHaveLength(2);

    // The cron route's pass 3 (finishPendingLeads, right after discovery in
    // the same sweep) correctly finds nothing left to do — the pool inside
    // runDiscoveryForCampaign already reached both leads within the shared
    // budget, not merely started them.
    stubResearchAndQualification();
    const finished = await finishPendingLeads(supabase, "org-1", "campaign-1", Date.now(), 60_000);
    expect(finished).toEqual({ finished: 0, failed: 0, outreach: { whatsappSent: 0, whatsappFailed: 0, gmailManualPending: 0, noChannelAvailable: 0 } });
    expect(tables.lead_research).toHaveLength(2);
  });

  it("no duplicate research occurs across two consecutive scheduled sweeps — the second sweep's discovery finds nothing new (cross-run dedup), and no lead gains a second lead_research row", async () => {
    stubRealPipeline();
    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    await runDiscoveryForCampaign(supabase, "org-1", "campaign-1", Date.now(), 240_000);
    stubResearchAndQualification();
    await finishPendingLeads(supabase, "org-1", "campaign-1", Date.now(), 60_000);
    expect(tables.lead_research).toHaveLength(2);

    // Next hourly tick: cross-run dedup means discovery finds nothing new...
    stubRealPipeline();
    const secondDiscovery = await runDiscoveryForCampaign(supabase, "org-1", "campaign-1", Date.now(), 240_000);
    expect(secondDiscovery.newLeads).toBe(0);

    // ...and the second finishPendingLeads pass has nothing to do either,
    // since both leads are already research_status: 'completed'.
    stubResearchAndQualification();
    const secondFinish = await finishPendingLeads(supabase, "org-1", "campaign-1", Date.now(), 60_000);
    expect(secondFinish).toEqual({ finished: 0, failed: 0, outreach: { whatsappSent: 0, whatsappFailed: 0, gmailManualPending: 0, noChannelAvailable: 0 } });
    expect(tables.lead_research).toHaveLength(2);
  });
  });

  // STEP 7 — target-based, durable, resumable discovery, proved here for the
  // SCHEDULED (cron) path specifically, since it is the one automatic
  // continuation mechanism this project's Vercel plan allows (its cron sweep
  // can only run once every 24 hours) — see discovery-run.test.ts for the
  // shared decision logic this reuses, and
  // actions.discovery-lifecycle.test.ts for the equivalent proof on the
  // manual "Start Discovery" path.
  it("a scheduled sweep resumes an existing incomplete run toward its own stored target instead of starting a new one, and reaches 'completed' once the target and its research are both done", async () => {
    stubRealPipeline(); // yields Bright Pixel + Triverse — exactly the 2 more leads this run needs to hit target 10
    const tables = seedTables();
    const runStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // stale enough that the concurrency guard allows this sweep through
    tables.agent_runs = [
      { id: "run-existing", organization_id: "org-1", agent_type: "lead_discovery", status: "running", started_at: runStartedAt, completed_at: null, input: { campaignId: "campaign-1", scheduled: true, targetLeads: 10 }, output: {} },
    ];
    tables.prospects = Array.from({ length: 8 }, (_, i) => ({
      id: `prospect-old-${i}`,
      organization_id: "org-1",
      campaign_id: "campaign-1",
      company_name: `Existing Co ${i}`,
      website: `existing${i}.example`,
      created_at: new Date(Date.parse(runStartedAt) + 1000).toISOString(),
    }));
    tables.leads = Array.from({ length: 8 }, (_, i) => ({
      id: `lead-old-${i}`,
      organization_id: "org-1",
      campaign_id: "campaign-1",
      prospect_id: `prospect-old-${i}`,
      status: "new",
      qualification_status: "qualified",
      research_status: "completed",
      created_at: new Date(Date.parse(runStartedAt) + 1000).toISOString(),
    }));
    const supabase = createFakeSupabase(tables);

    const result = await runDiscoveryForCampaign(supabase, "org-1", "campaign-1", Date.now(), 240_000);

    expect(result.ran).toBe(true);
    expect(result.newLeads).toBe(2);

    const discoveryRuns = (tables.agent_runs as (Row & { agent_type: string; id: string; status: string })[]).filter((r) => r.agent_type === "lead_discovery");
    expect(discoveryRuns).toHaveLength(1); // no duplicate run — the SAME row, resumed
    expect(discoveryRuns[0].id).toBe("run-existing");
    expect(discoveryRuns[0].status).toBe("completed"); // 8 + 2 = target of 10, and Bright Pixel/Triverse's own research+qualification (stubRealPipeline covers both) complete within this same call
  });
});
