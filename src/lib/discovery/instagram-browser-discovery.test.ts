import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveryCriteria } from "@/lib/ai/agents/discovery";
import { newTelemetry } from "@/lib/ai/agents/discovery";
import { InstagramBrowserDiscoveryTool, isInstagramDiscoveryConfigured } from "@/lib/discovery/instagram-browser-discovery";

const criteria: DiscoveryCriteria = {
  organizationId: "org-1",
  campaignName: "Jaipur Web Design Push",
  campaignObjective: "Book demo calls with local schools",
  icpCriteria: { location: "Jaipur", industry: "Education", businessType: "School" },
  businessContext: null,
};

const ORIGINAL_ENV = { ...process.env };

describe("isInstagramDiscoveryConfigured", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is false when neither env var is set", () => {
    delete process.env.INSTAGRAM_DISCOVERY_API_URL;
    delete process.env.INSTAGRAM_DISCOVERY_API_KEY;
    expect(isInstagramDiscoveryConfigured()).toBe(false);
  });

  it("is false when only one of the two env vars is set", () => {
    process.env.INSTAGRAM_DISCOVERY_API_URL = "https://automation.example/run";
    delete process.env.INSTAGRAM_DISCOVERY_API_KEY;
    expect(isInstagramDiscoveryConfigured()).toBe(false);
  });

  it("is true when both env vars are set", () => {
    process.env.INSTAGRAM_DISCOVERY_API_URL = "https://automation.example/run";
    process.env.INSTAGRAM_DISCOVERY_API_KEY = "test-key";
    expect(isInstagramDiscoveryConfigured()).toBe(true);
  });
});

describe("InstagramBrowserDiscoveryTool", () => {
  beforeEach(() => {
    process.env.INSTAGRAM_DISCOVERY_API_URL = "https://automation.example/run";
    process.env.INSTAGRAM_DISCOVERY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it("reports not-configured (never throws, never fakes a result) when the backend isn't set up", async () => {
    delete process.env.INSTAGRAM_DISCOVERY_API_URL;
    delete process.env.INSTAGRAM_DISCOVERY_API_KEY;
    const tool = new InstagramBrowserDiscoveryTool(criteria);

    const result = await tool.search("schools in Jaipur with outdated websites");

    expect(result).toEqual({ ok: false, message: expect.stringContaining("isn't connected") });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes a real, well-formed backend response into SearchHit[] tagged source: 'instagram' — candidate normalization + shared-shape compatibility", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              url: "https://www.instagram.com/sunrise_public_school/",
              title: "Sunrise Public School (@sunrise_public_school)",
              content: "CBSE school in Jaipur. Admissions open. Visit our website: sunrisepublicschool.example",
            },
          ],
        }),
        { status: 200 }
      )
    );

    const tool = new InstagramBrowserDiscoveryTool(criteria);
    const result = await tool.search("schools in Jaipur", newTelemetry());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results).toEqual([
      {
        url: "https://www.instagram.com/sunrise_public_school/",
        title: "Sunrise Public School (@sunrise_public_school)",
        content: "CBSE school in Jaipur. Admissions open. Visit our website: sunrisepublicschool.example",
        source: "instagram",
      },
    ]);
  });

  it("passes Campaign + ICP + Business Knowledge into the backend request — the same DiscoveryCriteria every other search source receives, never a second representation", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const withBusinessContext: DiscoveryCriteria = {
      ...criteria,
      businessContext: {
        businessProfile: {
          name: "Bright Web Studio",
          description: null,
          category: "Web design",
          about: null,
          website: null,
          phone: null,
          email: null,
          whatsapp: null,
          address: null,
          serviceArea: null,
          openingHours: null,
        },
        productsServices: [
          { name: "School website packages", description: null, category: null, price: null, pricingType: "fixed", features: [], benefits: [], availability: "in_stock", specialOffers: null },
        ],
        valueProposition: { keySellingPoints: [], productBenefits: [] },
        faqs: [],
        policies: [],
        aiCommunicationRules: null,
        mediaReferences: [],
      },
    };

    const tool = new InstagramBrowserDiscoveryTool(withBusinessContext);
    await tool.search("schools in Jaipur with weak web presence");

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.goal).toContain("schools in Jaipur with weak web presence");
    expect(body.goal).toContain(JSON.stringify(withBusinessContext.icpCriteria));
    expect(body.goal).toContain("Bright Web Studio");
    expect(body.goal).toContain("School website packages");
  });

  it("never sends the API key anywhere except the Authorization header, and never leaks it into an error message", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("simulated network failure"));
    const tool = new InstagramBrowserDiscoveryTool(criteria);

    const result = await tool.search("schools in Jaipur");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain("test-key");

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect((init as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe("Bearer test-key");
    const bodyStr = (init as RequestInit).body as string;
    expect(bodyStr).not.toContain("test-key");
  });

  it("isolates a network failure — real, typed failure, never a throw, never a fabricated result", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNRESET"));
    const tool = new InstagramBrowserDiscoveryTool(criteria);
    const telemetry = newTelemetry();

    const result = await tool.search("schools in Jaipur", telemetry);

    expect(result).toEqual({ ok: false, message: expect.stringContaining("ECONNRESET") });
    expect(telemetry.instagramDiscovery).toEqual({ requests: 1, succeeded: 0, failed: 1, results: 0 });
  });

  it("isolates a non-2xx backend response without throwing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("internal error", { status: 500 }));
    const tool = new InstagramBrowserDiscoveryTool(criteria);

    const result = await tool.search("schools in Jaipur");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("HTTP 500");
  });

  it("isolates a malformed (non-JSON) backend response without throwing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not json at all", { status: 200 }));
    const tool = new InstagramBrowserDiscoveryTool(criteria);

    const result = await tool.search("schools in Jaipur");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("could not be parsed");
  });

  it("isolates a response that parses as JSON but doesn't match the expected shape", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ unexpected: "shape" }), { status: 200 }));
    const tool = new InstagramBrowserDiscoveryTool(criteria);

    const result = await tool.search("schools in Jaipur");

    // The schema defaults a missing `results` key to [] rather than
    // rejecting outright — a genuinely empty, honest result, not a failure.
    expect(result).toEqual({ ok: true, results: [] });
  });

  it("reports a genuine, honest zero-result outcome — never fabricates a candidate to avoid an empty list", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const tool = new InstagramBrowserDiscoveryTool(criteria);
    const telemetry = newTelemetry();

    const result = await tool.search("schools in Jaipur", telemetry);

    expect(result).toEqual({ ok: true, results: [] });
    expect(telemetry.instagramDiscovery.succeeded).toBe(1);
    expect(telemetry.instagramDiscovery.results).toBe(0);
  });

  it("caps real browser work to MAX_QUERIES_PER_BATCH per instance — a slow/metered resource, not called once per planned query unbounded", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const tool = new InstagramBrowserDiscoveryTool(criteria);

    const first = await tool.search("query 1");
    const second = await tool.search("query 2");
    const third = await tool.search("query 3");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toEqual({ ok: true, results: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("is business-type-agnostic — the same tool handles a retail ICP exactly like an education ICP, no hardcoded vertical", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ url: "https://www.instagram.com/rao_textiles/", title: "Rao Textiles", content: "Wholesale textile shop." }] }), { status: 200 })
    );
    const retailCriteria: DiscoveryCriteria = { ...criteria, icpCriteria: { location: "Pune", industry: "Retail", businessType: "Textile shop" } };

    const tool = new InstagramBrowserDiscoveryTool(retailCriteria);
    const result = await tool.search("textile shops in Pune");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]?.source).toBe("instagram");
  });
});
