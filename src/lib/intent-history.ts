import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapIntentToBuyingIntent, type BuyingIntentSnapshot, type IntentCategory } from "@/lib/ai/agents/intent";
import type { Database } from "@/types/database.types";

type Client = SupabaseClient<Database>;

/**
 * A conversation's or lead's real recorded buying-intent history, replayed
 * from the conversation_events rows detectIntentAction (conversations/actions.ts)
 * already writes on every "Detect Intent" run — never re-inferred here.
 * Shared by the Lost Deal Intelligence agent (which feeds it to the AI as
 * evidence), the conversation detail page (which shows it as a timeline),
 * and the Buying Intent page (which uses the latest entry as "confidence").
 */

/** The intent history for a single conversation, in chronological order. */
export async function loadBuyingIntentHistory(supabase: Client, conversationId: string, organizationId: string): Promise<BuyingIntentSnapshot[]> {
  const { data } = await supabase
    .from("conversation_events")
    .select("payload, created_at")
    .eq("conversation_id", conversationId)
    .eq("organization_id", organizationId)
    .eq("event_type", "intent_detected")
    .order("created_at", { ascending: true });

  return (data ?? []).flatMap((row) => {
    const category = (row.payload as { intent?: string } | null)?.intent as IntentCategory | undefined;
    if (!category) return [];
    return [{ at: row.created_at, buyingIntent: mapIntentToBuyingIntent(category) }];
  });
}

export type LatestIntentSnapshot = { category: IntentCategory; buyingIntent: ReturnType<typeof mapIntentToBuyingIntent>; confidence: "low" | "medium" | "high"; at: string };

/**
 * The most recent intent_detected event across ANY of the given
 * conversations, keyed by conversation_id — one batched query rather than
 * one per conversation. Used to find a lead's latest detection: since
 * detectIntentAction writes leads.buying_intent from whichever of a lead's
 * conversations was last analyzed, look across all of that lead's
 * conversation ids, not just its most recently active one.
 */
export async function loadLatestIntentSnapshots(
  supabase: Client,
  conversationIds: string[],
  organizationId: string
): Promise<Map<string, LatestIntentSnapshot>> {
  const result = new Map<string, LatestIntentSnapshot>();
  const ids = [...new Set(conversationIds)].filter(Boolean);
  if (ids.length === 0) return result;

  const { data } = await supabase
    .from("conversation_events")
    .select("conversation_id, payload, created_at")
    .in("conversation_id", ids)
    .eq("organization_id", organizationId)
    .eq("event_type", "intent_detected")
    .order("created_at", { ascending: false });

  for (const row of data ?? []) {
    if (result.has(row.conversation_id)) continue; // already have the latest for this conversation (rows are newest-first)
    const payload = row.payload as { intent?: string; confidence?: string } | null;
    const category = payload?.intent as IntentCategory | undefined;
    if (!category) continue;
    const confidence = payload?.confidence === "low" || payload?.confidence === "medium" || payload?.confidence === "high" ? payload.confidence : "low";
    result.set(row.conversation_id, { category, buyingIntent: mapIntentToBuyingIntent(category), confidence, at: row.created_at });
  }

  return result;
}
