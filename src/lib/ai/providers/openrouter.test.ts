import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiError } from "@/lib/ai/errors";
import { DEFAULT_OPENROUTER_MODEL, OpenRouterProvider } from "@/lib/ai/providers/openrouter";
import type { AiCompletionRequest } from "@/lib/ai/types";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const baseRequest: AiCompletionRequest = {
  messages: [
    { role: "system", content: "system" },
    { role: "user", content: "hello" },
  ],
};

describe("OpenRouterProvider", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    delete process.env.OPENROUTER_MODEL;
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
    vi.unstubAllGlobals();
  });

  it("is not configured without an API key", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(new OpenRouterProvider().isConfigured()).toBe(false);
  });

  it("throws not_configured instead of calling fetch when the API key is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const provider = new OpenRouterProvider();
    await expect(provider.complete(baseRequest)).rejects.toMatchObject({ code: "not_configured" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the default Nemotron 3 Ultra free model when OPENROUTER_MODEL is unset", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        id: "req-1",
        model: DEFAULT_OPENROUTER_MODEL,
        choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
    );

    const response = await new OpenRouterProvider().complete(baseRequest);

    expect(response.text).toBe("hi there");
    expect(response.provider).toBe("openrouter");
    expect(response.model).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(response.requestId).toBe("req-1");

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.model).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it("respects an explicit OPENROUTER_MODEL override", async () => {
    process.env.OPENROUTER_MODEL = "nousresearch/hermes-3-llama-3.1-70b";
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, { choices: [{ message: { content: "ok" } }] })
    );

    await new OpenRouterProvider().complete(baseRequest);

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.model).toBe("nousresearch/hermes-3-llama-3.1-70b");
  });

  it.each([
    [401, "invalid_api_key"],
    [403, "invalid_api_key"],
    [404, "model_not_found"],
    [429, "rate_limited"],
    [500, "provider_unavailable"],
    [503, "provider_unavailable"],
    [418, "unknown"],
  ] as const)("maps HTTP %i to AiError code %s", async (status, expectedCode) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("provider error body", { status }));

    await expect(new OpenRouterProvider().complete(baseRequest)).rejects.toMatchObject({
      code: expectedCode,
      provider: "openrouter",
    });
  });

  it("maps a network failure to network_error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("fetch failed"));
    await expect(new OpenRouterProvider().complete(baseRequest)).rejects.toMatchObject({ code: "network_error" });
  });

  it("maps an AbortSignal timeout to a timeout error", async () => {
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    vi.mocked(fetch).mockRejectedValueOnce(timeoutError);
    await expect(new OpenRouterProvider().complete(baseRequest)).rejects.toMatchObject({ code: "timeout" });
  });

  it("treats an empty completion as a malformed response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { choices: [{ message: { content: "" } }] }));
    await expect(new OpenRouterProvider().complete(baseRequest)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("treats unparsable JSON as a malformed response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not json", { status: 200 }));
    await expect(new OpenRouterProvider().complete(baseRequest)).rejects.toBeInstanceOf(AiError);
  });

  it("normalizes tool calls when the model returns them", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "call_1", function: { name: "lookup_lead", arguments: '{"leadId":"123"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      })
    );

    const response = await new OpenRouterProvider().complete(baseRequest);
    expect(response.toolCalls).toEqual([{ id: "call_1", name: "lookup_lead", arguments: '{"leadId":"123"}' }]);
    expect(response.finishReason).toBe("tool_calls");
  });
});
