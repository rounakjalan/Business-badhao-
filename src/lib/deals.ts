export type DealStage = "new" | "qualified" | "proposal" | "payment_pending" | "won" | "lost";

/** All six stages, in pipeline order. */
export const DEAL_STAGES: readonly DealStage[] = ["new", "qualified", "proposal", "payment_pending", "won", "lost"];

/** The stages a deal can sit in before it's closed either way. */
export const OPEN_DEAL_STAGES: readonly DealStage[] = ["new", "qualified", "proposal", "payment_pending"];

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  new: "New",
  qualified: "Qualified",
  proposal: "Proposal / Product Info",
  payment_pending: "Payment Pending",
  won: "Won",
  lost: "Lost",
};

export function isDealStage(value: string): value is DealStage {
  return (DEAL_STAGES as readonly string[]).includes(value);
}

export function isOpenDealStage(value: string): value is (typeof OPEN_DEAL_STAGES)[number] {
  return (OPEN_DEAL_STAGES as readonly string[]).includes(value);
}

export function isClosedDealStage(value: string): boolean {
  return value === "won" || value === "lost";
}
