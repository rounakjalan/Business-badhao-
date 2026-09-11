import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// STEP 5: mirrors prospect-research.call-graph.test.ts (Step 4) for
// Qualification. Mocks nothing above the network boundary (fetch), so the
// REAL hermes-service.ts routing — resolveRouting, provider selection,
// retry, and the actual HTTP request — runs for real, for a genuine
// LEAD_QUALIFICATION-taskType call. Proves: a successful Nemotron response
// never touches Groq, a genuine OpenRouter failure really does fall through
// to Groq's real endpoint, and telemetry honestly distinguishes requested
// from actual. No existing test exercised the real routing chain
// specifically for Qualification's own taskType.

const { insertSpy, updateSpy } = vi.hoisted(() => ({ insertSpy: vi.fn(), updateSpy: vi.fn() }));

function fakeTrackingClient() {
  return {
    from: (table: string) => ({
      insert: (payload: unknown) => {
        insertSpy(table, payload);
        return { select: () => ({ single: async () => ({ data: { id: "run-1" }, error: null }) }) };
      },
      update: (payload: unknown) => {
        updateSpy(table, payload);
        return { eq: async () => ({ error: null }) };
      },
    }),
  } as never;
}

import { DEFAULT_OPENROUTER_MODEL } from "@/lib/ai/providers/openrouter";
import { runLeadQualification, type LeadQualificationInput } from "@/lib/ai/agents/qualification";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const baseInput: LeadQualificationInput = {
  organizationId: "org-1",
  leadName: "Priya Sharma",
  companyName: "Sharma Retailers",
  currentStatus: "new",
  currentScore: null,
  researchSummary: "Sharma Retailers operates three stores in Noida.",
  researchFindings: null,
  icpCriteria: null,
  campaignObjective: "Book demo calls",
  businessContext: null,
};

const VALID_QUALIFICATION_BODY = {
  qualificationScore: 70,
  fitScore: 75,
  intentScore: 60,
  confidence: "medium",
  positiveReasons: ["matches ICP"],
  negativeReasons: [],
  missingInformation: [],
  recommendedStatus: "qualifying",
};

function openRouterResponse(body: unknown, model = DEFAULT_OPENROUTER_MODEL) {
  return new Response(
    JSON.stringify({
      id: "req-1",
      model,
      choices: [{ message: { content: JSON.stringify(body) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "AI_PROVIDER", "AI_FALLBACK_PROVIDER", "GROQ_API_KEY", "GROQ_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

describe("real runtime call graph: Qualification -> Hermes -> Nemotron (OpenRouter) -> Groq fallback", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    delete process.env.OPENROUTER_MODEL; // so the default (Nemotron) is what actually gets requested
    delete process.env.AI_PROVIDER; // defaults to "openrouter"
    delete process.env.AI_FALLBACK_PROVIDER;
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_MODEL;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("a successful Nemotron response never invokes Groq, even when Groq is configured as the fallback", async () => {
    process.env.AI_FALLBACK_PROVIDER = "groq";
    process.env.GROQ_API_KEY = "test-groq-key";
    process.env.GROQ_MODEL = "openai/gpt-oss-120b";

    const openRouterCalls: Record<string, unknown>[] = [];
    const groqCalls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (url === OPENROUTER_URL) {
          openRouterCalls.push(body);
          return openRouterResponse(VALID_QUALIFICATION_BODY);
        }
        if (url === GROQ_URL) {
          groqCalls.push(body);
          throw new Error("Groq must never be called when Nemotron succeeds");
        }
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );

    const result = await runLeadQualification({ ...baseInput, client: fakeTrackingClient() });

    expect(result.ok).toBe(true);
    expect(openRouterCalls).toHaveLength(1);
    expect(openRouterCalls[0].model).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(groqCalls).toHaveLength(0);

    const completionUpdate = updateSpy.mock.calls.find(([, payload]) => (payload as { status?: string }).status === "completed");
    expect(completionUpdate?.[1]).toMatchObject({
      output: expect.objectContaining({
        requestedProvider: "openrouter",
        requestedModel: DEFAULT_OPENROUTER_MODEL,
        provider: "openrouter",
        model: DEFAULT_OPENROUTER_MODEL,
        usedFallback: false,
      }),
    });
  });

  it("a genuine OpenRouter/Nemotron failure falls back to Groq's own configured model — and telemetry honestly distinguishes requested (Nemotron/openrouter) from actual (Groq's real model), never mislabeling the fallback as Nemotron", async () => {
    process.env.AI_FALLBACK_PROVIDER = "groq";
    process.env.GROQ_API_KEY = "test-groq-key";
    process.env.GROQ_MODEL = "openai/gpt-oss-120b";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === OPENROUTER_URL) return new Response("internal server error", { status: 500 });
        if (url === GROQ_URL) return openRouterResponse(VALID_QUALIFICATION_BODY, "openai/gpt-oss-120b");
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );

    const result = await runLeadQualification({ ...baseInput, client: fakeTrackingClient() });

    expect(result.ok).toBe(true);

    const completionUpdate = updateSpy.mock.calls.find(([, payload]) => (payload as { status?: string }).status === "completed");
    expect(completionUpdate?.[1]).toMatchObject({
      output: expect.objectContaining({
        requestedProvider: "openrouter",
        requestedModel: DEFAULT_OPENROUTER_MODEL,
        provider: "groq",
        model: "openai/gpt-oss-120b",
        usedFallback: true,
      }),
    });
  });

  it("without a configured fallback, a genuine OpenRouter failure is reported honestly rather than fabricating a result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === OPENROUTER_URL) return new Response("internal server error", { status: 500 });
        throw new Error(`unexpected fetch url: ${url}`);
      })
    );

    const result = await runLeadQualification({ ...baseInput, client: fakeTrackingClient() });

    expect(result.ok).toBe(false);
  });

  it("the full structured Research findings still reach the real request body sent to the provider, unaffected by this routing fix", async () => {
    const researchFindings = {
      companySummary: "Sharma Retailers operates three stores.",
      likelyNeeds: ["Inventory management"],
      possiblePainPoints: ["Manual stock tracking"],
      relevantProductsOrServices: ["POS system"],
      buyingSignals: ["Recently opened a third location"],
      personalizationOpportunities: [],
      potentialObjections: ["May already have a vendor"],
      confidence: "high" as const,
      verifiedInformation: ["Three store locations"],
      businessFactsReferenced: ["POS Package"],
      inferredInformation: ["Likely evaluating vendors"],
      unavailableInformation: ["Current vendor, if any"],
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url !== OPENROUTER_URL) throw new Error(`unexpected fetch url: ${url}`);
        const body = JSON.parse(String(init?.body ?? "{}"));
        const userPrompt = String(body.messages?.[1]?.content ?? "");
        // formatResearchFindings (qualification.ts) deliberately includes only
        // confidence/verifiedInformation/buyingSignals/potentialObjections/
        // inferredInformation/unavailableInformation — not every research field
        // (possiblePainPoints etc. are outreach-drafting inputs, not
        // qualification-fit signals) — asserting on the fields it DOES include.
        expect(userPrompt).toContain("Recently opened a third location");
        expect(userPrompt).toContain("Three store locations");
        expect(userPrompt).toContain("May already have a vendor");
        return openRouterResponse(VALID_QUALIFICATION_BODY);
      })
    );

    const result = await runLeadQualification({ ...baseInput, researchFindings, client: fakeTrackingClient() });

    expect(result.ok).toBe(true);
  });
});
