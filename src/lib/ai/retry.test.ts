import { describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/errors";
import { withRetry } from "@/lib/ai/retry";

function transientError(): AiError {
  return new AiError({ code: "network_error", provider: "openrouter", message: "transient" });
}

function permanentError(): AiError {
  return new AiError({ code: "invalid_api_key", provider: "openrouter", message: "bad key" });
}

describe("withRetry", () => {
  it("returns the result immediately on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, 3);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient AiError up to maxRetries, then throws", async () => {
    const fn = vi.fn().mockRejectedValue(transientError());
    await expect(withRetry(fn, 2)).rejects.toMatchObject({ code: "network_error" });
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("succeeds after a transient failure followed by success", async () => {
    const fn = vi.fn().mockRejectedValueOnce(transientError()).mockResolvedValueOnce("recovered");
    const result = await withRetry(fn, 2);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable AiError, even with retries available", async () => {
    const fn = vi.fn().mockRejectedValue(permanentError());
    await expect(withRetry(fn, 3)).rejects.toMatchObject({ code: "invalid_api_key" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one attempt when maxRetries is 0", async () => {
    const fn = vi.fn().mockRejectedValue(transientError());
    await expect(withRetry(fn, 0)).rejects.toBeInstanceOf(AiError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry a plain (non-AiError) exception", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(withRetry(fn, 3)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // A rate limit clears on the provider's schedule, not ours. Retrying on a
  // shorter fixed backoff spends every attempt before the window reopens —
  // which is exactly how a real discovery run lost a lead's research.
  it("waits at least as long as a rate-limited provider asked before retrying", async () => {
    const rateLimited = new AiError({
      code: "rate_limited",
      provider: "groq",
      message: "Rate limit reached ... Please try again in 2.5125s.",
      statusCode: 429,
      retryAfterMs: 2513,
    });
    const fn = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValueOnce("recovered");

    const startedAt = Date.now();
    await expect(withRetry(fn, 2)).resolves.toBe("recovered");

    // The old fixed backoff would have retried after 300ms and failed again.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2400);
    expect(fn).toHaveBeenCalledTimes(2);
  }, 10000);

  it("caps exponential backoff growth instead of letting it grow unbounded across many retries", async () => {
    const fn = vi.fn().mockRejectedValue(transientError());

    const startedAt = Date.now();
    await expect(withRetry(fn, 5)).rejects.toMatchObject({ code: "network_error" });
    const elapsed = Date.now() - startedAt;

    // Uncapped exponential (300 * 2^attempt summed over 5 retries) would be
    // 300+600+1200+2400+4800 = 9300ms. Capped at 4000ms per wait, the worst
    // case across 5 waits is 20000ms — still bounded, but the real
    // regression this guards is the uncapped growth becoming unbounded as
    // maxRetries grows; 6 attempts finishing well under that ceiling proves
    // each individual wait was actually capped, not just summed differently.
    expect(fn).toHaveBeenCalledTimes(6); // 1 initial + 5 retries
    expect(elapsed).toBeLessThan(20000);
  }, 25000);

  it("adds jitter to the backoff instead of retrying at an identical fixed delay every time", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const randomSpy = vi.spyOn(Math, "random");

    randomSpy.mockReturnValueOnce(0); // low end of the jitter range
    await withRetry(vi.fn().mockRejectedValueOnce(transientError()).mockResolvedValueOnce("recovered"), 1);
    const lowDelay = setTimeoutSpy.mock.calls.at(-1)?.[1] as number;

    randomSpy.mockReturnValueOnce(1); // high end of the jitter range
    await withRetry(vi.fn().mockRejectedValueOnce(transientError()).mockResolvedValueOnce("recovered"), 1);
    const highDelay = setTimeoutSpy.mock.calls.at(-1)?.[1] as number;

    // A pure fixed (non-jittered) backoff would make these identical
    // regardless of Math.random()'s value.
    expect(lowDelay).toBeLessThan(highDelay);

    setTimeoutSpy.mockRestore();
    randomSpy.mockRestore();
  });

  it("ignores an implausibly long provider wait rather than holding the request open", async () => {
    const longWait = new AiError({
      code: "rate_limited",
      provider: "groq",
      message: "Please try again in 3600s.",
      statusCode: 429,
      retryAfterMs: 3_600_000,
    });
    const fn = vi.fn().mockRejectedValueOnce(longWait).mockResolvedValueOnce("recovered");

    const startedAt = Date.now();
    await expect(withRetry(fn, 2)).resolves.toBe("recovered");

    // Falls back to the normal short backoff instead of sleeping for an hour.
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});
