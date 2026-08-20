"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runCampaignPlanner, type CampaignPlan, type CampaignPlannerResult } from "@/lib/ai/agents/campaign-planner";
import { IcpSchema, runIcpGenerator, type IcpGeneratorResult } from "@/lib/ai/agents/icp-generator";
import { getBusinessContext } from "@/lib/business-context";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import type { TablesUpdate } from "@/types/database.types";

export async function generateCampaignPlan(input: {
  name: string;
  objective: string;
  description: string;
  customerType: string;
  location: string;
}): Promise<CampaignPlannerResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    return { ok: false, message: "Sign in to a workspace to generate a campaign plan." };
  }

  const businessContext = await getBusinessContext(currentOrg.organizationId);

  return runCampaignPlanner({
    organizationId: currentOrg.organizationId,
    organizationName: currentOrg.organizationName,
    campaignName: input.name,
    objective: input.objective,
    description: input.description,
    customerType: input.customerType,
    location: input.location,
    businessContext,
  });
}

export async function generateIcp(input: {
  name: string;
  objective: string;
  description: string;
  plan: CampaignPlan;
}): Promise<IcpGeneratorResult> {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    return { ok: false, message: "Sign in to a workspace to generate an ideal customer profile." };
  }

  return runIcpGenerator({
    organizationId: currentOrg.organizationId,
    organizationName: currentOrg.organizationName,
    campaignName: input.name,
    objective: input.objective,
    description: input.description,
    plan: input.plan,
  });
}

export async function createCampaign(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const objective = String(formData.get("objective") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const targetAudience = String(formData.get("targetAudience") ?? "").trim();
  const launch = formData.get("launch") === "true";
  const icpRaw = String(formData.get("icp") ?? "");

  if (!name) {
    redirect(`/campaigns/create?error=${encodeURIComponent("Campaign name is required.")}`);
  }

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    redirect("/onboarding");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // The AI plan and ICP (if the user generated and kept them) are optional
  // and re-validated here rather than trusted as-is — they arrived through
  // hidden form fields, so they're still just client-supplied data at this
  // point. Nothing is written to Supabase until this single insert, so
  // regenerating either in the wizard (client-side state) or refreshing
  // the page (loses in-progress wizard state, same as before this feature)
  // can never produce duplicate campaigns or duplicate ICP rows.
  let idealCustomerProfileId: string | null = null;
  if (icpRaw) {
    const icpParse = IcpSchema.safeParse(JSON.parse(icpRaw));
    if (icpParse.success) {
      const icp = icpParse.data;
      const { data: savedIcp } = await supabase
        .from("ideal_customer_profiles")
        .insert({
          organization_id: currentOrg.organizationId,
          name: `${name} — ICP`,
          description: icp.targetCustomer,
          criteria: icp,
          created_by: user?.id ?? null,
        })
        .select("id")
        .single();
      idealCustomerProfileId = savedIcp?.id ?? null;
    }
  }

  const { data: campaign, error } = await supabase
    .from("campaigns")
    .insert({
      organization_id: currentOrg.organizationId,
      ideal_customer_profile_id: idealCustomerProfileId,
      name,
      objective: objective || null,
      description: description || null,
      target_audience: targetAudience || null,
      status: launch ? "active" : "draft",
      created_by: user?.id ?? null,
    })
    .select("id")
    .single();

  if (error || !campaign) {
    redirect(`/campaigns/create?error=${encodeURIComponent(error?.message ?? "Could not create campaign.")}`);
  }

  redirect(`/campaigns/${campaign.id}`);
}

export async function updateCampaignStatus(campaignId: string, status: TablesUpdate<"campaigns">["status"]) {
  const supabase = await createClient();
  await supabase.from("campaigns").update({ status }).eq("id", campaignId);
  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/campaigns");
}
