import type { BusinessContext } from "@/lib/business-context";
import { isBusinessContextEmpty } from "@/lib/business-context";

// Turns a structured BusinessContext into the prompt text an agent hands to
// Hermes — deliberately section-by-section (never a blind dump of every
// column), and every section is omitted entirely when there's nothing in
// it, rather than printing "not specified" noise for a business that
// hasn't filled in that part of Knowledge yet. Shared across agents that
// need business grounding — today only the Campaign Planner calls this.

function formatProduct(p: BusinessContext["productsServices"][number]): string {
  const priceText = p.price != null ? `${p.price} (${p.pricingType})` : "price not set";
  const parts = [`- ${p.name} [${p.category ?? "uncategorized"}, ${priceText}, ${p.availability}]`];
  if (p.description) parts.push(`  Description: ${p.description}`);
  if (p.features.length > 0) parts.push(`  Features: ${p.features.join("; ")}`);
  if (p.benefits.length > 0) parts.push(`  Benefits: ${p.benefits.join("; ")}`);
  if (p.specialOffers) parts.push(`  Special offer: ${p.specialOffers}`);
  return parts.join("\n");
}

/**
 * Renders the BUSINESS KNOWLEDGE block. Returns null when the organization
 * has no Business Knowledge on file at all, so callers can render an
 * explicit "none on file" line instead of an empty section.
 */
export function formatBusinessContext(context: BusinessContext): string | null {
  if (isBusinessContextEmpty(context)) {
    return null;
  }

  const sections: string[] = [];

  if (context.businessProfile) {
    const p = context.businessProfile;
    const lines = [
      p.name ? `Name: ${p.name}` : null,
      p.category ? `Category: ${p.category}` : null,
      p.description ? `Description: ${p.description}` : null,
      p.about ? `About: ${p.about}` : null,
      p.serviceArea ? `Service area: ${p.serviceArea}` : null,
      p.address ? `Address: ${p.address}` : null,
      p.openingHours ? `Opening hours: ${p.openingHours}` : null,
      p.website ? `Website: ${p.website}` : null,
      p.phone ? `Phone: ${p.phone}` : null,
      p.email ? `Email: ${p.email}` : null,
      p.whatsapp ? `WhatsApp: ${p.whatsapp}` : null,
    ].filter((line): line is string => line !== null);
    if (lines.length > 0) {
      sections.push(`BUSINESS PROFILE:\n${lines.join("\n")}`);
    }
  }

  if (context.productsServices.length > 0) {
    sections.push(`PRODUCTS / SERVICES:\n${context.productsServices.map(formatProduct).join("\n")}`);
  }

  const { keySellingPoints, productBenefits } = context.valueProposition;
  if (keySellingPoints.length > 0 || productBenefits.length > 0) {
    const lines = [
      keySellingPoints.length > 0 ? `Key selling points: ${keySellingPoints.join("; ")}` : null,
      productBenefits.length > 0 ? `Benefits across products/services: ${productBenefits.join("; ")}` : null,
    ].filter((line): line is string => line !== null);
    sections.push(`VALUE PROPOSITION / DIFFERENTIATORS:\n${lines.join("\n")}`);
  }

  if (context.faqs.length > 0) {
    sections.push(`FAQs:\n${context.faqs.map((f) => `- Q: ${f.question}\n  A: ${f.answer}`).join("\n")}`);
  }

  if (context.policies.length > 0) {
    sections.push(`BUSINESS POLICIES:\n${context.policies.map((p) => `- [${p.policyType}] ${p.title}: ${p.content}`).join("\n")}`);
  }

  if (context.aiCommunicationRules) {
    const r = context.aiCommunicationRules;
    const lines = [
      r.brandVoice ? `Brand voice: ${r.brandVoice}` : null,
      r.preferredLanguage ? `Preferred language: ${r.preferredLanguage}` : null,
      r.formality ? `Formality: ${r.formality}` : null,
      r.mustEmphasize.length > 0 ? `Must emphasize: ${r.mustEmphasize.join("; ")}` : null,
      r.mustNeverClaim.length > 0 ? `Must NEVER claim: ${r.mustNeverClaim.join("; ")}` : null,
      r.competitorComparisonRules ? `Competitor/comparison rules: ${r.competitorComparisonRules}` : null,
      r.discountAuthority ? `Discount authority: ${r.discountAuthority}` : null,
      r.escalationRules ? `Escalation rules: ${r.escalationRules}` : null,
      r.handoffTriggers.length > 0 ? `Hand off to a human when: ${r.handoffTriggers.join("; ")}` : null,
    ].filter((line): line is string => line !== null);
    if (lines.length > 0) {
      sections.push(`AI COMMUNICATION RULES:\n${lines.join("\n")}`);
    }
  }

  if (context.mediaReferences.length > 0) {
    sections.push(
      `RELEVANT MEDIA/ASSETS ON FILE (reference by name if useful, do not describe contents you haven't been given):\n${context.mediaReferences
        .map((m) => `- [${m.category}] ${m.title ?? m.fileName}`)
        .join("\n")}`
    );
  }

  return sections.join("\n\n");
}
