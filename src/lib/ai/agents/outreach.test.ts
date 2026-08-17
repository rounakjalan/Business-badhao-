import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { generateOutreach } from "@/lib/ai/agents/outreach";

const VALID_DRAFT = {
  subject: null,
  message: "Hi Priya, following up on Sharma Retailers' online presence — happy to share a few quick ideas.",
  talkingPoints: ["online visibility"],
  personalizationUsed: ["company name"],
};

const baseInput = {
  organizationId: "org-1",
  leadName: "Priya Sharma",
  companyName: "Sharma Retailers",
  channel: "whatsapp",
  campaignName: "Q1 Push",
  campaignObjective: "Book demo calls",
  researchSummary: null,
  qualificationReasons: [],
};

describe("generateOutreach", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns a validated draft on success", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify(VALID_DRAFT),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await generateOutreach(baseInput);
    expect(result).toEqual({ ok: true, draft: VALID_DRAFT });
  });

  it("rejects a response missing the required message field", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({
      ok: true,
      text: JSON.stringify({ subject: null, talkingPoints: [], personalizationUsed: [] }),
      provider: "openrouter",
      model: "nousresearch/hermes-4-70b",
    });

    const result = await generateOutreach(baseInput);
    expect(result.ok).toBe(false);
  });

  it("propagates a Hermes-level failure", async () => {
    vi.mocked(runHermesCompletion).mockResolvedValue({ ok: false, code: "not_configured", message: "The AI assistant isn't connected yet." });
    const result = await generateOutreach(baseInput);
    expect(result.ok).toBe(false);
  });
});
