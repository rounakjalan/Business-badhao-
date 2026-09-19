/**
 * Structured (one JSON object per line) logging for the worker — easy to
 * ship to any real log aggregator (journald, Docker's own log driver,
 * CloudWatch, etc.) without a parser having to guess at free-text formats.
 *
 * Redacts INSTAGRAM_DISCOVERY_RUNTIME_TOKEN from every logged string as a
 * defense-in-depth measure: normal code paths never log the token at all
 * (api-client.mjs never does), but an unexpected error message that happens
 * to embed a request's own Authorization header, or similar, must still
 * never reach a log line unredacted.
 */

function redactValue(value) {
  const token = process.env.INSTAGRAM_DISCOVERY_RUNTIME_TOKEN;
  if (typeof value !== "string" || !token) return value;
  return value.split(token).join("[REDACTED]");
}

function redactDeep(value) {
  if (typeof value === "string") return redactValue(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = redactDeep(val);
    return out;
  }
  return value;
}

function emit(level, message, meta) {
  const entry = { time: new Date().toISOString(), level, message: redactValue(message) };
  if (meta !== undefined) entry.meta = redactDeep(meta);
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const logger = {
  info: (message, meta) => emit("info", message, meta),
  warn: (message, meta) => emit("warn", message, meta),
  error: (message, meta) => emit("error", message, meta),
};
