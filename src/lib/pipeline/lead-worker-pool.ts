import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { qualifyLead, researchLead, sendAutomaticWhatsAppOutreach } from "@/lib/pipeline/lead-pipeline";
import type { Database } from "@/types/database.types";

type Client = SupabaseClient<Database>;

/**
 * Tallies what selectOutreachChannel/sendAutomaticWhatsAppOutreach actually
 * did across every qualified lead a pool touched — never a claim that a
 * message was delivered, only what this deployment attempted and what Meta
 * (or the eligibility check) actually reported back. gmailManualPending
 * counts leads left for a human to send Gmail outreach to manually (this
 * automatic sweep never sends email itself); noChannelAvailable counts
 * leads with no usable channel at all right now (e.g. no phone, no
 * connected account) — never silently dropped, always one of these buckets.
 */
export type OutreachSweepSummary = {
  whatsappSent: number;
  whatsappFailed: number;
  gmailManualPending: number;
  noChannelAvailable: number;
};

export function emptyOutreachSummary(): OutreachSweepSummary {
  return { whatsappSent: 0, whatsappFailed: 0, gmailManualPending: 0, noChannelAvailable: 0 };
}

export function addOutreachSummary(into: OutreachSweepSummary, from: OutreachSweepSummary) {
  into.whatsappSent += from.whatsappSent;
  into.whatsappFailed += from.whatsappFailed;
  into.gmailManualPending += from.gmailManualPending;
  into.noChannelAvailable += from.noChannelAvailable;
}

/**
 * How many leads this pool researches at once. Bounded deliberately, not an
 * unbounded Promise.all over however many leads a run finds — Hermes,
 * Nemotron, Tavily/Exa and Supabase all sit behind real per-minute/
 * concurrent-request limits, and a single serverless invocation has its own
 * memory/CPU ceiling regardless of how many network calls it juggles.
 */
export const DEFAULT_RESEARCH_CONCURRENCY = 3;

export type LeadWorkerPoolSummary = {
  finished: number;
  failed: number;
  /** A job this pool declined to (re)start because the lead was already being researched elsewhere (a concurrent manual click, an overlapping sweep) — see researchLead's own atomic claim. Never counted as a failure. */
  skippedAlreadyInProgress: number;
  outreach: OutreachSweepSummary;
};

export type LeadWorkerPool = {
  /**
   * Queues a lead for research -> qualification -> automatic outreach.
   * Returns immediately without awaiting any of that work, so a caller
   * still discovering more leads (or fetching another search batch) is
   * never blocked by it. Safe to call more than once for the same lead —
   * this pool only ever runs one job per lead at a time; a repeat call
   * while that job is still queued/running is a no-op.
   */
  enqueue(leadId: string): void;
  /**
   * Resolves once every already-enqueued job has either completed or been
   * left for later by this pool's own time budget — "as much as fits,"
   * never "everything no matter how long it takes." Never rejects: a single
   * lead's own failure is tallied in `summary`, not thrown.
   */
  drain(): Promise<void>;
  /** Live tallies — safe to read at any point, including before drain() resolves, for progress reporting. */
  readonly summary: LeadWorkerPoolSummary;
};

/**
 * A small bounded-concurrency worker pool for the research -> qualification
 * -> automatic-outreach chain (researchLead/qualifyLead/
 * sendAutomaticWhatsAppOutreach, lead-pipeline.ts) — the mechanism that lets
 * a newly discovered lead start real AI research the moment it is
 * persisted, running concurrently with whatever discovery batch comes next,
 * instead of waiting for an entire discovery run to finish and then working
 * through a list one lead at a time.
 *
 * Never depends on the invoking request outliving its own response: every
 * job here runs to completion (or is abandoned by drain()'s own budget
 * check, before ever starting) entirely within the same async call stack
 * the caller is already awaiting. There is no background execution outside
 * the request's own lifetime — deliberately, per this project's serverless
 * constraints; concurrency comes from ordinary overlapping I/O-bound
 * promises (network calls), not from anything surviving past the response.
 *
 * One lead's own timeout or failure never aborts another's, and never
 * blocks whatever discovery is still doing alongside this pool — each job
 * is caught independently (see runOneLead below).
 */
