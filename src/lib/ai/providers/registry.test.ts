import { afterEach, describe, expect, it } from "vitest";
import { GroqProvider } from "@/lib/ai/providers/groq";
import { HuggingFaceProvider } from "@/lib/ai/providers/huggingface";
import { OpenRouterProvider } from "@/lib/ai/providers/openrouter";
import { createProvider } from "@/lib/ai/providers/registry";

const ENV_KEYS = ["OPENROUTER_API_KEY", "HUGGINGFACE_API_KEY", "HUGGINGFACE_MODEL", "GROQ_API_KEY", "GROQ_MODEL"] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("createProvider", () => {
  it("returns an OpenRouterProvider for 'openrouter'", () => {
    expect(createProvider("openrouter")).toBeInstanceOf(OpenRouterProvider);
  });

  it("returns a HuggingFaceProvider for 'huggingface'", () => {
    expect(createProvider("huggingface")).toBeInstanceOf(HuggingFaceProvider);
  });

  it("returns a GroqProvider for 'groq'", () => {
    expect(createProvider("groq")).toBeInstanceOf(GroqProvider);
  });
});

describe("provider.isConfigured()", () => {
  it("OpenRouter is configured once OPENROUTER_API_KEY is set", () => {
    expect(new OpenRouterProvider().isConfigured()).toBe(false);
    process.env.OPENROUTER_API_KEY = "test-key";
    expect(new OpenRouterProvider().isConfigured()).toBe(true);
  });

  it("Hugging Face requires BOTH api key and model to be configured", () => {
    expect(new HuggingFaceProvider().isConfigured()).toBe(false);
    process.env.HUGGINGFACE_API_KEY = "test-key";
    expect(new HuggingFaceProvider().isConfigured()).toBe(false);
    process.env.HUGGINGFACE_MODEL = "some/model";
    expect(new HuggingFaceProvider().isConfigured()).toBe(true);
  });

  it("Groq requires BOTH api key and model to be configured, with no hard-coded default model", () => {
    expect(new GroqProvider().isConfigured()).toBe(false);
    process.env.GROQ_API_KEY = "test-key";
    expect(new GroqProvider().isConfigured()).toBe(false);
    process.env.GROQ_MODEL = "some-model";
    expect(new GroqProvider().isConfigured()).toBe(true);
  });
});
