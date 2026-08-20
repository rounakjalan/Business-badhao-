import { createClient } from "@/lib/supabase/server";

// Server-side only — reads the Business Knowledge tables (business_profiles,
// products_services, faqs, business_policies, ai_communication_rules,
// media_assets) for one organization and shapes them into a structured
// object AI agents can consume. This module only ever reads; nothing here
// writes to Business Knowledge. Organization isolation comes from the same
// two layers as every other query in this app: the caller always passes an
// organizationId resolved from the signed-in user's session
// (getCurrentOrg()), and every query is additionally scoped with
// .eq("organization_id", organizationId) on top of the table's RLS policy
// (public.is_org_member) — so even a caller mistake here still can't cross
// a tenant boundary, RLS rejects it at the database level regardless.

export type BusinessProfileContext = {
  name: string | null;
  description: string | null;
  category: string | null;
  about: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  whatsapp: string | null;
  address: string | null;
  serviceArea: string | null;
  openingHours: string | null;
};

export type ProductServiceContext = {
  name: string;
  description: string | null;
  category: string | null;
  price: number | null;
  pricingType: string;
  features: string[];
  benefits: string[];
  availability: string;
  specialOffers: string | null;
};

export type FaqContext = {
  question: string;
  answer: string;
  category: string | null;
};

export type PolicyContext = {
  policyType: string;
  title: string;
  content: string;
};

export type AiCommunicationRulesContext = {
  brandVoice: string | null;
  preferredLanguage: string | null;
  formality: string | null;
  mustEmphasize: string[];
  mustNeverClaim: string[];
  competitorComparisonRules: string | null;
  discountAuthority: string | null;
  escalationRules: string | null;
  handoffTriggers: string[];
};

export type MediaReferenceContext = {
  category: string;
  title: string | null;
  fileName: string;
};

/**
 * Structured, section-separated business context — deliberately not "the
 * whole database concatenated." valueProposition is derived (key selling
 * points from AI communication rules + the distinct benefits already
 * entered per product/service), not a stored field of its own.
 */
export type BusinessContext = {
  businessProfile: BusinessProfileContext | null;
  productsServices: ProductServiceContext[];
  valueProposition: { keySellingPoints: string[]; productBenefits: string[] };
  faqs: FaqContext[];
  policies: PolicyContext[];
  aiCommunicationRules: AiCommunicationRulesContext | null;
  mediaReferences: MediaReferenceContext[];
};

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** True when the org has entered no Business Knowledge at all — callers use this to render "no business knowledge on file" instead of an empty-looking section. */
export function isBusinessContextEmpty(context: BusinessContext): boolean {
  return (
    !context.businessProfile &&
    context.productsServices.length === 0 &&
    context.valueProposition.keySellingPoints.length === 0 &&
    context.valueProposition.productBenefits.length === 0 &&
    context.faqs.length === 0 &&
    context.policies.length === 0 &&
    !context.aiCommunicationRules &&
    context.mediaReferences.length === 0
  );
}

export async function getBusinessContext(organizationId: string): Promise<BusinessContext> {
  const supabase = await createClient();

  const [profile, products, faqs, policies, aiRules, media] = await Promise.all([
    supabase.from("business_profiles").select("*").eq("organization_id", organizationId).maybeSingle(),
    supabase.from("products_services").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }),
    supabase.from("faqs").select("*").eq("organization_id", organizationId).eq("is_active", true).order("created_at", { ascending: false }),
    supabase.from("business_policies").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }),
    supabase.from("ai_communication_rules").select("*").eq("organization_id", organizationId).maybeSingle(),
    supabase
      .from("media_assets")
      .select("category, title, file_name")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const businessProfile: BusinessProfileContext | null = profile.data
    ? {
        name: profile.data.business_name,
        description: profile.data.business_description,
        category: profile.data.business_category,
        about: profile.data.about,
        website: profile.data.website,
        phone: profile.data.phone,
        email: profile.data.email,
        whatsapp: profile.data.whatsapp,
        address: profile.data.address,
        serviceArea: profile.data.service_area,
        openingHours: profile.data.opening_hours,
      }
    : null;

  const productsServices: ProductServiceContext[] = (products.data ?? []).map((p) => ({
    name: p.name,
    description: p.description,
    category: p.category,
    price: p.price,
    pricingType: p.pricing_type,
    features: toStringArray(p.features),
    benefits: toStringArray(p.benefits),
    availability: p.availability,
    specialOffers: p.special_offers,
  }));

  const aiCommunicationRules: AiCommunicationRulesContext | null = aiRules.data
    ? {
        brandVoice: aiRules.data.brand_voice,
        preferredLanguage: aiRules.data.preferred_language,
        formality: aiRules.data.formality,
        mustEmphasize: toStringArray(aiRules.data.must_emphasize),
        mustNeverClaim: toStringArray(aiRules.data.must_never_claim),
        competitorComparisonRules: aiRules.data.competitor_comparison_rules,
        discountAuthority: aiRules.data.discount_authority,
        escalationRules: aiRules.data.escalation_rules,
        handoffTriggers: toStringArray(aiRules.data.handoff_triggers),
      }
    : null;

  const productBenefits = [...new Set(productsServices.flatMap((p) => p.benefits))];

  return {
    businessProfile,
    productsServices,
    valueProposition: {
      keySellingPoints: toStringArray(aiRules.data?.key_selling_points),
      productBenefits,
    },
    faqs: (faqs.data ?? []).map((f) => ({ question: f.question, answer: f.answer, category: f.category })),
    policies: (policies.data ?? []).map((p) => ({ policyType: p.policy_type, title: p.title, content: p.content })),
    aiCommunicationRules,
    mediaReferences: (media.data ?? []).map((m) => ({ category: m.category, title: m.title, fileName: m.file_name })),
  };
}