export function createLeadWorkerPool(params: {
  supabase: Client;
  organizationId: string;
  startedAtMs: number;
  budgetMs: number;
  concurrency?: number;
}): LeadWorkerPool {
  const { supabase, organizationId, startedAtMs, budgetMs, concurrency = DEFAULT_RESEARCH_CONCURRENCY } = params;

  const queue: string[] = [];
  const inFlight = new Set<string>();
  let active = 0;
  const idleWaiters: (() => void)[] = [];

  const summary: LeadWorkerPoolSummary = {
    finished: 0,
    failed: 0,
    skippedAlreadyInProgress: 0,
    outreach: emptyOutreachSummary(),
  };

  // A small reserve, not the discovery loop's own — this only needs to stop
  // STARTING new jobs a little before the shared deadline; jobs already
  // running are always let finish (or fail on their own stage-specific
  // timeout), never aborted mid-flight.
  function outOfTime(): boolean {
    return Date.now() - startedAtMs > budgetMs - 15_000;
  }

  function notifyIfIdle() {
    if (active === 0 && queue.length === 0) {
      const waiters = idleWaiters.splice(0);
      waiters.forEach((resolve) => resolve());
    }
  }

  async function runOneLead(leadId: string): Promise<void> {
    try {
      // A lead already holding real research ('completed') is never
      // re-researched — that would waste the AI/search budget and create a
      // second lead_research row for no reason. Checked here rather than
      // left to researchLead's own atomic claim, because that claim only
      // ever guards against a SECOND *concurrent* attempt — it says nothing
      // about a lead that already finished successfully some time ago and
      // is only back in this pool for qualification (e.g. an earlier
      // qualification attempt failed) or re-enqueued as backlog.
      const { data: existingLead } = await supabase.from("leads").select("research_status").eq("id", leadId).eq("organization_id", organizationId).maybeSingle();

      if (existingLead?.research_status !== "completed") {
        const research = await researchLead(supabase, organizationId, leadId);
        if (!research.ok) {
          if (research.code === "already_in_progress") {
            summary.skippedAlreadyInProgress += 1;
          } else {
            summary.failed += 1;
          }
          return;
        }
      }

      const qualification = await qualifyLead(supabase, organizationId, leadId);
      if (!qualification.ok) {
        summary.failed += 1;
        return;
      }
      summary.finished += 1;

      if (qualification.qualification.recommendedStatus !== "qualified") return;

      const outcome = await sendAutomaticWhatsAppOutreach(supabase, organizationId, leadId);
      if (outcome.attempted) {
        if (outcome.ok) summary.outreach.whatsappSent += 1;
        else summary.outreach.whatsappFailed += 1;
      } else if (outcome.channel === "gmail_manual") {
        summary.outreach.gmailManualPending += 1;
      } else if (outcome.reason !== "already_contacted" && outcome.reason !== "already_sent" && outcome.reason !== "not_found") {
        // Every other skip reason (no phone, WhatsApp not connected/no
        // template, campaign opted out, max attempts reached, generation
        // failed) means this lead genuinely has no automatic channel right
        // now — worth surfacing, exactly as finishPendingLeads always did.
        summary.outreach.noChannelAvailable += 1;
      }
    } catch (error) {
      // A genuinely unexpected throw — not the normal ok:false path every
      // stage already uses — must still never take down a sibling lead's
      // own job, or whatever discovery is still doing alongside this pool.
      console.error("[lead-worker-pool] unexpected error researching lead", leadId, error);
      summary.failed += 1;
    }
  }

  function pump() {
    while (active < concurrency && queue.length > 0) {
      if (outOfTime()) {
        // Whatever is still queued is left exactly as it was found (still
        // "pending", or "researching" if a job for it happened to already
        // be in flight) for the next sweep to pick up — never started here,
        // never counted as a failure.
        queue.length = 0;
        break;
      }
      const leadId = queue.shift();
      if (leadId === undefined) break;
      active += 1;
      void runOneLead(leadId).finally(() => {
        inFlight.delete(leadId);
        active -= 1;
        pump();
        notifyIfIdle();
      });
    }
    notifyIfIdle();
  }

  return {
    enqueue(leadId: string) {
      if (inFlight.has(leadId)) return; // Already queued or actively running in this pool instance — researchLead's own atomic claim covers the cross-instance/cross-request case.
      inFlight.add(leadId);
      queue.push(leadId);
      pump();
    },
    async drain() {
      if (active === 0 && queue.length === 0) return;
      await new Promise<void>((resolve) => idleWaiters.push(resolve));
    },
    summary,
  };
}
