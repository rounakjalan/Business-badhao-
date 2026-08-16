-- =============================================================================
-- business_goals
-- =============================================================================
create table public.business_goals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null check (char_length(btrim(title)) > 0),
  description text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger business_goals_set_updated_at
  before update on public.business_goals
  for each row execute function public.set_updated_at();

create index business_goals_organization_id_idx on public.business_goals(organization_id);
create index business_goals_status_idx on public.business_goals(status);
create index business_goals_created_at_idx on public.business_goals(created_at);

-- =============================================================================
-- ideal_customer_profiles
-- `criteria` is intentionally a flexible jsonb bag (firmographics, signals,
-- exclusions, etc.) so the future AI campaign planner can read/write
-- structured criteria without further schema changes.
-- =============================================================================
create table public.ideal_customer_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  description text,
  criteria jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger ideal_customer_profiles_set_updated_at
  before update on public.ideal_customer_profiles
  for each row execute function public.set_updated_at();

create index ideal_customer_profiles_organization_id_idx on public.ideal_customer_profiles(organization_id);
create index ideal_customer_profiles_created_at_idx on public.ideal_customer_profiles(created_at);

-- =============================================================================
-- campaigns
-- =============================================================================
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  business_goal_id uuid references public.business_goals(id) on delete set null,
  ideal_customer_profile_id uuid references public.ideal_customer_profiles(id) on delete set null,
  name text not null check (char_length(btrim(name)) > 0),
  description text,
  objective text,
  status text not null default 'draft'
    check (status in ('draft', 'planning', 'active', 'paused', 'completed', 'archived')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger campaigns_set_updated_at
  before update on public.campaigns
  for each row execute function public.set_updated_at();

create index campaigns_organization_id_idx on public.campaigns(organization_id);
create index campaigns_status_idx on public.campaigns(status);
create index campaigns_created_at_idx on public.campaigns(created_at);
create index campaigns_business_goal_id_idx on public.campaigns(business_goal_id);
create index campaigns_ideal_customer_profile_id_idx on public.campaigns(ideal_customer_profile_id);

-- =============================================================================
-- RLS: all three tables are plain org-owned business data. Any member of
-- the organization can read/write; tenant isolation is enforced purely via
-- organization membership, never via a client-supplied organization_id.
-- =============================================================================
alter table public.business_goals enable row level security;
alter table public.ideal_customer_profiles enable row level security;
alter table public.campaigns enable row level security;

create policy "Members can view business goals"
  on public.business_goals for select
  to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create business goals"
  on public.business_goals for insert
  to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update business goals"
  on public.business_goals for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete business goals"
  on public.business_goals for delete
  to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view ideal customer profiles"
  on public.ideal_customer_profiles for select
  to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create ideal customer profiles"
  on public.ideal_customer_profiles for insert
  to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update ideal customer profiles"
  on public.ideal_customer_profiles for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete ideal customer profiles"
  on public.ideal_customer_profiles for delete
  to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view campaigns"
  on public.campaigns for select
  to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create campaigns"
  on public.campaigns for insert
  to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update campaigns"
  on public.campaigns for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete campaigns"
  on public.campaigns for delete
  to authenticated
  using (public.is_org_member(organization_id));
