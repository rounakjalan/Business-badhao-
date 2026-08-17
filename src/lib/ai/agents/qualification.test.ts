import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { runLeadQualification, QUALIFICATION_STATUSES } from "@/lib/ai/agents/qualification";

const VALID_QUALIFICATION = {
  qualificationScore: 78,
  fitScore: 80,
  intentScore: 60,
  confidence: "medium",
  positiveReasons: ["matches ICP industry"],
  negativeReasons: ["no budget signal yet"],
  missingInformation: ["company size"],
  recommendedStatus: "qualifying",
};

const baseInput = {
  organizationId: "org-1",
  leadName: "Priya Sharma",
  companyName: "Sharma Retailers",
  currentStatus: "new",
  currentScore: null,
  researchSummary: null,
  icpCriteria: null,
  campaignObjective: "Book demo calls",
};

describe("runLeadQualification", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a validated qualification on success", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify(VALID_QUALIFICATION),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runLeadQualification(baseInput);
    expect(result).toEqual({ ok: true, qualification: VALID_QUALIFICATION });
  });

  it("only ever recommends a status the leads.qualification_status column actually accepts", () => {
    expect(QUALIFICATION_STATUSES).toEqual(["pending", "qualifying", "qualified", "disqualified"]);
  });

  it("rejects a recommendedStatus outside the schema's allowed values", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_QUALIFICATION, recommendedStatus: "HIGH_INTENT" }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runLeadQualification(baseInput);
    expect(result.ok).toBe(false);
  });

  it("rejects an out-of-range score", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ ...VALID_QUALIFICATION, qualificationScore: 150 }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await runLeadQualification(baseInput);
    expect(result.ok).toBe(false);
  });

  it("propagates a Hermes-level failure", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "timeout", message: "The AI provider took too long to respond. Try again." });
    const result = await runLeadQualification(baseInput);
    expect(result).toEqual({ ok: false, message: "The AI provider took too long to respond. Try again." });
  });
});
