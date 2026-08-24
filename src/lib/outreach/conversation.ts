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
 *
 * A unique index on (organization_id, lead_id, channel) backs this
 * invariant at the database level (see the conversation_dedupe_index
 * migration) — two concurrent first-sends on a brand-new lead can't both
 * miss the "existing" check above and insert a duplicate; the loser's
 * insert fails with 23505 and falls back to the winner's row instead.
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

  if (created) return { ok: true, conversationId: created.id };

  if (error?.code === "23505") {
    const { data: winner } = await supabase
      .from("conversations")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("lead_id", leadId)
      .eq("channel", channel)
      .maybeSingle();
    if (winner) return { ok: true, conversationId: winner.id };
  }

  return { ok: false, message: error?.message ?? "Could not create a conversation for this lead." };
}
