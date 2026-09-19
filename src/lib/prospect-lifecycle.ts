/**
 * The Prospects page's lifecycle stages are a presentation-only view over
 * two columns that already exist on `leads` — research_status and
 * qualification_status (see database.types.ts and qualification.ts /
 * lead-pipeline.ts) — never a second, competing status system. This module
 * is the one place that mapping happens, so the UI and any future caller
 * agree on it.
 *
 * The mapping, in priority order (most specific/terminal signal first):
 *
 * - "qualified" / "disqualified": qualification_status already holds one of
 *   these two terminal verdicts.
 * - "needs_review": qualification_status is "qualifying" — the qualification
 *   agent's OWN considered recommendation when it cannot confidently qualify
 *   or disqualify (see clampWithoutResearchEvidence and the system prompt in
 *   qualification.ts: "recommend 'qualifying' ... rather than guessing"),
 *   not a transient "in progress" state. A failed research pass is folded in
 *   here too — the AI never got real evidence to qualify from, which is a
 *   different (and equally real) reason a prospect needs a human look, not
 *   a fabricated bucket invented to hide missing data.
 * - "researching": research_status is "researching" — the AI is actively
 *   working on this prospect right now.
 * - "new": everything else — research_status is "pending" (genuinely not
 *   started), or the rare transient window where research just completed
 *   but qualification has not run yet.
 */

export type ProspectStage = "new" | "researching" | "qualified" | "disqualified" | "needs_review";

export type ProspectStageInputs = {
  qualificationStatus: "pending" | "qualifying" | "qualified" | "disqualified";
  researchStatus: "pending" | "researching" | "completed" | "failed";
};

export function classifyProspectStage({ qualificationStatus, researchStatus }: ProspectStageInputs): ProspectStage {
  if (qualificationStatus === "qualified") return "qualified";
  if (qualificationStatus === "disqualified") return "disqualified";
  if (qualificationStatus === "qualifying") return "needs_review";
  if (researchStatus === "failed") return "needs_review";
  if (researchStatus === "researching") return "researching";
  return "new";
}

export const PROSPECT_STAGE_ORDER: ProspectStage[] = ["new", "researching", "qualified", "disqualified", "needs_review"];

export const PROSPECT_STAGE_LABEL: Record<ProspectStage, string> = {
  new: "New",
  researching: "Researching",
  qualified: "Qualified",
  disqualified: "Disqualified",
  needs_review: "Needs Review",
};

export const PROSPECT_STAGE_ICON: Record<ProspectStage, string> = {
  new: "🔵",
  researching: "🟡",
  qualified: "🟢",
  disqualified: "🔴",
  needs_review: "⚪",
};

export function countProspectStages(stages: ProspectStage[]): Record<ProspectStage, number> {
  const counts: Record<ProspectStage, number> = { new: 0, researching: 0, qualified: 0, disqualified: 0, needs_review: 0 };
  for (const stage of stages) counts[stage] += 1;
  return counts;
}
