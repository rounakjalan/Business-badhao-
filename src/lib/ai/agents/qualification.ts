import { z } from "zod";
import { formatBusinessContext } from "@/lib/ai/business-context-prompt";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";
import type { BusinessContext } from "@/lib/business-context";

// Kept identical to the leads.qualification_status CHECK constraint in the
// schema (supabase/migrations/20260816120300_leads_foundation.sql) — the
// AI's recommendation is only ever written into a column that already
// accepts exactly these values.
export const QUALIFICATION_STATUSES = ["pending", "qualifying", "qualified", "disqualified"] as const;

export const LeadQualificationSchema = z.object({
  qualificationScore: z.number().min(0).max(100),
  fitScore: z.number().min(0).max(100),
  intentScore: z.number().min(0).max(100),
  confidence: z.enum(["low", "medium", "high"]),
  positiveReasons: z.array(z.string()),
  negativeReasons: z.array(z.string()),
  missingInformation: z.array(z.string()),
  recommendedStatus: z.enum(QUALIFICATION_STATUSES),
});

export type LeadQualification = z.infer<typeof LeadQualificationSchema>;

export type LeadQualificationInput = {
  organizationId: string;
  leadName: string;
  companyName: string | null;
  currentStatus: string;
  currentScore: number | null;
  researchSummary: string | null;
  /** The campaign's Ideal Customer Profile — kept a fully separate concept from businessContext below; ICP is who the campaign targets, businessContext is what the business actually offers. */
  icpCriteria: Record<string, unknown> | null;
  campaignObjective: string | null;
  /** This organization's relevant Business Knowledge (see selectQualificationContext in src/lib/business-context.ts) — null when none is on file. */
  businessContext: BusinessContext | null;
};

export type LeadQualificationResult =
  | { ok: true; qualification: LeadQualification }
  | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI lead-qualification engine inside Business Badhao, a customer-acquisition CRM. Score how well a lead fits THIS BUSINESS and THIS CAMPAIGN, using only the information given: the lead's own record, any research on file, this business's real Business Knowledge (products/services, service area, relevant policies), and the campaign's Ideal Customer Profile criteria if available. Business Knowledge and the campaign's ICP are two separate things — Business Knowledge is what the business actually offers, the ICP is who this specific campaign targets. A lead can fit the ICP but not the business's actual offerings (e.g. outside the service area), or vice versa; consider both.

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly these keys:
{
  "qualificationScore": number (0-100),
  "fitScore": number (0-100),
  "intentScore": number (0-100),
  "confidence": "low" | "medium" | "high",
  "positiveReasons": string[],
  "negativeReasons": string[],
  "missingInformation": string[],
  "recommendedStatus": "pending" | "qualifying" | "qualified" | "disqualified"
}

Every reason must trace back to something in the input — never invent a product, price, policy, or business fact not present in Business Knowledge. If there isn't enough information to score confidently, say so in "missingInformation", keep confidence "low", and recommend "qualifying" or "pending" rather than guessing "qualified"/"disqualified".`;

/**
 * Scores a lead against its campaign's ICP, this business's real Business
 * Knowledge, and any research on file, and explains why. The result is
 * only ever written to columns whose CHECK constraints already allow it
 * (see QUALIFICATION_STATUSES above) — an out-of-range recommendedStatus
 * fails schema validation before it ever reaches the database.
 */
export async function runLeadQualification(input: LeadQualificationInput): Promise<LeadQualificationResult> {
  const businessKnowledgeText = input.businessContext ? formatBusinessContext(input.businessContext) : null;

  const userPrompt = [
    "=== BUSINESS KNOWLEDGE (authoritative — see system prompt) ===",
    businessKnowledgeText ?? "No Business Knowledge is on file for this organization yet.",
    "",
    "=== LEAD ===",
    `Lead name: ${input.leadName}`,
    `Company: ${input.companyName ?? "unknown"}`,
    `Current status: ${input.currentStatus}`,
    `Current score: ${input.currentScore ?? "not yet scored"}`,
    `Existing research summary: ${input.researchSummary ?? "none on file"}`,
    `Campaign objective: ${input.campaignObjective ?? "unknown"}`,
    "",
    "=== CAMPAIGN ICP (separate from Business Knowledge above — who this campaign targets) ===",
    input.icpCriteria ? JSON.stringify(input.icpCriteria) : "none on file",
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "lead_qualification",
    taskType: "LEAD_QUALIFICATION",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 700,
    temperature: 0.3,
    responseFormat: "json",
  });

  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  const parsed = parseAiJson(result.text, LeadQualificationSchema);
  if (!parsed.ok) {
    return { ok: false, message: "The AI qualification result couldn't be validated — please try again." };
  }

  return { ok: true, qualification: parsed.data };
}

// ---------------------------------------------------------------------------
// Discovery-time qualification.
//
// Same job as runLeadQualification above and it writes to the same columns,
// but it scores a whole discovery run in ONE request instead of one request
// per lead. That is not a stylistic choice: the configured models run on a
// per-minute token allowance, and a freshly discovered run of a dozen leads
// scored individually exceeds it several times over, so per-lead scoring
// simply fails at this point in the pipeline.
//
// It is deliberately the shallower of the two. It sees the discovery
// evidence — source URL and the excerpt the business was found in — but no
// research, because none exists yet. runLeadQualification remains the
// deeper pass a user runs per lead once Lead Research has something to say.
// ---------------------------------------------------------------------------

