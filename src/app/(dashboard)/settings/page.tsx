import {
  connectWhatsAppAction,
  disconnectGmailAction,
  disconnectInstagramAction,
  disconnectInstagramDiscoveryConnectionAction,
  disconnectWhatsAppAction,
  requestInstagramDiscoveryConnectionAction,
  testInstagramDiscoveryConnectionAction,
  updateOrganization,
  updateProfile,
  updateWhatsAppTemplateAction,
} from "@/app/(dashboard)/settings/actions";
import { SettingsSections } from "@/app/(dashboard)/settings/settings-sections";
import { getConnectionStatus } from "@/lib/gmail/tokens";
import { getConnectionStatus as getInstagramConnectionStatus } from "@/lib/instagram/tokens";
import { getInstagramDiscoveryConnectionStatus, isInstagramDiscoveryRuntimeConfigured } from "@/lib/instagram-discovery/connection";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import { getWhatsAppConnectionStatus } from "@/lib/whatsapp/tokens";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    message?: string;
    tab?: string;
    gmail?: string;
    gmailMessage?: string;
    whatsapp?: string;
    whatsappMessage?: string;
    instagram?: string;
    instagramMessage?: string;
    instagramDiscovery?: string;
    instagramDiscoveryMessage?: string;
  }>;
}) {
  const {
    error,
    message,
    tab,
    gmail,
    gmailMessage,
    whatsapp,
    whatsappMessage,
    instagram,
    instagramMessage,
    instagramDiscovery,
    instagramDiscoveryMessage,
  } = await searchParams;

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const [gmailStatus, whatsappStatus, instagramStatus, instagramDiscoveryStatus] = await Promise.all([
    getConnectionStatus(currentOrg.organizationId),
    getWhatsAppConnectionStatus(currentOrg.organizationId),
    getInstagramConnectionStatus(currentOrg.organizationId),
    getInstagramDiscoveryConnectionStatus(currentOrg.organizationId),
  ]);
  const instagramDiscoveryRuntimeConfigured = isInstagramDiscoveryRuntimeConfigured();

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
      whatsappStatus={whatsappStatus}
      whatsappNotice={whatsapp ? { status: whatsapp, detail: whatsappMessage } : null}
      connectWhatsAppAction={connectWhatsAppAction}
      disconnectWhatsAppAction={disconnectWhatsAppAction}
      updateWhatsAppTemplateAction={updateWhatsAppTemplateAction}
      instagramStatus={instagramStatus}
      instagramNotice={instagram ? { status: instagram, detail: instagramMessage } : null}
      disconnectInstagramAction={disconnectInstagramAction}
      instagramDiscoveryStatus={instagramDiscoveryStatus}
      instagramDiscoveryRuntimeConfigured={instagramDiscoveryRuntimeConfigured}
      instagramDiscoveryOrganizationId={currentOrg.organizationId}
      instagramDiscoveryNotice={instagramDiscovery ? { status: instagramDiscovery, detail: instagramDiscoveryMessage } : null}
      requestInstagramDiscoveryConnectionAction={requestInstagramDiscoveryConnectionAction}
      disconnectInstagramDiscoveryConnectionAction={disconnectInstagramDiscoveryConnectionAction}
      testInstagramDiscoveryConnectionAction={testInstagramDiscoveryConnectionAction}
    />
  );
}
