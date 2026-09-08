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

  it("classifies a lead with a website, real evidence, and an ICP match as medium", () => {
    expect(
      classifyResearchConfidence(
        inputs({ hasWebsite: true, hasEvidenceSnippet: true, matchedIcpCriteriaCount: 2 })
      )
    ).toBe("medium");
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
});
