-- =============================================================================
-- lead_sources
-- Where a prospect/lead originated from. Kept generic so future AI
-- discovery/scraping sources can register themselves without a schema
-- change.
-- =============================================================================
create table public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  type text not null default 'manual'
    check (type in ('manual', 'import', 'referral', 'website', 'ai_discovery', 'other')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger lead_sources_set_updated_at
  before update on public.lead_sources
  for each row execute function public.set_updated_at();

create index lead_sources_organization_id_idx on public.lead_sources(organization_id);

-- =============================================================================
-- prospects
-- Raw, unqualified prospect data (e.g. from discovery/import), kept
-- separate from `leads` so qualification state doesn't get tangled up
-- with the raw source record it came from.
-- =============================================================================
create table public.prospects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  lead_source_id uuid references public.lead_sources(id) on delete set null,
  company_name text,
  contact_name text,
  title text,
  email text,
  phone text,
  website text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger prospects_set_updated_at
  before update on public.prospects
  for each row execute function public.set_updated_at();

create index prospects_organization_id_idx on public.prospects(organization_id);
create index prospects_campaign_id_idx on public.prospects(campaign_id);
create index prospects_created_at_idx on public.prospects(created_at);

-- =============================================================================
-- leads
-- The tracked, working entity through qualification/outreach/deals.
-- =============================================================================
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  prospect_id uuid references public.prospects(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  lead_source_id uuid references public.lead_sources(id) on delete set null,
  status text not null default 'new'
    check (status in ('new', 'contacted', 'qualified', 'unqualified', 'converted', 'lost')),
  qualification_status text not null default 'pending'
    check (qualification_status in ('pending', 'qualifying', 'qualified', 'disqualified')),
  current_score integer,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

create index leads_organization_id_idx on public.leads(organization_id);
create index leads_campaign_id_idx on public.leads(campaign_id);
create index leads_status_idx on public.leads(status);
create index leads_created_at_idx on public.leads(created_at);

-- =============================================================================
-- contacts
-- Person-level contact info for a lead (a lead/company can have multiple
-- contacts).
-- =============================================================================
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  full_name text,
  email text,
  phone text,
  role_title text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

create index contacts_organization_id_idx on public.contacts(organization_id);
create index contacts_lead_id_idx on public.contacts(lead_id);

-- =============================================================================
-- lead_research
-- Findings gathered about a lead (manually today, by an AI research agent
-- later). One lead can accumulate multiple research entries over time.
-- =============================================================================
create table public.lead_research (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  summary text,
  findings jsonb not null default '{}'::jsonb,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger lead_research_set_updated_at
  before update on public.lead_research
  for each row execute function public.set_updated_at();

create index lead_research_organization_id_idx on public.lead_research(organization_id);
create index lead_research_lead_id_idx on public.lead_research(lead_id);

-- =============================================================================
-- lead_scores
-- Append-only score history for a lead; `leads.current_score` is a
-- denormalized read of the latest value for fast sorting/filtering.
-- =============================================================================
create table public.lead_scores (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  score integer not null,
  reason text,
  scored_by text not null default 'system' check (scored_by in ('system', 'agent', 'manual')),
  created_at timestamptz not null default now()
);

create index lead_scores_organization_id_idx on public.lead_scores(organization_id);
create index lead_scores_lead_id_idx on public.lead_scores(lead_id);
create index lead_scores_created_at_idx on public.lead_scores(created_at);

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.lead_sources enable row level security;
alter table public.prospects enable row level security;
alter table public.leads enable row level security;
alter table public.contacts enable row level security;
alter table public.lead_research enable row level security;
alter table public.lead_scores enable row level security;

create policy "Members can view lead sources"
  on public.lead_sources for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create lead sources"
  on public.lead_sources for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update lead sources"
  on public.lead_sources for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete lead sources"
  on public.lead_sources for delete to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view prospects"
  on public.prospects for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create prospects"
  on public.prospects for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update prospects"
  on public.prospects for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete prospects"
  on public.prospects for delete to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view leads"
  on public.leads for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create leads"
  on public.leads for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update leads"
  on public.leads for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete leads"
  on public.leads for delete to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view contacts"
  on public.contacts for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create contacts"
  on public.contacts for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update contacts"
  on public.contacts for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete contacts"
  on public.contacts for delete to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view lead research"
  on public.lead_research for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create lead research"
  on public.lead_research for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update lead research"
  on public.lead_research for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete lead research"
  on public.lead_research for delete to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view lead scores"
  on public.lead_scores for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create lead scores"
  on public.lead_scores for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can delete lead scores"
  on public.lead_scores for delete to authenticated
  using (public.is_org_member(organization_id));
