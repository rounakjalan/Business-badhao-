import { disconnectGmailAction, updateOrganization, updateProfile } from "@/app/(dashboard)/settings/actions";
import { SettingsSections } from "@/app/(dashboard)/settings/settings-sections";
import { getConnectionStatus } from "@/lib/gmail/tokens";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; tab?: string; gmail?: string; gmailMessage?: string }>;
}) {
  const { error, message, tab, gmail, gmailMessage } = await searchParams;

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const gmailStatus = await getConnectionStatus(currentOrg.organizationId);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, email")
    .eq("id", user?.id ?? "")
    .maybeSingle();

  const { data: members } = await supabase
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", currentOrg.organizationId);

  const memberIds = (members ?? []).map((m) => m.user_id);
  const { data: memberProfiles } = memberIds.length
    ? await supabase.from("profiles").select("id, full_name, email").in("id", memberIds)
    : { data: [] };

  const profileById = new Map((memberProfiles ?? []).map((p) => [p.id, p]));
  const teamMembers = (members ?? []).map((m) => ({
    userId: m.user_id,
    role: m.role,
    name: profileById.get(m.user_id)?.full_name ?? "Unknown",
    email: profileById.get(m.user_id)?.email ?? "",
  }));

  return (
    <SettingsSections
      error={error}
      message={message}
      profile={{ fullName: profile?.full_name ?? "", email: profile?.email ?? user?.email ?? "" }}
      organization={{ name: currentOrg.organizationName, role: currentOrg.role, canManage: currentOrg.role === "owner" || currentOrg.role === "admin" }}
      teamMembers={teamMembers}
      updateProfileAction={updateProfile}
      updateOrganizationAction={updateOrganization}
      initialTab={tab}
      gmailStatus={gmailStatus}
      gmailNotice={gmail ? { status: gmail, detail: gmailMessage } : null}
      disconnectGmailAction={disconnectGmailAction}
    />
  );
}
