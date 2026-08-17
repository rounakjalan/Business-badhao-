"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { CampaignPlanSchema, runCampaignPlanner, type CampaignPlannerResult } from "@/lib/ai/agents/campaign-planner";
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

  return runCampaignPlanner({
    organizationId: currentOrg.organizationId,
    organizationName: currentOrg.organizationName,
    campaignName: input.name,
    objective: input.objective,
    description: input.description,
    customerType: input.customerType,
    location: input.location,
  });
}

export async function createCampaign(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const objective = String(formData.get("objective") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const targetAudience = String(formData.get("targetAudience") ?? "").trim();
  const launch = formData.get("launch") === "true";
  const planRaw = String(formData.get("plan") ?? "");

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

  // The AI plan (if the user generated and kept one) is optional and
  // re-validated here rather than trusted as-is — it arrived through a
  // hidden form field, so it's still just client-supplied data at this
  // point.
  let idealCustomerProfileId: string | null = null;
  if (planRaw) {
    const planParse = CampaignPlanSchema.safeParse(JSON.parse(planRaw));
    if (planParse.success) {
      const plan = planParse.data;
      const { data: icp } = await supabase
        .from("ideal_customer_profiles")
        .insert({
          organization_id: currentOrg.organizationId,
          name: `${name} — ICP`,
          description: plan.customerProfile,
          criteria: {
            targetMarket: plan.targetMarket,
            idealCustomerCharacteristics: plan.idealCustomerCharacteristics,
            buyingSignals: plan.buyingSignals,
            painPoints: plan.painPoints,
            valueProposition: plan.valueProposition,
            suggestedChannels: plan.suggestedChannels,
            campaignStrategy: plan.campaignStrategy,
            qualificationCriteria: plan.qualificationCriteria,
            outreachStrategy: plan.outreachStrategy,
            followUpStrategy: plan.followUpStrategy,
          },
          created_by: user?.id ?? null,
        })
        .select("id")
        .single();
      idealCustomerProfileId = icp?.id ?? null;
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
