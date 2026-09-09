import { afterEach, describe, expect, it, vi } from "vitest";
import { getProviderCooldownMs, recordProviderRateLimit, resetRateLimitGuard } from "@/lib/ai/rate-limit-guard";

describe("rate-limit-guard", () => {
  afterEach(() => {
    resetRateLimitGuard();
    vi.useRealTimers();
  });

  it("reports no cooldown for a provider that has never been rate-limited", () => {
    expect(getProviderCooldownMs("groq")).toBe(0);
  });

  it("reports a positive cooldown immediately after a rate limit is recorded, honoring the provider's own stated wait", () => {
    recordProviderRateLimit("groq", 1000);
    const remaining = getProviderCooldownMs("groq");
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(1000);
  });

  it("falls back to a sane default cooldown when no retryAfterMs was given", () => {
    recordProviderRateLimit("groq");
    expect(getProviderCooldownMs("groq")).toBeGreaterThan(0);
  });

  it("caps an implausibly long provider-stated wait rather than stalling every sibling call for it", () => {
    recordProviderRateLimit("groq", 3_600_000);
    // Bounded short — never the full hour a provider might ask for.
    expect(getProviderCooldownMs("groq")).toBeLessThanOrEqual(3000);
  });

  it("never shortens an existing cooldown when a smaller wait is recorded afterward", () => {
    recordProviderRateLimit("groq", 2500);
    recordProviderRateLimit("groq", 10);
    // A second, shorter failure right after the first must not cut the
    // cooldown down to ~10ms — the longer one already in effect still wins.
    expect(getProviderCooldownMs("groq")).toBeGreaterThan(1000);
  });

  it("tracks providers independently — a groq cooldown never affects openrouter or huggingface", () => {
    recordProviderRateLimit("groq", 2000);
    expect(getProviderCooldownMs("openrouter")).toBe(0);
    expect(getProviderCooldownMs("huggingface")).toBe(0);
  });

  it("expires on its own once enough real time has passed", async () => {
    vi.useFakeTimers();
    recordProviderRateLimit("groq", 50);
    expect(getProviderCooldownMs("groq")).toBeGreaterThan(0);
    vi.advanceTimersByTime(200);
    expect(getProviderCooldownMs("groq")).toBe(0);
  });

  it("resetRateLimitGuard clears every recorded cooldown — the test-isolation escape hatch", () => {
    recordProviderRateLimit("groq", 2000);
    recordProviderRateLimit("openrouter", 2000);
    resetRateLimitGuard();
    expect(getProviderCooldownMs("groq")).toBe(0);
    expect(getProviderCooldownMs("openrouter")).toBe(0);
  });
});
