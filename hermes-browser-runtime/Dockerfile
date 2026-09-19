# Runs hermes-browser-runtime as a persistent container: real Chromium
# (Debian's own `chromium` package — not Playwright's bundled browser, not a
# cloud browser image), driven by puppeteer-core over real CDP. See README.md
# for why this runs as a separate, always-on service rather than on Vercel.
FROM node:22-bookworm-slim

# chromium: the real, locally-installed browser this runtime drives.
# ca-certificates: required for Chromium/Node to make real outbound HTTPS
# requests (Instagram, Business Badhao's own API).
# curl: used by the container HEALTHCHECK below to call this runtime's own
# /health endpoint.
# fonts-liberation: without at least one real font package, Chromium renders
# pages with missing glyphs, which can shift layouts enough to break the
# selectors in lib/instagram.mjs.
# gosu: lets the entrypoint fix a bind-mounted PROFILES_DIR's ownership as
# root, then drop to the non-root `hermes` user for the actual process —
# see docker-entrypoint.sh.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    curl \
    fonts-liberation \
    gosu \
    && rm -rf /var/lib/apt/lists/*

ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
# Headless Chromium under Docker's default seccomp profile and small
# /dev/shm needs these two flags to avoid crashing on launch — see
# lib/browser.mjs's own CHROMIUM_EXTRA_ARGS doc comment.
ENV CHROMIUM_EXTRA_ARGS="--no-sandbox --disable-dev-shm-usage"
ENV PROFILES_DIR=/data/profiles
ENV HEALTH_CHECK_PORT=8787

# Runs as a real non-root user — Chromium itself refuses to run as root
# without --no-sandbox even being enough on some kernels, and it is simply
# bad practice for a long-lived internet-facing process.
RUN groupadd -r hermes && useradd -r -g hermes -d /app hermes \
    && mkdir -p /data/profiles && chown -R hermes:hermes /data /app 2>/dev/null || true

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data/profiles && chown -R hermes:hermes /data /app \
    && chmod +x docker-entrypoint.sh

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:8787/health || exit 1

# Starts as root (fixes PROFILES_DIR ownership for whatever host bind mount
# is there — see docker-entrypoint.sh) and immediately drops to the
# non-root `hermes` user via gosu for the actual worker process.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "worker.mjs"]
