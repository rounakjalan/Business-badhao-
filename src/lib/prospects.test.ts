import { describe, expect, it } from "vitest";
import { parseProspectRawData } from "@/lib/prospects";
import type { Json } from "@/types/database.types";

describe("parseProspectRawData", () => {
  it("returns all-null/empty defaults for null raw_data", () => {
    expect(parseProspectRawData(null)).toEqual({
      location: null,
      industry: null,
      businessType: null,
      matchedIcpCriteria: [],
      evidenceSnippet: null,
      sourceUrl: null,
      searchQuery: null,
      discoverySource: null,
      discoveredAt: null,
      contact: null,
    });
  });

  it("returns defaults for undefined raw_data", () => {
    expect(parseProspectRawData(undefined).location).toBeNull();
  });

  it("returns defaults when raw_data is a JSON array instead of an object", () => {
    expect(parseProspectRawData(["not", "an", "object"] as unknown as Json)).toEqual(parseProspectRawData(null));
  });

  it("extracts real discovery fields written by discovery.ts / scheduled-pipeline.ts", () => {
    const result = parseProspectRawData({
      location: "Delhi NCR",
      industry: "Retail electronics",
      businessType: "Single-location physical store",
      matchedIcpCriteria: ["Located in target city", "Sells relevant category"],
      evidenceSnippet: "Sharma Retailers is a local electronics shop in Karol Bagh.",
      sourceUrl: "https://example.com/sharma-retailers",
      searchQuery: "electronics stores Delhi",
      discoverySource: "tavily",
      discoveredAt: "2026-08-20T10:00:00.000Z",
    });

    expect(result).toEqual({
      location: "Delhi NCR",
      industry: "Retail electronics",
      businessType: "Single-location physical store",
      matchedIcpCriteria: ["Located in target city", "Sells relevant category"],
      evidenceSnippet: "Sharma Retailers is a local electronics shop in Karol Bagh.",
      sourceUrl: "https://example.com/sharma-retailers",
      searchQuery: "electronics stores Delhi",
      discoverySource: "tavily",
      discoveredAt: "2026-08-20T10:00:00.000Z",
      contact: null,
    });
  });

  it("drops fields with the wrong type instead of throwing or fabricating a value", () => {
    const result = parseProspectRawData({
      location: 42,
      industry: null,
      matchedIcpCriteria: "not an array",
      evidenceSnippet: { nested: "object" },
    } as unknown as Json);

    expect(result.location).toBeNull();
    expect(result.industry).toBeNull();
    expect(result.matchedIcpCriteria).toEqual([]);
    expect(result.evidenceSnippet).toBeNull();
  });

  it("filters non-string entries out of matchedIcpCriteria rather than failing the whole field", () => {
    const result = parseProspectRawData({ matchedIcpCriteria: ["real one", 5, null, "real two"] } as unknown as Json);
    expect(result.matchedIcpCriteria).toEqual(["real one", "real two"]);
  });

  describe("contact channels", () => {
    it("reads the contact block discovery's website enrichment writes", () => {
      const result = parseProspectRawData({
        contact: {
          email: { value: "hello@brightpixel.in", source: "https://brightpixel.in/contact" },
          phone: { value: "+91 98765 43210", source: "https://brightpixel.in/contact" },
          instagram: { value: "https://instagram.com/brightpixel", source: "https://brightpixel.in/" },
          enrichedAt: "2026-09-02T10:00:00.000Z",
        },
      } as unknown as Json);

      expect(result.contact?.email).toEqual({ value: "hello@brightpixel.in", source: "https://brightpixel.in/contact" });
      expect(result.contact?.phone?.value).toBe("+91 98765 43210");
      expect(result.contact?.instagram?.source).toBe("https://brightpixel.in/");
      expect(result.contact?.enrichedAt).toBe("2026-09-02T10:00:00.000Z");
    });

    it("drops a contact that arrived without the page it came from — an unsourced contact is not evidence", () => {
      const result = parseProspectRawData({
        contact: { phone: { value: "+91 98765 43210" }, email: { value: "x@y.in", source: "" } },
      } as unknown as Json);

      expect(result.contact).toBeNull();
    });

    it("keeps the sourced channels and drops only the unsourced ones", () => {
      const result = parseProspectRawData({
        contact: {
          phone: { value: "+91 98765 43210" },
          email: { value: "hello@brightpixel.in", source: "https://brightpixel.in/contact" },
        },
      } as unknown as Json);

      expect(result.contact?.phone).toBeNull();
      expect(result.contact?.email?.value).toBe("hello@brightpixel.in");
    });

    it("returns null when a prospect has no contact block at all", () => {
      expect(parseProspectRawData({ location: "Delhi" } as unknown as Json).contact).toBeNull();
    });

    it("returns null for a contact block holding only a timestamp and no real channel", () => {
      expect(parseProspectRawData({ contact: { enrichedAt: "2026-09-02T10:00:00.000Z" } } as unknown as Json).contact).toBeNull();
    });
  });
});
