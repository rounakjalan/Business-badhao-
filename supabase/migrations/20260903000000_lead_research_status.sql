-- =============================================================================
-- Automatic AI Research: distinguishing "never researched", "in progress",
-- "researched successfully" and "research failed" for a lead.
--
-- Before this, a lead's only research signal was whether a lead_research row
-- existed for it — a successful run and a lead nobody had ever researched
-- both had none... no, wait: a successful run HAS a row, but a genuinely
-- attempted-and-failed run leaves no row at all, which is indistinguishable
-- from "never attempted". That was fine while research only ever ran from a
-- human pressing a button and watching the result. It stops being fine once
-- research runs automatically and unattended: without a durable "this failed"
-- marker, the scheduled sweep would re-attempt a permanently failing lead
-- (e.g. one with genuinely nothing to reason over) on every single hourly
-- cycle forever — an uncontrolled, unbounded cost with nothing in the UI to
-- show it's happening.
--
-- Mirrors the existing leads.qualification_status pattern exactly, so the
-- automatic pipeline can tell "attempt this" (pending/researching) apart
-- from "already have real evidence, don't redo it" (completed) and "already
-- tried for real and it didn't work, leave it for a human to retry"
-- (failed).
-- =============================================================================

alter table public.leads
  add column if not exists research_status text not null default 'pending'
    check (research_status in ('pending', 'researching', 'completed', 'failed')),
  add column if not exists research_error text;

-- Backfill: a lead that already has a lead_research row was already
-- genuinely researched by the existing manual flow — mark it 'completed'
-- rather than letting the new default make it look unresearched to the
-- automatic sweep, which would otherwise research it a second time.
update public.leads
set research_status = 'completed'
where id in (select distinct lead_id from public.lead_research);

comment on column public.leads.research_status is
  'AI Research lifecycle: pending | researching | completed | failed. The automatic pipeline only ever attempts a lead once (pending/researching); a failed lead is left for the manual "Run AI Research" button to retry, never auto-retried on a later cycle.';
comment on column public.leads.research_error is
  'Why the most recent AI Research attempt failed, for display on the lead page. Cleared on a successful attempt.';
