-- =============================================================================
-- Recurring campaign lead discovery.
--
-- A discovery run has always been a one-shot: it spends its existing time
-- budget (the platform kills a serverless function at 300s, so the run stops
-- itself at ~4 minutes — see FOLLOW_UP_BUDGET_MS in campaigns/actions.ts) and
-- then nothing brings the campaign back until someone presses the button
-- again. These columns turn that single run into a cycle the existing cron
-- sweep (/api/cron/lead-pipeline) can continue on its own, roughly hourly.
--
-- discovery_next_run_at is deliberately ONE column rather than a job queue:
-- a campaign can only ever hold a single pending discovery slot, so a
-- duplicate schedule for the same campaign is impossible by construction
-- rather than by a uniqueness rule someone has to remember to enforce.
-- Rescheduling is an UPDATE of that slot, never an INSERT of another job.
--
-- Default 'scheduled' is what the app already does, made explicit: the daily
-- sweep has always picked up every active campaign with a usable ICP without
-- anyone opting in. 'stopped' is the new explicit off switch, and is the only
-- state the sweep refuses to act on.
-- =============================================================================

alter table public.campaigns
  add column if not exists discovery_state text not null default 'scheduled'
    check (discovery_state in ('running', 'scheduled', 'stopped', 'completed', 'failed')),
  add column if not exists discovery_next_run_at timestamptz,
  add column if not exists discovery_last_run_at timestamptz,
  add column if not exists discovery_last_error text;

-- Exactly the predicate the sweep reads (see findEligibleCampaigns): campaigns
-- that are not stopped, ordered by when their next discovery is due. A NULL
-- discovery_next_run_at means "never scheduled yet" and is treated as due, so
-- campaigns that existed before this migration keep being swept as they were.
create index if not exists campaigns_discovery_due_idx
  on public.campaigns(discovery_next_run_at)
  where discovery_state <> 'stopped';

comment on column public.campaigns.discovery_state is
  'Recurring discovery lifecycle: running | scheduled | stopped | completed | failed. Only ''stopped'' blocks the scheduled sweep.';
comment on column public.campaigns.discovery_next_run_at is
  'When the next scheduled discovery run becomes due. NULL means due now (never scheduled). Single-slot by design — prevents duplicate scheduling for one campaign.';
comment on column public.campaigns.discovery_last_error is
  'Why the most recent discovery run failed, as reported by the provider. Cleared on the next successful run.';
