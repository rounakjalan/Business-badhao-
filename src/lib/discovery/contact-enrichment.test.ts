import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverProspectContacts, enrichProspectContact, mergeContactIntoRawData, toFetchableUrl } from "@/lib/discovery/contact-enrichment";

/**
 * discoverProspectContacts is the fix for the exact production bug reported:
 * "Triverse" and "D S Media Link" both have website: null in production, and
 * the old enrichProspectContact was 100% website-fetch-dependent — a null
 * website meant contact enrichment was never even attempted. These tests
 * prove the fallback chain actually closes that gap, not just that the
 * individual pieces exist.
 */

function htmlResponse(html: string) {
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
}

function mockFetchRouter(handlers: { website?: (url: string) => Response | Promise<Response>; tavily?: (query: string) => Response | Promise<Response> }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "https://api.tavily.com/search") {
      if (!handlers.tavily) throw new Error("unexpected Tavily call in this test");
      const body = JSON.parse(String(init?.body ?? "{}"));
      return handlers.tavily(body.query);
    }
    if (!handlers.website) throw new Error(`unexpected website fetch in this test: ${url}`);
    return handlers.website(url);
  });
}

describe("discoverProspectContacts", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, TAVILY_API_KEY: "test-key" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it("THE PRODUCTION BUG: a prospect with website: null now gets a real contact via search fallback, instead of never being attempted at all", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchRouter({
        tavily: (query) => {
          if (query.includes("Triverse")) {
            return new Response(
              JSON.stringify({ results: [{ title: "Triverse Studio", url: "https://triverse.studio/contact", content: "Reach us at hello@triverse.studio or call +91 98765 43210." }] }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        },
      })
    );

    const outcome = await discoverProspectContacts({ companyName: "Triverse", website: null, location: "Pune" });

    expect(outcome.status).toBe("found");
    expect(outcome.contacts?.email?.value).toBe("hello@triverse.studio");
    expect(outcome.contacts?.phone?.value).toBe("+91 98765 43210");
  });

  it("prefers the website stage over search when the website alone already has real contact info", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchRouter({
        website: () => htmlResponse(`<html><body><a href="mailto:hello@brightpixel.in">Email</a></body></html>`),
        tavily: () => {
          throw new Error("must not call search when the website already found something");
        },
      })
    );

    const outcome = await discoverProspectContacts({ companyName: "Bright Pixel", website: "brightpixel.in", location: "Delhi" });
    expect(outcome.status).toBe("found");
    expect(outcome.contacts?.email?.value).toBe("hello@brightpixel.in");
  });

  it("falls back to search when the website exists but genuinely states no contact info", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchRouter({
        website: () => htmlResponse(`<html><body><h1>Coming soon</h1></body></html>`),
        tavily: () =>
          new Response(JSON.stringify({ results: [{ title: "Bright Pixel Studio", url: "https://brightpixel.in/about", content: "Contact hello@brightpixel.in" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      })
    );

    const outcome = await discoverProspectContacts({ companyName: "Bright Pixel", website: "brightpixel.in", location: "Delhi" });
    expect(outcome.status).toBe("found");
    expect(outcome.contacts?.email?.value).toBe("hello@brightpixel.in");
  });

  it("records contact_status: not_found — an honest completed search, never silence and never a fabrication — when nothing real exists anywhere", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchRouter({
        website: () => htmlResponse(`<html><body><h1>Coming soon</h1></body></html>`),
        tavily: () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
      })
    );

    const outcome = await discoverProspectContacts({ companyName: "Ghost Business", website: "ghostbusiness.in", location: "Delhi" });
    expect(outcome.status).toBe("not_found");
    expect(outcome.contacts).toBeNull();
  });

  it("still records a definite not_found status (not silence) for a prospect with no website at all and no search evidence", async () => {
    vi.stubGlobal("fetch", mockFetchRouter({ tavily: () => new Response(JSON.stringify({ results: [] }), { status: 200 }) }));

    const outcome = await discoverProspectContacts({ companyName: "Unfindable Co", website: null, location: null });
    expect(outcome.status).toBe("not_found");
  });
});

describe("mergeContactIntoRawData", () => {
  it("always writes a contact block with contactStatus, even on a not_found outcome — distinguishing 'searched, found nothing' from 'never attempted'", () => {
    const result = mergeContactIntoRawData({ location: "Pune" }, { contacts: null, status: "not_found" });
    expect(result.contact).toMatchObject({ contactStatus: "not_found", email: null, phone: null });
    expect(result.location).toBe("Pune");
  });

  it("preserves every other raw_data field untouched", () => {
    const result = mergeContactIntoRawData({ location: "Pune", industry: "Retail", evidenceSnippet: "a real snippet" }, { contacts: null, status: "not_found" });
    expect(result.industry).toBe("Retail");
    expect(result.evidenceSnippet).toBe("a real snippet");
  });
});

describe("enrichProspectContact / toFetchableUrl (website stage, unchanged behavior)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null immediately for a null website — never attempts a fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await enrichProspectContact(null);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades gracefully — returns null, never throws — when the site is unreachable (simulated timeout/network failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network timeout");
      })
    );
    const result = await enrichProspectContact("unreachable-site.example");
    expect(result).toBeNull();
  });

  it("degrades gracefully when the site returns a real HTTP error (broken contact page / whole site down)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));
    const result = await enrichProspectContact("brokensite.example");
    expect(result).toBeNull();
  });

  it("normalizes a bare domain into a fetchable https URL", () => {
    expect(toFetchableUrl("brightpixel.in")).toBe("https://brightpixel.in/");
    expect(toFetchableUrl("https://brightpixel.in")).toBe("https://brightpixel.in/");
  });

  it("rejects an unusable website value rather than attempting a malformed fetch", () => {
    expect(toFetchableUrl(null)).toBeNull();
    expect(toFetchableUrl("")).toBeNull();
    expect(toFetchableUrl("not a url at all")).toBeNull();
  });
});