export const DiscoveryAssessmentSchema = z.object({
  companyName: z.string(),
  qualificationScore: z.number().min(0).max(100),
  confidence: z.enum(["low", "medium", "high"]),
  recommendedStatus: z.enum(QUALIFICATION_STATUSES),
  positiveReasons: z.array(z.string()),
  negativeReasons: z.array(z.string()),
});

const DiscoveryQualificationSchema = z.object({ assessments: z.array(DiscoveryAssessmentSchema) });

export type DiscoveryAssessment = z.infer<typeof DiscoveryAssessmentSchema>;

export type DiscoveryQualificationInput = {
  organizationId: string;
  campaignObjective: string | null;
  icpCriteria: Record<string, unknown> | null;
  /** Seller-side Business Knowledge — what the business offers, never who to look for. */
  businessContext: BusinessContext | null;
  prospects: {
    companyName: string;
    location: string | null;
    industry: string | null;
    website: string | null;
    sourceUrl: string;
    evidenceSnippet: string;
  }[];
};

export type DiscoveryQualificationResult =
  | { ok: true; assessments: DiscoveryAssessment[] }
  | { ok: false; message: string };

const DISCOVERY_QUALIFICATION_SYSTEM_PROMPT = `You triage freshly discovered prospects for a business, deciding which are genuinely worth pursuing. For each prospect you are given its name, where it was found, and the exact excerpt it was found in — plus BUSINESS KNOWLEDGE (what this business sells) and the campaign's IDEAL CUSTOMER PROFILE (who it wants as customers). These are two different things: judge each prospect on BOTH — could this organisation plausibly buy what the business sells, and does it match who the campaign is targeting?

Respond with ONLY a single JSON object — no markdown fences, no commentary — with exactly this key:
{
  "assessments": [
    {
      "companyName": string,
      "qualificationScore": number (0-100),
      "confidence": "low" | "medium" | "high",
      "recommendedStatus": "pending" | "qualifying" | "qualified" | "disqualified",
      "positiveReasons": string[],
      "negativeReasons": string[]
    }
  ]
}

Return exactly one assessment per prospect given, using its companyName verbatim so it can be matched back. Keep reasons short — one clause each, at most two per list.

How to decide:
- "disqualified" — the prospect plainly contradicts the ICP (wrong location, wrong kind of organisation, matches a stated disqualifier), or is a competitor/supplier of what this business sells, or is not a real trading organisation at all.
- "qualified" — the evidence positively supports both the ICP and a plausible need for what the business sells.
- "qualifying" — a real, plausible business that fits on the face of it but where the evidence is too thin to be sure. Discovery evidence is usually just a directory line, so this will often be the honest answer.
- "pending" — you cannot tell anything at all.

Every reason must trace back to the given evidence, the ICP or Business Knowledge. Never invent a fact about a prospect — no revenue, staff count, website condition or need that the excerpt does not show. Not knowing something is a reason for "qualifying" and low confidence, never a reason to invent it.`;

/** Scores every prospect from one discovery run in a single request. Never invents a prospect: assessments are matched back by name, and an unmatched one is ignored by the caller. */
export async function runDiscoveryQualification(input: DiscoveryQualificationInput): Promise<DiscoveryQualificationResult> {
  if (input.prospects.length === 0) return { ok: true, assessments: [] };

  const businessKnowledgeText = input.businessContext ? formatBusinessContext(input.businessContext) : null;

  const prospectLines = input.prospects
    .map((p, i) =>
      [
        `${i + 1}. ${p.companyName}`,
        `   location: ${p.location ?? "unknown"} | industry: ${p.industry ?? "unknown"} | website: ${p.website ?? "unknown"}`,
        `   found at: ${p.sourceUrl}`,
        `   evidence: ${p.evidenceSnippet.slice(0, 220)}`,
      ].join("\n")
    )
    .join("\n\n");

  const userPrompt = [
    "=== BUSINESS KNOWLEDGE (what this business sells — not a prospect) ===",
    businessKnowledgeText ? businessKnowledgeText.slice(0, 900) : "No Business Knowledge is on file for this organization yet.",
    `Campaign objective: ${input.campaignObjective ?? "unknown"}`,
    "",
    "=== CAMPAIGN ICP (who this campaign wants as customers) ===",
    input.icpCriteria ? JSON.stringify(input.icpCriteria) : "none on file",
    "",
    `=== DISCOVERED PROSPECTS (${input.prospects.length}) ===`,
    prospectLines,
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "lead_qualification_discovery",
    taskType: "LEAD_QUALIFICATION",
    systemPrompt: DISCOVERY_QUALIFICATION_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 2600,
    temperature: 0.2,
    responseFormat: "json",
  });

  if (!result.ok) return { ok: false, message: result.message };

  const parsed = parseAiJson(result.text, DiscoveryQualificationSchema);
  if (!parsed.ok) {
    return { ok: false, message: "The AI qualification result couldn't be validated — please try again." };
  }

  return { ok: true, assessments: parsed.data.assessments };
}
