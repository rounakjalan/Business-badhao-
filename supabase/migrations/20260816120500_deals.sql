-- =============================================================================
-- deals
-- =============================================================================
create table public.deals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  title text not null check (char_length(btrim(title)) > 0),
  status text not null default 'open' check (status in ('open', 'won', 'lost')),
  value numeric(12, 2) not null default 0 check (value >= 0),
  currency text not null default 'INR',
  expected_close_date date,
  won_at timestamptz,
  lost_at timestamptz,
  loss_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger deals_set_updated_at
  before update on public.deals
  for each row execute function public.set_updated_at();

create index deals_organization_id_idx on public.deals(organization_id);
create index deals_lead_id_idx on public.deals(lead_id);
create index deals_status_idx on public.deals(status);
create index deals_created_at_idx on public.deals(created_at);

-- =============================================================================
-- deal_events
-- =============================================================================
create table public.deal_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  deal_id uuid not null references public.deals(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index deal_events_organization_id_idx on public.deal_events(organization_id);
create index deal_events_deal_id_idx on public.deal_events(deal_id);
create index deal_events_created_at_idx on public.deal_events(created_at);

-- =============================================================================
-- loss_analysis
-- =============================================================================
create table public.loss_analysis (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  deal_id uuid not null references public.deals(id) on delete cascade,
  reason_category text,
  summary text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index loss_analysis_organization_id_idx on public.loss_analysis(organization_id);
create index loss_analysis_deal_id_idx on public.loss_analysis(deal_id);

-- =============================================================================
-- recovery_attempts
-- =============================================================================
create table public.recovery_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  deal_id uuid not null references public.deals(id) on delete cascade,
  loss_analysis_id uuid references public.loss_analysis(id) on delete set null,
  status text not null default 'planned'
    check (status in ('planned', 'in_progress', 'succeeded', 'failed')),
  notes text,
  attempted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger recovery_attempts_set_updated_at
  before update on public.recovery_attempts
  for each row execute function public.set_updated_at();

create index recovery_attempts_organization_id_idx on public.recovery_attempts(organization_id);
create index recovery_attempts_deal_id_idx on public.recovery_attempts(deal_id);

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.deals enable row level security;
alter table public.deal_events enable row level security;
alter table public.loss_analysis enable row level security;
alter table public.recovery_attempts enable row level security;

create policy "Members can view deals"
  on public.deals for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create deals"
  on public.deals for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update deals"
  on public.deals for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete deals"
  on public.deals for delete to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view deal events"
  on public.deal_events for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create deal events"
  on public.deal_events for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy "Members can view loss analysis"
  on public.loss_analysis for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create loss analysis"
  on public.loss_analysis for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update loss analysis"
  on public.loss_analysis for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy "Members can view recovery attempts"
  on public.recovery_attempts for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create recovery attempts"
  on public.recovery_attempts for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update recovery attempts"
  on public.recovery_attempts for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
