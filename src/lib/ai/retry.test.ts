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
});
