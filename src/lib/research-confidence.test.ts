import { describe, expect, it } from "vitest";
import { classifyResearchConfidence, type ResearchConfidenceInputs } from "@/lib/research-confidence";

function inputs(overrides: Partial<ResearchConfidenceInputs> = {}): ResearchConfidenceInputs {
  return {
    hasWebsite: false,
    hasEvidenceSnippet: false,
    matchedIcpCriteriaCount: 0,
    hasVerifiedContact: false,
    verifiedInformationCount: 0,
    businessFactsReferencedCount: 0,
    inferredInformationCount: 0,
    unavailableInformationCount: 0,
    ...overrides,
  };
}

describe("classifyResearchConfidence", () => {
  it("classifies a lead with almost no real evidence as low", () => {
    expect(classifyResearchConfidence(inputs())).toBe("low");
  });

  it("classifies a lead with only a website and no other signal as low — one signal is not enough", () => {
    expect(classifyResearchConfidence(inputs({ hasWebsite: true }))).toBe("low");
  });

  it("classifies a lead with discovery-side identity signals but zero verified facts as low, not medium — identity signals are never a substitute for the research pass itself verifying something", () => {
    expect(
      classifyResearchConfidence(
        inputs({ hasWebsite: true, hasEvidenceSnippet: true, matchedIcpCriteriaCount: 2 })
      )
    ).toBe("low");
  });

  it("classifies a fully grounded, mostly-verified lead as high", () => {
    expect(
      classifyResearchConfidence(
        inputs({
          hasWebsite: true,
          hasEvidenceSnippet: true,
          matchedIcpCriteriaCount: 2,
          hasVerifiedContact: true,
          verifiedInformationCount: 2,
          businessFactsReferencedCount: 1,
          unavailableInformationCount: 0,
          inferredInformationCount: 1,
        })
      )
    ).toBe("high");
  });

  it("penalizes a lead whose research is mostly speculation beyond what was actually verified", () => {
    const base = { hasWebsite: true, hasEvidenceSnippet: true, matchedIcpCriteriaCount: 1, verifiedInformationCount: 1 };
    const grounded = classifyResearchConfidence(inputs(base));
    const speculative = classifyResearchConfidence(inputs({ ...base, inferredInformationCount: 5 }));

    const rank: Record<string, number> = { low: 0, medium: 1, high: 2 };
    expect(rank[speculative]).toBeLessThan(rank[grounded]);
  });

  it("penalizes a lead with a lot of unavailable information even if some facts are verified", () => {
    const result = classifyResearchConfidence(
      inputs({
        hasWebsite: true,
        hasEvidenceSnippet: true,
        matchedIcpCriteriaCount: 1,
        verifiedInformationCount: 2,
        unavailableInformationCount: 4,
      })
    );
    expect(result).not.toBe("high");
  });

  it("never returns high for a lead with zero real evidence, however many things the model claims to infer", () => {
    expect(classifyResearchConfidence(inputs({ inferredInformationCount: 10 }))).toBe("low");
  });

  // Universal quality tiers — the exact inputs a research pass with strong,
  // useful, or sparse evidence would realistically produce, independent of
  // any particular business's vertical. classifyResearchConfidence never
  // takes an industry/business-type parameter at all, so these three cases
  // are what actually separates the three confidence levels in production.
  describe("evidence-quality tiers (Case A/B/C)", () => {
    it("Case A: strong verified evidence, multiple sources, few critical unknowns -> high", () => {
      expect(
        classifyResearchConfidence(
          inputs({
            hasWebsite: true,
            hasEvidenceSnippet: true,
            matchedIcpCriteriaCount: 3,
            hasVerifiedContact: true,
            verifiedInformationCount: 5,
            businessFactsReferencedCount: 2,
            unavailableInformationCount: 3,
            inferredInformationCount: 2,
          })
        )
      ).toBe("high");
    });

    it("Case B: useful evidence, some verified facts, meaningful unknowns -> medium", () => {
      expect(
        classifyResearchConfidence(
          inputs({
            hasWebsite: false,
            hasEvidenceSnippet: true,
            matchedIcpCriteriaCount: 1,
            hasVerifiedContact: false,
            verifiedInformationCount: 3,
            unavailableInformationCount: 4,
            inferredInformationCount: 2,
          })
        )
      ).toBe("medium");
    });

    it("Case C: sparse/weak evidence, substantial uncertainty and missing facts -> low", () => {
      expect(
        classifyResearchConfidence(
          inputs({
            hasWebsite: false,
            hasEvidenceSnippet: false,
            matchedIcpCriteriaCount: 0,
            hasVerifiedContact: false,
            verifiedInformationCount: 1,
            unavailableInformationCount: 6,
            inferredInformationCount: 4,
          })
        )
      ).toBe("low");
    });
  });

  // Business-type agnosticism: classifyResearchConfidence has no notion of
  // "industry" or "business type" anywhere in its signature or logic — these
  // tests prove that in practice, using realistic evidence a research pass
  // would produce for very different kinds of businesses.
  describe("business-type agnosticism", () => {
    it("a website/design agency with strong verified evidence reaches high", () => {
      expect(
        classifyResearchConfidence(
          inputs({
            hasWebsite: true,
            hasEvidenceSnippet: true,
            matchedIcpCriteriaCount: 2,
            hasVerifiedContact: true,
            verifiedInformationCount: 4,
            businessFactsReferencedCount: 1,
            unavailableInformationCount: 3,
            inferredInformationCount: 2,
          })
        )
      ).toBe("high");
    });

    it("a school with no website but equally strong verified evidence also reaches high", () => {
      // Schools/colleges frequently have no discoverable "website" field the
      // way a digital agency does, but that alone must never cap confidence
      // when the research itself is well-verified.
      expect(
        classifyResearchConfidence(
          inputs({
            hasWebsite: false,
            hasEvidenceSnippet: true,
            matchedIcpCriteriaCount: 2,
            hasVerifiedContact: true,
            verifiedInformationCount: 6,
            businessFactsReferencedCount: 1,
            unavailableInformationCount: 4,
            inferredInformationCount: 3,
          })
        )
      ).toBe("high");
    });

    it("a product business (e-commerce) with moderate evidence reaches medium", () => {
      expect(
        classifyResearchConfidence(
          inputs({
            hasWebsite: true,
            hasEvidenceSnippet: true,
            matchedIcpCriteriaCount: 1,
            hasVerifiedContact: false,
            verifiedInformationCount: 2,
            unavailableInformationCount: 5,
            inferredInformationCount: 2,
          })
        )
      ).toBe("medium");
    });

    it("a service business (consultant) with equivalent moderate evidence also reaches medium", () => {
      expect(
        classifyResearchConfidence(
          inputs({
            hasWebsite: false,
            hasEvidenceSnippet: true,
            matchedIcpCriteriaCount: 1,
            hasVerifiedContact: true,
            verifiedInformationCount: 2,
            unavailableInformationCount: 6,
            inferredInformationCount: 1,
          })
        )
      ).toBe("medium");
    });

    it("a local business (restaurant) with sparse evidence reaches low", () => {
      expect(
        classifyResearchConfidence(
          inputs({
            hasWebsite: false,
            hasEvidenceSnippet: false,
            matchedIcpCriteriaCount: 0,
            hasVerifiedContact: false,
            verifiedInformationCount: 1,
            unavailableInformationCount: 5,
            inferredInformationCount: 3,
          })
        )
      ).toBe("low");
    });

    it("business type alone does not determine confidence — two 'school' leads with different evidence quality land in different tiers", () => {
      const wellVerifiedSchool = classifyResearchConfidence(
        inputs({
          hasEvidenceSnippet: true,
          matchedIcpCriteriaCount: 2,
          hasVerifiedContact: true,
          verifiedInformationCount: 6,
          unavailableInformationCount: 4,
          inferredInformationCount: 2,
        })
      );
      const poorlyVerifiedSchool = classifyResearchConfidence(
        inputs({
          hasEvidenceSnippet: false,
          matchedIcpCriteriaCount: 0,
          hasVerifiedContact: false,
          verifiedInformationCount: 0,
          unavailableInformationCount: 5,
          inferredInformationCount: 4,
        })
      );

      const rank: Record<string, number> = { low: 0, medium: 1, high: 2 };
      expect(rank[wellVerifiedSchool]).toBeGreaterThan(rank[poorlyVerifiedSchool]);
    });
  });
});
