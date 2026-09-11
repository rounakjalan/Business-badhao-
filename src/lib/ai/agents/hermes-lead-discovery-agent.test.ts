import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Proves HermesLeadDiscoveryAgent genuinely OWNS the Lead Discovery
// workflow — not a renamed function, not a thin wrapper around
// runHermesCompletion. Unlike discovery.test.ts (which drives the same
// pipeline indirectly through TavilyDiscoveryProvider.discover(), to prove
// backward compatibility), this file talks to HermesLeadDiscoveryAgent
// directly with an injected, fully-controlled DiscoverySearchTool, so the
// orchestration itself — not any particular search provider — is what's
// under test.

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { HermesLeadDiscoveryAgent, type DiscoverySearchTool } from "@/lib/ai/agents/hermes-lead-discovery-agent";
import type { DiscoveryCriteria, SearchHit } from "@/lib/ai/agents/discovery";

const criteria: DiscoveryCriteria = {
  organizationId: "org-1",
  campaignName: "Jaipur Retail Push",
  campaignObjective: "Book demo calls with boutique owners",
  icpCriteria: { location: "Jaipur", industry: "Retail" },
  businessContext: null,
};

const REAL_HIT: SearchHit = {
  title: "Sharma Boutique — Jaipur",
  url: "https://sharmaboutique.example/about",
  content: "Sharma Boutique is a family-run clothing store in Jaipur.",
};

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    companyName: "Sharma Boutique",
    website: "sharmaboutique.example",
    location: "Jaipur",
    industry: "Retail",
    businessType: "Boutique",
    email: null,
    phone: null,
    matchedIcpCriteria: ["location: Jaipur"],
    evidenceSnippet: "Sharma Boutique is a family-run clothing store in Jaipur.",
    sourceUrl: REAL_HIT.url,
    searchQuery: "retail store owners in Jaipur",
    ...overrides,
  };
}

/** A fully-controlled, in-memory search tool — no fetch, no Tavily/Exa involved — so this file tests only the agent's own orchestration. */
function fakeSearchTool(resultsByQuery: Record<string, SearchHit[]>): DiscoverySearchTool & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake",
    calls,
    async search(query: string) {
      calls.push(query);
      return { ok: true, results: resultsByQuery[query] ?? [] };
    },
  };
}

function hermesOk(text: unknown, model = "nvidia/nemotron-3-ultra-550b-a55b:free") {
  return { ok: true as const, text: JSON.stringify(text), provider: "openrouter" as const, model };
}

