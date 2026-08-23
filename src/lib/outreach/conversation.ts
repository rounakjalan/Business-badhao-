import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

type Client = SupabaseClient<Database>;
type Channel = Database["public"]["Tables"]["conversations"]["Row"]["channel"];

export type EnsureConversationResult = { ok: true; conversationId: string } | { ok: false; message: string };

/**
 * Finds the lead's existing conversation on this channel, or creates one.
 * Shared by the outreach-send path (first message on a channel starts the
 * thread) and the reply-poll path (a reply from a lead with no prior
 * outbound message still needs somewhere to land) so both agree on what
 * "the conversation" for a lead+channel means.
 */
export async function ensureConversation(supabase: Client, organizationId: string, leadId: string, channel: Channel): Promise<EnsureConversationResult> {
  const { data: existing } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("lead_id", leadId)
    .eq("channel", channel)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return { ok: true, conversationId: existing.id };

  const { data: lead } = await supabase.from("leads").select("campaign_id").eq("id", leadId).eq("organization_id", organizationId).maybeSingle();

  const { data: created, error } = await supabase
    .from("conversations")
    .insert({ organization_id: organizationId, lead_id: leadId, campaign_id: lead?.campaign_id ?? null, channel, status: "open" })
    .select("id")
    .single();

  if (error || !created) return { ok: false, message: error?.message ?? "Could not create a conversation for this lead." };
  return { ok: true, conversationId: created.id };
}
