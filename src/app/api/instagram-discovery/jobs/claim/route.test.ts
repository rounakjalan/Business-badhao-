import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instagram-discovery/connection", () => ({ isInstagramDiscoveryRuntimeConfigured: vi.fn() }));
vi.mock("@/lib/instagram-discovery/jobs", () => ({ claimNextInstagramDiscoveryJob: vi.fn() }));

import { isInstagramDiscoveryRuntimeConfigured } from "@/lib/instagram-discovery/connection";
import { claimNextInstagramDiscoveryJob } from "@/lib/instagram-discovery/jobs";
import { POST } from "@/app/api/instagram-discovery/jobs/claim/route";

const URL = "https://business-badhao.example.com/api/instagram-discovery/jobs/claim";
const ORIGINAL_ENV = { ...process.env };

function claimRequest(headers: Record<string, string> = {}) {
  return new Request(URL, { method: "POST", headers });
}

describe("POST /api/instagram-discovery/jobs/claim", () => {
  afterEach(() => {
    vi.resetAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports not_configured (503) when no runtime token exists for this deployment", async () => {
    delete process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(false);

    const response = await POST(claimRequest());

    expect(response.status).toBe(503);
    expect(claimNextInstagramDiscoveryJob).not.toHaveBeenCalled();
  });

  it("rejects a request with no/wrong bearer token", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);

    const response = await POST(claimRequest({ authorization: "Bearer wrong-secret" }));

    expect(response.status).toBe(401);
    expect(claimNextInstagramDiscoveryJob).not.toHaveBeenCalled();
  });

  it("returns job: null (not an error) when nothing is pending", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(claimNextInstagramDiscoveryJob).mockResolvedValue(null);

    const response = await POST(claimRequest({ authorization: "Bearer real-runtime-secret" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, job: null });
  });

  it("returns a real claimed search job's fields, scoped to its own organization", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(claimNextInstagramDiscoveryJob).mockResolvedValue({
      id: "job-1",
      organizationId: "org-1",
      type: "search",
      query: "retail shops Jaipur",
      browserProfileRef: "org-1",
    });

    const response = await POST(claimRequest({ authorization: "Bearer real-runtime-secret" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      job: { id: "job-1", organizationId: "org-1", type: "search", query: "retail shops Jaipur", browserProfileRef: "org-1" },
    });
  });

  it("returns a real claimed verify job with no query field", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(claimNextInstagramDiscoveryJob).mockResolvedValue({
      id: "job-2",
      organizationId: "org-1",
      type: "verify",
      browserProfileRef: "org-1",
    });

    const response = await POST(claimRequest({ authorization: "Bearer real-runtime-secret" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, job: { id: "job-2", organizationId: "org-1", type: "verify", browserProfileRef: "org-1" } });
  });

  it("never echoes the runtime token back in any response", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);

    const response = await POST(claimRequest({ authorization: "Bearer wrong-secret" }));
    const text = await response.text();

    expect(text).not.toContain("real-runtime-secret");
  });
});
