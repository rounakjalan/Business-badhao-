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

/**
 * Same lower bound send.ts has always enforced before ever calling Meta —
 * pulled out here so eligibility checks upstream (deciding whether a lead is
 * a WhatsApp candidate at all) agree with the one place that actually sends,
 * instead of guessing a second threshold that could silently disagree with
 * it. Deliberately lenient: this never tries to validate a real international
 * numbering plan (country code, subscriber-number length per region) — that
 * would risk rejecting a genuinely valid number people actually enter in all
 * kinds of formats. The real, authoritative validity check is Meta's own API
 * at send time, which returns an honest invalid_recipient for anything this
 * lets through that isn't real.
 */
export function isValidWhatsAppNumber(phone: string | null | undefined): boolean {
  if (!phone) return false;
  return normalizePhoneNumber(phone).length >= 8;
}
