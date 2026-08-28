import { describe, expect, it } from "vitest";
import {
  DEAL_STAGES,
  DEAL_STAGE_LABELS,
  OPEN_DEAL_STAGES,
  isClosedDealStage,
  isDealStage,
  isOpenDealStage,
} from "@/lib/deals";

describe("deal stages", () => {
  it("has exactly the six required stages, in pipeline order", () => {
    expect(DEAL_STAGES).toEqual(["new", "qualified", "proposal", "payment_pending", "won", "lost"]);
  });

  it("has a human label for every stage", () => {
    for (const stage of DEAL_STAGES) {
      expect(DEAL_STAGE_LABELS[stage]).toBeTruthy();
    }
    expect(DEAL_STAGE_LABELS.proposal).toBe("Proposal / Product Info");
    expect(DEAL_STAGE_LABELS.payment_pending).toBe("Payment Pending");
  });

  it("open stages are every stage except Won and Lost", () => {
    expect(OPEN_DEAL_STAGES).toEqual(["new", "qualified", "proposal", "payment_pending"]);
    expect(OPEN_DEAL_STAGES).not.toContain("won");
    expect(OPEN_DEAL_STAGES).not.toContain("lost");
  });

  it("isDealStage accepts only real stages", () => {
    expect(isDealStage("qualified")).toBe(true);
    expect(isDealStage("won")).toBe(true);
    expect(isDealStage("negotiation")).toBe(false);
    expect(isDealStage("open")).toBe(false);
    expect(isDealStage("")).toBe(false);
  });

  it("isOpenDealStage rejects Won and Lost — this is what stops a stage move from closing a deal", () => {
    expect(isOpenDealStage("new")).toBe(true);
    expect(isOpenDealStage("payment_pending")).toBe(true);
    expect(isOpenDealStage("won")).toBe(false);
    expect(isOpenDealStage("lost")).toBe(false);
  });

  it("isClosedDealStage is true only for won/lost", () => {
    expect(isClosedDealStage("won")).toBe(true);
    expect(isClosedDealStage("lost")).toBe(true);
    expect(isClosedDealStage("new")).toBe(false);
    expect(isClosedDealStage("proposal")).toBe(false);
  });
});
