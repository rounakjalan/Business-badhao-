/**
 * Absolute origin of the deployed app. Needed where Supabase requires a
 * redirect URL it can't infer from the current request (e.g. building an
 * email confirmation link inside a Server Action) — without this, Supabase
 * falls back to the project's dashboard-configured Site URL, which defaults
 * to http://localhost:3000 and breaks confirmation emails sent from any
 * real deployment.
 *
 * Prefers an explicit NEXT_PUBLIC_SITE_URL (set this to the production
 * domain); falls back to Vercel's own deployment URL, then localhost for
 * local dev.
 */
export function getSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return `https://${vercelUrl}`;

  return "http://localhost:3000";
}
