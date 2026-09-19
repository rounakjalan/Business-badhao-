import http from "node:http";
import { logger } from "./logger.mjs";

/**
 * A minimal, dependency-free HTTP endpoint for operational monitoring
 * (Docker HEALTHCHECK, an uptime monitor, a k8s-style liveness probe) —
 * never anything requiring the Business Badhao bearer token, since this is
 * meant to be reachable from ordinary infra tooling on the runtime's own
 * host, not authenticated the same way as the Business Badhao API calls.
 *
 * `getStatus()` must return a plain JSON-safe object with no passwords,
 * cookies, tokens, or browser-profile contents — see worker.mjs's own
 * `buildHealthStatus` for exactly what is (and deliberately isn't) included.
 * Returns HTTP 200 when the worker looks healthy, 503 when it doesn't
 * (never launched Chromium successfully, or can't reach Business Badhao) —
 * so a container/process-manager healthcheck can act on it directly.
 */
export function startHealthServer(port, getStatus) {
  if (!port) {
    logger.info("Health check server disabled (HEALTH_CHECK_PORT not set).");
    return null;
  }

  const server = http.createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }

    const status = getStatus();
    res.writeHead(status.healthy ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  });

  server.listen(port, () => logger.info(`Health check server listening on :${port}/health`));
  server.on("error", (error) => logger.error("Health check server error", { error: String(error?.message || error) }));

  return server;
}
