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
  /** Contact channels read from the business's own website — see contact-enrichment.ts. Null when the site was never reached or stated nothing. */
  contact: ProspectContact | null;
};

/**
 * A contact channel together with the page it was actually read from. The
 * source is not decoration: it is what makes a saved phone number checkable
 * rather than something the app merely asserts.
 */
export type ProspectContactField = { value: string; source: string };

export type ProspectContact = {
  email: ProspectContactField | null;
  phone: ProspectContactField | null;
  whatsapp: ProspectContactField | null;
  contactPageUrl: ProspectContactField | null;
  contactFormUrl: ProspectContactField | null;
  instagram: ProspectContactField | null;
  linkedin: ProspectContactField | null;
  facebook: ProspectContactField | null;
  address: ProspectContactField | null;
  enrichedAt: string | null;
};

/** Reads one contact field, keeping it only if both the value and its source survived the round trip. */
function parseContactField(raw: unknown): ProspectContactField | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const value = typeof record.value === "string" ? record.value.trim() : "";
  const source = typeof record.source === "string" ? record.source.trim() : "";
  if (!value || !source) return null;
  return { value, source };
}

function parseProspectContact(raw: unknown): ProspectContact | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const contact: ProspectContact = {
    email: parseContactField(record.email),
    phone: parseContactField(record.phone),
    whatsapp: parseContactField(record.whatsapp),
    contactPageUrl: parseContactField(record.contactPageUrl),
    contactFormUrl: parseContactField(record.contactFormUrl),
    instagram: parseContactField(record.instagram),
    linkedin: parseContactField(record.linkedin),
    facebook: parseContactField(record.facebook),
    address: parseContactField(record.address),
    enrichedAt: typeof record.enrichedAt === "string" ? record.enrichedAt : null,
  };

  const hasChannel = Object.entries(contact).some(([key, value]) => key !== "enrichedAt" && value !== null);
  return hasChannel ? contact : null;
}

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
    contact: parseProspectContact(data.contact),
  };
}
