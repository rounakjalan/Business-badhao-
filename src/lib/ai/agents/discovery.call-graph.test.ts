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
//     -> extracted candidates -> runHermesCompletion a THIRD time -> a
//        genuinely distinct real HTTP request carrying both the real
//        evidence and the second call's own candidates, reviewing them
//     -> deterministic grounding/validation (discovery.ts's own code, not
//        a fourth AI call) still runs on whatever that third call accepted
//        -> final result
//
// If discovery.ts ever stopped actually routing through Hermes/Nemotron —
// e.g. someone hard-coded a different model, or skipped the third AI call
// and just echoed the second — these tests would fail without needing to
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

  it("A-H: a discover() call genuinely flows Hermes -> Nemotron -> Tavily -> Nemotron -> a DISTINCT final Hermes call -> deterministic validation -> back to the caller", async () => {
    const realHit = {
      title: "Jaipur Retail Directory",
      url: "https://directory.example/jaipur-retail",
      content: "Sharma Boutique and Rao Fabrics are family-run clothing stores in Jaipur. Contact them via the directory.",
    };

    // Three candidates the second (extraction) call returns, each proving a
    // different thing once they reach the third (final validation) call:
    //  - Sharma Boutique: grounded and genuinely accepted by both stages —
    //    the only one that should survive to the caller.
    //  - Rao Fabrics: grounded (real, cited URL) and would pass every
    //    deterministic check on its own — the mocked final-Hermes response
    //    below deliberately excludes it, so its disappearance can only be
    //    explained by the third call's own judgment, not by grounding.
    //  - Fabricated Traders: cites a URL that was never in the real search
    //    results. The mocked final-Hermes response below (naively) accepts
    //    it anyway, simulating Hermes missing a fabrication — proving the
    //    deterministic layer after it is a real backstop, not decoration.
    const extractedCandidates = [
      {
        companyName: "Sharma Boutique",
        website: "sharmaboutique.example",
        location: "Jaipur",
        industry: "Retail",
        businessType: "Boutique",
        email: null,
        phone: null,
        matchedIcpCriteria: ["location: Jaipur"],
        evidenceSnippet: "Sharma Boutique and Rao Fabrics are family-run clothing stores in Jaipur.",
        sourceUrl: realHit.url,
        searchQuery: "retail store owners in Jaipur",
      },
      {
        companyName: "Rao Fabrics",
        website: "raofabrics.example",
        location: "Jaipur",
        industry: "Retail",
        businessType: "Boutique",
        email: null,
        phone: null,
        matchedIcpCriteria: ["location: Jaipur"],
        evidenceSnippet: "Sharma Boutique and Rao Fabrics are family-run clothing stores in Jaipur.",
        sourceUrl: realHit.url,
        searchQuery: "retail store owners in Jaipur",
      },
      {
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
    ];

    const openRouterCalls: { url: string; body: Record<string, unknown> }[] = [];
    const tavilyCalls: { url: string; body: Record<string, unknown> }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));

        if (url === OPENROUTER_URL) {
          openRouterCalls.push({ url, body });
          const userPrompt = String(body.messages?.[1]?.content ?? "");

          // Call 3 = final validation. Checked first since its prompt also
          // repeats the real evidence and would otherwise be mistaken for
          // call 2's own "REAL SEARCH RESULTS" marker.
          if (userPrompt.includes("CANDIDATE PROSPECTS TO REVIEW")) {
            // Deliberately naive: accepts Sharma Boutique (correctly) and
            // Fabricated Traders (a mistake — testing the safety net below),
            // but excludes Rao Fabrics even though it's just as grounded —
            // that exclusion is this call's own judgment, tested at G/H.
            return openRouterResponse({ accepted: [extractedCandidates[0], extractedCandidates[2]] });
          }
          if (userPrompt.includes("REAL SEARCH RESULTS")) {
            return openRouterResponse({ prospects: extractedCandidates });
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
    expect(openRouterCalls).toHaveLength(3);
    expect(openRouterCalls[0].body.model).toBe(DEFAULT_OPENROUTER_MODEL);

    // C: Nemotron's own query output is what actually got searched — not a
    // hardcoded or pre-baked query.
    expect(tavilyCalls).toHaveLength(1);
    expect(tavilyCalls[0].body.query).toBe("retail store owners in Jaipur");

    // D: the second Nemotron call's prompt carries the REAL Tavily result
    // content, not a repeat of the original campaign/ICP prompt — and the
    // third call (final Hermes validation) is a genuinely separate real
    // request, not the second call's response relabeled.
    expect(openRouterCalls[1].body.model).toBe(DEFAULT_OPENROUTER_MODEL);
    const extractionPrompt = String((openRouterCalls[1].body.messages as { content: string }[])[1].content);
    expect(extractionPrompt).toContain(realHit.url);
    expect(extractionPrompt).toContain("Sharma Boutique and Rao Fabrics are family-run clothing stores in Jaipur");

    // E: the third call's own prompt is distinct from the second's — it
    // carries the same real evidence AND the second call's own extracted
    // candidates (not the original campaign prompt, not empty).
    expect(openRouterCalls[2].body.model).toBe(DEFAULT_OPENROUTER_MODEL);
    const finalValidationPrompt = String((openRouterCalls[2].body.messages as { content: string }[])[1].content);
    expect(finalValidationPrompt).toContain(realHit.url);
    expect(finalValidationPrompt).toContain("Sharma Boutique and Rao Fabrics are family-run clothing stores in Jaipur");
    expect(finalValidationPrompt).toContain("Rao Fabrics");
    expect(finalValidationPrompt).toContain("Fabricated Traders");

    // F/G/H: only Sharma Boutique survives to the caller.
    //  - Rao Fabrics is gone even though it was fully grounded — proof the
    //    third call's own rejection had a real effect (H), not just
    //    grounding, which alone would have kept it.
    //  - Fabricated Traders is gone despite the third call accepting it —
    //    proof the deterministic layer after it is a genuine backstop (G),
    //    not merely trusting whatever Hermes decided.
    expect(result.prospects.map((p) => p.companyName)).toEqual(["Sharma Boutique"]);
    expect(result.prospects[0].sourceUrl).toBe(realHit.url);

    // This validated, structured result is exactly what reaches Business
    // Badhao's persistence layer (campaigns/actions.ts / scheduled-pipeline.ts).
    expect(result.queriesRun).toEqual(["retail store owners in Jaipur"]);
    expect(result.queriesFailed).toEqual([]);
  });

  it("Exa fallback: when Tavily fails, Exa's real results reach the second Nemotron call AND the third (final Hermes) call unchanged", async () => {
    process.env.EXA_API_KEY = "test-exa-key";
    const exaHit = { title: "Mehta Fashions — Jaipur", url: "https://mehtafashions.example/about", text: "Mehta Fashions is a boutique clothing retailer in Jaipur." };
    const candidate = {
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
    };

    const openRouterCalls: { url: string; body: Record<string, unknown> }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (url === OPENROUTER_URL) {
          openRouterCalls.push({ url, body });
          const userPrompt = String(body.messages?.[1]?.content ?? "");
          if (userPrompt.includes("CANDIDATE PROSPECTS TO REVIEW")) return openRouterResponse({ accepted: [candidate] });
          if (userPrompt.includes("REAL SEARCH RESULTS")) return openRouterResponse({ prospects: [candidate] });
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

    // The third (final Hermes) call's own prompt genuinely carries Exa's
    // real result, exactly as the second call's did — the fallback isn't
    // special-cased away once it reaches later stages.
    expect(openRouterCalls).toHaveLength(3);
    const finalValidationPrompt = String((openRouterCalls[2].body.messages as { content: string }[])[1].content);
    expect(finalValidationPrompt).toContain(exaHit.url);
    expect(finalValidationPrompt).toContain("Mehta Fashions is a boutique clothing retailer in Jaipur");
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

  it("final Hermes call failure: a real Nemotron extraction still fails the whole run honestly if the THIRD call fails, never falling back to unvalidated candidates", async () => {
    const realHit = { title: "Jaipur Retail Directory", url: "https://directory.example/jaipur-retail", content: "Sharma Boutique is a family-run clothing store in Jaipur." };
    const candidate = {
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
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (url === OPENROUTER_URL) {
          const userPrompt = String(body.messages?.[1]?.content ?? "");
          // The third call specifically fails — the first two calls (and
          // the real Tavily search) all genuinely succeeded first.
          if (userPrompt.includes("CANDIDATE PROSPECTS TO REVIEW")) return new Response("internal server error", { status: 500 });
          if (userPrompt.includes("REAL SEARCH RESULTS")) return openRouterResponse({ prospects: [candidate] });
          return openRouterResponse({ queries: ["retail store owners in Jaipur"] });
        }
        if (url === TAVILY_URL) return new Response(JSON.stringify({ results: [realHit] }), { status: 200, headers: { "Content-Type": "application/json" } });
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );

    const result = await new TavilyDiscoveryProvider().discover(criteria);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("provider_error");
    // Confirms discover() does not silently fall back to the second call's
    // un-reviewed candidates when the third call itself fails.
  });
});
