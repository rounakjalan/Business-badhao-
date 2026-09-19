import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instagram-discovery/connection", () => ({ isInstagramDiscoveryRuntimeConfigured: vi.fn() }));
vi.mock("@/lib/instagram-discovery/jobs", () => ({ completeInstagramDiscoveryJob: vi.fn() }));

import { isInstagramDiscoveryRuntimeConfigured } from "@/lib/instagram-discovery/connection";
import { completeInstagramDiscoveryJob } from "@/lib/instagram-discovery/jobs";
import { POST } from "@/app/api/instagram-discovery/jobs/complete/route";

const URL = "https://business-badhao.example.com/api/instagram-discovery/jobs/complete";
const ORIGINAL_ENV = { ...process.env };

function completeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("POST /api/instagram-discovery/jobs/complete", () => {
  afterEach(() => {
    vi.resetAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports not_configured (503) when no runtime token exists for this deployment", async () => {
    delete process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(false);

    const response = await POST(completeRequest({ jobId: "job-1", status: "completed", candidates: [] }));

    expect(response.status).toBe(503);
    expect(completeInstagramDiscoveryJob).not.toHaveBeenCalled();
  });

  it("rejects a request with no/wrong bearer token", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);

    const response = await POST(completeRequest({ jobId: "job-1", status: "completed", candidates: [] }, { authorization: "Bearer wrong" }));

    expect(response.status).toBe(401);
    expect(completeInstagramDiscoveryJob).not.toHaveBeenCalled();
  });

  it("accepts a real completed report with structured candidates", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(completeInstagramDiscoveryJob).mockResolvedValue({ ok: true });

    const candidates = [{ username: "biz_official", profileUrl: "https://www.instagram.com/biz_official/", bio: "A real bio" }];
    const response = await POST(completeRequest({ jobId: "job-1", status: "completed", candidates }, { authorization: "Bearer real-runtime-secret" }));

    expect(response.status).toBe(200);
    expect(completeInstagramDiscoveryJob).toHaveBeenCalledWith({ jobId: "job-1", status: "completed", candidates });
  });

  it("accepts a real failure report and never requires fabricated candidates for it", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(completeInstagramDiscoveryJob).mockResolvedValue({ ok: true });

    const response = await POST(
      completeRequest({ jobId: "job-1", status: "failed", error: "Instagram session expired" }, { authorization: "Bearer real-runtime-secret" })
    );

    expect(response.status).toBe(200);
    expect(completeInstagramDiscoveryJob).toHaveBeenCalledWith({ jobId: "job-1", status: "failed", error: "Instagram session expired" });
  });

  it("rejects a completed report with no candidates array at all", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);

    const response = await POST(completeRequest({ jobId: "job-1", status: "completed" }, { authorization: "Bearer real-runtime-secret" }));

    expect(response.status).toBe(400);
    expect(completeInstagramDiscoveryJob).not.toHaveBeenCalled();
  });

  it("surfaces a genuine not_claimed rejection as 404, never fabricating success", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(completeInstagramDiscoveryJob).mockResolvedValue({ ok: false, code: "not_claimed", message: "not claimed" });

    const response = await POST(
      completeRequest({ jobId: "job-1", status: "completed", candidates: [] }, { authorization: "Bearer real-runtime-secret" })
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);
  });

  it("never echoes the runtime token back in any response", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);

    const response = await POST(completeRequest({ jobId: "job-1", status: "completed", candidates: [] }, { authorization: "Bearer wrong" }));
    const text = await response.text();

    expect(text).not.toContain("real-runtime-secret");
  });
});
