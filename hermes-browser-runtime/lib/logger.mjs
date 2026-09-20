/**
 * Structured (one JSON object per line) logging for the worker — easy to
 * ship to any real log aggregator (journald, Docker's own log driver,
 * CloudWatch, etc.) without a parser having to guess at free-text formats.
 *
 * Redacts INSTAGRAM_DISCOVERY_RUNTIME_TOKEN and (when this process is
 * credential-login.mjs) INSTAGRAM_LOGIN_PASSWORD from every logged string as
 * a defense-in-depth measure: normal code paths never log either at all
 * (api-client.mjs never logs the token; credential-login.mjs never logs the
 * password — see its own doc comment), but an unexpected error message that
 * happens to embed one of them must still never reach a log line unredacted.
 */

function redactValue(value) {
  if (typeof value !== "string") return value;
  let out = value;
  for (const name of ["INSTAGRAM_DISCOVERY_RUNTIME_TOKEN", "INSTAGRAM_LOGIN_PASSWORD"]) {
    const secret = process.env[name];
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  return out;
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
