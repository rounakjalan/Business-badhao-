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
});
