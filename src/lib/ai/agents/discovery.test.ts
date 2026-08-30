import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectDiscoveryContext, type BusinessContext } from "@/lib/business-context";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import {
  dedupeProspects,
  finalizeDiscoveryResult,
  getDiscoveryProvider,
  isCompetitorSeekingQuery,
  isNonBusinessName,
  isSourceSiteName,
  newTelemetry,
  NullDiscoveryProvider,
  normalizeWebsite,
  prospectDedupeKey,
  runFinalHermesValidation,
  TavilyDiscoveryProvider,
  type DiscoveredProspect,
  type DiscoveryCriteria,
} from "@/lib/ai/agents/discovery";

const QUERIES_RESPONSE = { queries: ["retail store owners in Jaipur", "boutique clothing shops Jaipur"] };

const SEARCH_HITS = [
  { title: "Sharma Boutique — Jaipur", url: "https://sharmaboutique.example/about", content: "Sharma Boutique is a family-run clothing store in Jaipur serving customers since 2010." },
  { title: "Jaipur Retail Directory", url: "https://directory.example/jaipur-retail", content: "A directory listing of many retail stores in Jaipur." },
];

const EXTRACTION_RESPONSE = {
  prospects: [
    {
      companyName: "Sharma Boutique",
      website: "sharmaboutique.example",
      location: "Jaipur",
      industry: "Retail",
      businessType: "Boutique",
      email: null,
      phone: null,
      matchedIcpCriteria: ["location: Jaipur", "industry: Retail"],
      evidenceSnippet: "Sharma Boutique is a family-run clothing store in Jaipur serving customers since 2010.",
      sourceUrl: "https://sharmaboutique.example/about",
      searchQuery: "retail store owners in Jaipur",
    },
  ],
};

const SINGLE_QUERY_RESPONSE = { queries: ["retail store owners in Jaipur"] };

const EXA_HITS = [
  { title: "Mehta Fashions — Jaipur", url: "https://mehtafashions.example/about", text: "Mehta Fashions is a boutique clothing retailer in Jaipur, family-owned since 2015." },
];

const EXA_EXTRACTION_RESPONSE = {
  prospects: [
    {
      companyName: "Mehta Fashions",
      website: "mehtafashions.example",
      location: "Jaipur",
      industry: "Retail",
      businessType: "Boutique",
      email: null,
      phone: null,
      matchedIcpCriteria: ["location: Jaipur", "industry: Retail"],
      evidenceSnippet: "Mehta Fashions is a boutique clothing retailer in Jaipur, family-owned since 2015.",
      sourceUrl: "https://mehtafashions.example/about",
      searchQuery: "retail store owners in Jaipur",
    },
  ],
};

const baseCriteria: DiscoveryCriteria = {
  organizationId: "org-1",
  campaignName: "Jaipur Retail Push",
  campaignObjective: "Book demo calls with boutique owners",
  icpCriteria: { location: "Jaipur", industry: "Retail" },
  businessContext: null,
};

function mockFetchOk(hitsByQuery: Record<string, { title: string; url: string; content: string }[]>) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const results = hitsByQuery[body.query] ?? [];
    return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

/** Routes fetch by URL to distinct Tavily/Exa handlers, so fallback tests can assert precisely which provider was actually called. */
function mockFetchRouter(handlers: { tavily?: () => Response | Promise<Response>; exa?: () => Response | Promise<Response> }) {
  return vi.fn(async (url: string) => {
    if (url === "https://api.tavily.com/search") {
      if (!handlers.tavily) throw new Error("unexpected Tavily call in this test");
      return handlers.tavily();
    }
    if (url === "https://api.exa.ai/search") {
      if (!handlers.exa) throw new Error("unexpected Exa call in this test");
      return handlers.exa();
    }
    throw new Error(`unexpected fetch url: ${url}`);
  });
}

/**
 * Default behavior for the third runHermesCompletion call (final
 * validation) once a test's own queued mockResolvedValueOnce responses run
 * out. Every existing test below queues exactly the two calls it cares
 * about (query generation, extraction) and was written before the final
 * validation stage existed — mockResolvedValueOnce queues are always
 * consumed before mockImplementation is reached, so this only ever runs
 * for that third call, never for the two calls those tests are actually
 * asserting on. It passes every candidate through unchanged, so the
 * deterministic checks downstream (which is what those tests exercise)
 * still see exactly the extraction output they always did. Tests that
 * specifically exercise final validation (see the dedicated describe
 * block below) override this with their own mockResolvedValueOnce.
 */
function passThroughFinalValidation(request: { userPrompt: string }) {
  const marker = "=== CANDIDATE PROSPECTS TO REVIEW ===\n";
  const idx = request.userPrompt.indexOf(marker);
  const candidatesJson = idx === -1 ? "[]" : request.userPrompt.slice(idx + marker.length).trim();
  return Promise.resolve({
    ok: true as const,
    text: JSON.stringify({ accepted: JSON.parse(candidatesJson) }),
    provider: "openrouter" as const,
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
  });
}

