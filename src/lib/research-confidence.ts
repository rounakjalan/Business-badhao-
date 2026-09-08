/**
 * Deterministic confidence classification for AI lead research — never the
 * model's own self-reported "confidence" field taken on faith. Same
 * philosophy as the Deterministic Validator in discovery.ts: a model's own
 * claim about the quality of its work is not trusted just because it made
 * the claim. researchLead (lib/pipeline/lead-pipeline.ts) computes this from
 * the real discovery evidence and the research output's own evidence
 * bookkeeping (verifiedInformation, unavailableInformation, etc.), then
 * overwrites the stored confidence with this value before saving —
 * lead_research.findings.confidence remains the one field the UI reads
 * (see prospect-research-schema.ts), never a second, competing one.
 */

export type ResearchConfidenceInputs = {
  /** A real company website is on file — the strongest single identity signal available before research even runs. */
  hasWebsite: boolean;
  /** A real, non-fabricated excerpt from the search result that surfaced this prospect. */
  hasEvidenceSnippet: boolean;
  /** How many ICP criteria the discovery stage judged this prospect matches. */
  matchedIcpCriteriaCount: number;
  /** A real email/phone/whatsapp/contact page/social profile was actually found and verified against a source. */
  hasVerifiedContact: boolean;
  /** Facts the research agent marked as directly verified from what it was given (never invented). */
  verifiedInformationCount: number;
  /** Business Knowledge facts the research agent actually drew on. */
  businessFactsReferencedCount: number;
  /** The research agent's own speculative reasoning, kept distinct from verified facts. */
  inferredInformationCount: number;
  /** What the research agent explicitly could not determine. */
  unavailableInformationCount: number;
};

export type ResearchConfidence = "low" | "medium" | "high";

/**
 * Seven independent, evidence-based signals, each worth one point. Deliberately
 * not a weighted/tunable formula — every signal here is a plain fact ("is there
 * a website", "how many things were verified"), not a judgment call, so the
 * classification stays auditable from the same evidence the Research tab shows.
 *
 * >= 5 of 7  -> high   (identity verified, real evidence, mostly-verified facts, little missing)
 * 3-4 of 7   -> medium (some real evidence, but meaningfully incomplete or inference-heavy)
 * <= 2 of 7  -> low    (little to no real, verifiable evidence)
 */
export function classifyResearchConfidence(inputs: ResearchConfidenceInputs): ResearchConfidence {
  const verifiedTotal = inputs.verifiedInformationCount + inputs.businessFactsReferencedCount;

  let score = 0;
  if (inputs.hasWebsite) score += 1;
  if (inputs.hasEvidenceSnippet) score += 1;
  if (inputs.matchedIcpCriteriaCount > 0) score += 1;
  if (inputs.hasVerifiedContact) score += 1;
  if (verifiedTotal >= 2) score += 1;
  if (inputs.unavailableInformationCount === 0) score += 1;
  // Gated on verifiedTotal > 0 so a research pass that verified nothing at
  // all can't earn this point vacuously just because it also inferred
  // nothing — a research agent that infers no more than it verified is
  // doing its job; one that infers more than it could verify is guessing
  // beyond what it actually knows.
  if (verifiedTotal > 0 && inputs.inferredInformationCount <= verifiedTotal) score += 1;

  let level: ResearchConfidence = score >= 5 ? "high" : score >= 3 ? "medium" : "low";

  // Hard caps: identity signals from discovery (website, ICP match) can
  // raise the additive score on their own, but they can never stand in for
  // the research pass itself actually verifying something, or leave too
  // much genuinely unresolved and still be called "high".
  if (verifiedTotal === 0 && level === "high") level = "medium";
  if (inputs.unavailableInformationCount >= 3) {
    if (level === "high") level = "medium";
    if (verifiedTotal === 0) level = "low";
  }

  return level;
}
