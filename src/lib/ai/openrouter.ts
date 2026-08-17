// Server-only. Never import this from a Client Component — it reads
// OPENROUTER_API_KEY, which must never reach the browser bundle.

const OPENROUTER_MODEL = "nousresearch/hermes-4-70b";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export type AiCompletionResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Calls Hermes 4 70B via OpenRouter. Returns a discriminated result instead
 * of throwing — callers run this from on-demand user actions (e.g. clicking
 * "Ask AI"), not from a path every request goes through, so a missing key
 * or a provider outage should degrade to a friendly message, never a crash.
 */
export async function generateAiCompletion(prompt: string, systemPrompt: string): Promise<AiCompletionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "not_configured" };
  }

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Business Badhao",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        max_tokens: 200,
        temperature: 0.6,
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}` };
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      return { ok: false, reason: "empty_response" };
    }

    return { ok: true, text };
  } catch {
    return { ok: false, reason: "network_error" };
  }
}
