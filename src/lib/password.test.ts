import { describe, expect, it } from "vitest";
import { validateNewPassword } from "@/lib/password";

describe("validateNewPassword", () => {
  it("accepts a matching password/confirmation at the minimum length", () => {
    expect(validateNewPassword("abcdef", "abcdef")).toEqual({ ok: true });
  });

  it("rejects an empty password", () => {
    const result = validateNewPassword("", "abcdef");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty confirmation", () => {
    const result = validateNewPassword("abcdef", "");
    expect(result.ok).toBe(false);
  });

  it("rejects a password shorter than the minimum length", () => {
    const result = validateNewPassword("abc", "abc");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least/i);
  });

  it("rejects a mismatched confirmation", () => {
    const result = validateNewPassword("abcdef", "ghijkl");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/match/i);
  });

  it("checks length before confirmation match, so a too-short mismatched pair reports the length error", () => {
    const result = validateNewPassword("ab", "cd");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least/i);
  });
});
