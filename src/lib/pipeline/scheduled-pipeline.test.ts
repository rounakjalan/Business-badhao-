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
      neq(column: string, value: unknown) {
        filters.push((row) => row[column] !== value);
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

    expect(result).toEqual({ finished: 1, failed: 0 });
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

    expect(result).toEqual({ finished: 1, failed: 0 });
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
    expect(result).toEqual({ finished: 0, failed: 0 });
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

    expect(result).toEqual({ finished: 1, failed: 1 });
    const leads = tables.leads as (Row & { id: string; research_status: string; qualification_status: string })[];
    const failLead = leads.find((l) => l.id === "lead-1")!;
    const goodLead = leads.find((l) => l.id === "lead-2")!;
    expect(failLead.research_status).toBe("failed");
    expect(failLead.qualification_status).toBe("pending");
    expect(goodLead.research_status).toBe("completed");
    expect(goodLead.qualification_status).toBe("qualifying");
  });

  it("scheduled discovery (runDiscoveryForCampaign) followed by finishPendingLeads — exactly what the cron route does in one sweep — automatically researches the newly discovered leads with no button pressed", async () => {
    stubRealPipeline();
    const tables = seedTables();
    const supabase = createFakeSupabase(tables);

    const discovered = await runDiscoveryForCampaign(supabase, "org-1", "campaign-1", Date.now(), 240_000);
    expect(discovered.newLeads).toBe(2);

    // Same call the cron route's pass 3 makes right after discovery, for
    // the same campaign, in the same sweep.
    stubResearchAndQualification();
    const finished = await finishPendingLeads(supabase, "org-1", "campaign-1", Date.now(), 60_000);

    expect(finished).toEqual({ finished: 2, failed: 0 });
    const leads = tables.leads as (Row & { research_status: string })[];
    expect(leads.every((l) => l.research_status === "completed")).toBe(true);
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
    expect(secondFinish).toEqual({ finished: 0, failed: 0 });
    expect(tables.lead_research).toHaveLength(2);
  });
  });
});
