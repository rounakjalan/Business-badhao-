import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instagram-discovery/connection", () => ({
  applyInstagramDiscoveryRuntimeReport: vi.fn(),
  isInstagramDiscoveryRuntimeConfigured: vi.fn(),
}));

import { applyInstagramDiscoveryRuntimeReport, isInstagramDiscoveryRuntimeConfigured } from "@/lib/instagram-discovery/connection";
import { POST } from "@/app/api/instagram-discovery/session-report/route";

const URL = "https://business-badhao.example.com/api/instagram-discovery/session-report";
const ORIGINAL_ENV = { ...process.env };

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("POST /api/instagram-discovery/session-report", () => {
  afterEach(() => {
    vi.resetAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports not_configured (503) honestly when no runtime token exists for this deployment — never silently accepts", async () => {
    delete process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(false);

    const response = await POST(postRequest({ organizationId: "org-1", status: "connected" }));

    expect(response.status).toBe(503);
    expect(applyInstagramDiscoveryRuntimeReport).not.toHaveBeenCalled();
  });

  it("rejects a request with no/wrong bearer token — 401, never processes the report", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);

    const response = await POST(postRequest({ organizationId: "org-1", status: "connected" }, { authorization: "Bearer wrong-secret" }));

    expect(response.status).toBe(401);
    expect(applyInstagramDiscoveryRuntimeReport).not.toHaveBeenCalled();
  });

  it("rejects a request with no Authorization header at all", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);

    const response = await POST(postRequest({ organizationId: "org-1", status: "connected" }));

    expect(response.status).toBe(401);
  });

  it("accepts a correctly authenticated, valid report and applies it", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(applyInstagramDiscoveryRuntimeReport).mockResolvedValue({ ok: true });

    const response = await POST(
      postRequest({ organizationId: "org-1", status: "connected", username: "biz_official" }, { authorization: "Bearer real-runtime-secret" })
    );

    expect(response.status).toBe(200);
    expect(applyInstagramDiscoveryRuntimeReport).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", status: "connected", username: "biz_official" })
    );
  });

  it("rejects a malformed body (invalid status enum) without calling apply", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);

    const response = await POST(postRequest({ organizationId: "org-1", status: "totally_made_up" }, { authorization: "Bearer real-runtime-secret" }));

    expect(response.status).toBe(400);
    expect(applyInstagramDiscoveryRuntimeReport).not.toHaveBeenCalled();
  });

  it("surfaces a genuine no_pending_connection rejection as 404, never fabricating success", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);
    vi.mocked(applyInstagramDiscoveryRuntimeReport).mockResolvedValue({ ok: false, code: "no_pending_connection", message: "no pending connection" });

    const response = await POST(postRequest({ organizationId: "org-never-requested", status: "connected" }, { authorization: "Bearer real-runtime-secret" }));

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it("never echoes the runtime token back in any response", async () => {
    process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN = "real-runtime-secret";
    vi.mocked(isInstagramDiscoveryRuntimeConfigured).mockReturnValue(true);

    const response = await POST(postRequest({ organizationId: "org-1", status: "connected" }, { authorization: "Bearer wrong-secret" }));
    const text = await response.text();

    expect(text).not.toContain("real-runtime-secret");
  });
});
