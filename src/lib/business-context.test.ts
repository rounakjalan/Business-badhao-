import { afterEach, describe, expect, it, vi } from "vitest";

// Records every .eq("organization_id", ...) call made across all table
// queries in a test, so tests can assert org-scoping without re-implementing
// the Supabase query builder in full.
const orgIdFilters: unknown[] = [];

type TableData = Record<string, { data: unknown; error?: unknown }>;

function buildFrom(tableData: TableData) {
  return (table: string) => {
    const config = tableData[table] ?? { data: null };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        if (column === "organization_id") orgIdFilters.push(value);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: config.data, error: config.error ?? null }),
      then: (resolve: (result: { data: unknown; error: unknown }) => void) => resolve({ data: config.data, error: config.error ?? null }),
    };
    return builder;
  };
}

const { mockCreateClient } = vi.hoisted(() => ({ mockCreateClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mockCreateClient }));

import { getBusinessContext, isBusinessContextEmpty } from "@/lib/business-context";

function mockSupabase(tableData: TableData) {
  mockCreateClient.mockResolvedValue({ from: buildFrom(tableData) });
}

describe("getBusinessContext", () => {
  afterEach(() => {
    vi.clearAllMocks();
    orgIdFilters.length = 0;
  });

  it("retrieves business context for the given organization", async () => {
    mockSupabase({
      business_profiles: { data: { business_name: "Acme", business_description: null, business_category: null, website: null, phone: null, email: null, whatsapp: null, address: null, service_area: null, opening_hours: null, about: null } },
      products_services: { data: [] },
      faqs: { data: [] },
      business_policies: { data: [] },
      ai_communication_rules: { data: null },
      media_assets: { data: [] },
    });

    const context = await getBusinessContext("org-1");

    expect(context.businessProfile?.name).toBe("Acme");
  });

  it("scopes every table query to the requested organization_id (RLS defense-in-depth)", async () => {
    mockSupabase({
      business_profiles: { data: null },
      products_services: { data: [] },
      faqs: { data: [] },
      business_policies: { data: [] },
      ai_communication_rules: { data: null },
      media_assets: { data: [] },
    });

    await getBusinessContext("org-42");

    // One .eq("organization_id", "org-42") per table queried (6 tables).
    expect(orgIdFilters.length).toBeGreaterThanOrEqual(6);
    expect(orgIdFilters.every((v) => v === "org-42")).toBe(true);
    // Never leaks a different organization's id into the same call.
    expect(orgIdFilters).not.toContain("org-1");
  });

  it("includes products/services in the returned context", async () => {
    mockSupabase({
      business_profiles: { data: null },
      products_services: {
        data: [{ name: "Home Theatre Installation", description: "Setup", category: "Installation", price: 4999, pricing_type: "fixed", features: ["Wall mounting"], benefits: ["Same-day"], availability: "available", special_offers: null }],
      },
      faqs: { data: [] },
      business_policies: { data: [] },
      ai_communication_rules: { data: null },
      media_assets: { data: [] },
    });

    const context = await getBusinessContext("org-1");

    expect(context.productsServices).toHaveLength(1);
    expect(context.productsServices[0].name).toBe("Home Theatre Installation");
    expect(context.valueProposition.productBenefits).toContain("Same-day");
  });

  it("includes FAQs in the returned context", async () => {
    mockSupabase({
      business_profiles: { data: null },
      products_services: { data: [] },
      faqs: { data: [{ question: "Do you offer warranty?", answer: "Yes, 1 year.", category: "Warranty" }] },
      business_policies: { data: [] },
      ai_communication_rules: { data: null },
      media_assets: { data: [] },
    });

    const context = await getBusinessContext("org-1");

    expect(context.faqs).toEqual([{ question: "Do you offer warranty?", answer: "Yes, 1 year.", category: "Warranty" }]);
  });

  it("includes business policies in the returned context", async () => {
    mockSupabase({
      business_profiles: { data: null },
      products_services: { data: [] },
      faqs: { data: [] },
      business_policies: { data: [{ policy_type: "refund", title: "Refund Policy", content: "7 day refund." }] },
      ai_communication_rules: { data: null },
      media_assets: { data: [] },
    });

    const context = await getBusinessContext("org-1");

    expect(context.policies).toEqual([{ policyType: "refund", title: "Refund Policy", content: "7 day refund." }]);
  });

  it("includes AI communication rules in the returned context", async () => {
    mockSupabase({
      business_profiles: { data: null },
      products_services: { data: [] },
      faqs: { data: [] },
      business_policies: { data: [] },
      ai_communication_rules: {
        data: {
          brand_voice: "Friendly",
          preferred_language: "English",
          formality: "Casual",
          key_selling_points: ["Certified installers"],
          must_emphasize: ["Certified installers"],
          must_never_claim: ["Same-day outside NCR"],
          competitor_comparison_rules: null,
          discount_authority: null,
          escalation_rules: null,
          handoff_triggers: ["Customer asks for a refund"],
        },
      },
      media_assets: { data: [] },
    });

    const context = await getBusinessContext("org-1");

    expect(context.aiCommunicationRules?.brandVoice).toBe("Friendly");
    expect(context.aiCommunicationRules?.mustNeverClaim).toEqual(["Same-day outside NCR"]);
    expect(context.valueProposition.keySellingPoints).toEqual(["Certified installers"]);
  });

  it("returns an empty (not failing) context when the organization has no Business Knowledge at all", async () => {
    mockSupabase({
      business_profiles: { data: null },
      products_services: { data: [] },
      faqs: { data: [] },
      business_policies: { data: [] },
      ai_communication_rules: { data: null },
      media_assets: { data: [] },
    });

    const context = await getBusinessContext("org-1");

    expect(isBusinessContextEmpty(context)).toBe(true);
  });

  it("does not throw when only some sections are missing (partially filled-in Knowledge)", async () => {
    mockSupabase({
      business_profiles: { data: null }, // profile never filled in
      products_services: { data: [{ name: "A Service", description: null, category: null, price: null, pricing_type: "fixed", features: [], benefits: [], availability: "available", special_offers: null }] },
      faqs: { data: [] },
      business_policies: { data: [] },
      ai_communication_rules: { data: null },
      media_assets: { data: [] },
    });

    const context = await getBusinessContext("org-1");

    expect(context.businessProfile).toBeNull();
    expect(context.productsServices).toHaveLength(1);
    expect(isBusinessContextEmpty(context)).toBe(false);
  });
});
