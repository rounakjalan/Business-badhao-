import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/instagram-discovery/jobs", () => ({
  createInstagramDiscoveryJob: vi.fn(),
  pollInstagramDiscoveryJobResult: vi.fn(),
}));

import { createInstagramDiscoveryJob, pollInstagramDiscoveryJobResult } from "@/lib/instagram-discovery/jobs";
import { InstagramDiscoveryTool } from "@/lib/instagram-discovery/instagram-discovery-tool";

describe("InstagramDiscoveryTool", () => {
  afterEach(() => vi.resetAllMocks());

  it("dispatches a real job scoped to its own organization for the exact query it was asked to search", async () => {
    vi.mocked(createInstagramDiscoveryJob).mockResolvedValue({ jobId: "job-1" });
    vi.mocked(pollInstagramDiscoveryJobResult).mockResolvedValue({ ok: true, candidates: [] });

    const tool = new InstagramDiscoveryTool("org-1", 1000);
    await tool.search("boutique clothing shops Jaipur");

    expect(createInstagramDiscoveryJob).toHaveBeenCalledWith("org-1", "boutique clothing shops Jaipur");
    expect(pollInstagramDiscoveryJobResult).toHaveBeenCalledWith("job-1", 1000);
  });

  it("maps only real, runtime-reported fields into SearchHit — never fabricating a bio", async () => {
    vi.mocked(createInstagramDiscoveryJob).mockResolvedValue({ jobId: "job-1" });
    vi.mocked(pollInstagramDiscoveryJobResult).mockResolvedValue({
      ok: true,
      candidates: [
        {
          username: "biz_official",
          profileUrl: "https://www.instagram.com/biz_official/",
          displayName: "Biz Official Store",
          bio: "Handmade boutique clothing in Jaipur",
          category: "Clothing (Brand)",
          externalUrl: "https://bizofficial.example",
        },
        { username: "no_bio_account", profileUrl: "https://www.instagram.com/no_bio_account/" },
      ],
    });

    const tool = new InstagramDiscoveryTool("org-1", 1000);
    const result = await tool.search("boutique clothing shops Jaipur");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.results).toHaveLength(2);

    expect(result.results[0]).toEqual({
      title: "Biz Official Store",
      url: "https://www.instagram.com/biz_official/",
      content: "Handmade boutique clothing in Jaipur | Category: Clothing (Brand) | Link: https://bizofficial.example",
      source: "instagram",
    });

    // No real fields reported for this candidate — content honestly says so, never invents a bio.
    expect(result.results[1]).toEqual({
      title: "@no_bio_account",
      url: "https://www.instagram.com/no_bio_account/",
      content: "Instagram business account @no_bio_account",
      source: "instagram",
    });
  });

  it("reports an honest failure without fabricating results when the job can't even be dispatched", async () => {
    vi.mocked(createInstagramDiscoveryJob).mockResolvedValue(null);

    const tool = new InstagramDiscoveryTool("org-1", 1000);
    const result = await tool.search("q");

    expect(result).toEqual({ ok: false, message: expect.stringContaining("Could not dispatch") });
    expect(pollInstagramDiscoveryJobResult).not.toHaveBeenCalled();
  });

  it("passes through the runtime's own real failure/timeout message rather than fabricating a result", async () => {
    vi.mocked(createInstagramDiscoveryJob).mockResolvedValue({ jobId: "job-1" });
    vi.mocked(pollInstagramDiscoveryJobResult).mockResolvedValue({ ok: false, message: "The Instagram discovery runtime did not respond within the allotted time." });

    const tool = new InstagramDiscoveryTool("org-1", 1000);
    const result = await tool.search("q");

    expect(result).toEqual({ ok: false, message: "The Instagram discovery runtime did not respond within the allotted time." });
  });
});
