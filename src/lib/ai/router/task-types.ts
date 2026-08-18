// The task categories Hermes routes on. This is a superset of what has a
// real agent today (LEAD_DISCOVERY, ICP_GENERATION, CONVERSATION, and
// RECOVERY_ANALYSIS don't have a dedicated Hermes-calling agent yet) —
// defined now so the router and future agents share one vocabulary instead
// of each agent inventing its own ad-hoc label.
export type AiTaskType =
  | "CAMPAIGN_PLANNING"
  | "ICP_GENERATION"
  | "LEAD_DISCOVERY"
  | "PROSPECT_RESEARCH"
  | "LEAD_QUALIFICATION"
  | "OUTREACH_GENERATION"
  | "CONVERSATION"
  | "INTENT_DETECTION"
  | "FOLLOW_UP"
  | "DEAL_ANALYSIS"
  | "LOSS_ANALYSIS"
  | "RECOVERY_ANALYSIS"
  | "GENERAL_CHAT";

export const AI_TASK_TYPES: readonly AiTaskType[] = [
  "CAMPAIGN_PLANNING",
  "ICP_GENERATION",
  "LEAD_DISCOVERY",
  "PROSPECT_RESEARCH",
  "LEAD_QUALIFICATION",
  "OUTREACH_GENERATION",
  "CONVERSATION",
  "INTENT_DETECTION",
  "FOLLOW_UP",
  "DEAL_ANALYSIS",
  "LOSS_ANALYSIS",
  "RECOVERY_ANALYSIS",
  "GENERAL_CHAT",
];
