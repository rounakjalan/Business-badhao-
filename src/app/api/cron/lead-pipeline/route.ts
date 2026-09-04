import { NextResponse } from "next/server";
import { findEligibleCampaigns, runDiscoveryForCampaign, finishPendingLeads, type PipelineRunSummary } from "@/lib/pipeline/scheduled-pipeline";
import { checkRepliesForAllConnectedOrganizations } from "@/lib/gmail/replies";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The scheduled half of the lead pipeline — the part that connects the
 * campaign space to the lead space with nobody clicking anything.
 *
 * Lead discovery finds only a handful of businesses per run — the extraction
 * step has to fit inside the AI provider's per-minute token allowance, so a
 * single run cannot be made much bigger without failing outright. Running on
 * a schedule is the way to accumulate leads over time without the AI running
 * continuously: each cycle adds a fresh batch, deduplicated against
 * everything already found.
 *
 * This sweep ticks hourly, but a campaign is only discovered for when its own
 * discovery_next_run_at slot is due (roughly an hour after its last run) and
 * its discovery has not been stopped — see discovery-schedule.ts. The tick
 * rate is therefore the resolution of the cycle, not its frequency: raising
 * it would not make any one campaign search more often.
 *
 * It also removes the clicking, in both directions:
 * - On the campaign side: a campaign only needs a saved ICP to be reachable.
 *   findEligibleCampaigns auto-launches a draft or planning campaign that
 *   already has one, since the ICP — not the status — is what actually
 *   determines whether there is anything to go find.
 * - On the lead side: leads left unresearched because a run hit its time
 *   budget, or whose research failed, are picked up automatically instead of
 *   waiting for someone to open each one and press two buttons.
 *
 * Order: finish the existing backlog before discovering anything new, so a
 * campaign with a long backlog can't have that work crowded out by fresh
 * discovery — then, budget permitting, finish again. Without that second
 * pass, every lead a campaign's own discovery step just created would sit
 * untouched until tomorrow's run, adding a full day of pure dead time
 * between "found" and "qualified" by construction, every single day.
 *
 * This endpoint's name predates a second, unrelated responsibility it now
 * also carries: pulling in real inbound Gmail replies for every connected
 * organization (see checkRepliesForAllConnectedOrganizations,
 * gmail/replies.ts), which is what makes the Conversation Agent and
 * Buying Intent detection run automatically instead of only when someone
 * presses "Check for Replies". Kept on this same cron entry rather than a
 * second one — this deployment's plan allows only a small number of
 * scheduled functions, and daily is already the actual cadence for
 * everything on this route, Gmail included; not renamed, to avoid
 * re-registering the cron path for no functional reason.
 */

// This does real AI work per lead, so it needs the long end of the platform's
// allowance rather than the default.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const TOTAL_BUDGET_MS = 240_000;

/**
 * Own slice of the total request budget, spent first: a real customer
 * waiting on a reply matters more than discovering one more prospect, and
 * capping it here means a busy mailbox can never crowd out the rest of
 * this sweep the way an unbounded pass could.
 */
const GMAIL_REPLY_BUDGET_MS = 60_000;

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
    autoLaunched: [],
    leadsFinished: 0,
    leadsFailed: 0,
    discoveryRuns: 0,
    newLeads: 0,
    skipped: [],
  };

  // Real inbound Gmail replies, for every organization with a connected
  // account — automatic ingestion (this call), not the manual "Check for
  // Replies" button, which stays as an on-demand fallback. Runs first, on
  // its own bounded sub-budget, before any lead-discovery work below: see
  // checkRepliesForAllConnectedOrganizations (gmail/replies.ts) for how
  // this reuses checkForReplies completely unchanged — same per-message
  // dedup, same human-takeover gate inside respondToConversation, same
  // token refresh.
  const gmailReplies = await checkRepliesForAllConnectedOrganizations(startedAtMs, GMAIL_REPLY_BUDGET_MS);

  const campaigns = await findEligibleCampaigns(supabase);
  summary.campaignsConsidered = campaigns.length;
  summary.autoLaunched = campaigns.filter((c) => c.wasAutoLaunched).map((c) => c.id);

  const outOfTime = () => Date.now() - startedAtMs > TOTAL_BUDGET_MS;

  // Pass 1: finish whatever backlog already existed before this run, so a
  // campaign with a lot of it can't have that work crowded out by fresh
  // discovery on other campaigns.
  for (const campaign of campaigns) {
    if (outOfTime()) {
      summary.skipped.push({ campaignId: campaign.id, reason: "out_of_time" });
      continue;
    }
    const finished = await finishPendingLeads(supabase, campaign.organizationId, campaign.id, startedAtMs, TOTAL_BUDGET_MS);
    summary.leadsFinished += finished.finished;
    summary.leadsFailed += finished.failed;
  }

  // Pass 2: discovery — only for campaigns whose next scheduled run is
  // actually due. This sweep runs hourly, so most campaigns are skipped on
  // most ticks; a campaign the user stopped is never picked up at all.
  for (const campaign of campaigns) {
    if (outOfTime()) {
      summary.skipped.push({ campaignId: campaign.id, reason: "out_of_time" });
      continue;
    }
    if (!campaign.discoveryDue) {
      summary.skipped.push({ campaignId: campaign.id, reason: campaign.discoverySkipReason ?? "not_due" });
      continue;
    }
    const discovered = await runDiscoveryForCampaign(supabase, campaign.organizationId, campaign.id, startedAtMs, TOTAL_BUDGET_MS);
    if (discovered.ran) {
      summary.discoveryRuns += 1;
      summary.newLeads += discovered.newLeads;
    } else if (discovered.reason) {
      summary.skipped.push({ campaignId: campaign.id, reason: discovered.reason });
    }
  }

  // Pass 3: finish again, budget permitting. Whatever pass 2 just
  // discovered is still sitting "pending" — without this, it would wait
  // until tomorrow's run no matter how much time is left today.
  for (const campaign of campaigns) {
    if (outOfTime()) continue;
    const finished = await finishPendingLeads(supabase, campaign.organizationId, campaign.id, startedAtMs, TOTAL_BUDGET_MS);
    summary.leadsFinished += finished.finished;
    summary.leadsFailed += finished.failed;
  }

  return NextResponse.json({
    ok: true,
    ...summary,
    gmailReplies,
    elapsedMs: Date.now() - startedAtMs,
  });
}
