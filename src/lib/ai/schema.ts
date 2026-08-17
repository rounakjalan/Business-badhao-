import type { z } from "zod";

export type AiJsonParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Extracts the first JSON object/array from a model's raw text output and
 * validates it against `schema`. Models asked for JSON still sometimes wrap
 * it in a ```json fence or add a stray sentence before/after — this strips
 * that rather than requiring byte-perfect JSON, but the zod schema is what
 * actually decides whether the *content* is trustworthy. Used by every
 * structured agent (campaign planner, qualification, intent detection,
 * etc.) so "reject invalid AI output" is enforced in exactly one place.
 */
export function parseAiJson<T>(rawText: string, schema: z.ZodType<T>): AiJsonParseResult<T> {
  const candidate = extractJsonCandidate(rawText);
  if (candidate === null) {
    return { ok: false, error: "No JSON object found in the AI response" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(candidate);
  } catch {
    return { ok: false, error: "AI response was not valid JSON" };
  }

  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    return { ok: false, error: `AI response did not match the expected shape: ${result.error.issues.map((i) => i.message).join("; ")}` };
  }

  return { ok: true, data: result.data };
}

function extractJsonCandidate(rawText: string): string | null {
  const trimmed = rawText.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}
