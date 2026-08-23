import "server-only";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import { getSupabaseUrl } from "@/lib/supabase/env";

export type AdminClient = SupabaseClient<Database>;

/**
 * Supabase client that bypasses row-level security.
 *
 * Every other client in this codebase carries a signed-in user and is gated
 * by RLS, which resolves the organization from auth.uid(). Scheduled work
 * has no user and therefore no auth.uid(), so those clients can read
 * nothing at all — this exists solely for that case.
 *
 * Because it bypasses RLS, it must never be reachable from a request path
 * that carries user input. It is `server-only` and callers are responsible
 * for scoping every query by organization_id explicitly, since the database
 * will no longer do it for them.
 *
 * Returns null rather than throwing when the key is absent, so a deployment
 * without it degrades to "automation is off" instead of crashing routes.
 */
export function createAdminClient(): AdminClient | null {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return null;

  return createSupabaseClient<Database>(getSupabaseUrl(), serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Whether scheduled automation can run at all in this deployment. */
export function isAutomationConfigured(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.CRON_SECRET);
}
