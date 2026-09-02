import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchContactEvidence } from "@/lib/discovery/contact-search";

/**
 * The fallback stage for exactly the case unit tests must prove works: a
 * prospect Lead Discovery found and validated as real (that already happened
 * upstream in discovery.ts, unmocked here) without ever capturing a website —
 * Triverse and D S Media Link in production were both exactly this shape.
 */

function mockFetchOk(hitsByQuery: Record<string, { title: string; url: string; content: string }[]>) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const results = hitsByQuery[body.query] ?? [];
    return new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

describe("searchContactEvidence", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, TAVILY_API_KEY: "test-key" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it("returns null when no search provider is configured, never fabricating a substitute", async () => {
    process.env.TAVILY_API_KEY = "";
    vi.stubGlobal("fetch", vi.fn());
    const result = await searchContactEvidence({ businessName: "Triverse", location: "Pune", websiteHost: null });
    expect(result).toBeNull();
  });

  it("extracts a real email from a genuinely relevant result, found by a business email domain match", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOk({
        '"Triverse" Pune contact email phone': [
          { title: "Triverse — Web & App Studio", url: "https://triverse.in/contact", content: "Reach the Triverse team at hello@triverse.in or call our studio." },
        ],
      })
    );

    const result = await searchContactEvidence({ businessName: "Triverse", location: "Pune", websiteHost: "triverse.in" });
    expect(result?.email?.value).toBe("hello@triverse.in");
    expect(result?.email?.confidence).toBe("high");
    expect(result?.email?.source).toBe("https://triverse.in/contact");
  });

  it("rejects a same-named-mention result whose own URL gives no evidence of being this business", async () => {
    // A directory page that happens to mention "Triverse" in its title text,
    // but whose URL/content is a generic aggregator with an unrelated email —
    // must not be accepted as Triverse's own contact.
    vi.stubGlobal(
      "fetch",
      mockFetchOk({
        '"Triverse" Pune contact email phone': [
          { title: "Business Directory — Pune IT Companies", url: "https://someaggregator.example/pune-it-list", content: "See Triverse and 200 other companies. General enquiries: info@someaggregator.example." },
        ],
      })
    );

    const result = await searchContactEvidence({ businessName: "Triverse", location: "Pune", websiteHost: null });
    expect(result).toBeNull();
  });

  it("accepts a social profile only when the platform's own URL contains the business name — real evidence, not a snippet mention", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOk({
        '"D S Media Link" Mumbai contact email phone': [
          { title: "D S Media Link | LinkedIn", url: "https://linkedin.com/company/ds-media-link", content: "D S Media Link is a digital marketing agency." },
        ],
      })
    );

    const result = await searchContactEvidence({ businessName: "D S Media Link", location: "Mumbai", websiteHost: null });
    expect(result?.linkedin?.value).toBe("https://linkedin.com/company/ds-media-link");
    expect(result?.linkedin?.confidence).toBe("medium");
  });

  it("never invents a Gmail address from the business name — only extracts one actually present in retrieved text", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOk({
        '"Triverse" Pune contact email phone': [{ title: "Triverse Studio", url: "https://triverse.in/about", content: "A design studio in Pune. No contact details listed here." }],
      })
    );

    const result = await searchContactEvidence({ businessName: "Triverse", location: "Pune", websiteHost: "triverse.in" });
    expect(result).toBeNull();
  });

  it("stops after the first query once it finds real evidence, never spending the second query's budget needlessly", async () => {
    const fetchMock = mockFetchOk({
      '"Triverse" Pune contact email phone': [{ title: "Triverse", url: "https://triverse.in/contact", content: "hello@triverse.in" }],
      '"Triverse" official website contact us': [{ title: "should not be called", url: "https://triverse.in/x", content: "x@triverse.in" }],
    });
    vi.stubGlobal("fetch", fetchMock);

    await searchContactEvidence({ businessName: "Triverse", location: "Pune", websiteHost: "triverse.in" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries a second, narrower query only when the first finds nothing", async () => {
    const fetchMock = mockFetchOk({
      '"Triverse" Pune contact email phone': [],
      '"Triverse" official website contact us': [{ title: "Triverse", url: "https://triverse.in/contact", content: "hello@triverse.in" }],
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchContactEvidence({ businessName: "Triverse", location: "Pune", websiteHost: "triverse.in" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.email?.value).toBe("hello@triverse.in");
  });

  it("returns null, not a partial guess, when a real business genuinely has no discoverable public contact", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOk({
        '"Triverse" Pune contact email phone': [],
        '"Triverse" official website contact us': [],
      })
    );

    const result = await searchContactEvidence({ businessName: "Triverse", location: "Pune", websiteHost: null });
    expect(result).toBeNull();
  });

  it("degrades gracefully when the search provider itself fails, never throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Service Unavailable", { status: 503 })));
    const result = await searchContactEvidence({ businessName: "Triverse", location: "Pune", websiteHost: null });
    expect(result).toBeNull();
  });
});
