-- =============================================================================
-- Analytics scalability fix (audit finding: "Analytics aggregates in JS
-- across 7+ sequential/parallel queries").
--
-- The Analytics page used to fetch every lead/conversation/deal/prospect
-- row for an organization and group them by campaign_id/lead_source_id in
-- JavaScript. That transfers O(rows) data for an O(1)-sized answer and gets
-- linearly slower as an org's lead/deal counts grow. These three functions
-- move that grouping into Postgres, which already holds the rows and can
-- aggregate them without shipping a single one to the application.
--
-- Every function is SECURITY INVOKER (the default — stated explicitly so
-- it can never silently change): called through the normal signed-in-user
-- client, each function's internal queries are still subject to the exact
-- same `is_org_member(organization_id)` RLS policies already enforced on
-- leads/conversations/deals/prospects/campaigns/lead_sources — nothing here
-- bypasses RLS. The explicit `organization_id = p_organization_id` filter
-- inside every function is this codebase's established defense-in-depth
-- pattern (explicit org scoping alongside RLS, never RLS alone), not a
-- replacement for RLS.
--
-- Each function aggregates every joined table in its OWN subquery before
-- joining those pre-aggregated, one-row-per-key results together. Joining
-- leads + conversations + deals directly on a shared campaign_id without
-- this would fan out into a cross product (e.g. 5 leads x 3 conversations x
-- 2 deals = 30 rows for one campaign before grouping), which would silently
-- multiply sum(value) and every count by however many rows the OTHER joined
-- tables happened to contribute that run — a real correctness bug, not a
-- style choice.
-- =============================================================================

create or replace function public.analytics_campaign_performance(p_organization_id uuid)
returns table (
  campaign_id uuid,
  campaign_name text,
  leads_count bigint,
  qualified_count bigint,
  conversations_count bigint,
  deals_count bigint,
  won_count bigint,
  revenue numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    c.id as campaign_id,
    c.name as campaign_name,
    coalesce(lead_agg.leads_count, 0) as leads_count,
    coalesce(lead_agg.qualified_count, 0) as qualified_count,
    coalesce(conv_agg.conversations_count, 0) as conversations_count,
    coalesce(deal_agg.deals_count, 0) as deals_count,
    coalesce(deal_agg.won_count, 0) as won_count,
    coalesce(deal_agg.revenue, 0) as revenue
  from public.campaigns c
  left join (
    select
      campaign_id,
      count(*) as leads_count,
      count(*) filter (where qualification_status = 'qualified') as qualified_count
    from public.leads
    where organization_id = p_organization_id and campaign_id is not null
    group by campaign_id
  ) lead_agg on lead_agg.campaign_id = c.id
  left join (
    select campaign_id, count(*) as conversations_count
    from public.conversations
    where organization_id = p_organization_id and campaign_id is not null
    group by campaign_id
  ) conv_agg on conv_agg.campaign_id = c.id
  left join (
    select
      campaign_id,
      count(*) as deals_count,
      count(*) filter (where status = 'won') as won_count,
      sum(value) filter (where status = 'won') as revenue
    from public.deals
    where organization_id = p_organization_id and campaign_id is not null
    group by campaign_id
  ) deal_agg on deal_agg.campaign_id = c.id
  where c.organization_id = p_organization_id
  order by c.name;
$$;

comment on function public.analytics_campaign_performance(uuid) is
  'One row per campaign in the given organization with leads/qualified/conversations/deals/won counts and won revenue, aggregated in SQL for the Analytics page (replaces fetching every leads/conversations/deals row and grouping them in JavaScript). SECURITY INVOKER — relies on the calling user''s own RLS, same as every other query in this codebase.';

create or replace function public.analytics_lead_source_performance(p_organization_id uuid)
returns table (
  lead_source_id uuid,
  lead_source_name text,
  prospects_count bigint,
  leads_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    s.id as lead_source_id,
    s.name as lead_source_name,
    coalesce(prospect_agg.prospects_count, 0) as prospects_count,
    coalesce(lead_agg.leads_count, 0) as leads_count
  from public.lead_sources s
  left join (
    select lead_source_id, count(*) as prospects_count
    from public.prospects
    where organization_id = p_organization_id and lead_source_id is not null
    group by lead_source_id
  ) prospect_agg on prospect_agg.lead_source_id = s.id
  left join (
    select lead_source_id, count(*) as leads_count
    from public.leads
    where organization_id = p_organization_id and lead_source_id is not null
    group by lead_source_id
  ) lead_agg on lead_agg.lead_source_id = s.id
  where s.organization_id = p_organization_id
  order by s.name;
$$;

comment on function public.analytics_lead_source_performance(uuid) is
  'One row per lead source in the given organization with prospect/lead counts, aggregated in SQL for the Analytics page. SECURITY INVOKER.';

create or replace function public.analytics_overall_totals(p_organization_id uuid)
returns table (
  total_won bigint,
  total_revenue numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) filter (where status = 'won') as total_won,
    coalesce(sum(value) filter (where status = 'won'), 0) as total_revenue
  from public.deals
  where organization_id = p_organization_id;
$$;

comment on function public.analytics_overall_totals(uuid) is
  'Org-wide total won deals and won revenue (every deal in the organization, regardless of campaign), aggregated in SQL for the Analytics page — matches what the page previously computed from every deal row fetched into JavaScript. SECURITY INVOKER.';

-- -----------------------------------------------------------------------------
-- Indexes: these columns are now a real, recurring GROUP BY key on every
-- Analytics page load (via the functions above), not a hypothetical future
-- access pattern. leads.campaign_id and prospects.campaign_id already had
-- covering indexes; these four did not (already flagged as unindexed
-- foreign keys by Supabase's own advisor, now actually exercised).
-- -----------------------------------------------------------------------------

create index if not exists conversations_campaign_id_idx on public.conversations (campaign_id);
create index if not exists deals_campaign_id_idx on public.deals (campaign_id);
create index if not exists leads_lead_source_id_idx on public.leads (lead_source_id);
create index if not exists prospects_lead_source_id_idx on public.prospects (lead_source_id);
