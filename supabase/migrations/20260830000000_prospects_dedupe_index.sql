-- Database-level backstop for prospect deduplication.
--
-- Lead Discovery already deduplicates in application code before inserting
-- (src/lib/ai/agents/discovery.ts's prospectDedupeKey/dedupeProspects, plus
-- the cross-run check in campaigns/actions.ts and scheduled-pipeline.ts that
-- reads existing prospects for the org before persisting). That check-then-
-- insert is not atomic: two discovery runs for the same org racing each
-- other (an interactive click landing while the daily cron's run for the
-- same org is also in flight, or two campaigns' runs overlapping) could each
-- read the same "not yet present" snapshot and both insert. dedupe_key
-- mirrors prospectDedupeKey's normalization (canonical website domain, or a
-- normalized-name fallback when there is no website) as a generated column,
-- so every prospect always carries it regardless of which code path
-- inserted the row, and the unique index makes a genuine duplicate a
-- rejected insert rather than a second row silently entering the pipeline.
--
-- NULL when neither website nor company_name yields anything to key on;
-- Postgres never treats two NULLs as equal in a unique index, so such a row
-- (nothing in the codebase currently inserts one) is simply not covered by
-- the guarantee rather than blocked.
alter table public.prospects
  add column dedupe_key text generated always as (
    coalesce(
      nullif(
        regexp_replace(
          regexp_replace(regexp_replace(lower(website), '^https?://', ''), '^www\.', ''),
          '/.*$',
          ''
        ),
        ''
      ),
      case when company_name is not null then 'name:' || lower(trim(company_name)) else null end
    )
  ) stored;

create unique index prospects_org_dedupe_key_idx on public.prospects (organization_id, dedupe_key);
