import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instagram-discovery/connection", () => ({ isInstagramDiscoveryRuntimeConfigured: vi.fn() }));
vi.mock("@/lib/instagram-discovery/jobs", () => ({ getInstagramDiscoveryQueueStats: vi.fn() }));

import { isInstagramDiscoveryRuntimeConfigured } from "@/lib/instagram-discovery/connection";
import { getInstagramDiscoveryQueueStats } from "@/lib/instagram-discovery/jobs";
import { GET } from "@/app/api/instagram-discovery/jobs/status/route";

const URL = "https://business-badhao.example.com/api/instagram-discovery/jobs/status";
const ORIGINAL_ENV = { ...process.env };

function statusRequest(headers: Record<string, string> = {}) {
  return new Request(URL, { method: "GET", headers });
}

describe("GET /api/instagram-discovery/jobs/status", () => {
  afterEach(() => {
    vi.resetAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports not_configured (503) when no runtime token exists for this deployment", async () => {
    delete process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(false);

    const response = await GET(statusRequest());

    expect(response.status).toBe(503);
    expect(getInstagramDiscoveryQueueStats).not.toHaveBeenCalled();
  });

  it("rejects a request with no/wrong bearer token", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);

    const response = await GET(statusRequest({ authorization: "Bearer wrong-secret" }));

    expect(response.status).toBe(401);
    expect(getInstagramDiscoveryQueueStats).not.toHaveBeenCalled();
  });

  it("returns real, safe-for-monitoring aggregate counts", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(getInstagramDiscoveryQueueStats).mockResolvedValue({
      pending: 2,
      claimed: 1,
      completedLast24h: 10,
      failedLast24h: 1,
      expiredLast24h: 0,
    });

    const response = await GET(statusRequest({ authorization: "Bearer real-runtime-secret" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, queue: { pending: 2, claimed: 1, completedLast24h: 10, failedLast24h: 1, expiredLast24h: 0 } });
  });

  it("never echoes the runtime token back in any response", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);

    const response = await GET(statusRequest({ authorization: "Bearer wrong-secret" }));
    const text = await response.text();

    expect(text).not.toContain("real-runtime-secret");
  });
});
