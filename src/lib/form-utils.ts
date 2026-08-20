/**
 * Splits a textarea's lines into a trimmed, non-empty string array — the
 * "one item per line" convention used for every list-shaped field across
 * the app's forms (campaign ICP, AI communication rules, product
 * features/benefits, etc.), so array-valued jsonb columns don't need a
 * dedicated multi-item editor component.
 */
export function parseLines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Trims a form field and normalizes "" to null, matching how optional text columns are stored. */
export function parseOptionalString(value: FormDataEntryValue | null): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}
