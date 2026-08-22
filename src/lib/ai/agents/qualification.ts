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

  const hasResearchEvidence = Boolean(input.researchSummary && input.researchSummary.trim().length > 0);
  return { ok: true, qualification: clampWithoutResearchEvidence(parsed.data, hasResearchEvidence) };
}

/**
 * A final "qualified"/"disqualified" verdict must be backed by real Lead
 * Research evidence, not just discovery-time signals — the model is told
 * this in the system prompt, but that is advisory, not a guarantee. This is
 * the deterministic backstop: without research on file, any such verdict is
 * held at "qualifying" rather than being written to the lead as final.
 */
export function clampWithoutResearchEvidence(qualification: LeadQualification, hasResearchEvidence: boolean): LeadQualification {
  if (hasResearchEvidence) return qualification;
  if (qualification.recommendedStatus !== "qualified" && qualification.recommendedStatus !== "disqualified") return qualification;

  return {
    ...qualification,
    recommendedStatus: "qualifying",
    missingInformation: [
      ...qualification.missingInformation,
      'No Lead Research evidence yet — recommendation held at "qualifying" until research completes.',
    ],
  };
}
