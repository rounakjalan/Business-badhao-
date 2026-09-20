import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // src/lib/instagram-discovery/sandbox-runtime.ts reads hermes-browser-runtime's
  // own source files (worker.mjs, credential-login.mjs, lib/*.mjs, package.json)
  // off this deployment's own filesystem at request time, to upload them into the on-demand Vercel
  // Sandbox that runs them (see that file's own doc comment for why: Vercel's
  // build-time file tracer only bundles files actually reached via a JS
  // import/require graph, and this package's own .mjs files are read as data,
  // never imported, so without this they would silently be missing from the
  // deployed function and every Sandbox wake would fail with ENOENT). Excludes
  // hermes-browser-runtime/node_modules — the Sandbox installs its own copy of
  // puppeteer-core via npm ci, matching its own OS/architecture, rather than
  // reusing whatever was resolved for this build's host.
  outputFileTracingIncludes: {
    "/**": [
      "./hermes-browser-runtime/worker.mjs",
      "./hermes-browser-runtime/credential-login.mjs",
      "./hermes-browser-runtime/lib/*.mjs",
      "./hermes-browser-runtime/package.json",
      "./hermes-browser-runtime/package-lock.json",
    ],
  },
};

export default nextConfig;
