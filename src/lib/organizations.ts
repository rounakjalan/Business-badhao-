import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { OrgRole } from "@/types/database.types";

export type CurrentOrg = {
  organizationId: string;
  organizationName: string;
  role: OrgRole;
};

/**
 * Resolves the signed-in user's organization membership. Business Badhao
 * doesn't yet support switching between multiple organizations, so this
 * takes the user's oldest membership as their "current" one.
 *
 * Wrapped in React's `cache()` so multiple calls within the same request
 * (e.g. from a layout and a page) only hit the database once.
 */
export const getCurrentOrg = cache(async (): Promise<CurrentOrg | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

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
