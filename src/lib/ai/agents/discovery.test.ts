import { describe, expect, it } from "vitest";
import { getDiscoveryProvider, NullDiscoveryProvider } from "@/lib/ai/agents/discovery";

describe("lead discovery", () => {
  it("has no configured discovery source by default — never fabricates prospects", async () => {
    const provider = getDiscoveryProvider();
    expect(provider).toBeInstanceOf(NullDiscoveryProvider);
    expect(provider.isConfigured()).toBe(false);

    const result = await provider.discover({ organizationId: "org-1", icpCriteria: null, location: null, limit: 10 });

    expect(result).toEqual({
      ok: false,
      code: "not_configured",
      message: "Lead discovery isn't connected to a data source yet.",
    });
  });
});
