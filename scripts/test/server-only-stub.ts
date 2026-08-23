// Vitest runs outside Next.js's bundler, which is the only thing that
// understands the real `server-only` package (it throws when imported from
// a client bundle; it's a no-op everywhere else). Files under src/lib use
// `import "server-only"` as a guard against accidental client bundling —
// aliased here to this empty module so those same files stay testable
// without weakening that guard in the actual Next.js build.
export {};
