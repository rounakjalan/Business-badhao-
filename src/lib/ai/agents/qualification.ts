import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { formatBusinessContext } from "@/lib/ai/business-context-prompt";
import type { ProspectResearch } from "@/lib/ai/agents/prospect-research-schema";
import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { parseAiJson } from "@/lib/ai/schema";
import type { BusinessContext } from "@/lib/business-context";
import type { Database } from "@/types/database.types";

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
  /**
   * The structured findings from the most recent Lead Research pass on this
   * lead (see prospect-research-schema.ts) — a third, separate context from
   * businessContext (what the business offers) and icpCriteria (who the
   * campaign targets): what was actually discovered about THIS prospect.
   * null when there is no research on file, it hasn't completed, or the
   * stored findings don't parse (e.g. a manually-entered lead_research row)
   * — qualification must work from researchSummary alone in that case, and
   * this field is never consulted by clampWithoutResearchEvidence below,
   * which keys off researchSummary only, so its presence or absence can
   * never change whether the no-research-evidence gate applies.
   */
  researchFindings: ProspectResearch | null;
  /** The campaign's Ideal Customer Profile — kept a fully separate concept from businessContext below; ICP is who the campaign targets, businessContext is what the business actually offers. */
  icpCriteria: Record<string, unknown> | null;
  campaignObjective: string | null;
  /** This organization's relevant Business Knowledge (see selectQualificationContext in src/lib/business-context.ts) — null when none is on file. */
  businessContext: BusinessContext | null;
  /**
   * Forwarded straight through to runHermesCompletion's own `client` (see
   * its doc comment) — omit for a call made inside a real user session;
   * scheduled/cron work (lead-pipeline.ts's qualifyLead) must pass its own
   * service-role client here, the same one it already uses for its own
   * leads writes, or this call's agent_runs/model_usage telemetry is
   * silently rejected by RLS.
   */
  client?: SupabaseClient<Database>;
};

export type LeadQualificationResult =
  | { ok: true; qualification: LeadQualification }
  | { ok: false; message: string };

const SYSTEM_PROMPT = `You are the AI lead-qualification engine inside Business Badhao, a customer-acquisition CRM. Score how well a lead fits THIS BUSINESS and THIS CAMPAIGN, using only the information given: the lead's own record, any research on file, this business's real Business Knowledge (products/services, service area, relevant policies), and the campaign's Ideal Customer Profile criteria if available. Business Knowledge, the campaign's ICP, and Prospect Research are three separate things — Business Knowledge is what the business actually offers, the ICP is who this specific campaign targets, and Prospect Research is what was actually discovered about THIS lead. A lead can fit the ICP but not the business's actual offerings (e.g. outside the service area), or vice versa; consider both. Keep evaluating the lead against the campaign's ICP — research evidence should inform and sharpen that judgment, never substitute for it.

When structured Prospect Research findings are available, treat them as evidence to weigh, not settled fact: only what the research explicitly lists as verified is a verified fact about the prospect. Anything listed as inferred is the research agent's OWN speculation, not confirmed — do not upgrade it to a verified fact just because it appears alongside real evidence, and do not let an unverified buying signal or objection alone justify a confident "qualified"/"disqualified" call. Where research leaves something unresolved, say so in "missingInformation" rather than guessing.

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
 * Only the structured Lead Research fields that actually bear on a
 * fit/intent decision, and that production data shows are reliably
 * populated (see this fix's own report). Deliberately excludes fields
 * already covered elsewhere or not needed here: companySummary duplicates
 * researchSummary above (same value, written from the same source),
 * businessFactsReferenced duplicates businessContext already passed
 * separately, and likelyNeeds/possiblePainPoints/relevantProductsOrServices/
 * personalizationOpportunities are outreach-drafting inputs (see
 * generateOutreach), not qualification-fit signals — repeating them here
 * would just spend tokens without changing the score.
 */
function formatResearchFindings(findings: ProspectResearch | null): string {
  if (!findings) return "No structured research findings on file for this lead yet.";

  return [
    `Research confidence: ${findings.confidence}`,
    findings.verifiedInformation.length > 0
      ? `Verified facts about this prospect (directly evidenced — treat as fact): ${findings.verifiedInformation.join("; ")}`
      : "Verified facts about this prospect: none recorded.",
    findings.buyingSignals.length > 0 ? `Buying signals: ${findings.buyingSignals.join("; ")}` : "Buying signals: none recorded.",
    findings.potentialObjections.length > 0 ? `Potential objections: ${findings.potentialObjections.join("; ")}` : "Potential objections: none recorded.",
    findings.inferredInformation.length > 0
      ? `Inferred by research (the research agent's OWN reasoning, NOT independently verified — weigh cautiously, never treat as fact): ${findings.inferredInformation.join("; ")}`
      : "Inferred information: none recorded.",
    findings.unavailableInformation.length > 0
      ? `What research explicitly could not determine: ${findings.unavailableInformation.join("; ")}`
      : "What research could not determine: nothing flagged as unavailable.",
  ].join("\n");
}

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
    "=== PROSPECT RESEARCH FINDINGS (what was discovered about THIS lead — separate from Business Knowledge and the campaign ICP; distinguish verified facts from inference per the system prompt) ===",
    formatResearchFindings(input.researchFindings),
    "",
    "=== CAMPAIGN ICP (separate from Business Knowledge and Prospect Research above — who this campaign targets) ===",
    input.icpCriteria ? JSON.stringify(input.icpCriteria) : "none on file",
  ].join("\n");

  const result = await runHermesCompletion({
    organizationId: input.organizationId,
    agentType: "lead_qualification",
    taskType: "LEAD_QUALIFICATION",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    // Qualification now always runs *after* Lead Research and receives its
    // findings, so the model has substantially more to weigh and explain
    // than when it scored a bare lead record. Measured: the same lead with
    // no research on file completed in ~270 tokens, while with research the
    // primary model hit the old 700 ceiling every time — truncating
    // mid-document (finishReason "length") so schema validation rejected an
    // otherwise good result. 1600 matches the research agent's budget. A
    // ceiling, not a reservation.
    maxTokens: 1600,
    temperature: 0.3,
    responseFormat: "json",
    client: input.client,
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
