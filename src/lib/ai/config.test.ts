import { afterEach, describe, expect, it } from "vitest";
import { AiConfigError } from "@/lib/ai/errors";
import { getAiConfig } from "@/lib/ai/config";

const ENV_KEYS = ["AI_PROVIDER", "AI_FALLBACK_PROVIDER", "AI_TIMEOUT_MS", "AI_MAX_RETRIES"] as const;

function clearAiEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

afterEach(() => {
  clearAiEnv();
});

describe("getAiConfig", () => {
  it("defaults to openrouter with no fallback when nothing is set", () => {
    clearAiEnv();
    const config = getAiConfig();
    expect(config.provider).toBe("openrouter");
    expect(config.fallbackProvider).toBeNull();
    expect(config.timeoutMs).toBe(20_000);
    expect(config.maxRetries).toBe(1);
  });

  it("honors an explicit AI_PROVIDER", () => {
    process.env.AI_PROVIDER = "groq";
    expect(getAiConfig().provider).toBe("groq");
  });

  it("rejects an invalid AI_PROVIDER", () => {
    process.env.AI_PROVIDER = "totally-not-a-provider";
    expect(() => getAiConfig()).toThrow(AiConfigError);
  });

  it("accepts a valid fallback provider different from the primary", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.AI_FALLBACK_PROVIDER = "groq";
    const config = getAiConfig();
    expect(config.fallbackProvider).toBe("groq");
  });

  it("rejects a fallback provider equal to the primary", () => {
    process.env.AI_PROVIDER = "openrouter";
    process.env.AI_FALLBACK_PROVIDER = "openrouter";
    expect(() => getAiConfig()).toThrow(AiConfigError);
  });

  it("treats an empty AI_FALLBACK_PROVIDER as no fallback", () => {
    process.env.AI_FALLBACK_PROVIDER = "";
    expect(getAiConfig().fallbackProvider).toBeNull();
  });

  it("parses AI_TIMEOUT_MS and AI_MAX_RETRIES when valid", () => {
    process.env.AI_TIMEOUT_MS = "5000";
    process.env.AI_MAX_RETRIES = "3";
    const config = getAiConfig();
    expect(config.timeoutMs).toBe(5000);
    expect(config.maxRetries).toBe(3);
  });

  it("falls back to defaults for invalid AI_TIMEOUT_MS / AI_MAX_RETRIES", () => {
    process.env.AI_TIMEOUT_MS = "not-a-number";
    process.env.AI_MAX_RETRIES = "-5";
    const config = getAiConfig();
    expect(config.timeoutMs).toBe(20_000);
    expect(config.maxRetries).toBe(1);
  });

  it("allows AI_MAX_RETRIES=0 (no retries)", () => {
    process.env.AI_MAX_RETRIES = "0";
    expect(getAiConfig().maxRetries).toBe(0);
  });
});
