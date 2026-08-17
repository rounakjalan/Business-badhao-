// Lead discovery architecture only — no scraping/search integration exists
// yet. An AI model is not a web scraper, and Business Badhao doesn't ship
// with a hard-coded scraping/data provider (that would need a specific
// paid service's credentials this codebase doesn't have). This defines the
// shape a real discovery provider will implement later — search APIs,
// business directories, approved lead-data providers, etc. — so that
// integration is additive (implement DiscoveryProvider, register it below)
// rather than a rewrite of how discovery is consumed.

export type DiscoveredProspect = {
  name: string | null;
  company: string | null;
  website: string | null;
  location: string | null;
  industry: string | null;
  email: string | null;
  phone: string | null;
  source: string;
  sourceUrl: string | null;
  discoveredAt: string;
  researchSummary: string | null;
  signals: string[];
  icpMatch: {
    score: number | null;
    reasoning: string | null;
  };
};

export type DiscoveryCriteria = {
  organizationId: string;
  icpCriteria: Record<string, unknown> | null;
  location: string | null;
  limit: number;
};

export type DiscoveryResult =
  | { ok: true; prospects: DiscoveredProspect[] }
  | { ok: false; code: "not_configured" | "provider_error"; message: string };

export interface DiscoveryProvider {
  readonly name: string;
  isConfigured(): boolean;
  discover(criteria: DiscoveryCriteria): Promise<DiscoveryResult>;
}

/**
 * Honest default: no discovery source is connected. Returns a controlled
 * "not_configured" result rather than fabricating prospects — the
 * dashboard's "Find More Leads" button stays disabled until a real
 * DiscoveryProvider (search API, directory, approved data provider, etc.)
 * is implemented and wired in here.
 */
export class NullDiscoveryProvider implements DiscoveryProvider {
  readonly name = "none";

  isConfigured(): boolean {
    return false;
  }

  async discover(): Promise<DiscoveryResult> {
    return {
      ok: false,
      code: "not_configured",
      message: "Lead discovery isn't connected to a data source yet.",
    };
  }
}

/** Swap this out once a real provider is implemented — nothing else needs to change. */
export function getDiscoveryProvider(): DiscoveryProvider {
  return new NullDiscoveryProvider();
}
