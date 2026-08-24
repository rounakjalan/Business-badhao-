import type { Json } from "@/types/database.types";

/**
 * Everything Lead Discovery (src/lib/ai/agents/discovery.ts) writes into
 * prospects.raw_data — the only place this data lives, since prospects has
 * no dedicated columns for it. Every field is optional because prospects
 * created outside discovery (manual entry, future sources) have no raw_data
 * at all.
 */
export type ProspectRawData = {
  location: string | null;
  industry: string | null;
  businessType: string | null;
  /** Which ICP criteria this prospect appears to match, in the discovery model's own words — a judgment, not a verified fact. */
  matchedIcpCriteria: string[];
  /** The actual excerpt from the search result that supports this prospect — never AI-invented text. */
  evidenceSnippet: string | null;
  sourceUrl: string | null;
  searchQuery: string | null;
  discoverySource: string | null;
  discoveredAt: string | null;
};

/** Parses prospects.raw_data defensively — it's untyped jsonb, and rows created before a field existed simply won't have it. */
export function parseProspectRawData(raw: Json | null | undefined): ProspectRawData {
  const data = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return {
    location: typeof data.location === "string" ? data.location : null,
    industry: typeof data.industry === "string" ? data.industry : null,
    businessType: typeof data.businessType === "string" ? data.businessType : null,
    matchedIcpCriteria: Array.isArray(data.matchedIcpCriteria) ? data.matchedIcpCriteria.filter((v): v is string => typeof v === "string") : [],
    evidenceSnippet: typeof data.evidenceSnippet === "string" ? data.evidenceSnippet : null,
    sourceUrl: typeof data.sourceUrl === "string" ? data.sourceUrl : null,
    searchQuery: typeof data.searchQuery === "string" ? data.searchQuery : null,
    discoverySource: typeof data.discoverySource === "string" ? data.discoverySource : null,
    discoveredAt: typeof data.discoveredAt === "string" ? data.discoveredAt : null,
  };
}
