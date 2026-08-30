import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every test in discovery.test.ts mocks runHermesCompletion directly, which
// proves discovery.ts calls Hermes correctly but never actually exercises
// what Hermes does with that call — resolveRouting, provider selection, or
// the real HTTP request to whichever model that resolves to. This file
// mocks nothing above the network boundary (fetch) and the database
// boundary (Supabase, for agent_runs/model_usage tracking), so the full
// requested call graph runs for real:
//
//   discover() -> runHermesCompletion -> resolveRouting -> OpenRouterProvider
//     -> real HTTP request naming nvidia/nemotron-3-ultra-550b-a55b:free
//     -> queries -> real Tavily/Exa HTTP request -> real results
//     -> runHermesCompletion again -> OpenRouterProvider -> real HTTP request,
//        this time carrying the real search results in its prompt
//     -> extracted candidates -> deterministic grounding/validation
//        (discovery.ts's own code, not another AI call) -> final result
//
// If discovery.ts ever stopped actually routing through Hermes/Nemotron —
// e.g. someone hard-coded a different model, or skipped the second AI call
// and just echoed the first — these tests would fail without needing to
// know anything about discovery.ts's internals, because they only look at
// what actually crossed the network.

const { insertSpy, updateSpy } = vi.hoisted(() => ({ insertSpy: vi.fn(), updateSpy: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (_table: string) => ({
      insert: (payload: unknown) => {
        insertSpy(_table, payload);
        return { select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }) };
      },
      update: (payload: unknown) => {
        updateSpy(_table, payload);
        return { eq: async () => ({ error: null }) };
      },
    }),
  })),
}));

import { DEFAULT_OPENROUTER_MODEL } from "@/lib/ai/providers/openrouter";
import { TavilyDiscoveryProvider, type DiscoveryCriteria } from "@/lib/ai/agents/discovery";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TAVILY_URL = "https://api.tavily.com/search";
const EXA_URL = "https://api.exa.ai/search";

const criteria: DiscoveryCriteria = {
  organizationId: "org-1",
  campaignName: "Jaipur Retail Push",
  campaignObjective: "Book demo calls with boutique owners",
  icpCriteria: { location: "Jaipur", industry: "Retail" },
  businessContext: null,
};

