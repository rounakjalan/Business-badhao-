import { afterEach, describe, expect, it, vi } from "vitest";
import { extractInstagramUsername, lookupInstagramBusinessProfile } from "@/lib/instagram/business-discovery";

describe("extractInstagramUsername", () => {
  it("extracts the handle from a full profile URL", () => {
    expect(extractInstagramUsername("https://instagram.com/brightpixel")).toBe("brightpixel");
    expect(extractInstagramUsername("https://www.instagram.com/brightpixel/")).toBe("brightpixel");
  });

  it("accepts an already-bare handle, with or without a leading @", () => {
    expect(extractInstagramUsername("brightpixel")).toBe("brightpixel");
    expect(extractInstagramUsername("@brightpixel")).toBe("brightpixel");
  });

  it("rejects a post/reel/explore path — never a business's own handle", () => {
    expect(extractInstagramUsername("https://instagram.com/p/Cabc123/")).toBeNull();
    expect(extractInstagramUsername("https://instagram.com/reel/Cxyz456/")).toBeNull();
    expect(extractInstagramUsername("https://instagram.com/explore/tags/webdesign/")).toBeNull();
  });

  it("rejects an empty or unusable value", () => {
    expect(extractInstagramUsername("")).toBeNull();
    expect(extractInstagramUsername("   ")).toBeNull();
  });
});

describe("lookupInstagramBusinessProfile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a real, verified public profile on success — never inventing a field the API didn't return", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            business_discovery: {
              username: "brightpixel",
              name: "Bright Pixel Studio",
              biography: "Web design studio in Pune.",
              category: "Design agency",
              followers_count: 4200,
              media_count: 310,
              website: "https://brightpixel.in",
              profile_picture_url: "https://example.com/pic.jpg",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const result = await lookupInstagramBusinessProfile({ accessToken: "tok", igBusinessAccountId: "1789", username: "brightpixel" });

    expect(result).toEqual({
      ok: true,
      profile: {
        username: "brightpixel",
        name: "Bright Pixel Studio",
        biography: "Web design studio in Pune.",
        category: "Design agency",
        followersCount: 4200,
        mediaCount: 310,
        website: "https://brightpixel.in",
        profilePictureUrl: "https://example.com/pic.jpg",
      },
    });
  });

  it("reports 'not_found' for a private account or one that isn't a professional account — a real, expected negative result, not a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "Unsupported get request.", code: 100 } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const result = await lookupInstagramBusinessProfile({ accessToken: "tok", igBusinessAccountId: "1789", username: "someprivateaccount" });
    expect(result).toEqual({ ok: false, code: "not_found", message: "Unsupported get request." });
  });

  it("classifies Instagram's own rate-limit error code as 'rate_limited', isolated from a genuine failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "Application request limit reached", code: 4 } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    const result = await lookupInstagramBusinessProfile({ accessToken: "tok", igBusinessAccountId: "1789", username: "brightpixel" });
    expect(result).toEqual({ ok: false, code: "rate_limited", message: "Application request limit reached" });
  });

  it("never throws on a network failure — reports it as a typed result instead", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND graph.facebook.com");
      })
    );

    const result = await lookupInstagramBusinessProfile({ accessToken: "tok", igBusinessAccountId: "1789", username: "brightpixel" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("network_error");
  });
});