describe("lead discovery", () => {
  const originalTavilyKey = process.env.TAVILY_API_KEY;
  const originalExaKey = process.env.EXA_API_KEY;

  beforeEach(() => {
    vi.mocked(runHermesCompletion).mockImplementation(passThroughFinalValidation);
  });

  afterEach(() => {
    // resetAllMocks (not clearAllMocks) — several tests below intentionally
    // consume fewer queued mockResolvedValueOnce values than they set (e.g.
    // the zero-hits test skips extraction entirely), and clearAllMocks does
    // not drain that queue, which would leak a stale queued response into
    // the next test's first call.
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    if (originalTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalTavilyKey;
    if (originalExaKey === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = originalExaKey;
  });

  describe("provider selection — never fabricates without a real provider", () => {
    it("has no configured discovery source when TAVILY_API_KEY is unset", () => {
      delete process.env.TAVILY_API_KEY;
      const provider = getDiscoveryProvider();
      expect(provider).toBeInstanceOf(NullDiscoveryProvider);
      expect(provider.isConfigured()).toBe(false);
    });

    it("NullDiscoveryProvider returns a controlled not_configured result, never a fabricated prospect list", async () => {
      const result = await new NullDiscoveryProvider().discover();
      expect(result).toEqual({
        ok: false,
        code: "not_configured",
        message: "Lead discovery isn't connected to a data source yet.",
      });
    });

    it("selects TavilyDiscoveryProvider once TAVILY_API_KEY is set", () => {
      process.env.TAVILY_API_KEY = "test-key";
      const provider = getDiscoveryProvider();
      expect(provider).toBeInstanceOf(TavilyDiscoveryProvider);
      expect(provider.isConfigured()).toBe(true);
    });
  });

  describe("TavilyDiscoveryProvider — real search + grounded extraction", () => {
    beforeEach(() => {
      process.env.TAVILY_API_KEY = "test-key";
    });

    it("reports not_configured (not a crash or a fake result) if the API key is missing at call time", async () => {
      delete process.env.TAVILY_API_KEY;
      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);
      expect(result).toEqual({
        ok: false,
        code: "not_configured",
        message: "Lead discovery isn't connected to a search provider yet — TAVILY_API_KEY is not set.",
      });
    });

    it("turns the campaign's actual ICP into search queries, then runs a real search for each", async () => {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(QUERIES_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ prospects: [] }), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      const fetchMock = mockFetchOk({});
      vi.stubGlobal("fetch", fetchMock);

      await new TavilyDiscoveryProvider().discover(baseCriteria);

      const queryPrompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
      expect(queryPrompt).toContain('"location":"Jaipur"');
      expect(queryPrompt).toContain('"industry":"Retail"');

      expect(fetchMock).toHaveBeenCalledTimes(QUERIES_RESPONSE.queries.length);
      for (const call of fetchMock.mock.calls) {
        expect(call[0]).toBe("https://api.tavily.com/search");
        const body = JSON.parse(String((call[1] as RequestInit).body));
        expect(body.api_key).toBe("test-key");
      }
    });

    it("extracts real, distinct prospects from real search results and never invents a company", async () => {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(QUERIES_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(EXTRACTION_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      vi.stubGlobal(
        "fetch",
        mockFetchOk({
          "retail store owners in Jaipur": SEARCH_HITS,
          "boutique clothing shops Jaipur": [],
        })
      );

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok result");
      expect(result.prospects).toHaveLength(1);
      expect(result.prospects[0].companyName).toBe("Sharma Boutique");
    });

    it("preserves the source URL and evidence snippet exactly as extracted — no rewriting", async () => {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(QUERIES_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(EXTRACTION_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      vi.stubGlobal("fetch", mockFetchOk({ "retail store owners in Jaipur": SEARCH_HITS, "boutique clothing shops Jaipur": [] }));

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);
      if (!result.ok) throw new Error("expected ok result");

      expect(result.prospects[0].sourceUrl).toBe("https://sharmaboutique.example/about");
      expect(result.prospects[0].evidenceSnippet).toBe(
        "Sharma Boutique is a family-run clothing store in Jaipur serving customers since 2010."
      );
    });

    it("anti-fabrication guard: drops an extracted prospect whose sourceUrl was never actually in the search results", async () => {
      const fabricated = {
        prospects: [
          ...EXTRACTION_RESPONSE.prospects,
          {
            companyName: "Fictional Fashions",
            website: "fictionalfashions.example",
            location: "Jaipur",
            industry: "Retail",
            businessType: "Boutique",
            email: null,
            phone: null,
            matchedIcpCriteria: ["industry: Retail"],
            evidenceSnippet: "A made-up excerpt.",
            sourceUrl: "https://fictionalfashions.example/never-returned-by-search",
            searchQuery: "retail store owners in Jaipur",
          },
        ],
      };

      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(QUERIES_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(fabricated), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      vi.stubGlobal("fetch", mockFetchOk({ "retail store owners in Jaipur": SEARCH_HITS, "boutique clothing shops Jaipur": [] }));

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);
      if (!result.ok) throw new Error("expected ok result");

      expect(result.prospects.map((p) => p.companyName)).not.toContain("Fictional Fashions");
      expect(result.prospects).toHaveLength(1);
    });

    it("returns ok with zero prospects (not an error) when searches succeed but find nothing", async () => {
      vi.mocked(runHermesCompletion).mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify(QUERIES_RESPONSE),
        provider: "openrouter",
        model: "nousresearch/hermes-4-70b",
      });

      vi.stubGlobal("fetch", mockFetchOk({}));

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result).toMatchObject({ ok: true, prospects: [] });
      // Zero search hits means extraction is skipped entirely — never asked
      // the model to "find something" from nothing.
      expect(vi.mocked(runHermesCompletion)).toHaveBeenCalledTimes(1);
    });

    it("honestly returns an empty prospect list when Hermes itself returns none, instead of retrying into a fabrication", async () => {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(QUERIES_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ prospects: [] }), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      vi.stubGlobal("fetch", mockFetchOk({ "retail store owners in Jaipur": SEARCH_HITS, "boutique clothing shops Jaipur": [] }));

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);
      expect(result).toMatchObject({ ok: true, prospects: [] });
    });

    it("partial failure: reports which queries failed but still returns prospects from the ones that succeeded", async () => {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(QUERIES_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(EXTRACTION_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.query === "boutique clothing shops Jaipur") {
          return new Response("Internal Server Error", { status: 500 });
        }
        return new Response(JSON.stringify({ results: SEARCH_HITS }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok result");
      expect(result.queriesFailed).toEqual(["boutique clothing shops Jaipur"]);
      expect(result.queriesRun).toEqual(["retail store owners in Jaipur"]);
      expect(result.prospects).toHaveLength(1);
    });

    it("fails honestly with provider_error when every search query fails — never silently reports success", async () => {
      vi.mocked(runHermesCompletion).mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify(QUERIES_RESPONSE),
        provider: "openrouter",
        model: "nousresearch/hermes-4-70b",
      });

      vi.stubGlobal("fetch", vi.fn(async () => new Response("Service Unavailable", { status: 503 })));

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure result");
      expect(result.code).toBe("provider_error");
    });

    it("propagates a Hermes-level failure during query generation as provider_error", async () => {
      vi.mocked(runHermesCompletion).mockResolvedValueOnce({
        ok: false,
        code: "timeout",
        message: "The AI provider took too long to respond. Try again.",
      });

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result).toEqual({
        ok: false,
        code: "provider_error",
        message: "The AI provider took too long to respond. Try again.",
      });
    });

    it("sends Business Knowledge and the campaign alongside the ICP, in clearly separate sections", async () => {
      const businessContext: BusinessContext = {
        businessProfile: { name: "Acme Ads", description: null, category: "Marketing agency", about: null, website: null, phone: null, email: null, whatsapp: null, address: null, serviceArea: "Jaipur", openingHours: null },
        productsServices: [],
        valueProposition: { keySellingPoints: [], productBenefits: [] },
        faqs: [],
        policies: [],
        aiCommunicationRules: null,
        mediaReferences: [],
      };

      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(QUERIES_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ prospects: [] }), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      vi.stubGlobal("fetch", mockFetchOk({ "retail store owners in Jaipur": SEARCH_HITS, "boutique clothing shops Jaipur": [] }));

      await new TavilyDiscoveryProvider().discover({ ...baseCriteria, businessContext });

      const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
      const sellerIdx = prompt.indexOf("=== WHAT THIS BUSINESS SELLS");
      const icpIdx = prompt.indexOf("=== IDEAL CUSTOMER PROFILE");
      expect(prompt).toContain("Acme Ads");
      expect(sellerIdx).toBeGreaterThanOrEqual(0);
      expect(icpIdx).toBeGreaterThan(sellerIdx);
    });

    it("keeps organizationId scoped through both AI calls, so every tracked agent run stays attributable to the calling org", async () => {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(QUERIES_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(EXTRACTION_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      vi.stubGlobal("fetch", mockFetchOk({ "retail store owners in Jaipur": SEARCH_HITS, "boutique clothing shops Jaipur": [] }));

      await new TavilyDiscoveryProvider().discover({ ...baseCriteria, organizationId: "org-42" });

      for (const call of vi.mocked(runHermesCompletion).mock.calls) {
        expect(call[0].organizationId).toBe("org-42");
      }
    });
  });

  describe("Tavily -> Exa fallback (Exa is a fallback only, never a replacement)", () => {
    beforeEach(() => {
      process.env.TAVILY_API_KEY = "tavily-key";
    });

    it("Tavily succeeds -> Exa is never called", async () => {
      process.env.EXA_API_KEY = "exa-key";
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(SINGLE_QUERY_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(EXTRACTION_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      const fetchMock = mockFetchRouter({ tavily: async () => new Response(JSON.stringify({ results: SEARCH_HITS }), { status: 200 }) });
      vi.stubGlobal("fetch", fetchMock);

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result).toMatchObject({ ok: true, queriesFailed: [] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("https://api.tavily.com/search", expect.anything());
    });

    it("Tavily fails (rate limit) -> Exa is automatically called and its results are used", async () => {
      process.env.EXA_API_KEY = "exa-key";
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(SINGLE_QUERY_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(EXA_EXTRACTION_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      const fetchMock = mockFetchRouter({
        tavily: async () => new Response(JSON.stringify({ detail: { error: "Unauthorized: quota exceeded" } }), { status: 429 }),
        exa: async () => new Response(JSON.stringify({ results: EXA_HITS }), { status: 200 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok result");
      expect(result.queriesFailed).toEqual([]);
      expect(result.queriesRun).toEqual(["retail store owners in Jaipur"]);
      expect(result.prospects).toHaveLength(1);
      expect(result.prospects[0].companyName).toBe("Mehta Fashions");
      expect(result.prospects[0].sourceUrl).toBe("https://mehtafashions.example/about");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("Tavily succeeds with zero results -> Exa is not called, and zero results stays zero (not treated as failure)", async () => {
      process.env.EXA_API_KEY = "exa-key";
      vi.mocked(runHermesCompletion).mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify(SINGLE_QUERY_RESPONSE),
        provider: "openrouter",
        model: "nousresearch/hermes-4-70b",
      });

      const fetchMock = mockFetchRouter({ tavily: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }) });
      vi.stubGlobal("fetch", fetchMock);

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result).toMatchObject({ ok: true, prospects: [], queriesFailed: [] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Extraction is skipped entirely on zero hits, same as before Exa existed.
      expect(vi.mocked(runHermesCompletion)).toHaveBeenCalledTimes(1);
    });

    it("Exa's normalized results (title/url/text->content) flow through the existing extraction pipeline unchanged", async () => {
      process.env.EXA_API_KEY = "exa-key";
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(SINGLE_QUERY_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(EXA_EXTRACTION_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      const fetchMock = mockFetchRouter({
        tavily: async () => new Response("Service Unavailable", { status: 503 }),
        exa: async () => new Response(JSON.stringify({ results: EXA_HITS }), { status: 200 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await new TavilyDiscoveryProvider().discover(baseCriteria);

      // The extraction prompt (2nd Hermes call) is built from SearchHit[]
      // (title/url/content) regardless of provider — assert Exa's "text"
      // field actually made it into "content" in that prompt.
      const extractionPrompt = vi.mocked(runHermesCompletion).mock.calls[1][0].userPrompt;
      expect(extractionPrompt).toContain("Mehta Fashions is a boutique clothing retailer in Jaipur, family-owned since 2015.");
      expect(extractionPrompt).toContain("https://mehtafashions.example/about");
    });

    it("Exa API key missing -> Tavily's failure is not rescued; existing failure behavior is preserved", async () => {
      delete process.env.EXA_API_KEY;
      vi.mocked(runHermesCompletion).mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify(SINGLE_QUERY_RESPONSE),
        provider: "openrouter",
        model: "nousresearch/hermes-4-70b",
      });

      const fetchMock = mockFetchRouter({ tavily: async () => new Response("Service Unavailable", { status: 503 }) });
      vi.stubGlobal("fetch", fetchMock);

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure result");
      expect(result.code).toBe("provider_error");
      expect(result.message).toContain("HTTP 503");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("both Tavily and Exa fail -> existing discovery failure behavior, no fabricated prospects", async () => {
      process.env.EXA_API_KEY = "exa-key";
      vi.mocked(runHermesCompletion).mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify(SINGLE_QUERY_RESPONSE),
        provider: "openrouter",
        model: "nousresearch/hermes-4-70b",
      });

      const fetchMock = mockFetchRouter({
        tavily: async () => new Response("Service Unavailable", { status: 503 }),
        exa: async () => new Response("Internal Server Error", { status: 500 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure result");
      expect(result.code).toBe("provider_error");
      expect(result.message).toMatch(/Tavily[\s\S]*Exa/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("Tavily-only configuration (EXA_API_KEY never set) continues to work exactly as before", async () => {
      delete process.env.EXA_API_KEY;
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(SINGLE_QUERY_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(EXTRACTION_RESPONSE), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      const fetchMock = mockFetchRouter({ tavily: async () => new Response(JSON.stringify({ results: SEARCH_HITS }), { status: 200 }) });
      vi.stubGlobal("fetch", fetchMock);

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result).toMatchObject({ ok: true, prospects: [{ companyName: "Sharma Boutique" }] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("deduplication (within one run) — canonical domain first, name fallback", () => {
    it("normalizes a website to a bare lowercase hostname, ignoring scheme/www/path", () => {
      expect(normalizeWebsite("https://www.Example.com/about")).toBe("example.com");
      expect(normalizeWebsite("example.com")).toBe("example.com");
      expect(normalizeWebsite(null)).toBeNull();
      expect(normalizeWebsite("not a url")).toBeNull();
    });

    it("dedupes two prospects with the same canonical domain, keeping the first", () => {
      const a: DiscoveredProspect = { ...EXTRACTION_RESPONSE.prospects[0], website: "https://www.sharmaboutique.example/" };
      const b: DiscoveredProspect = { ...EXTRACTION_RESPONSE.prospects[0], website: "sharmaboutique.example", evidenceSnippet: "a different excerpt" };

      const deduped = dedupeProspects([a, b]);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].evidenceSnippet).toBe(a.evidenceSnippet);
    });

    it("falls back to normalized company name when there is no website", () => {
      const a: DiscoveredProspect = { ...EXTRACTION_RESPONSE.prospects[0], website: null, companyName: "Sharma Boutique" };
      const b: DiscoveredProspect = { ...EXTRACTION_RESPONSE.prospects[0], website: null, companyName: "  sharma boutique  " };
      expect(prospectDedupeKey(a)).toBe(prospectDedupeKey(b));
      expect(dedupeProspects([a, b])).toHaveLength(1);
    });

    it("keeps two genuinely different companies distinct", () => {
      const a: DiscoveredProspect = { ...EXTRACTION_RESPONSE.prospects[0], website: "sharmaboutique.example" };
      const b: DiscoveredProspect = { ...EXTRACTION_RESPONSE.prospects[0], website: "otherboutique.example", companyName: "Other Boutique" };
      expect(dedupeProspects([a, b])).toHaveLength(2);
    });

    it("caps a single discover() run at 20 prospects even when extraction legitimately finds more distinct businesses", async () => {
      process.env.TAVILY_API_KEY = "test-key";
      const query = "retail store owners in Jaipur";
      const hits = [{ title: "Jaipur Retail Directory", url: "https://directory.example/jaipur-retail", content: "A directory listing many retail stores in Jaipur." }];

      const manyProspects = Array.from({ length: 25 }, (_, i) => ({
        companyName: `Retailer ${i}`,
        website: `retailer${i}.example`,
        location: "Jaipur",
        industry: "Retail",
        businessType: "Shop",
        email: null,
        phone: null,
        matchedIcpCriteria: ["location: Jaipur"],
        evidenceSnippet: "A directory listing many retail stores in Jaipur.",
        sourceUrl: hits[0].url,
        searchQuery: query,
      }));

      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ queries: [query] }), provider: "openrouter", model: "nousresearch/hermes-4-70b" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ prospects: manyProspects }), provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      vi.stubGlobal("fetch", mockFetchOk({ [query]: hits }));

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // All 25 were real, distinct, grounded businesses — dedupeProspects
      // would have kept every one of them; the run-level cap is what trims
      // it to 20, not deduplication.
      expect(result.prospects).toHaveLength(20);
      expect(result.prospects.map((p) => p.companyName)).toEqual(manyProspects.slice(0, 20).map((p) => p.companyName));
    });
  });

  describe("finalizeDiscoveryResult — the final orchestration/validation stage, tested directly and in isolation", () => {
    // No runHermesCompletion mock is needed anywhere in this block: this
    // function is the deterministic stage that runs AFTER the second
    // Nemotron call returns, so it never itself calls Hermes/Nemotron. That
    // is the point being tested — it's real, callable, isolated code, not
    // logic buried inside the extraction step.

    const realHit = { title: "Sharma Boutique — Jaipur", url: "https://sharmaboutique.example/about", content: "Sharma Boutique is a family-run clothing store in Jaipur." };
    const groundingMap = () => new Map([["sharmaboutique.example/about", realHit]]);

    function candidate(overrides: Partial<DiscoveredProspect> = {}): DiscoveredProspect {
      return {
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
        ...overrides,
      };
    }

    it("receives the second Nemotron stage's raw candidates and returns a valid, structured DiscoveryResult", () => {
      const result = finalizeDiscoveryResult(baseCriteria, [candidate()], groundingMap(), ["retail store owners in Jaipur"], [], newTelemetry());

      expect(result).toEqual({
        ok: true,
        prospects: [candidate()],
        queriesRun: ["retail store owners in Jaipur"],
        queriesFailed: [],
        telemetry: expect.objectContaining({ verified: 1 }),
      });
    });

    it("rejects a candidate whose sourceUrl was never actually in the search results — the anti-fabrication guarantee holds at this stage", () => {
      const fabricated = candidate({ companyName: "Invented Traders", sourceUrl: "https://never-searched.example/fake" });
      const telemetry = newTelemetry();

      const result = finalizeDiscoveryResult(baseCriteria, [fabricated], groundingMap(), [], [], telemetry);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prospects).toEqual([]);
      expect(telemetry.rejectedNotGrounded).toBe(1);
    });

    it("rejects duplicate candidates citing the same real business, keeping the first", () => {
      const dup = candidate({ evidenceSnippet: "a different-worded citation of the same real excerpt" });
      const result = finalizeDiscoveryResult(baseCriteria, [candidate(), dup], groundingMap(), [], [], newTelemetry());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prospects).toHaveLength(1);
    });

    it("rejects a non-business name (course/listing heading) even when it cites a real, grounded URL", () => {
      const notABusiness = candidate({ companyName: "Advanced Excel Training Course" });
      const telemetry = newTelemetry();

      const result = finalizeDiscoveryResult(baseCriteria, [notABusiness], groundingMap(), [], [], telemetry);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prospects).toEqual([]);
      expect(telemetry.rejectedNotABusiness).toBe(1);
    });

    // No organization-isolation test here: finalizeDiscoveryResult is a
    // pure function with no database access, so there is nothing at this
    // layer that could leak between organizations. Org scoping is enforced
    // where data actually moves — every prospects/leads insert in
    // campaigns/actions.ts carries organization_id, unchanged by this
    // refactor and already covered by that module's existing behavior.
  });

  describe("runFinalHermesValidation — the real, distinct third model call", () => {
    beforeEach(() => {
      process.env.TAVILY_API_KEY = "test-key";
    });

    const realHit = { title: "Sharma Boutique — Jaipur", url: "https://sharmaboutique.example/about", content: "Sharma Boutique is a family-run clothing store in Jaipur." };
    const groundingMap = () => new Map([["sharmaboutique.example/about", realHit]]);

    function candidate(overrides: Partial<DiscoveredProspect> = {}): DiscoveredProspect {
      return {
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
        ...overrides,
      };
    }

    it("calls runHermesCompletion a genuinely separate time, sending the real evidence and the candidates to review", async () => {
      vi.mocked(runHermesCompletion).mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({ accepted: [candidate()] }),
        provider: "openrouter",
        model: "nousresearch/hermes-4-70b",
      });

      const result = await runFinalHermesValidation(baseCriteria, [candidate()], groundingMap(), newTelemetry());

      expect(result).toEqual({ ok: true, candidates: [candidate()] });
      expect(runHermesCompletion).toHaveBeenCalledTimes(1);
      const call = vi.mocked(runHermesCompletion).mock.calls[0][0];
      expect(call.agentType).toBe("lead_discovery_final_validation");
      expect(call.userPrompt).toContain(realHit.url);
      expect(call.userPrompt).toContain(realHit.content);
      expect(call.userPrompt).toContain("Sharma Boutique");
    });

    it("skips the call entirely when there are no candidates to review — nothing to validate, no point spending a request", async () => {
      const result = await runFinalHermesValidation(baseCriteria, [], groundingMap(), newTelemetry());

      expect(result).toEqual({ ok: true, candidates: [] });
      expect(runHermesCompletion).not.toHaveBeenCalled();
    });

    it("Hermes rejecting a candidate removes it — the accepted list can be a genuine subset, not just a passthrough", async () => {
      const kept = candidate();
      const dropped = candidate({ companyName: "Rao Fabrics", website: "raofabrics.example" });

      vi.mocked(runHermesCompletion).mockResolvedValueOnce({
        ok: true,
        text: JSON.stringify({ accepted: [kept] }),
        provider: "openrouter",
        model: "nousresearch/hermes-4-70b",
      });

      const telemetry = newTelemetry();
      const result = await runFinalHermesValidation(baseCriteria, [kept, dropped], groundingMap(), telemetry);

      expect(result).toEqual({ ok: true, candidates: [kept] });
      expect(telemetry.finalValidationInput).toBe(2);
      expect(telemetry.finalValidationAccepted).toBe(1);
    });

    it("propagates a Hermes-level failure honestly, never fabricating an accepted list", async () => {
      vi.mocked(runHermesCompletion).mockResolvedValueOnce({ ok: false, code: "provider_unavailable", message: "The AI provider is temporarily unavailable." });

      const result = await runFinalHermesValidation(baseCriteria, [candidate()], groundingMap(), newTelemetry());

      expect(result.ok).toBe(false);
    });

    it("returns an honest failure (not a fabricated accept) on a malformed model response", async () => {
      vi.mocked(runHermesCompletion).mockResolvedValueOnce({ ok: true, text: "not json", provider: "openrouter", model: "nousresearch/hermes-4-70b" });

      const result = await runFinalHermesValidation(baseCriteria, [candidate()], groundingMap(), newTelemetry());

      expect(result.ok).toBe(false);
    });
  });

  describe("buyer-focused query targeting (never competitors)", () => {
    beforeEach(() => {
      process.env.TAVILY_API_KEY = "tavily-key";
      delete process.env.EXA_API_KEY;
    });

    // The real ICP that produced competitor results in production: a web
    // design agency selling to SMEs. Note the buying signal and channels
    // that name the seller's own category.
    const webDesignIcp = {
      targetCustomer: "Small to medium enterprises in Noida lacking a modern website",
      location: "Noida, India",
      industry: "Multiple industries (SMEs)",
      businessType: "Small to medium enterprise",
      needs: ["Modern responsive website"],
      painPoints: ["Outdated design hurting brand perception"],
      buyingSignals: ["Searching for web design agencies online", "Requesting quotes for redesign"],
      preferredChannels: ["Networking at Noida business chambers"],
      decisionFactors: ["Portfolio quality"],
      disqualifiers: ["Business located outside Noida"],
      qualificationCriteria: ["Existing website older than 3 years or none"],
    };

    const webDesignCriteria: DiscoveryCriteria = {
      ...baseCriteria,
      campaignName: "Web designing agency",
      campaignObjective: "Get more customers",
      icpCriteria: webDesignIcp,
    };

    /** Runs discovery with the model returning `queries`, and reports which ones actually reached the search provider. */
    async function queriesActuallySearched(criteria: DiscoveryCriteria, queries: string[]) {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ queries }), provider: "groq", model: "m" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ prospects: [] }), provider: "groq", model: "m" });
      const searched: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          searched.push(JSON.parse(String(init?.body ?? "{}")).query);
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        })
      );
      await new TavilyDiscoveryProvider().discover(criteria);
      return searched;
    }

    it("1. keeps buyer-focused queries for a buyer-focused ICP", async () => {
      const searched = await queriesActuallySearched(webDesignCriteria, [
        "Noida SME manufacturers outdated website",
        "Noida retail businesses no website",
        "small businesses Noida website redesign needed",
      ]);
      expect(searched).toHaveLength(3);
      expect(searched).toContain("Noida SME manufacturers outdated website");
    });

    it("2. drops competitor-seeking queries before they are ever searched", async () => {
      const searched = await queriesActuallySearched(webDesignCriteria, [
        "Noida SME manufacturers outdated website",
        "web design agency in Noida",
        "web development company Noida",
        "digital marketing agencies Noida",
      ]);
      expect(searched).toEqual(["Noida SME manufacturers outdated website"]);
    });

    it("2b. falls back to an ICP-derived query when every generated query targets competitors", async () => {
      const searched = await queriesActuallySearched(webDesignCriteria, [
        "web design agency in Noida",
        "best web designers Noida",
      ]);
      expect(searched).toHaveLength(1);
      // Composed from saved ICP fields only — nothing invented.
      expect(searched[0]).toContain("Small to medium enterprises in Noida lacking a modern website");
      expect(isCompetitorSeekingQuery(searched[0], ["web", "designing"])).toBe(false);
    });

    it("2c. keeps provider-shaped queries when the ICP genuinely targets providers", async () => {
      const agencyIcp = {
        ...webDesignIcp,
        targetCustomer: "Marketing agencies needing white-label web development",
        industry: "Marketing agencies",
        businessType: "Agency",
      };
      const searched = await queriesActuallySearched(
        { ...webDesignCriteria, icpCriteria: agencyIcp },
        ["marketing agencies in Noida", "white label web development agency partners Noida"]
      );
      expect(searched).toHaveLength(2);
    });

    it("3. sends the ICP's location and business type, and frames the ICP as the buyer", async () => {
      await queriesActuallySearched(webDesignCriteria, ["Noida SME outdated website"]);
      const prompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
      const system = vi.mocked(runHermesCompletion).mock.calls[0][0].systemPrompt;

      expect(prompt).toContain("Noida, India");
      expect(prompt).toContain("Small to medium enterprise");
      expect(prompt).toContain("the BUYER to find");
      // The campaign name is present but explicitly marked as seller-side, not a target.
      expect(prompt).toContain("not a search target");
      expect(system).toMatch(/never search for other businesses that sell or supply/i);
    });

    it("4. instructs the model to use problem/buying signals but not provider-seeking ones", async () => {
      await queriesActuallySearched(webDesignCriteria, ["Noida SME outdated website"]);
      const system = vi.mocked(runHermesCompletion).mock.calls[0][0].systemPrompt;
      expect(system).toMatch(/painPoints/);
      expect(system).toMatch(/buyingSignals/);
      expect(system).toMatch(/looking for, hiring, comparing or contacting a provider/i);
      // Outreach/evaluation fields are explicitly excluded as search targets.
      expect(system).toMatch(/preferredChannels[\s\S]*NOT search targets/i);
    });

    it("does not flag a legitimate buyer query that merely mentions an ambiguous provider noun", () => {
      const sellerTokens = ["web", "designing"];
      // Real buyers that happen to be named with a provider-ish word.
      expect(isCompetitorSeekingQuery("Noida law firms with an outdated website", sellerTokens)).toBe(false);
      expect(isCompetitorSeekingQuery("Noida yoga studios outdated website", sellerTokens)).toBe(false);
      expect(isCompetitorSeekingQuery("Noida companies needing website redesign", sellerTokens)).toBe(false);
      expect(isCompetitorSeekingQuery("Noida manufacturing companies no website", sellerTokens)).toBe(false);

      // The seller's own trade, and adjacent trades that are competitors too.
      expect(isCompetitorSeekingQuery("web design agency Noida", sellerTokens)).toBe(true);
      expect(isCompetitorSeekingQuery("web development company Noida", sellerTokens)).toBe(true);
      expect(isCompetitorSeekingQuery("digital marketing agencies Noida", sellerTokens)).toBe(true);
      expect(isCompetitorSeekingQuery("SEO agency in Noida", sellerTokens)).toBe(true);
      expect(isCompetitorSeekingQuery("freelancers for website work Noida", sellerTokens)).toBe(true);
    });

    it("5. leaves the Tavily -> Exa fallback untouched under the new targeting", async () => {
      process.env.EXA_API_KEY = "exa-key";
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ queries: ["Noida SME outdated website"] }), provider: "groq", model: "m" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(EXA_EXTRACTION_RESPONSE), provider: "groq", model: "m" });
      const fetchMock = mockFetchRouter({
        tavily: async () => new Response("rate limited", { status: 429 }),
        exa: async () => new Response(JSON.stringify({ results: EXA_HITS }), { status: 200 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await new TavilyDiscoveryProvider().discover(webDesignCriteria);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(fetchMock).toHaveBeenCalledTimes(2); // Tavily attempted, then Exa
      expect(result.prospects).toHaveLength(1);
    });

    it("6. leaves extraction -> verification -> persistence shape untouched under the new targeting", async () => {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ queries: ["Noida SME outdated website"] }), provider: "groq", model: "m" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(EXTRACTION_RESPONSE), provider: "groq", model: "m" });
      vi.stubGlobal("fetch", mockFetchRouter({ tavily: async () => new Response(JSON.stringify({ results: SEARCH_HITS }), { status: 200 }) }));

      const result = await new TavilyDiscoveryProvider().discover(webDesignCriteria);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      // Same verified, persistence-ready shape as before this change.
      expect(result.prospects[0]).toMatchObject({
        companyName: "Sharma Boutique",
        sourceUrl: "https://sharmaboutique.example/about",
      });
      expect(result.prospects[0].evidenceSnippet).toBeTruthy();
    });
  });

  describe("structured extraction from real search results", () => {
    beforeEach(() => {
      process.env.TAVILY_API_KEY = "tavily-key";
      delete process.env.EXA_API_KEY;
    });

    /** Runs one discovery pass where Tavily returns SEARCH_HITS and the model replies with `extractionText`. */
    async function runExtraction(extractionText: string) {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(SINGLE_QUERY_RESPONSE), provider: "openrouter", model: "m" })
        .mockResolvedValueOnce({ ok: true, text: extractionText, provider: "groq", model: "openai/gpt-oss-120b" });
      vi.stubGlobal("fetch", mockFetchRouter({ tavily: async () => new Response(JSON.stringify({ results: SEARCH_HITS }), { status: 200 }) }));
      return new TavilyDiscoveryProvider().discover(baseCriteria);
    }

    it("converts a valid model response into a persisted-shape prospect", async () => {
      const result = await runExtraction(JSON.stringify(EXTRACTION_RESPONSE));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.prospects).toHaveLength(1);
      expect(result.prospects[0]).toMatchObject({
        companyName: "Sharma Boutique",
        sourceUrl: "https://sharmaboutique.example/about",
      });
    });

    it("accepts a code-fenced JSON response", async () => {
      const result = await runExtraction("```json\n" + JSON.stringify(EXTRACTION_RESPONSE) + "\n```");

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.prospects).toHaveLength(1);
    });

    it("keeps a prospect whose cited URL differs only in formatting, and stores the provider's real URL", async () => {
      // Same page, reformatted by the model: scheme, "www." and trailing slash.
      const reformatted = {
        prospects: [{ ...EXTRACTION_RESPONSE.prospects[0], sourceUrl: "HTTP://WWW.sharmaboutique.example/about/" }],
      };

      const result = await runExtraction(JSON.stringify(reformatted));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.prospects).toHaveLength(1);
      // Stored URL is the one the search provider actually returned, not the model's rendering.
      expect(result.prospects[0].sourceUrl).toBe("https://sharmaboutique.example/about");
    });

    it("still drops a fabricated URL — a different path on a real host is not a match", async () => {
      const fabricated = {
        prospects: [{ ...EXTRACTION_RESPONSE.prospects[0], sourceUrl: "https://sharmaboutique.example/invented-page" }],
      };

      const result = await runExtraction(JSON.stringify(fabricated));

      expect(result).toMatchObject({ ok: true, prospects: [] });
    });

    it("replaces an evidence quote that does not appear in the real page text", async () => {
      const invented = {
        prospects: [{ ...EXTRACTION_RESPONSE.prospects[0], evidenceSnippet: "A sentence the page never actually contained." }],
      };

      const result = await runExtraction(JSON.stringify(invented));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      // Evidence is taken from the real search result instead of the model's invention.
      expect(result.prospects[0].evidenceSnippet).not.toContain("never actually contained");
      expect(SEARCH_HITS[0].content).toContain(result.prospects[0].evidenceSnippet.replace(/…$/, ""));
    });

    it("returns an honest failure (not a fabricated prospect) on a malformed model response", async () => {
      const result = await runExtraction("this is not json at all");

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.code).toBe("provider_error");
    });

    it("returns zero prospects when the model legitimately finds none", async () => {
      const result = await runExtraction(JSON.stringify({ prospects: [] }));
      expect(result).toMatchObject({ ok: true, prospects: [] });
    });

    it("drops an entry with an empty company name", async () => {
      const nameless = { prospects: [{ ...EXTRACTION_RESPONSE.prospects[0], companyName: "   " }] };
      const result = await runExtraction(JSON.stringify(nameless));
      expect(result).toMatchObject({ ok: true, prospects: [] });
    });

    it("extracts from Exa results after a Tavily failure, preserving Exa's source URL", async () => {
      process.env.EXA_API_KEY = "exa-key";
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(SINGLE_QUERY_RESPONSE), provider: "openrouter", model: "m" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(EXA_EXTRACTION_RESPONSE), provider: "groq", model: "openai/gpt-oss-120b" });
      vi.stubGlobal(
        "fetch",
        mockFetchRouter({
          tavily: async () => new Response("rate limited", { status: 429 }),
          exa: async () => new Response(JSON.stringify({ results: EXA_HITS }), { status: 200 }),
        })
      );

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.prospects).toHaveLength(1);
      expect(result.prospects[0].companyName).toBe("Mehta Fashions");
      expect(result.prospects[0].sourceUrl).toBe("https://mehtafashions.example/about");
    });

    it("keeps the extraction request inside the provider's per-minute token window", async () => {
      await runExtraction(JSON.stringify(EXTRACTION_RESPONSE));
      const extractionCall = vi.mocked(runHermesCompletion).mock.calls[1][0];

      expect(extractionCall.responseFormat).toBe("json");
      // Two-sided, both bounds observed failing in production against Groq's
      // 8k TPM free tier: too small and a reasoning model runs out mid-JSON
      // (HTTP 400 json_validate_failed); too large and prompt + reserved
      // completion tokens exceed the allowance (HTTP 413).
      expect(extractionCall.maxTokens ?? 0).toBeGreaterThanOrEqual(2500);
      const promptChars = extractionCall.systemPrompt.length + extractionCall.userPrompt.length;
      expect(Math.ceil(promptChars / 4) + (extractionCall.maxTokens ?? 0)).toBeLessThan(8000);
    });

    it("caps how many search results are sent, taking a slice from every query rather than only the first", async () => {
      const manyHits = (prefix: string) =>
        Array.from({ length: 30 }, (_, i) => ({
          title: `${prefix} ${i}`,
          url: `https://${prefix}${i}.example/page`,
          content: "x".repeat(5000),
        }));

      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(QUERIES_RESPONSE), provider: "openrouter", model: "m" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ prospects: [] }), provider: "groq", model: "m" });
      vi.stubGlobal(
        "fetch",
        mockFetchOk({
          "retail store owners in Jaipur": manyHits("alpha"),
          "boutique clothing shops Jaipur": manyHits("beta"),
        })
      );

      await new TavilyDiscoveryProvider().discover(baseCriteria);

      const prompt = vi.mocked(runHermesCompletion).mock.calls[1][0].userPrompt;
      const resultCount = (prompt.match(/^URL: /gm) ?? []).length;
      expect(resultCount).toBeLessThanOrEqual(10);
      // Both queries are represented — capping must not silently drop one entirely.
      expect(prompt).toContain("alpha0.example");
      expect(prompt).toContain("beta0.example");
      // Long pages are excerpted, not sent whole.
      expect(prompt.length).toBeLessThan(20_000);
    });
  });

  describe("finding identifiable businesses via directories and listings", () => {
    beforeEach(() => {
      process.env.TAVILY_API_KEY = "tavily-key";
      delete process.env.EXA_API_KEY;
    });

    // A realistic directory page: one URL, several individually named businesses.
    const DIRECTORY_HIT = {
      title: "Top Packaging Manufacturers in Noida — Business Directory",
      url: "https://directory.example/noida/packaging-manufacturers",
      content:
        "Shreeji Packaging Industries — corrugated box manufacturer based in Sector 63, Noida, serving FMCG clients since 2004. " +
        "Noida Poly Pack Pvt Ltd — flexible packaging supplier in Sector 8, Noida. " +
        "Anand Cartons — family-run carton maker operating from Phase 2, Noida.",
    };

    const DIRECTORY_EXTRACTION = {
      prospects: ["Shreeji Packaging Industries", "Noida Poly Pack Pvt Ltd", "Anand Cartons"].map((companyName) => ({
        companyName,
        website: null,
        location: "Noida",
        industry: "Packaging",
        businessType: "Manufacturer",
        email: null,
        phone: null,
        matchedIcpCriteria: ["location: Noida"],
        evidenceSnippet: DIRECTORY_HIT.content.slice(0, 100),
        sourceUrl: DIRECTORY_HIT.url,
        searchQuery: "packaging manufacturers in Noida directory",
      })),
    };

    async function runWithHits(hits: { title: string; url: string; content: string }[], extractionText: string) {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ queries: ["packaging manufacturers in Noida directory"] }), provider: "groq", model: "m" })
        .mockResolvedValueOnce({ ok: true, text: extractionText, provider: "groq", model: "m" });
      vi.stubGlobal("fetch", mockFetchRouter({ tavily: async () => new Response(JSON.stringify({ results: hits }), { status: 200 }) }));
      return new TavilyDiscoveryProvider().discover(baseCriteria);
    }

    it("directs query generation at sources that actually name businesses, not at the buying need", async () => {
      await runWithHits([DIRECTORY_HIT], JSON.stringify({ prospects: [] }));
      const system = vi.mocked(runHermesCompletion).mock.calls[0][0].systemPrompt;

      expect(system).toMatch(/business directories|local and chamber-of-commerce listings/i);
      expect(system).toMatch(/FIND PAGES THAT NAME REAL, INDIVIDUAL BUSINESSES/i);
      // Pain points are demoted to qualification, not mandatory search terms.
      expect(system).toMatch(/QUALIFICATION signals[\s\S]*NOT required search terms/i);
      // And the competitor guard is still stated.
      expect(system).toMatch(/never search for other businesses that sell or supply/i);
    });

    it("extracts every individually named business from a single directory page", async () => {
      const result = await runWithHits([DIRECTORY_HIT], JSON.stringify(DIRECTORY_EXTRACTION));

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.prospects.map((p) => p.companyName)).toEqual([
        "Shreeji Packaging Industries",
        "Noida Poly Pack Pvt Ltd",
        "Anand Cartons",
      ]);
      // All three keep the real directory URL as their source.
      for (const prospect of result.prospects) {
        expect(prospect.sourceUrl).toBe(DIRECTORY_HIT.url);
        expect(DIRECTORY_HIT.content).toContain(prospect.evidenceSnippet.replace(/…$/, ""));
      }
    });

    it("tells the model to list the businesses, not the directory site itself", async () => {
      await runWithHits([DIRECTORY_HIT], JSON.stringify({ prospects: [] }));
      const system = vi.mocked(runHermesCompletion).mock.calls[1][0].systemPrompt;
      expect(system).toMatch(/extract the individually named businesses the page lists/i);
      expect(system).toMatch(/never the site doing the listing/i);
    });

    it("fabricates nothing from a listing page that names no companies", async () => {
      const emptyDirectory = {
        title: "Noida Business Directory",
        url: "https://directory.example/noida",
        content: "Browse thousands of verified businesses across every category in Noida. Sign up to list your business.",
      };
      const result = await runWithHits([emptyDirectory], JSON.stringify({ prospects: [] }));
      expect(result).toMatchObject({ ok: true, prospects: [] });
    });

    it("does not let the model claim a website problem the page never evidenced", async () => {
      await runWithHits([DIRECTORY_HIT], JSON.stringify({ prospects: [] }));
      const system = vi.mocked(runHermesCompletion).mock.calls[1][0].systemPrompt;
      expect(system).toMatch(/Do not assert a problem the evidence does not show/i);
      expect(system).toMatch(/do not claim its website is outdated, missing or poor/i);
      expect(system).toMatch(/Leave "website" null unless the content actually gives that company's own site/i);
    });

    it("persists a discovered business that has no website yet, without inventing one", async () => {
      const result = await runWithHits([DIRECTORY_HIT], JSON.stringify(DIRECTORY_EXTRACTION));
      if (!result.ok) throw new Error("expected ok");
      // Discovery's job ends at an identifiable business; website may legitimately be unknown.
      expect(result.prospects[0].website).toBeNull();
      expect(result.prospects[0].companyName).toBe("Shreeji Packaging Industries");
    });

    it("sends directory excerpts long enough to keep the listed company names", async () => {
      await runWithHits([DIRECTORY_HIT], JSON.stringify({ prospects: [] }));
      const prompt = vi.mocked(runHermesCompletion).mock.calls[1][0].userPrompt;
      // All three names survive truncation into the extraction prompt.
      expect(prompt).toContain("Shreeji Packaging Industries");
      expect(prompt).toContain("Noida Poly Pack Pvt Ltd");
      expect(prompt).toContain("Anand Cartons");
    });

    it("still excludes competitor-shaped queries under directory-first targeting", async () => {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({
          ok: true,
          text: JSON.stringify({ queries: ["packaging manufacturers Noida directory", "web design agencies in Noida"] }),
          provider: "groq",
          model: "m",
        })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ prospects: [] }), provider: "groq", model: "m" });
      const searched: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          searched.push(JSON.parse(String(init?.body ?? "{}")).query);
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        })
      );

      await new TavilyDiscoveryProvider().discover({ ...baseCriteria, campaignName: "Web designing agency" });

      expect(searched).toEqual(["packaging manufacturers Noida directory"]);
    });

    it("still falls back to Exa when Tavily fails on a directory query", async () => {
      process.env.EXA_API_KEY = "exa-key";
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ queries: ["packaging manufacturers in Noida directory"] }), provider: "groq", model: "m" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(DIRECTORY_EXTRACTION), provider: "groq", model: "m" });
      const fetchMock = mockFetchRouter({
        tavily: async () => new Response("rate limited", { status: 429 }),
        exa: async () => new Response(JSON.stringify({ results: [{ title: DIRECTORY_HIT.title, url: DIRECTORY_HIT.url, text: DIRECTORY_HIT.content }] }), { status: 200 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.prospects).toHaveLength(3);
      expect(result.prospects[0].sourceUrl).toBe(DIRECTORY_HIT.url);
    });
  });

  describe("lead quality gates", () => {
    beforeEach(() => {
      process.env.TAVILY_API_KEY = "tavily-key";
      delete process.env.EXA_API_KEY;
    });

    const LISTING_HIT = {
      title: "Noida Business Directory — Manufacturing",
      url: "https://merithub.example/noida/listings",
      content:
        "H.V. Metal Arc Private Limited — sheet metal fabricator, Sector 63 Noida. " +
        "Advanced Excel Course Noida — 6 week programme. " +
        "SAS Base Training Institute Noida — analytics training provider. " +
        "Top 10 IT Companies in Noida. Merithub. Senior Developer Job Noida.",
    };

    function entry(companyName: string) {
      return {
        companyName,
        website: null,
        location: "Noida",
        industry: "Manufacturing",
        businessType: "SME",
        email: null,
        phone: null,
        matchedIcpCriteria: ["location: Noida"],
        evidenceSnippet: LISTING_HIT.content.slice(0, 80),
        sourceUrl: LISTING_HIT.url,
        searchQuery: "manufacturing businesses Noida directory listings",
      };
    }

    async function extractFrom(names: string[]) {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ queries: ["manufacturing businesses Noida directory listings"] }), provider: "groq", model: "m" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ prospects: names.map(entry) }), provider: "groq", model: "m" });
      vi.stubGlobal("fetch", mockFetchRouter({ tavily: async () => new Response(JSON.stringify({ results: [LISTING_HIT] }), { status: 200 }) }));
      return new TavilyDiscoveryProvider().discover(baseCriteria);
    }

    it("keeps a real company and rejects courses, headings, jobs and the directory itself", async () => {
      const result = await extractFrom([
        "H.V. Metal Arc Private Limited",
        "Advanced Excel Course Noida",
        "Top 10 IT Companies in Noida",
        "Senior Developer Job Noida",
        "Merithub",
      ]);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.prospects.map((p) => p.companyName)).toEqual(["H.V. Metal Arc Private Limited"]);
      expect(result.telemetry?.extracted).toBe(5);
      expect(result.telemetry?.rejectedNotABusiness).toBe(4);
      expect(result.telemetry?.verified).toBe(1);
    });

    it("does not mistake a training institute (an organisation) for a course", () => {
      expect(isNonBusinessName("SAS Base Training Institute Noida")).toBe(false);
      expect(isNonBusinessName("Advanced SAS Base Training Course Noida")).toBe(true);
      expect(isNonBusinessName("Kent RO Systems Limited")).toBe(false);
      expect(isNonBusinessName("Best Manufacturers in Noida")).toBe(true);
      expect(isNonBusinessName("List of IT companies")).toBe(true);
      expect(isNonBusinessName("Sunrise Dental Clinic")).toBe(false);
    });

    it("rejects the publishing site being extracted as its own prospect", () => {
      expect(isSourceSiteName("Merithub", "https://merithub.example/noida/listings")).toBe(true);
      // A real company that merely appears on that page is untouched.
      expect(isSourceSiteName("H.V. Metal Arc Private Limited", "https://merithub.example/noida/listings")).toBe(false);
    });

    it("instructs extraction to require an organisation and to apply the ICP's size and disqualifiers", async () => {
      await extractFrom(["H.V. Metal Arc Private Limited"]);
      const system = vi.mocked(runHermesCompletion).mock.calls[1][0].systemPrompt;
      expect(system).toMatch(/EVERY ENTRY MUST BE AN ACTUAL ORGANISATION/i);
      expect(system).toMatch(/a course is not a company/i);
      expect(system).toMatch(/APPLY THE ICP BEFORE INCLUDING A BUSINESS/i);
      expect(system).toMatch(/do not include large enterprises, multinationals or household-name corporations/i);
      expect(system).toMatch(/matching any of the ICP's disqualifiers/i);
      expect(system).toMatch(/at most 3 businesses from any single result/i);
    });

    it("steers queries away from listicles, course catalogues and job boards", async () => {
      await extractFrom(["H.V. Metal Arc Private Limited"]);
      const system = vi.mocked(runHermesCompletion).mock.calls[0][0].systemPrompt;
      expect(system).toMatch(/blog roundups and news articles/i);
      expect(system).toMatch(/course catalogues, training-programme listings, job boards/i);
      expect(system).toMatch(/favour local and sector directories/i);
    });

    it("records Tavily telemetry proving which provider served the run", async () => {
      const result = await extractFrom(["H.V. Metal Arc Private Limited"]);
      if (!result.ok) throw new Error("expected ok");
      expect(result.telemetry?.tavily).toEqual({ requests: 1, succeeded: 1, failed: 0, results: 1 });
      expect(result.telemetry?.exa).toEqual({ requests: 0, succeeded: 0, failed: 0, results: 0 });
      expect(result.telemetry?.servedByExa).toEqual([]);
    });

    it("records Exa telemetry when the fallback actually serves the query", async () => {
      process.env.EXA_API_KEY = "exa-key";
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ queries: ["manufacturing businesses Noida directory listings"] }), provider: "groq", model: "m" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ prospects: [] }), provider: "groq", model: "m" });
      vi.stubGlobal(
        "fetch",
        mockFetchRouter({
          tavily: async () => new Response("rate limited", { status: 429 }),
          exa: async () => new Response(JSON.stringify({ results: [{ title: LISTING_HIT.title, url: LISTING_HIT.url, text: LISTING_HIT.content }] }), { status: 200 }),
        })
      );

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);
      if (!result.ok) throw new Error("expected ok");

      expect(result.telemetry?.tavily.requests).toBe(1);
      expect(result.telemetry?.tavily.failed).toBe(1);
      expect(result.telemetry?.exa).toEqual({ requests: 1, succeeded: 1, failed: 0, results: 1 });
      expect(result.telemetry?.servedByExa).toEqual(["manufacturing businesses Noida directory listings"]);
    });

    it("rejects an extracted company whose own name advertises it as a competitor", async () => {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ queries: ["manufacturing businesses Noida directory listings"] }), provider: "groq", model: "m" })
        .mockResolvedValueOnce({
          ok: true,
          text: JSON.stringify({ prospects: [entry("Pixel Web Design Studio"), entry("H.V. Metal Arc Private Limited")] }),
          provider: "groq",
          model: "m",
        });
      vi.stubGlobal("fetch", mockFetchRouter({ tavily: async () => new Response(JSON.stringify({ results: [LISTING_HIT] }), { status: 200 }) }));

      const result = await new TavilyDiscoveryProvider().discover({ ...baseCriteria, campaignName: "Web designing agency" });
      if (!result.ok) throw new Error("expected ok");

      expect(result.prospects.map((p) => p.companyName)).toEqual(["H.V. Metal Arc Private Limited"]);
      expect(result.telemetry?.rejectedCompetitor).toBe(1);
    });

    it("tells extraction to skip businesses described as providers of what the seller sells", async () => {
      await extractFrom(["H.V. Metal Arc Private Limited"]);
      const system = vi.mocked(runHermesCompletion).mock.calls[1][0].systemPrompt;
      expect(system).toMatch(/NEVER INCLUDE A COMPETITOR/i);
      expect(system).toMatch(/described as an agency, studio or provider of the seller's service must be skipped/i);
    });

    it("counts a prospect citing an ungrounded URL as rejected, not persisted", async () => {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ queries: ["manufacturing businesses Noida directory listings"] }), provider: "groq", model: "m" })
        .mockResolvedValueOnce({
          ok: true,
          text: JSON.stringify({ prospects: [{ ...entry("Phantom Metals Ltd"), sourceUrl: "https://otherhost.example/never-returned" }] }),
          provider: "groq",
          model: "m",
        });
      vi.stubGlobal("fetch", mockFetchRouter({ tavily: async () => new Response(JSON.stringify({ results: [LISTING_HIT] }), { status: 200 }) }));

      const result = await new TavilyDiscoveryProvider().discover(baseCriteria);
      if (!result.ok) throw new Error("expected ok");

      expect(result.prospects).toEqual([]);
      expect(result.telemetry?.rejectedNotGrounded).toBe(1);
      expect(result.telemetry?.verified).toBe(0);
    });
  });

  describe("Business Knowledge reaches extraction without becoming a search target", () => {
    beforeEach(() => {
      process.env.TAVILY_API_KEY = "tavily-key";
      delete process.env.EXA_API_KEY;
    });

    // A seller profile carrying BOTH offering info and seller-side identity.
    // selectDiscoveryContext is what strips the identity half; this is the
    // shape discovery actually receives after that.
    const sellerContext: BusinessContext = {
      businessProfile: {
        name: "Acme Web Studio",
        description: "We build and redesign websites for Indian SMEs",
        category: "Web design",
        about: "Specialists in mobile-first redesigns",
        website: null,
        phone: null,
        email: null,
        whatsapp: null,
        address: null,
        serviceArea: null,
        openingHours: null,
      },
      productsServices: [
        { name: "Website Redesign", description: "Rebuild of an outdated site", category: null, price: null, pricingType: "custom", features: [], benefits: ["mobile-friendly"], availability: "available", specialOffers: null },
      ],
      valueProposition: { keySellingPoints: ["10 years redesigning SME sites"], productBenefits: [] },
      faqs: [],
      policies: [],
      aiCommunicationRules: null,
      mediaReferences: [],
    };

    async function runWithSellerContext() {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(SINGLE_QUERY_RESPONSE), provider: "groq", model: "m" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(EXTRACTION_RESPONSE), provider: "groq", model: "m" });
      vi.stubGlobal("fetch", mockFetchRouter({ tavily: async () => new Response(JSON.stringify({ results: SEARCH_HITS }), { status: 200 }) }));
      return new TavilyDiscoveryProvider().discover({ ...baseCriteria, businessContext: sellerContext });
    }

    it("1. sends what the business sells into the extraction prompt", async () => {
      await runWithSellerContext();
      const extractionPrompt = vi.mocked(runHermesCompletion).mock.calls[1][0].userPrompt;

      expect(extractionPrompt).toContain("WHAT THIS BUSINESS SELLS");
      expect(extractionPrompt).toContain("Website Redesign");
      expect(extractionPrompt).toContain("We build and redesign websites for Indian SMEs");
      // The ICP is still there, and still distinct from the seller block.
      const sellerIdx = extractionPrompt.indexOf("WHAT THIS BUSINESS SELLS");
      const icpIdx = extractionPrompt.indexOf("IDEAL CUSTOMER PROFILE");
      expect(icpIdx).toBeGreaterThan(sellerIdx);
    });

    it("1b. tells extraction to use the seller context for relevance only, never as a company to extract", async () => {
      await runWithSellerContext();
      const system = vi.mocked(runHermesCompletion).mock.calls[1][0].systemPrompt;
      expect(system).toMatch(/USE THE SELLER CONTEXT FOR RELEVANCE, NOT AS A SEARCH TARGET/i);
      expect(system).toMatch(/the seller is not a prospect/i);
    });

    it("2. selectDiscoveryContext strips seller identity so it can never become a buyer search target", () => {
      const full: BusinessContext = {
        ...sellerContext,
        businessProfile: {
          ...sellerContext.businessProfile!,
          website: "https://acmewebstudio.example",
          phone: "+91 99999 00000",
          email: "hello@acmewebstudio.example",
          whatsapp: "+91 99999 00000",
          address: "Sector 62, Noida",
          serviceArea: "Delhi NCR",
          openingHours: "9-6",
        },
      };

      const selected = selectDiscoveryContext(full);

      // Offering survives...
      expect(selected.businessProfile?.category).toBe("Web design");
      expect(selected.productsServices).toHaveLength(1);
      // ...identity and seller geography do not.
      expect(selected.businessProfile?.website).toBeNull();
      expect(selected.businessProfile?.phone).toBeNull();
      expect(selected.businessProfile?.email).toBeNull();
      expect(selected.businessProfile?.address).toBeNull();
      expect(selected.businessProfile?.serviceArea).toBeNull();
    });

    it("2b. the seller's own geography never reaches the query prompt as a place to search", async () => {
      const full: BusinessContext = {
        ...sellerContext,
        businessProfile: { ...sellerContext.businessProfile!, serviceArea: "Delhi NCR", address: "Sector 62, Noida" },
      };
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(SINGLE_QUERY_RESPONSE), provider: "groq", model: "m" })
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ prospects: [] }), provider: "groq", model: "m" });
      vi.stubGlobal("fetch", mockFetchRouter({ tavily: async () => new Response(JSON.stringify({ results: SEARCH_HITS }), { status: 200 }) }));

      await new TavilyDiscoveryProvider().discover({ ...baseCriteria, businessContext: selectDiscoveryContext(full) });

      const queryPrompt = vi.mocked(runHermesCompletion).mock.calls[0][0].userPrompt;
      expect(queryPrompt).not.toContain("Delhi NCR");
      expect(queryPrompt).not.toContain("Sector 62");
      // The ICP's own location is still the search geography.
      expect(queryPrompt).toContain("Jaipur");
    });

    it("6. anti-fabrication and competitor guards still hold with seller context present", async () => {
      vi.mocked(runHermesCompletion)
        .mockResolvedValueOnce({ ok: true, text: JSON.stringify(SINGLE_QUERY_RESPONSE), provider: "groq", model: "m" })
        .mockResolvedValueOnce({
          ok: true,
          text: JSON.stringify({
            prospects: [
              { ...EXTRACTION_RESPONSE.prospects[0], companyName: "Ghost Ltd", sourceUrl: "https://never-returned.example/x" },
              { ...EXTRACTION_RESPONSE.prospects[0], companyName: "Rival Web Design Agency" },
              EXTRACTION_RESPONSE.prospects[0],
            ],
          }),
          provider: "groq",
          model: "m",
        });
      vi.stubGlobal("fetch", mockFetchRouter({ tavily: async () => new Response(JSON.stringify({ results: SEARCH_HITS }), { status: 200 }) }));

      const result = await new TavilyDiscoveryProvider().discover({
        ...baseCriteria,
        campaignName: "Web designing agency",
        businessContext: sellerContext,
      });
      if (!result.ok) throw new Error("expected ok");

      expect(result.prospects.map((p) => p.companyName)).toEqual(["Sharma Boutique"]);
      expect(result.telemetry?.rejectedNotGrounded).toBe(1);
      expect(result.telemetry?.rejectedCompetitor).toBe(1);
    });
  });

  describe("Discovery/Qualification/Research boundary", () => {
    it("a DiscoveredProspect never carries a qualification score or research summary — those stages own that data, not Discovery", () => {
      const keys = Object.keys(EXTRACTION_RESPONSE.prospects[0]);
      expect(keys).not.toContain("qualificationScore");
      expect(keys).not.toContain("companySummary");
      expect(keys).not.toContain("recommendedStatus");
    });
  });
});
