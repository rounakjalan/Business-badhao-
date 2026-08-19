import { z } from "zod";

// Split out from icp-generator.ts (which also imports the Hermes service,
// a server-only module) so this schema/type can be safely imported from
// Client Components too, e.g. to validate a campaign's stored ICP jsonb
// before rendering it.
export const IcpSchema = z.object({
  targetCustomer: z.string(),
  ageRange: z.string().nullable(),
  location: z.string(),
  industry: z.string(),
  businessType: z.string().nullable(),
  budgetRange: z.string().nullable(),
  needs: z.array(z.string()).min(1),
  painPoints: z.array(z.string()).min(1),
  buyingSignals: z.array(z.string()).min(1),
  decisionFactors: z.array(z.string()).min(1),
  disqualifiers: z.array(z.string()).min(1),
  preferredChannels: z.array(z.string()).min(1),
  qualificationCriteria: z.array(z.string()).min(1),
});

export type Icp = z.infer<typeof IcpSchema>;
