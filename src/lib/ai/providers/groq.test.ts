import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroqProvider } from "@/lib/ai/providers/groq";
import type { AiCompletionRequest } from "@/lib/ai/types";

const baseRequest: AiCompletionRequest = { messages: [{ role: "user", content: "hi" }] };

describe("GroqProvider", () => {
  beforeEach(() => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_MODEL;
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_MODEL;
    vi.unstubAllGlobals();
  });

  it("is not configured when neither variable is set", () => {
    expect(new GroqProvider().isConfigured()).toBe(false);
  });

  it("is not configured with only an API key — no hard-coded default model", () => {
    process.env.GROQ_API_KEY = "groq-key";
    expect(new GroqProvider().isConfigured()).toBe(false);
  });

  it("throws not_configured rather than calling fetch when unconfigured", async () => {
    await expect(new GroqProvider().complete(baseRequest)).rejects.toMatchObject({ code: "not_configured", provider: "groq" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls Groq's OpenAI-compatible API with the configured model once both are set", async () => {
    process.env.GROQ_API_KEY = "groq-key";
    process.env.GROQ_MODEL = "llama-3.3-70b-versatile";
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "hello from groq" } }] }), { status: 200 })
    );

    const response = await new GroqProvider().complete(baseRequest);

    expect(response.text).toBe("hello from groq");
    expect(response.provider).toBe("groq");

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.model).toBe("llama-3.3-70b-versatile");
  });
});
