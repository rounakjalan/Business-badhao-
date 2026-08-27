import { describe, expect, it } from "vitest";
import { normalizePhoneNumber } from "@/lib/whatsapp/phone";

describe("normalizePhoneNumber", () => {
  it("strips a leading + and internal spaces", () => {
    expect(normalizePhoneNumber("+91 98765 43210")).toBe("919876543210");
  });

  it("strips dashes and parentheses", () => {
    expect(normalizePhoneNumber("(+91)-98765-43210")).toBe("919876543210");
  });

  it("leaves an already-normalized digits-only number unchanged", () => {
    expect(normalizePhoneNumber("919876543210")).toBe("919876543210");
  });

  it("makes a differently-formatted stored contact number and an inbound WhatsApp 'from' field match after normalizing both sides", () => {
    const storedContactPhone = "+91 98765-43210";
    const inboundFrom = "919876543210";
    expect(normalizePhoneNumber(storedContactPhone)).toBe(normalizePhoneNumber(inboundFrom));
  });
});
