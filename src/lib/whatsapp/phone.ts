/**
 * WhatsApp Cloud API expects phone numbers as digits only (country code
 * included, no leading '+', no spaces/dashes/parentheses) — both when
 * sending (the "to" field) and when matching an inbound message's "from"
 * field against a stored contact/prospect phone number, which may have
 * been entered as "+91 98765 43210", "91-98765-43210", etc. Normalizing
 * both sides to digits-only before comparing is what makes that matching
 * actually work; comparing raw strings would silently miss real matches.
 */
export function normalizePhoneNumber(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}
