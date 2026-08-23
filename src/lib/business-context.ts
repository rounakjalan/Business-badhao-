import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database.types";

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

export const EMPTY_BUSINESS_CONTEXT: BusinessContext = {
  businessProfile: null,
  productsServices: [],
  valueProposition: { keySellingPoints: [], productBenefits: [] },
  faqs: [],
  policies: [],
  aiCommunicationRules: null,
  mediaReferences: [],
};

// ---------------------------------------------------------------------------
// Agent-specific context selection. Each function takes the one full
// BusinessContext already fetched via getBusinessContext() and returns a
// same-shaped object with only the categories that agent actually needs —
// so formatBusinessContext() (src/lib/ai/business-context-prompt.ts) can be
// reused as-is by every agent, instead of each agent inventing its own
// formatting. Callers fetch once per request and select per agent; this
// never re-queries Supabase.
// ---------------------------------------------------------------------------

/** Lead Research: who this business is and what it sells, so the agent can reason about fit — not FAQs/policies/brand-voice rules, which aren't about the business's facts. */
export function selectResearchContext(context: BusinessContext): BusinessContext {
  return { ...EMPTY_BUSINESS_CONTEXT, businessProfile: context.businessProfile, productsServices: context.productsServices, valueProposition: context.valueProposition };
}

/** Lead Qualification: what's offered, service area (via profile), and policies that can gate fit (e.g. an admission policy) — campaign ICP stays a separate input, passed alongside this, never merged into it. */
export function selectQualificationContext(context: BusinessContext): BusinessContext {
  return { ...EMPTY_BUSINESS_CONTEXT, businessProfile: context.businessProfile, productsServices: context.productsServices, policies: context.policies };
}

/** Personalized Outreach: profile, product/service, value proposition, FAQs as the source of approved claims, brand voice/communication rules, and asset references. */
export function selectOutreachContext(context: BusinessContext): BusinessContext {
  return {
    ...EMPTY_BUSINESS_CONTEXT,
    businessProfile: context.businessProfile,
    productsServices: context.productsServices,
    valueProposition: context.valueProposition,
    faqs: context.faqs,
    aiCommunicationRules: context.aiCommunicationRules,
    mediaReferences: context.mediaReferences,
  };
}

/** Follow-up: business/product info, FAQs (for answering questions), relevant policies, and communication rules — conversation history is a separate existing input, untouched. */
export function selectFollowUpContext(context: BusinessContext): BusinessContext {
  return {
    ...EMPTY_BUSINESS_CONTEXT,
    businessProfile: context.businessProfile,
    productsServices: context.productsServices,
    faqs: context.faqs,
    policies: context.policies,
    aiCommunicationRules: context.aiCommunicationRules,
  };
}

/** Deal Agent: product, pricing/availability (both on products_services), policies (incl. payment), and communication rules — never the full profile/FAQs, this agent is transactional, not introductory. */
export function selectDealContext(context: BusinessContext): BusinessContext {
  return { ...EMPTY_BUSINESS_CONTEXT, productsServices: context.productsServices, policies: context.policies, aiCommunicationRules: context.aiCommunicationRules };
}

/** Loss Analysis: product/pricing and policies only — deal info and conversation/outreach history are separate existing inputs. */
export function selectLossAnalysisContext(context: BusinessContext): BusinessContext {
  return { ...EMPTY_BUSINESS_CONTEXT, productsServices: context.productsServices, policies: context.policies };
}

/**
 * Lead Discovery: what this business SELLS — category, description,
 * products/services, value proposition and the policies that can gate fit.
 * Used to interpret the ICP into search queries and, later, to judge
 * whether a discovered business is plausibly relevant. The ICP, never this,
 * is the search target.
 *
 * The seller's own contact details and geography (website, phone, email,
 * WhatsApp, address, service area, opening hours) are deliberately stripped:
 * they are seller *identity*, not offering. They carry no signal about who
 * to look for, and leaving the seller's own location in risks it competing
 * with the ICP's location for the "where" of a search. No FAQs/media
 * either — irrelevant to finding prospects.
 */
export function selectDiscoveryContext(context: BusinessContext): BusinessContext {
  const profile = context.businessProfile;
  return {
    ...EMPTY_BUSINESS_CONTEXT,
    businessProfile: profile
      ? {
          ...profile,
          website: null,
          phone: null,
          email: null,
          whatsapp: null,
          address: null,
          serviceArea: null,
          openingHours: null,
        }
      : null,
    productsServices: context.productsServices,
    valueProposition: context.valueProposition,
    policies: context.policies,
  };
}

/**
 * Intent Detection: deliberately NOT a BusinessContext at all — just the
 * names of what's offered, so the model can recognize e.g. "the Home
 * Theatre package" as product-interest intent. Everything else (FAQs,
 * policies, brand voice, pricing) is irrelevant to classifying intent and
 * is never sent here, per the explicit "don't send the whole object"
 * requirement for this agent specifically.
 */
export function selectIntentProductNames(context: BusinessContext): string[] {
  return context.productsServices.map((p) => p.name);
}

/**
 * @param client Optional client. Scheduled work has no signed-in user, so it
 * must pass one that can read without auth.uid(); otherwise every query is
 * denied by row-level security and the caller silently gets empty Business
 * Knowledge, which quietly strips the AI of its grounding.
 */
export async function getBusinessContext(
  organizationId: string,
  client?: SupabaseClient<Database>
): Promise<BusinessContext> {
  const supabase = client ?? (await createClient());

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
