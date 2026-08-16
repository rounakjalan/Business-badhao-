"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

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