function openRouterResponse(body: unknown, model = DEFAULT_OPENROUTER_MODEL) {
  return new Response(
    JSON.stringify({
      id: "req-1",
      model, // real APIs echo back the model that actually answered — this is what response.model reads
      choices: [{ message: { content: JSON.stringify(body) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

const ENV_KEYS = ["TAVILY_API_KEY", "EXA_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "AI_PROVIDER", "AI_FALLBACK_PROVIDER", "GROQ_API_KEY", "HUGGINGFACE_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("real runtime call graph: Business Badhao -> Hermes -> Nemotron -> Tavily/Exa -> Nemotron -> Hermes -> Business Badhao", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.TAVILY_API_KEY = "test-tavily-key";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.OPENROUTER_MODEL; // so the default (Nemotron) is what actually gets requested
    delete process.env.AI_PROVIDER; // defaults to "openrouter" in getAiConfig
    delete process.env.AI_FALLBACK_PROVIDER;
    delete process.env.EXA_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.HUGGINGFACE_API_KEY;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("A-F: a discover() call genuinely flows Hermes -> Nemotron -> Tavily -> Nemotron -> Hermes's own validation -> back to the caller", async () => {
    const realHit = {
      title: "Jaipur Retail Directory",
      url: "https://directory.example/jaipur-retail",
      content: "Sharma Boutique is a family-run clothing store in Jaipur. Contact them via the directory.",
    };

    const openRouterCalls: { url: string; body: Record<string, unknown> }[] = [];
    const tavilyCalls: { url: string; body: Record<string, unknown> }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));

        if (url === OPENROUTER_URL) {
          openRouterCalls.push({ url, body });
          // Call 1 = query generation (asks for search queries), call 2 = extraction
          // (its prompt names the real search results — see assertion D below).
          const userPrompt = body.messages?.[1]?.content ?? "";
          if (typeof userPrompt === "string" && userPrompt.includes("REAL SEARCH RESULTS")) {
            return openRouterResponse({
              prospects: [
                {
                  companyName: "Sharma Boutique",
                  website: "sharmaboutique.example",
                  location: "Jaipur",
                  industry: "Retail",
                  businessType: "Boutique",
                  email: null,
                  phone: null,
                  matchedIcpCriteria: ["location: Jaipur"],
                  evidenceSnippet: "Sharma Boutique is a family-run clothing store in Jaipur.",
                  sourceUrl: realHit.url,
                  searchQuery: "retail store owners in Jaipur",
                },
                {
                  // Nemotron could hallucinate a citation for a page that was never
                  // searched — this is what stage E's grounding check must catch.
                  companyName: "Fabricated Traders",
                  website: "fabricated-traders.example",
                  location: "Jaipur",
                  industry: "Retail",
                  businessType: "Shop",
                  email: null,
                  phone: null,
                  matchedIcpCriteria: ["location: Jaipur"],
                  evidenceSnippet: "invented text",
                  sourceUrl: "https://never-searched.example/fake",
                  searchQuery: "retail store owners in Jaipur",
                },
              ],
            });
          }
          return openRouterResponse({ queries: ["retail store owners in Jaipur"] });
        }

        if (url === TAVILY_URL) {
          tavilyCalls.push({ url, body });
          return new Response(JSON.stringify({ results: [realHit] }), { status: 200, headers: { "Content-Type": "application/json" } });
        }

        throw new Error(`unexpected fetch url in call-graph test: ${url}`);
      })
    );

    const result = await new TavilyDiscoveryProvider().discover(criteria);

    // A: Business Badhao's call into the provider actually happened and returned.
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // B: Hermes really routed the first call to Nemotron (real HTTP request naming it).
    expect(openRouterCalls).toHaveLength(2);
    expect(openRouterCalls[0].body.model).toBe(DEFAULT_OPENROUTER_MODEL);

    // C: Nemotron's own query output is what actually got searched — not a
    // hardcoded or pre-baked query.
    expect(tavilyCalls).toHaveLength(1);
    expect(tavilyCalls[0].body.query).toBe("retail store owners in Jaipur");

    // D: the second Nemotron call's prompt carries the REAL Tavily result
    // content, not a repeat of the original campaign/ICP prompt.
    expect(openRouterCalls[1].body.model).toBe(DEFAULT_OPENROUTER_MODEL);
    const extractionPrompt = String((openRouterCalls[1].body.messages as { content: string }[])[1].content);
    expect(extractionPrompt).toContain(realHit.url);
    expect(extractionPrompt).toContain("Sharma Boutique is a family-run clothing store in Jaipur");

    // E: Hermes's deterministic final layer actually ran on Nemotron's raw
    // output — the fabricated citation is gone, the grounded one survived
    // with its real evidence intact.
    expect(result.prospects.map((p) => p.companyName)).toEqual(["Sharma Boutique"]);
    expect(result.prospects[0].sourceUrl).toBe(realHit.url);

    // F: this validated, structured result is exactly what reaches Business
    // Badhao's persistence layer (campaigns/actions.ts / scheduled-pipeline.ts).
    expect(result.queriesRun).toEqual(["retail store owners in Jaipur"]);
    expect(result.queriesFailed).toEqual([]);
  });

  it("Exa fallback: when Tavily fails, Exa's real results are what the second Nemotron call actually reasons over", async () => {
    process.env.EXA_API_KEY = "test-exa-key";
    const exaHit = { title: "Mehta Fashions — Jaipur", url: "https://mehtafashions.example/about", text: "Mehta Fashions is a boutique clothing retailer in Jaipur." };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (url === OPENROUTER_URL) {
          const userPrompt = body.messages?.[1]?.content ?? "";
          if (typeof userPrompt === "string" && userPrompt.includes("REAL SEARCH RESULTS")) {
            return openRouterResponse({
              prospects: [
                {
                  companyName: "Mehta Fashions",
                  website: "mehtafashions.example",
                  location: "Jaipur",
                  industry: "Retail",
                  businessType: "Boutique",
                  email: null,
                  phone: null,
                  matchedIcpCriteria: ["location: Jaipur"],
                  evidenceSnippet: "Mehta Fashions is a boutique clothing retailer in Jaipur.",
                  sourceUrl: exaHit.url,
                  searchQuery: "retail store owners in Jaipur",
                },
              ],
            });
          }
          return openRouterResponse({ queries: ["retail store owners in Jaipur"] });
        }
        if (url === TAVILY_URL) return new Response("service unavailable", { status: 503 });
        if (url === EXA_URL) return new Response(JSON.stringify({ results: [exaHit] }), { status: 200, headers: { "Content-Type": "application/json" } });
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );

    const result = await new TavilyDiscoveryProvider().discover(criteria);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prospects).toHaveLength(1);
    expect(result.prospects[0].sourceUrl).toBe(exaHit.url);
    expect(result.telemetry?.servedByExa).toEqual(["retail store owners in Jaipur"]);
  });

  it("Nemotron/Hermes failure: an OpenRouter outage produces a truthful failure, never a fabricated discovery result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === OPENROUTER_URL) return new Response("internal server error", { status: 500 });
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );

    const result = await new TavilyDiscoveryProvider().discover(criteria);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("provider_error");
  });
});