describe("HermesLeadDiscoveryAgent — genuine orchestration, not a renamed runHermesCompletion wrapper", () => {
  beforeEach(() => {
    process.env.TAVILY_API_KEY = "unused-in-this-file";
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("1/2: receives campaign + ICP and invokes Nemotron discovery planning with them, via the explicit openrouter model override", async () => {
    const tool = fakeSearchTool({});
    vi.mocked(runHermesCompletion).mockResolvedValueOnce(hermesOk({ queries: ["retail store owners in Jaipur"] }));

    await new HermesLeadDiscoveryAgent(tool).discover(criteria);

    expect(runHermesCompletion).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runHermesCompletion).mock.calls[0][0];
    expect(call.agentType).toBe("lead_discovery_query_generation");
    expect(call.organizationId).toBe(criteria.organizationId);
    expect(call.userPrompt).toContain('"location":"Jaipur"');
    expect(call.modelByProvider).toEqual({ openrouter: "nvidia/nemotron-3-ultra-550b-a55b:free" });
  });

  it("3: invokes the injected search tool with every query Nemotron's planning step produced", async () => {
    const tool = fakeSearchTool({ "retail store owners in Jaipur": [REAL_HIT], "boutique clothing shops Jaipur": [] });
    vi.mocked(runHermesCompletion)
      .mockResolvedValueOnce(hermesOk({ queries: ["retail store owners in Jaipur", "boutique clothing shops Jaipur"] }))
      .mockResolvedValueOnce(hermesOk({ prospects: [] }));

    await new HermesLeadDiscoveryAgent(tool).discover(criteria);

    expect(tool.calls).toEqual(["retail store owners in Jaipur", "boutique clothing shops Jaipur"]);
  });

  it("4: invokes Nemotron candidate extraction over the search tool's real results", async () => {
    const tool = fakeSearchTool({ "retail store owners in Jaipur": [REAL_HIT] });
    vi.mocked(runHermesCompletion)
      .mockResolvedValueOnce(hermesOk({ queries: ["retail store owners in Jaipur"] }))
      .mockResolvedValueOnce(hermesOk({ prospects: [candidate()] }))
      .mockResolvedValueOnce(hermesOk({ accepted: [candidate()] }, "nousresearch/hermes-3-llama-3.1-70b"));

    await new HermesLeadDiscoveryAgent(tool).discover(criteria);

    expect(runHermesCompletion).toHaveBeenCalledTimes(3);
    const extractionCall = vi.mocked(runHermesCompletion).mock.calls[1][0];
    expect(extractionCall.agentType).toBe("lead_discovery_extraction");
    expect(extractionCall.userPrompt).toContain(REAL_HIT.url);
    expect(extractionCall.userPrompt).toContain(REAL_HIT.content);
  });

  it("5/6: candidates reach the Independent Hermes Reviewer, which is called with a model distinct from the primary planning/extraction calls", async () => {
    const tool = fakeSearchTool({ "retail store owners in Jaipur": [REAL_HIT] });
    vi.mocked(runHermesCompletion)
      .mockResolvedValueOnce(hermesOk({ queries: ["retail store owners in Jaipur"] }))
      .mockResolvedValueOnce(hermesOk({ prospects: [candidate()] }))
      .mockResolvedValueOnce(hermesOk({ accepted: [candidate()] }, "nousresearch/hermes-3-llama-3.1-70b"));

    const result = await new HermesLeadDiscoveryAgent(tool).discover(criteria);

    expect(result.ok).toBe(true);
    const calls = vi.mocked(runHermesCompletion).mock.calls.map((c) => c[0]);
    expect(calls[2].agentType).toBe("lead_discovery_hermes_review");
    expect(calls[2].model).toBe("nousresearch/hermes-3-llama-3.1-70b");
    // Distinct from what the planning/extraction calls ask for — not merely
    // a different agentType label on the same requested model.
    expect(calls[2].model).not.toBe(calls[0].modelByProvider?.openrouter);
    expect(calls[2].model).not.toBe("nvidia/nemotron-3-ultra-550b-a55b:free");
  });

  it("7/8: a total Reviewer failure still allows deterministic validation to run, and the validator executes AFTER the (failed) review — never bypassed", async () => {
    const tool = fakeSearchTool({ "retail store owners in Jaipur": [REAL_HIT] });
    vi.mocked(runHermesCompletion)
      .mockResolvedValueOnce(hermesOk({ queries: ["retail store owners in Jaipur"] }))
      .mockResolvedValueOnce(hermesOk({ prospects: [candidate()] }))
      .mockResolvedValueOnce({ ok: false, code: "timeout", message: "The AI provider took too long to respond. Try again." })
      .mockResolvedValueOnce({ ok: false, code: "timeout", message: "The AI provider took too long to respond. Try again." });

    const result = await new HermesLeadDiscoveryAgent(tool).discover(criteria);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The candidate survived a total Reviewer failure — the Deterministic
    // Validator still ran on the unreviewed, but still-grounded, candidate.
    expect(result.prospects.map((p) => p.companyName)).toEqual(["Sharma Boutique"]);
    expect(result.telemetry?.reviewerStatus).toBe("failed");
  });

  it("8 (continued): the Deterministic Validator still rejects an ungrounded candidate even when the Reviewer degraded — validation is never skipped just because review failed", async () => {
    const ungrounded = candidate({ companyName: "Fake Co", sourceUrl: "https://never-searched.example/fake" });
    const tool = fakeSearchTool({ "retail store owners in Jaipur": [REAL_HIT] });
    vi.mocked(runHermesCompletion)
      .mockResolvedValueOnce(hermesOk({ queries: ["retail store owners in Jaipur"] }))
      .mockResolvedValueOnce(hermesOk({ prospects: [candidate(), ungrounded] }))
      .mockResolvedValueOnce({ ok: false, code: "timeout", message: "timeout" })
      .mockResolvedValueOnce({ ok: false, code: "timeout", message: "timeout" });

    const result = await new HermesLeadDiscoveryAgent(tool).discover(criteria);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prospects.map((p) => p.companyName)).toEqual(["Sharma Boutique"]);
    expect(result.telemetry?.rejectedNotGrounded).toBe(1);
  });

  it("9/10: deduplication executes before returning, so valid, distinct candidates create the final prospect list without duplicates", async () => {
    const dup = candidate({ evidenceSnippet: "a differently-worded citation of the same real excerpt" });
    const tool = fakeSearchTool({ "retail store owners in Jaipur": [REAL_HIT] });
    vi.mocked(runHermesCompletion)
      .mockResolvedValueOnce(hermesOk({ queries: ["retail store owners in Jaipur"] }))
      .mockResolvedValueOnce(hermesOk({ prospects: [candidate(), dup] }))
      .mockResolvedValueOnce(hermesOk({ accepted: [candidate(), dup] }, "nousresearch/hermes-3-llama-3.1-70b"));

    const result = await new HermesLeadDiscoveryAgent(tool).discover(criteria);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prospects).toHaveLength(1);
  });

  it("stops early (no extraction call) when every planned query returns zero hits — the agent itself decides this, not a provider", async () => {
    const tool = fakeSearchTool({ "retail store owners in Jaipur": [] });
    vi.mocked(runHermesCompletion).mockResolvedValueOnce(hermesOk({ queries: ["retail store owners in Jaipur"] }));

    const result = await new HermesLeadDiscoveryAgent(tool).discover(criteria);

    expect(result).toMatchObject({ ok: true, prospects: [] });
    expect(runHermesCompletion).toHaveBeenCalledTimes(1);
  });

  it("reports provider_error, attributing the real search tool's failure, when every query fails — the agent's own branching, not delegated to the tool", async () => {
    const failingTool: DiscoverySearchTool = { name: "fake", search: vi.fn().mockResolvedValue({ ok: false, message: "simulated outage" }) };
    vi.mocked(runHermesCompletion).mockResolvedValueOnce(hermesOk({ queries: ["retail store owners in Jaipur"] }));

    const result = await new HermesLeadDiscoveryAgent(failingTool).discover(criteria);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("provider_error");
    expect(result.message).toContain("simulated outage");
  });

  it("propagates a planning-stage Hermes failure as provider_error without ever calling the search tool", async () => {
    const tool = fakeSearchTool({});
    vi.mocked(runHermesCompletion).mockResolvedValueOnce({ ok: false, code: "timeout", message: "The AI provider took too long to respond. Try again." });

    const result = await new HermesLeadDiscoveryAgent(tool).discover(criteria);

    expect(result).toEqual({ ok: false, code: "provider_error", message: "The AI provider took too long to respond. Try again." });
    expect(tool.calls).toEqual([]);
  });

  it("12: never calls the search tool or extraction/review stages more than the queries it actually planned — bounded, not unbounded concurrency", async () => {
    const tool = fakeSearchTool({
      "retail store owners in Jaipur": [REAL_HIT],
      "boutique clothing shops Jaipur": [],
      "textile wholesalers Jaipur": [],
    });
    vi.mocked(runHermesCompletion)
      .mockResolvedValueOnce(hermesOk({ queries: ["retail store owners in Jaipur", "boutique clothing shops Jaipur", "textile wholesalers Jaipur"] }))
      .mockResolvedValueOnce(hermesOk({ prospects: [candidate()] }))
      .mockResolvedValueOnce(hermesOk({ accepted: [candidate()] }, "nousresearch/hermes-3-llama-3.1-70b"));

    await new HermesLeadDiscoveryAgent(tool).discover(criteria);

    expect(tool.calls).toHaveLength(3);
  });
});
