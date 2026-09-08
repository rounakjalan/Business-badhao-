import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { OrgRole } from "@/types/database.types";

export type CurrentOrg = {
  organizationId: string;
  organizationName: string;
  role: OrgRole;
};

/**
 * The signed-in user for this request. `auth.getUser()` always makes a
 * real round-trip to Supabase Auth to revalidate the token (unlike
 * `getSession()`, which trusts the local cookie) — calling it more than
 * once per request is a genuine, avoidable network cost, not just a
 * redundant local check.
 *
 * Wrapped in React's `cache()` so every caller within the same request
 * (the dashboard layout, getCurrentOrg below, any page that also needs the
 * raw user) shares one call instead of each paying for their own.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/**
 * Resolves the signed-in user's organization membership. Business Badhao
 * doesn't yet support switching between multiple organizations, so this
 * takes the user's oldest membership as their "current" one.
 *
 * Wrapped in React's `cache()` so multiple calls within the same request
 * (e.g. from a layout and a page) only hit the database once.
 */
export const getCurrentOrg = cache(async (): Promise<CurrentOrg | null> => {
  const user = await getCurrentUser();

  if (!user) {
    return null;
  }

  const supabase = await createClient();
  const { data: membership } = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!membership) {
    return null;
  }

  const { data: organization } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", membership.organization_id)
    .maybeSingle();

  return {
    organizationId: membership.organization_id,
    organizationName: organization?.name ?? "",
    role: membership.role,
  };
});
