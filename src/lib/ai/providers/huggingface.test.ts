import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HuggingFaceProvider } from "@/lib/ai/providers/huggingface";
import type { AiCompletionRequest } from "@/lib/ai/types";

const baseRequest: AiCompletionRequest = { messages: [{ role: "user", content: "hi" }] };

describe("HuggingFaceProvider", () => {
  beforeEach(() => {
    delete process.env.HUGGINGFACE_API_KEY;
    delete process.env.HUGGINGFACE_MODEL;
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    delete process.env.HUGGINGFACE_API_KEY;
    delete process.env.HUGGINGFACE_MODEL;
    vi.unstubAllGlobals();
  });

  it("is not configured when neither variable is set", () => {
    expect(new HuggingFaceProvider().isConfigured()).toBe(false);
  });

  it("is not configured with only an API key and no model — Business Badhao never guesses a default HF model", () => {
    process.env.HUGGINGFACE_API_KEY = "hf-key";
    expect(new HuggingFaceProvider().isConfigured()).toBe(false);
  });

  it("throws not_configured rather than calling fetch when unconfigured", async () => {
    const provider = new HuggingFaceProvider();
    await expect(provider.complete(baseRequest)).rejects.toMatchObject({ code: "not_configured", provider: "huggingface" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls the HF OpenAI-compatible router with the configured model once both are set", async () => {
    process.env.HUGGINGFACE_API_KEY = "hf-key";
    process.env.HUGGINGFACE_MODEL = "meta-llama/Llama-3.1-8B-Instruct";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "hello from hf" } }] }), { status: 200 })
    );

    const response = await new HuggingFaceProvider().complete(baseRequest);

    expect(response.text).toBe("hello from hf");
    expect(response.provider).toBe("huggingface");

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://router.huggingface.co/v1/chat/completions");
    expect((init as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe("Bearer hf-key");
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.model).toBe("meta-llama/Llama-3.1-8B-Instruct");
  });
});
