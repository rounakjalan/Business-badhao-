import { z } from "zod";

// Split out from prospect-research.ts (which also imports the Hermes
// service, a server-only module) so this schema/type can be safely
// imported from Client Components too, e.g. to render a lead's stored
// lead_research.findings jsonb without re-running the agent.
export const ProspectResearchSchema = z.object({
  companySummary: z.string(),
  likelyNeeds: z.array(z.string()),
  possiblePainPoints: z.array(z.string()),
  relevantProductsOrServices: z.array(z.string()),
  buyingSignals: z.array(z.string()),
  personalizationOpportunities: z.array(z.string()),
  potentialObjections: z.array(z.string()),
  confidence: z.enum(["low", "medium", "high"]),
  verifiedInformation: z.array(z.string()),
  /** Which supplied Business Knowledge facts (products, profile, differentiators) were actually drawn on — kept distinct from verifiedInformation (about the prospect) and inferredInformation (the model's own reasoning). */
  businessFactsReferenced: z.array(z.string()),
  inferredInformation: z.array(z.string()),
  unavailableInformation: z.array(z.string()),
});

export type ProspectResearch = z.infer<typeof ProspectResearchSchema>;
