import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusinessContext } from "@/lib/business-context";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import {
  dedupeProspects,
  getDiscoveryProvider,
  NullDiscoveryProvider,
  normalizeWebsite,
  prospectDedupeKey,
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

describe("lead discovery", () => {
  const originalTavilyKey = process.env.TAVILY_API_KEY;
  const originalExaKey = process.env.EXA_API_KEY;

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
      const businessIdx = prompt.indexOf("=== BUSINESS KNOWLEDGE");
      const icpIdx = prompt.indexOf("=== IDEAL CUSTOMER PROFILE");
      expect(prompt).toContain("Acme Ads");
      expect(businessIdx).toBeGreaterThanOrEqual(0);
      expect(icpIdx).toBeGreaterThan(businessIdx);
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
