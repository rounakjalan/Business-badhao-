"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseLines, parseOptionalString } from "@/lib/form-utils";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";
import type { Json, TablesInsert } from "@/types/database.types";

const BUSINESS_ASSETS_BUCKET = "business-assets";

async function requireOrg() {
  const currentOrg = await getCurrentOrg();
  if (!currentOrg) {
    redirect("/onboarding");
  }
  return currentOrg;
}

// ---------------------------------------------------------------------------
// Business profile (one row per organization — upserted on organization_id)
// ---------------------------------------------------------------------------
export async function updateBusinessProfile(formData: FormData) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();

  const payload: TablesInsert<"business_profiles"> = {
    organization_id: currentOrg.organizationId,
    business_name: parseOptionalString(formData.get("businessName")),
    business_description: parseOptionalString(formData.get("businessDescription")),
    business_category: parseOptionalString(formData.get("businessCategory")),
    website: parseOptionalString(formData.get("website")),
    phone: parseOptionalString(formData.get("phone")),
    email: parseOptionalString(formData.get("email")),
    whatsapp: parseOptionalString(formData.get("whatsapp")),
    address: parseOptionalString(formData.get("address")),
    service_area: parseOptionalString(formData.get("serviceArea")),
    opening_hours: parseOptionalString(formData.get("openingHours")),
    about: parseOptionalString(formData.get("about")),
  };

  const { error } = await supabase.from("business_profiles").upsert(payload, { onConflict: "organization_id" });

  if (error) {
    redirect(`/knowledge?tab=profile&error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/knowledge");
  redirect("/knowledge?tab=profile&message=profile-updated");
}

// ---------------------------------------------------------------------------
// Products & services
// ---------------------------------------------------------------------------
export async function createProductService(formData: FormData) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();

  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    redirect(`/knowledge?tab=products&error=${encodeURIComponent("Name is required.")}`);
  }

  const priceRaw = String(formData.get("price") ?? "").trim();
  const price = priceRaw ? Number(priceRaw) : null;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("products_services").insert({
    organization_id: currentOrg.organizationId,
    name,
    description: parseOptionalString(formData.get("description")),
    category: parseOptionalString(formData.get("category")),
    price: price !== null && Number.isFinite(price) ? price : null,
    pricing_type: String(formData.get("pricingType") ?? "fixed") as TablesInsert<"products_services">["pricing_type"],
    features: parseLines(formData.get("features")) as unknown as Json,
    benefits: parseLines(formData.get("benefits")) as unknown as Json,
    availability: String(formData.get("availability") ?? "available") as TablesInsert<"products_services">["availability"],
    special_offers: parseOptionalString(formData.get("specialOffers")),
    created_by: user?.id ?? null,
  });

  if (error) {
    redirect(`/knowledge?tab=products&error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/knowledge");
  redirect("/knowledge?tab=products");
}

export async function updateProductService(id: string, formData: FormData) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();

  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    redirect(`/knowledge?tab=products&error=${encodeURIComponent("Name is required.")}`);
  }

  const priceRaw = String(formData.get("price") ?? "").trim();
  const price = priceRaw ? Number(priceRaw) : null;

  const { error } = await supabase
    .from("products_services")
    .update({
      name,
      description: parseOptionalString(formData.get("description")),
      category: parseOptionalString(formData.get("category")),
      price: price !== null && Number.isFinite(price) ? price : null,
      pricing_type: String(formData.get("pricingType") ?? "fixed") as TablesInsert<"products_services">["pricing_type"],
      features: parseLines(formData.get("features")) as unknown as Json,
      benefits: parseLines(formData.get("benefits")) as unknown as Json,
      availability: String(formData.get("availability") ?? "available") as TablesInsert<"products_services">["availability"],
      special_offers: parseOptionalString(formData.get("specialOffers")),
    })
    .eq("id", id)
    .eq("organization_id", currentOrg.organizationId);

  if (error) {
    redirect(`/knowledge?tab=products&error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/knowledge");
  redirect("/knowledge?tab=products");
}

export async function deleteProductService(id: string) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();
  await supabase.from("products_services").delete().eq("id", id).eq("organization_id", currentOrg.organizationId);
  revalidatePath("/knowledge");
}

// ---------------------------------------------------------------------------
// Media assets — file goes to Supabase Storage, metadata to media_assets.
// ---------------------------------------------------------------------------
export async function uploadMediaAsset(formData: FormData) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect(`/knowledge?tab=media&error=${encodeURIComponent("Choose a file to upload.")}`);
  }

  const category = String(formData.get("category") ?? "other");
  const productServiceId = parseOptionalString(formData.get("productServiceId"));

  // Unique path per upload (storage_path is unique) — keeps the original
  // filename visible while guaranteeing no collision between uploads.
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${currentOrg.organizationId}/${category}/${crypto.randomUUID()}-${safeName}`;

  const { error: uploadError } = await supabase.storage.from(BUSINESS_ASSETS_BUCKET).upload(storagePath, file, {
    contentType: file.type || undefined,
  });

  if (uploadError) {
    redirect(`/knowledge?tab=media&error=${encodeURIComponent(uploadError.message)}`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error: insertError } = await supabase.from("media_assets").insert({
    organization_id: currentOrg.organizationId,
    category: category as TablesInsert<"media_assets">["category"],
    storage_path: storagePath,
    file_name: file.name,
    mime_type: file.type || null,
    file_size: file.size,
    title: parseOptionalString(formData.get("title")),
    description: parseOptionalString(formData.get("description")),
    product_service_id: productServiceId,
    created_by: user?.id ?? null,
  });

  if (insertError) {
    // Roll back the upload so a failed insert never leaves an orphaned file.
    await supabase.storage.from(BUSINESS_ASSETS_BUCKET).remove([storagePath]);
    redirect(`/knowledge?tab=media&error=${encodeURIComponent(insertError.message)}`);
  }

  revalidatePath("/knowledge");
  redirect("/knowledge?tab=media");
}

export async function deleteMediaAsset(id: string) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();

  const { data: asset } = await supabase
    .from("media_assets")
    .select("storage_path")
    .eq("id", id)
    .eq("organization_id", currentOrg.organizationId)
    .maybeSingle();

  if (!asset) return;

  await supabase.storage.from(BUSINESS_ASSETS_BUCKET).remove([asset.storage_path]);
  await supabase.from("media_assets").delete().eq("id", id).eq("organization_id", currentOrg.organizationId);

  revalidatePath("/knowledge");
}

// ---------------------------------------------------------------------------
// FAQs
// ---------------------------------------------------------------------------
export async function createFaq(formData: FormData) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();

  const question = String(formData.get("question") ?? "").trim();
  const answer = String(formData.get("answer") ?? "").trim();
  if (!question || !answer) {
    redirect(`/knowledge?tab=faqs&error=${encodeURIComponent("Question and answer are both required.")}`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("faqs").insert({
    organization_id: currentOrg.organizationId,
    question,
    answer,
    category: parseOptionalString(formData.get("category")),
    is_active: formData.get("isActive") !== "false",
    created_by: user?.id ?? null,
  });

  if (error) {
    redirect(`/knowledge?tab=faqs&error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/knowledge");
  redirect("/knowledge?tab=faqs");
}

export async function updateFaq(id: string, formData: FormData) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();

  const question = String(formData.get("question") ?? "").trim();
  const answer = String(formData.get("answer") ?? "").trim();
  if (!question || !answer) {
    redirect(`/knowledge?tab=faqs&error=${encodeURIComponent("Question and answer are both required.")}`);
  }

  const { error } = await supabase
    .from("faqs")
    .update({
      question,
      answer,
      category: parseOptionalString(formData.get("category")),
      is_active: formData.get("isActive") !== "false",
    })
    .eq("id", id)
    .eq("organization_id", currentOrg.organizationId);

  if (error) {
    redirect(`/knowledge?tab=faqs&error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/knowledge");
  redirect("/knowledge?tab=faqs");
}

export async function toggleFaqActive(id: string, isActive: boolean) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();
  await supabase.from("faqs").update({ is_active: isActive }).eq("id", id).eq("organization_id", currentOrg.organizationId);
  revalidatePath("/knowledge");
}

export async function deleteFaq(id: string) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();
  await supabase.from("faqs").delete().eq("id", id).eq("organization_id", currentOrg.organizationId);
  revalidatePath("/knowledge");
}

// ---------------------------------------------------------------------------
// Business policies
// ---------------------------------------------------------------------------
export async function createPolicy(formData: FormData) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();

  const title = String(formData.get("title") ?? "").trim();
  const content = String(formData.get("content") ?? "").trim();
  if (!title || !content) {
    redirect(`/knowledge?tab=policies&error=${encodeURIComponent("Title and content are both required.")}`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("business_policies").insert({
    organization_id: currentOrg.organizationId,
    policy_type: String(formData.get("policyType") ?? "other") as TablesInsert<"business_policies">["policy_type"],
    title,
    content,
    created_by: user?.id ?? null,
  });

  if (error) {
    redirect(`/knowledge?tab=policies&error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/knowledge");
  redirect("/knowledge?tab=policies");
}

export async function updatePolicy(id: string, formData: FormData) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();

  const title = String(formData.get("title") ?? "").trim();
  const content = String(formData.get("content") ?? "").trim();
  if (!title || !content) {
    redirect(`/knowledge?tab=policies&error=${encodeURIComponent("Title and content are both required.")}`);
  }

  const { error } = await supabase
    .from("business_policies")
    .update({
      policy_type: String(formData.get("policyType") ?? "other") as TablesInsert<"business_policies">["policy_type"],
      title,
      content,
    })
    .eq("id", id)
    .eq("organization_id", currentOrg.organizationId);

  if (error) {
    redirect(`/knowledge?tab=policies&error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/knowledge");
  redirect("/knowledge?tab=policies");
}

export async function deletePolicy(id: string) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();
  await supabase.from("business_policies").delete().eq("id", id).eq("organization_id", currentOrg.organizationId);
  revalidatePath("/knowledge");
}

// ---------------------------------------------------------------------------
// AI communication rules (one row per organization — upserted)
// ---------------------------------------------------------------------------
export async function updateAiCommunicationRules(formData: FormData) {
  const currentOrg = await requireOrg();
  const supabase = await createClient();

  const payload: TablesInsert<"ai_communication_rules"> = {
    organization_id: currentOrg.organizationId,
    brand_voice: parseOptionalString(formData.get("brandVoice")),
    preferred_language: parseOptionalString(formData.get("preferredLanguage")),
    formality: parseOptionalString(formData.get("formality")),
    key_selling_points: parseLines(formData.get("keySellingPoints")) as unknown as Json,
    must_emphasize: parseLines(formData.get("mustEmphasize")) as unknown as Json,
    must_never_claim: parseLines(formData.get("mustNeverClaim")) as unknown as Json,
    competitor_comparison_rules: parseOptionalString(formData.get("competitorComparisonRules")),
    discount_authority: parseOptionalString(formData.get("discountAuthority")),
    escalation_rules: parseOptionalString(formData.get("escalationRules")),
    handoff_triggers: parseLines(formData.get("handoffTriggers")) as unknown as Json,
  };

  const { error } = await supabase.from("ai_communication_rules").upsert(payload, { onConflict: "organization_id" });

  if (error) {
    redirect(`/knowledge?tab=ai-rules&error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/knowledge");
  redirect("/knowledge?tab=ai-rules&message=rules-updated");
}
