import { describe, expect, it } from "vitest";
import { formatBusinessContext } from "@/lib/ai/business-context-prompt";
import type { BusinessContext } from "@/lib/business-context";

const EMPTY_CONTEXT: BusinessContext = {
  businessProfile: null,
  productsServices: [],
  valueProposition: { keySellingPoints: [], productBenefits: [] },
  faqs: [],
  policies: [],
  aiCommunicationRules: null,
  mediaReferences: [],
};

describe("formatBusinessContext", () => {
  it("returns null when there is no Business Knowledge at all, rather than an empty-looking block", () => {
    expect(formatBusinessContext(EMPTY_CONTEXT)).toBeNull();
  });

  it("omits sections that have no data, even when other sections do", () => {
    const context: BusinessContext = {
      ...EMPTY_CONTEXT,
      faqs: [{ question: "Open on Sundays?", answer: "Yes, 10am-4pm.", category: null }],
    };

    const text = formatBusinessContext(context);

    expect(text).toContain("FAQs:");
    expect(text).not.toContain("PRODUCTS / SERVICES:");
    expect(text).not.toContain("BUSINESS POLICIES:");
    expect(text).not.toContain("AI COMMUNICATION RULES:");
  });

  it("renders products/services with price, availability, features, and benefits", () => {
    const context: BusinessContext = {
      ...EMPTY_CONTEXT,
      productsServices: [
        {
          name: "Home Theatre Installation",
          description: "Full setup",
          category: "Installation",
          price: 4999,
          pricingType: "fixed",
          features: ["Wall mounting"],
          benefits: ["Same-day service"],
          availability: "available",
          specialOffers: "10% off",
        },
      ],
    };

    const text = formatBusinessContext(context);

    expect(text).toContain("Home Theatre Installation");
    expect(text).toContain("Wall mounting");
    expect(text).toContain("Same-day service");
    expect(text).toContain("10% off");
  });

  it("does not print a fabricated price when a product has none set", () => {
    const context: BusinessContext = {
      ...EMPTY_CONTEXT,
      productsServices: [
        { name: "Consultation", description: null, category: null, price: null, pricingType: "custom", features: [], benefits: [], availability: "available", specialOffers: null },
      ],
    };

    const text = formatBusinessContext(context);

    expect(text).toContain("price not set");
    expect(text).not.toMatch(/₹|\$\d/);
  });

  it("renders AI communication rules, including must-never-claim boundaries", () => {
    const context: BusinessContext = {
      ...EMPTY_CONTEXT,
      aiCommunicationRules: {
        brandVoice: "Friendly",
        preferredLanguage: null,
        formality: null,
        mustEmphasize: [],
        mustNeverClaim: ["Free installation"],
        competitorComparisonRules: null,
        discountAuthority: null,
        escalationRules: null,
        handoffTriggers: [],
      },
    };

    const text = formatBusinessContext(context);

    expect(text).toContain("AI COMMUNICATION RULES:");
    expect(text).toContain("Must NEVER claim: Free installation");
  });

  it("renders media references by category and title without exposing any URL", () => {
    const context: BusinessContext = {
      ...EMPTY_CONTEXT,
      mediaReferences: [{ category: "brochure", title: "2026 Catalogue", fileName: "catalogue.pdf" }],
    };

    const text = formatBusinessContext(context);

    expect(text).toContain("2026 Catalogue");
    expect(text).not.toContain("http");
  });
});
