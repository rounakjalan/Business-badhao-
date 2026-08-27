import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

type Client = SupabaseClient<Database>;

export type LeadIdentity = { name: string; email: string | null; phone: string | null };

const UNKNOWN: LeadIdentity = { name: "Unnamed lead", email: null, phone: null };

/**
 * Resolves what a lead should be called on screen.
 *
 * Discovery finds businesses, not people: it writes a company onto the
 * prospect and never creates a contact. Reading a name from `contacts`
 * alone therefore leaves every AI-discovered lead — the majority of them —
 * displayed as "Unnamed lead" across the whole app. The company is the
 * lead's real identity until someone adds a person to it.
 */
export async function resolveLeadIdentities(supabase: Client, leadIds: string[]): Promise<Map<string, LeadIdentity>> {
  const ids = [...new Set(leadIds)].filter(Boolean);
  const identities = new Map<string, LeadIdentity>();
  if (ids.length === 0) return identities;

  const [contacts, leads] = await Promise.all([
    supabase.from("contacts").select("lead_id, full_name, email, phone").in("lead_id", ids).eq("is_primary", true),
    supabase.from("leads").select("id, prospect_id").in("id", ids),
  ]);

  const prospectIds = (leads.data ?? []).map((l) => l.prospect_id).filter((id): id is string => Boolean(id));
  const { data: prospects } = prospectIds.length
    ? await supabase.from("prospects").select("id, company_name, contact_name, email, phone").in("id", prospectIds)
    : { data: [] };

  const contactByLead = new Map((contacts.data ?? []).map((c) => [c.lead_id, c]));
  const prospectById = new Map((prospects ?? []).map((p) => [p.id, p]));

  for (const lead of leads.data ?? []) {
    const contact = contactByLead.get(lead.id);
    const prospect = lead.prospect_id ? prospectById.get(lead.prospect_id) : null;
    identities.set(lead.id, {
      name: contact?.full_name ?? prospect?.contact_name ?? prospect?.company_name ?? UNKNOWN.name,
      email: contact?.email ?? prospect?.email ?? null,
      phone: contact?.phone ?? prospect?.phone ?? null,
    });
  }

  return identities;
}

export async function resolveLeadIdentity(supabase: Client, leadId: string): Promise<LeadIdentity> {
  const identities = await resolveLeadIdentities(supabase, [leadId]);
  return identities.get(leadId) ?? UNKNOWN;
}
