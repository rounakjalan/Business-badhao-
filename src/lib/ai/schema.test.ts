import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseAiJson } from "@/lib/ai/schema";

const PersonSchema = z.object({ name: z.string(), age: z.number() });

describe("parseAiJson", () => {
  it("parses clean JSON", () => {
    const result = parseAiJson('{"name":"Priya","age":30}', PersonSchema);
    expect(result).toEqual({ ok: true, data: { name: "Priya", age: 30 } });
  });

  it("extracts JSON from a markdown code fence", () => {
    const raw = 'Here is the result:\n```json\n{"name":"Rohit","age":25}\n```\nHope that helps!';
    const result = parseAiJson(raw, PersonSchema);
    expect(result).toEqual({ ok: true, data: { name: "Rohit", age: 25 } });
  });

  it("extracts a bare JSON object surrounded by stray prose", () => {
    const raw = 'Sure, {"name":"Ananya","age":40} is the answer.';
    const result = parseAiJson(raw, PersonSchema);
    expect(result).toEqual({ ok: true, data: { name: "Ananya", age: 40 } });
  });

  it("rejects text with no JSON object at all", () => {
    const result = parseAiJson("I cannot help with that.", PersonSchema);
    expect(result.ok).toBe(false);
  });

  it("rejects malformed JSON", () => {
    const result = parseAiJson("{name: Priya, age: 30}", PersonSchema);
    expect(result.ok).toBe(false);
  });

  it("rejects JSON that doesn't match the schema (wrong type)", () => {
    const result = parseAiJson('{"name":"Priya","age":"thirty"}', PersonSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/expected shape/i);
    }
  });

  it("rejects JSON missing a required field", () => {
    const result = parseAiJson('{"name":"Priya"}', PersonSchema);
    expect(result.ok).toBe(false);
  });
});
