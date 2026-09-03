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
import { runDiscoveryForCampaign } from "@/lib/pipeline/scheduled-pipeline";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TAVILY_URL = "https://api.tavily.com/search";

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
});
