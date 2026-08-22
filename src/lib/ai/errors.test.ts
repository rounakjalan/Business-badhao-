import { describe, expect, it } from "vitest";
import { AiError, parseRetryAfterMs } from "@/lib/ai/errors";

describe("parseRetryAfterMs", () => {
  // The exact shape Groq returns on a tokens-per-minute overage — the case
  // that cost a real discovery run one lead's research.
  it("reads the wait out of a real Groq rate-limit message", () => {
    const message =
      "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` " +
      "on tokens per minute (TPM): Limit 8000, Used 6044, Requested 2291. Please try again in 2.5125s.";
    expect(parseRetryAfterMs(message)).toBe(2513);
  });

  it("handles a millisecond wait", () => {
    expect(parseRetryAfterMs("Please try again in 800ms.")).toBe(800);
  });

  it("rounds up so a retry never fires a hair too early", () => {
    expect(parseRetryAfterMs("try again in 1.0001s")).toBe(1001);
  });

  it("returns undefined when no wait is stated, so the caller keeps its default backoff", () => {
    expect(parseRetryAfterMs("Rate limit reached. Slow down.")).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
  });

  it("ignores a nonsensical wait rather than trusting it", () => {
    expect(parseRetryAfterMs("try again in 0s")).toBeUndefined();
  });
});

describe("AiError", () => {
  it("carries retryAfterMs through when a provider supplies one", () => {
    const err = new AiError({
      code: "rate_limited",
      provider: "groq",
      message: "Please try again in 2.5s.",
      statusCode: 429,
      retryAfterMs: 2500,
    });
    expect(err.retryAfterMs).toBe(2500);
    expect(err.retryable).toBe(true);
  });

  it("leaves retryAfterMs undefined when none was supplied", () => {
    const err = new AiError({ code: "network_error", provider: "openrouter", message: "boom" });
    expect(err.retryAfterMs).toBeUndefined();
  });
});
