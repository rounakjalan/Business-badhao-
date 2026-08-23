import { NextResponse } from "next/server";
import { runDiscoveryForCampaign, finishPendingLeads, type PipelineRunSummary } from "@/lib/pipeline/scheduled-pipeline";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The scheduled half of the lead pipeline.
 *
 * Lead discovery finds only a handful of businesses per run — the extraction
 * step has to fit inside the AI provider's per-minute token allowance, so a
 * single run cannot be made much bigger without failing outright. Running on
 * a schedule is the way to accumulate leads over time without the AI running
 * continuously: each day adds a fresh batch, deduplicated against everything
 * already found.
 *
 * It also removes the clicking. Leads left unresearched because a run hit its
 * time budget, or whose research failed, are picked up here instead of
 * waiting for someone to open each one and press two buttons.
 *
 * Order matters: unfinished leads are completed before any new ones are
 * discovered, so the backlog cannot grow faster than it is worked off.
 */

// This does real AI work per lead, so it needs the long end of the platform's
// allowance rather than the default.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const TOTAL_BUDGET_MS = 240_000;

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;

  // Without a secret this endpoint would let anyone on the internet spend the
  // account's AI budget, so it stays closed rather than open by default.
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "not_configured", detail: "CRON_SECRET is not set — scheduled automation is disabled." },
      { status: 503 }
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return unauthorized();

  const supabase = createAdminClient();
  if (!supabase) {
    return NextResponse.json(
      {
        ok: false,
        error: "not_configured",
        detail: "SUPABASE_SERVICE_ROLE_KEY is not set. Scheduled work runs without a signed-in user, so it cannot read data through row-level security.",
      },
      { status: 503 }
    );
  }

  const startedAtMs = Date.now();
  const summary: PipelineRunSummary = {
    startedAt: new Date().toISOString(),
    campaignsConsidered: 0,
    leadsFinished: 0,
    leadsFailed: 0,
    discoveryRuns: 0,
    newLeads: 0,
    skipped: [],
  };

  // Only active campaigns. Pausing a campaign is what stops its automation,
  // which is what pausing already means everywhere else in the app.
  const { data: campaigns, error } = await supabase
    .from("campaigns")
    .select("id, organization_id, ideal_customer_profile_id")
    .eq("status", "active")
    .not("ideal_customer_profile_id", "is", null);

  if (error) {
    return NextResponse.json({ ok: false, error: "query_failed", detail: error.message }, { status: 500 });
  }

  summary.campaignsConsidered = campaigns?.length ?? 0;

  // Finish what is already on the books before looking for more.
  for (const campaign of campaigns ?? []) {
    if (Date.now() - startedAtMs > TOTAL_BUDGET_MS) {
      summary.skipped.push({ campaignId: campaign.id, reason: "out_of_time" });
      continue;
    }
    const finished = await finishPendingLeads(supabase, campaign.organization_id, campaign.id, startedAtMs, TOTAL_BUDGET_MS);
    summary.leadsFinished += finished.finished;
    summary.leadsFailed += finished.failed;
  }

  for (const campaign of campaigns ?? []) {
    if (Date.now() - startedAtMs > TOTAL_BUDGET_MS) {
      summary.skipped.push({ campaignId: campaign.id, reason: "out_of_time" });
      continue;
    }
    const discovered = await runDiscoveryForCampaign(supabase, campaign.organization_id, campaign.id, startedAtMs, TOTAL_BUDGET_MS);
    if (discovered.ran) {
      summary.discoveryRuns += 1;
      summary.newLeads += discovered.newLeads;
    } else if (discovered.reason) {
      summary.skipped.push({ campaignId: campaign.id, reason: discovered.reason });
    }
  }

  return NextResponse.json({
    ok: true,
    ...summary,
    elapsedMs: Date.now() - startedAtMs,
  });
}
