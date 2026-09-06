import { describe, expect, it } from "vitest";
import { isValidWhatsAppNumber, normalizePhoneNumber } from "@/lib/whatsapp/phone";

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

describe("isValidWhatsAppNumber", () => {
  it("accepts a real-looking international number", () => {
    expect(isValidWhatsAppNumber("+91 98765 43210")).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidWhatsAppNumber(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isValidWhatsAppNumber(undefined)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidWhatsAppNumber("")).toBe(false);
  });

  it("rejects a too-short digit string", () => {
    expect(isValidWhatsAppNumber("12345")).toBe(false);
  });

  it("rejects a random non-numeric phone-like string with no real digits", () => {
    expect(isValidWhatsAppNumber("call us!")).toBe(false);
  });

  it("agrees with the exact threshold sendWhatsAppMessage itself enforces (>= 8 digits)", () => {
    expect(isValidWhatsAppNumber("1234567")).toBe(false);
    expect(isValidWhatsAppNumber("12345678")).toBe(true);
  });
});
