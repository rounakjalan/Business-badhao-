import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // A separate, standalone Node.js package (its own puppeteer-core
    // runtime, never built/shipped by this Next.js app) — lints/typechecks
    // independently, not against this project's Next-specific config.
    "hermes-browser-runtime/**",
  ]),
]);

export default eslintConfig;
