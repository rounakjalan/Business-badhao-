import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardGroupLayout({
  children,
}: {
  children: ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The middleware already redirects unauthenticated requests away from
  // these routes; this is a defense-in-depth check for the layout itself.
  if (!user) {
    redirect("/login");
  }

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    redirect("/onboarding");
  }

  const { data: profile } = await supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle();

  return (
    <DashboardShell
      organizationName={currentOrg.organizationName}
      userEmail={user.email ?? ""}
      userFullName={profile?.full_name ?? ""}
    >
      {children}
    </DashboardShell>
  );
}
