import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { AiToolDefinition } from "@/lib/ai/types";

// Read-only, organization-scoped tools the model can call mid-completion
// (see runWithTools in hermes-service.ts). Every query here filters on
// organization_id derived from the server-side session (HermesRequest.
// organizationId, itself always set by the caller via getCurrentOrg() —
// never taken from the model's tool-call arguments), and additionally
// runs through the RLS-respecting authenticated client, so a tool call
// can never read another organization's data even if the model tries to
// pass a foreign id. No tool here writes anything.

export const HERMES_TOOL_DEFINITIONS: AiToolDefinition[] = [
  {
    name: "lookup_lead",
    description:
      "Fetch one lead's current record (status, qualification, score, notes, next action) by its id, scoped to the signed-in organization. Use this when you need more detail on a specific lead than what's already in the prompt.",
    parameters: {
      type: "object",
      properties: { leadId: { type: "string", description: "The lead's id." } },
      required: ["leadId"],
    },
  },
  {
    name: "search_leads",
    description:
      "Search the signed-in organization's leads by contact name. Returns up to 5 matches with id, name, status, and score. Use this when you know a name but not the lead's id.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Contact name (or part of one) to search for." } },
      required: ["query"],
    },
  },
  {
    name: "lookup_deal",
    description:
      "Fetch one deal's current record (title, value, status, loss reason if any) by its id, scoped to the signed-in organization.",
    parameters: {
      type: "object",
      properties: { dealId: { type: "string", description: "The deal's id." } },
      required: ["dealId"],
    },
  },
];

export type ToolExecutionResult = { ok: true; data: unknown } | { ok: false; error: string };

const LookupLeadArgs = z.object({ leadId: z.string().min(1) });
const SearchLeadsArgs = z.object({ query: z.string().min(1) });
const LookupDealArgs = z.object({ dealId: z.string().min(1) });

async function executeLookupLead(organizationId: string, rawArgs: unknown): Promise<ToolExecutionResult> {
  const parsed = LookupLeadArgs.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: "invalid arguments: leadId is required" };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("leads")
    .select("id, status, qualification_status, current_score, intent, notes, next_action")
    .eq("id", parsed.data.leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) return { ok: false, error: "lookup failed" };
  if (!data) return { ok: false, error: "no lead found with that id in this organization" };
  return { ok: true, data };
}

async function executeSearchLeads(organizationId: string, rawArgs: unknown): Promise<ToolExecutionResult> {
  const parsed = SearchLeadsArgs.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: "invalid arguments: query is required" };

  const supabase = await createClient();
  const { data: contacts, error: contactsError } = await supabase
    .from("contacts")
    .select("full_name, lead_id")
    .eq("organization_id", organizationId)
    .ilike("full_name", `%${parsed.data.query}%`)
    .limit(5);

  if (contactsError) return { ok: false, error: "search failed" };
  if (!contacts || contacts.length === 0) return { ok: true, data: { matches: [] } };

  const leadIds = contacts.map((c) => c.lead_id);
  const { data: leads, error: leadsError } = await supabase
    .from("leads")
    .select("id, status, qualification_status, current_score")
    .in("id", leadIds)
    .eq("organization_id", organizationId);

  if (leadsError) return { ok: false, error: "search failed" };

  const matches = contacts.map((c) => {
    const lead = (leads ?? []).find((l) => l.id === c.lead_id);
    return { leadId: c.lead_id, contactName: c.full_name, status: lead?.status ?? null, score: lead?.current_score ?? null };
  });

  return { ok: true, data: { matches } };
}

async function executeLookupDeal(organizationId: string, rawArgs: unknown): Promise<ToolExecutionResult> {
  const parsed = LookupDealArgs.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: "invalid arguments: dealId is required" };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("deals")
    .select("id, title, status, value, currency, loss_reason")
    .eq("id", parsed.data.dealId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) return { ok: false, error: "lookup failed" };
  if (!data) return { ok: false, error: "no deal found with that id in this organization" };
  return { ok: true, data };
}

/**
 * Executes a tool call by name, always scoped to organizationId. Never
 * throws — a bad tool name, unparsable arguments, or a DB error all become
 * a `{ ok: false, error }` result so the model can see and react to the
 * failure instead of the whole Hermes call blowing up.
 */
export async function executeTool(organizationId: string, name: string, rawArguments: string): Promise<ToolExecutionResult> {
  let args: unknown;
  try {
    args = JSON.parse(rawArguments);
  } catch {
    return { ok: false, error: "invalid arguments: could not parse as JSON" };
  }

  switch (name) {
    case "lookup_lead":
      return executeLookupLead(organizationId, args);
    case "search_leads":
      return executeSearchLeads(organizationId, args);
    case "lookup_deal":
      return executeLookupDeal(organizationId, args);
    default:
      return { ok: false, error: `unknown tool: ${name}` };
  }
}
