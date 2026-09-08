import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { getCurrentOrg, getCurrentUser } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardGroupLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await getCurrentUser();

  // The middleware already redirects unauthenticated requests away from
  // these routes; this is a defense-in-depth check for the layout itself.
  if (!user) {
    redirect("/login");
  }

  // Independent of each other — both only need user.id — so they run
  // concurrently instead of the org lookup finishing before the profile
  // query even starts. getCurrentOrg's own auth.getUser() call is the same
  // cached call as the one above (see getCurrentUser), not a second one.
  const supabase = await createClient();
  const [currentOrg, profile] = await Promise.all([
    getCurrentOrg(),
    supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
  ]);

  if (!currentOrg) {
    redirect("/onboarding");
  }

  return (
    <DashboardShell
      organizationName={currentOrg.organizationName}
      userEmail={user.email ?? ""}
      userFullName={profile.data?.full_name ?? ""}
    >
      {children}
    </DashboardShell>
  );
}
