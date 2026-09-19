import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// This file tests exactly one thing: the GATING logic in
// TavilyDiscoveryProvider.discover() that decides whether a real
// InstagramDiscoveryTool is constructed and handed to HermesLeadDiscoveryAgent
// as an additionalSearchTool — never whether Instagram discovery itself
// "works" (that would require a real Hermes browser runtime and a real
// Instagram account, neither of which exist in a unit test). See
// discovery.test.ts for the pre-existing, unmodified Tavily/Exa coverage —
// none of it should be affected by this wiring (verified by the "unaffected
// when the runtime isn't configured" tests below).

vi.mock("@/lib/ai/hermes/hermes-service", () => ({ runHermesCompletion: vi.fn() }));
vi.mock("@/lib/instagram-discovery/connection", () => ({ getInstagramDiscoveryConnectionStatus: vi.fn() }));
vi.mock("@/lib/instagram-discovery/instagram-discovery-tool", () => ({ InstagramDiscoveryTool: vi.fn() }));

import { runHermesCompletion } from "@/lib/ai/hermes/hermes-service";
import { getInstagramDiscoveryConnectionStatus } from "@/lib/instagram-discovery/connection";
import { InstagramDiscoveryTool } from "@/lib/instagram-discovery/instagram-discovery-tool";
import { TavilyDiscoveryProvider, type DiscoveryCriteria } from "@/lib/ai/agents/discovery";

const baseCriteria: DiscoveryCriteria = {
  organizationId: "org-1",
  campaignName: "Jaipur Retail Push",
  campaignObjective: "Book demo calls with boutique owners",
  icpCriteria: { location: "Jaipur", industry: "Retail" },
  businessContext: null,
};

function queuePassthroughHermesCalls() {
  vi.mocked(runHermesCompletion)
    .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ queries: ["retail stores in Jaipur"] }), provider: "openrouter", model: "m" })
    .mockResolvedValueOnce({ ok: true, text: JSON.stringify({ prospects: [] }), provider: "openrouter", model: "m" })
    .mockResolvedValue({ ok: true, text: JSON.stringify({ accepted: [] }), provider: "openrouter", model: "m" });
}

const ORIGINAL_TOKEN = process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
const ORIGINAL_TAVILY_KEY = process.env.TAVILY_API_KEY;

describe("TavilyDiscoveryProvider.discover — Instagram additionalSearchTools gating", () => {
  beforeEach(() => {
    process.env.TAVILY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    if (ORIGINAL_TOKEN === undefined) delete process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
    else process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = ORIGINAL_TOKEN;
    if (ORIGINAL_TAVILY_KEY === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = ORIGINAL_TAVILY_KEY;
  });

  it("never constructs InstagramDiscoveryTool or checks connection status when no runtime token is configured for this deployment", async () => {
    delete process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
    queuePassthroughHermesCalls();

    await new TavilyDiscoveryProvider().discover(baseCriteria);

    expect(getInstagramDiscoveryConnectionStatus).not.toHaveBeenCalled();
    expect(InstagramDiscoveryTool).not.toHaveBeenCalled();
  });

  it("checks connection status but never constructs the tool for an organization that hasn't connected", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "runtime-secret";
    vi.mocked(getInstagramDiscoveryConnectionStatus).mockResolvedValue({
      status: "not_connected",
      connectedUsername: null,
      lastError: null,
      requestedAt: null,
      lastVerifiedAt: null,
    });
    queuePassthroughHermesCalls();

    await new TavilyDiscoveryProvider().discover(baseCriteria);

    expect(getInstagramDiscoveryConnectionStatus).toHaveBeenCalledWith("org-1");
    expect(InstagramDiscoveryTool).not.toHaveBeenCalled();
  });

  it("constructs a real InstagramDiscoveryTool, scoped to this organization, once its connection reports connected", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "runtime-secret";
    vi.mocked(getInstagramDiscoveryConnectionStatus).mockResolvedValue({
      status: "connected",
      connectedUsername: "biz_official",
      lastError: null,
      requestedAt: null,
      lastVerifiedAt: null,
    });
    const searchMock = vi.fn().mockResolvedValue({ ok: true, results: [] });
    vi.mocked(InstagramDiscoveryTool).mockImplementation(function (this: unknown, organizationId: string) {
      return { name: "instagram", search: searchMock, organizationId } as never;
    } as never);
    queuePassthroughHermesCalls();

    await new TavilyDiscoveryProvider().discover(baseCriteria);

    expect(InstagramDiscoveryTool).toHaveBeenCalledTimes(1);
    expect(InstagramDiscoveryTool).toHaveBeenCalledWith("org-1");
    expect(searchMock).toHaveBeenCalledWith("retail stores in Jaipur", expect.anything());
  });

  it("also constructs the tool when the connection reports 'ready' (an already-authenticated profile, not just a fresh login)", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "runtime-secret";
    vi.mocked(getInstagramDiscoveryConnectionStatus).mockResolvedValue({
      status: "ready",
      connectedUsername: "biz_official",
      lastError: null,
      requestedAt: null,
      lastVerifiedAt: null,
    });
    vi.mocked(InstagramDiscoveryTool).mockImplementation(function () {
      return { name: "instagram", search: vi.fn().mockResolvedValue({ ok: true, results: [] }) } as never;
    } as never);
    queuePassthroughHermesCalls();

    await new TavilyDiscoveryProvider().discover(baseCriteria);

    expect(InstagramDiscoveryTool).toHaveBeenCalledTimes(1);
  });

  it("a failing/timed-out Instagram tool never fails the overall discovery run — Tavily's own results still succeed", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "runtime-secret";
    vi.mocked(getInstagramDiscoveryConnectionStatus).mockResolvedValue({
      status: "connected",
      connectedUsername: "biz_official",
      lastError: null,
      requestedAt: null,
      lastVerifiedAt: null,
    });
    vi.mocked(InstagramDiscoveryTool).mockImplementation(function () {
      return { name: "instagram", search: vi.fn().mockResolvedValue({ ok: false, message: "runtime did not respond in time" }) } as never;
    } as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ results: [{ title: "Sharma Boutique", url: "https://sharmaboutique.example/about", content: "A retail store in Jaipur." }] }),
          { status: 200 }
        )
      )
    );
    queuePassthroughHermesCalls();

    const result = await new TavilyDiscoveryProvider().discover(baseCriteria);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.queriesFailed).toEqual([]);
  });
});
