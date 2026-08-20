import { describe, expect, it } from "vitest";
import { parseLines, parseOptionalString } from "@/lib/form-utils";

describe("parseLines", () => {
  it("splits a multi-line textarea value into a trimmed array", () => {
    expect(parseLines("Free WiFi\nAir conditioning\n24/7 support")).toEqual(["Free WiFi", "Air conditioning", "24/7 support"]);
  });

  it("trims whitespace on each line", () => {
    expect(parseLines("  Free WiFi  \n  Air conditioning  ")).toEqual(["Free WiFi", "Air conditioning"]);
  });

  it("drops blank lines rather than keeping empty strings", () => {
    expect(parseLines("Free WiFi\n\n\nAir conditioning\n")).toEqual(["Free WiFi", "Air conditioning"]);
  });

  it("returns an empty array for null, undefined, or blank input", () => {
    expect(parseLines(null)).toEqual([]);
    expect(parseLines("")).toEqual([]);
    expect(parseLines("   \n  \n")).toEqual([]);
  });
});

describe("parseOptionalString", () => {
  it("returns the trimmed value when present", () => {
    expect(parseOptionalString("  Sunrise Public School  ")).toBe("Sunrise Public School");
  });

  it("normalizes an empty or whitespace-only value to null", () => {
    expect(parseOptionalString("")).toBeNull();
    expect(parseOptionalString("   ")).toBeNull();
  });

  it("normalizes null/undefined to null", () => {
    expect(parseOptionalString(null)).toBeNull();
  });
});
