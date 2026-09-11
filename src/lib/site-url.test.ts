import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSiteUrl } from "@/lib/site-url";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.VERCEL_URL;
}

describe("getSiteUrl — the mechanism password-reset emails rely on to avoid localhost in production", () => {
  beforeEach(resetEnv);
  afterEach(resetEnv);

  it("prefers NEXT_PUBLIC_SITE_URL when set, over a deployed VERCEL_URL", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://business-badhao.vercel.app";
    process.env.VERCEL_URL = "some-other-deployment.vercel.app";
    expect(getSiteUrl()).toBe("https://business-badhao.vercel.app");
  });

  it("strips trailing slashes from an explicit NEXT_PUBLIC_SITE_URL", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://business-badhao.vercel.app///";
    expect(getSiteUrl()).toBe("https://business-badhao.vercel.app");
  });

  it("treats a blank/whitespace-only NEXT_PUBLIC_SITE_URL as unset and falls through", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "   ";
    process.env.VERCEL_URL = "my-app.vercel.app";
    expect(getSiteUrl()).toBe("https://my-app.vercel.app");
  });

  it("falls back to https://VERCEL_URL when NEXT_PUBLIC_SITE_URL is not set", () => {
    process.env.VERCEL_URL = "business-badhao.vercel.app";
    expect(getSiteUrl()).toBe("https://business-badhao.vercel.app");
  });

  it("never returns localhost when either production env var is set", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://business-badhao.vercel.app";
    expect(getSiteUrl()).not.toContain("localhost");

    delete process.env.NEXT_PUBLIC_SITE_URL;
    process.env.VERCEL_URL = "business-badhao.vercel.app";
    expect(getSiteUrl()).not.toContain("localhost");
  });

  it("falls back to localhost only when neither production env var is set (local dev)", () => {
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });
});
