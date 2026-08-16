"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function markDealWon(dealId: string) {
  const supabase = await createClient();
  const { data: deal } = await supabase.from("deals").select("organization_id").eq("id", dealId).maybeSingle();
  await supabase.from("deals").update({ status: "won", won_at: new Date().toISOString() }).eq("id", dealId);

  if (deal) {
    await supabase.from("deal_events").insert({ organization_id: deal.organization_id, deal_id: dealId, event_type: "won" });
  }

  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals");
  revalidatePath("/dashboard");
}

export async function markDealLost(dealId: string, lossReason: string) {
  const supabase = await createClient();
  const { data: deal } = await supabase.from("deals").select("organization_id").eq("id", dealId).maybeSingle();

  await supabase
    .from("deals")
    .update({ status: "lost", lost_at: new Date().toISOString(), loss_reason: lossReason || null })
    .eq("id", dealId);

  if (deal) {
    await supabase.from("deal_events").insert({ organization_id: deal.organization_id, deal_id: dealId, event_type: "lost" });
    if (lossReason) {
      await supabase.from("loss_analysis").insert({
        organization_id: deal.organization_id,
        deal_id: dealId,
        reason_category: lossReason,
      });
    }
  }

  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals");
  revalidatePath("/dashboard");
}

export async function updateDealStage(dealId: string, status: "open" | "negotiation" | "won" | "lost") {
  const supabase = await createClient();
  await supabase.from("deals").update({ status }).eq("id", dealId);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/deals");
}
