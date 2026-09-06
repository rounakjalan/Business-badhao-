"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { disconnectAccount } from "@/lib/gmail/tokens";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import { disconnectWhatsAppAccount, saveWhatsAppAccount, updateWhatsAppTemplate } from "@/lib/whatsapp/tokens";

export async function updateProfile(formData: FormData) {
  const fullName = String(formData.get("fullName") ?? "").trim();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { error } = await supabase.from("profiles").update({ full_name: fullName }).eq("id", user.id);

  if (error) {
    redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/settings");
  redirect("/settings?message=profile-updated");
}

export async function updateOrganization(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    redirect(`/settings?error=${encodeURIComponent("Organization name is required.")}`);
  }

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    redirect("/onboarding");
  }

  const supabase = await createClient();
  // RLS also enforces this (only admins/owners can update an organization),
  // this check just produces a clearer error message than a generic RLS
  // rejection would.
  if (currentOrg.role !== "owner" && currentOrg.role !== "admin") {
    redirect(`/settings?error=${encodeURIComponent("Only owners and admins can rename the organization.")}`);
  }

  const { error } = await supabase.from("organizations").update({ name }).eq("id", currentOrg.organizationId);

  if (error) {
    redirect(`/settings?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/settings");
  redirect("/settings?message=organization-updated");
}

export async function disconnectGmailAction() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  await disconnectAccount(currentOrg.organizationId);

  revalidatePath("/settings");
  revalidatePath("/leads");
  redirect("/settings?tab=Integrations&gmail=disconnected");
}

/**
 * WhatsApp Cloud API has no OAuth consent screen the way Gmail does — the
 * org admin enters the phone_number_id and access_token they already
 * obtained directly from Meta Business Manager (see the doc comment on
 * src/lib/whatsapp/config.ts for why). This just validates and stores them.
 */
export async function connectWhatsAppAction(formData: FormData) {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  const phoneNumberId = String(formData.get("phoneNumberId") ?? "").trim();
  const accessToken = String(formData.get("accessToken") ?? "").trim();
  const displayPhoneNumber = String(formData.get("displayPhoneNumber") ?? "").trim();
  const templateName = String(formData.get("templateName") ?? "").trim();
  const templateLanguage = String(formData.get("templateLanguage") ?? "").trim();

  if (!phoneNumberId || !accessToken) {
    redirect(`/settings?tab=Integrations&whatsapp=error&whatsappMessage=${encodeURIComponent("Phone Number ID and Access Token are both required.")}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const saved = await saveWhatsAppAccount({
    organizationId: currentOrg.organizationId,
    connectedBy: user.id,
    phoneNumberId,
    businessAccountId: null,
    displayPhoneNumber: displayPhoneNumber || null,
    accessToken,
    templateName: templateName || null,
    templateLanguage: templateLanguage || undefined,
  });

  if (!saved.ok) {
    redirect(`/settings?tab=Integrations&whatsapp=error&whatsappMessage=${encodeURIComponent(saved.message ?? "Could not save this WhatsApp connection.")}`);
  }

  revalidatePath("/settings");
  redirect("/settings?tab=Integrations&whatsapp=connected");
}

/**
 * Lets an already-connected org add or change its approved cold-outreach
 * template without re-entering phone_number_id/access_token — see the doc
 * comment on updateWhatsAppTemplate (whatsapp/tokens.ts) for why this is a
 * separate action from connectWhatsAppAction.
 */
export async function updateWhatsAppTemplateAction(formData: FormData) {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  const templateName = String(formData.get("templateName") ?? "").trim();
  const templateLanguage = String(formData.get("templateLanguage") ?? "").trim() || "en_US";

  const result = await updateWhatsAppTemplate(currentOrg.organizationId, { templateName: templateName || null, templateLanguage });

  if (!result.ok) {
    redirect(`/settings?tab=Integrations&whatsapp=error&whatsappMessage=${encodeURIComponent(result.message ?? "Could not save the WhatsApp template.")}`);
  }

  revalidatePath("/settings");
  redirect("/settings?tab=Integrations&whatsapp=template_saved");
}

export async function disconnectWhatsAppAction() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) redirect("/login");

  await disconnectWhatsAppAccount(currentOrg.organizationId);

  revalidatePath("/settings");
  redirect("/settings?tab=Integrations&whatsapp=disconnected");
}
