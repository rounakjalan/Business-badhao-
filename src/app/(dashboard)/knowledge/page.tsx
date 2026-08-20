import {
  createFaq,
  createPolicy,
  createProductService,
  deleteFaq,
  deleteMediaAsset,
  deletePolicy,
  deleteProductService,
  toggleFaqActive,
  updateAiCommunicationRules,
  updateBusinessProfile,
  updateFaq,
  updatePolicy,
  updateProductService,
  uploadMediaAsset,
} from "@/app/(dashboard)/knowledge/actions";
import { KnowledgeTabs } from "@/app/(dashboard)/knowledge/knowledge-tabs";
import { getCurrentOrg } from "@/lib/organizations";
import { createClient } from "@/lib/supabase/server";

const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour — regenerated on every page load, never persisted or exposed beyond that.

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string; tab?: string }>;
}) {
  const { error, message, tab } = await searchParams;

  const currentOrg = await getCurrentOrg();
  if (!currentOrg) return null;

  const supabase = await createClient();

  const [profile, products, media, faqs, policies, aiRules] = await Promise.all([
    supabase.from("business_profiles").select("*").eq("organization_id", currentOrg.organizationId).maybeSingle(),
    supabase.from("products_services").select("*").eq("organization_id", currentOrg.organizationId).order("created_at", { ascending: false }),
    supabase.from("media_assets").select("*").eq("organization_id", currentOrg.organizationId).order("created_at", { ascending: false }),
    supabase.from("faqs").select("*").eq("organization_id", currentOrg.organizationId).order("created_at", { ascending: false }),
    supabase.from("business_policies").select("*").eq("organization_id", currentOrg.organizationId).order("created_at", { ascending: false }),
    supabase.from("ai_communication_rules").select("*").eq("organization_id", currentOrg.organizationId).maybeSingle(),
  ]);

  const mediaPaths = (media.data ?? []).map((m) => m.storage_path);
  const { data: signedUrls } = mediaPaths.length
    ? await supabase.storage.from("business-assets").createSignedUrls(mediaPaths, SIGNED_URL_TTL_SECONDS)
    : { data: [] as { path: string | null; signedUrl: string }[] };
  const signedUrlByPath = new Map((signedUrls ?? []).map((s) => [s.path, s.signedUrl]));
  const mediaWithUrls = (media.data ?? []).map((m) => ({ ...m, signedUrl: signedUrlByPath.get(m.storage_path) ?? null }));

  return (
    <KnowledgeTabs
      error={error}
      message={message}
      initialTab={tab}
      businessProfile={profile.data ?? null}
      products={products.data ?? []}
      media={mediaWithUrls}
      faqs={faqs.data ?? []}
      policies={policies.data ?? []}
      aiRules={aiRules.data ?? null}
      actions={{
        updateBusinessProfile,
        createProductService,
        updateProductService,
        deleteProductService,
        uploadMediaAsset,
        deleteMediaAsset,
        createFaq,
        updateFaq,
        toggleFaqActive,
        deleteFaq,
        createPolicy,
        updatePolicy,
        deletePolicy,
        updateAiCommunicationRules,
      }}
    />
  );
}
