import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/types/database.types";
import { getSupabaseAnonKey, getSupabaseUrl } from "@/lib/supabase/env";

/**
 * Supabase client for use in Server Components, Server Actions and Route
 * Handlers. Reads the session from cookies via the anon key only — never
 * import the service-role key here or anywhere that runs on request paths
 * shared with user input.
 *
 * `setAll` is wrapped in try/catch because Server Components cannot write
 * cookies; when called from one, the write is a no-op and session refresh
 * is instead handled by the middleware.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — safe to ignore, the
          // middleware refreshes the session cookie on navigation.
        }
      },
    },
  });
}
