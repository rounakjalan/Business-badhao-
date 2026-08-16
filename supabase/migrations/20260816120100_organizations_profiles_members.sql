-- =============================================================================
-- organizations
-- =============================================================================
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

-- =============================================================================
-- profiles
-- One row per auth user. Created automatically by the handle_new_user
-- trigger below; email/full_name are denormalized from auth.users purely
-- for convenient querying/joining from the public schema.
-- =============================================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- =============================================================================
-- organization_members
-- Join table between profiles and organizations, carrying the member's role.
-- =============================================================================
create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create trigger organization_members_set_updated_at
  before update on public.organization_members
  for each row execute function public.set_updated_at();

create index organization_members_organization_id_idx on public.organization_members(organization_id);
create index organization_members_user_id_idx on public.organization_members(user_id);

-- =============================================================================
-- New auth user -> profile row
-- =============================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- RLS helper functions
--
-- These run as SECURITY DEFINER so they can read organization_members
-- without being subject to organization_members' own RLS policies. Without
-- this, a policy on organization_members that queries organization_members
-- to check membership would recurse into itself. This is the standard
-- Supabase-recommended pattern for membership-based multi-tenant RLS.
-- =============================================================================
create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = target_org
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_org_admin(target_org uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = target_org
      and m.user_id = auth.uid()
      and m.role in ('owner', 'admin')
  );
$$;

create or replace function public.is_org_owner(target_org uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = target_org
      and m.user_id = auth.uid()
      and m.role = 'owner'
  );
$$;

create or replace function public.current_org_role(target_org uuid)
returns public.org_role
language sql
security definer
set search_path = public
stable
as $$
  select m.role
  from public.organization_members m
  where m.organization_id = target_org
    and m.user_id = auth.uid()
  limit 1;
$$;

-- Used by the organization_members bootstrap insert policy below. A brand
-- new organization has no members yet, so the caller cannot rely on
-- is_org_member/organizations' own RLS to prove they created it; this
-- bypasses that RLS to check `created_by` directly.
create or replace function public.is_org_creator(target_org uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.organizations o
    where o.id = target_org
      and o.created_by = auth.uid()
  );
$$;

-- Used by the profiles SELECT policy so teammates can see each other's
-- basic profile info (e.g. for a future members list) without exposing
-- profiles across unrelated organizations.
create or replace function public.shares_org_with(target_user uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.organization_members mine
    join public.organization_members theirs
      on theirs.organization_id = mine.organization_id
    where mine.user_id = auth.uid()
      and theirs.user_id = target_user
  );
$$;

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_members enable row level security;

-- organizations --------------------------------------------------------------
create policy "Members can view their organizations"
  on public.organizations for select
  to authenticated
  using (public.is_org_member(id));

create policy "Authenticated users can create organizations"
  on public.organizations for insert
  to authenticated
  with check (created_by = auth.uid());

create policy "Admins can update their organizations"
  on public.organizations for update
  to authenticated
  using (public.is_org_admin(id))
  with check (public.is_org_admin(id));

create policy "Owners can delete their organizations"
  on public.organizations for delete
  to authenticated
  using (public.is_org_owner(id));

-- profiles ---------------------------------------------------------------
create policy "Users can view their own profile"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.shares_org_with(id));

create policy "Users can insert their own profile"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

create policy "Users can update their own profile"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- organization_members -----------------------------------------------------
create policy "Members can view their organization's membership list"
  on public.organization_members for select
  to authenticated
  using (public.is_org_member(organization_id));

create policy "Bootstrap owner or admins can add members"
  on public.organization_members for insert
  to authenticated
  with check (
    (
      -- Bootstrap: the creator of a brand-new organization may add
      -- themselves as its first member, with the owner role.
      user_id = auth.uid()
      and role = 'owner'
      and public.is_org_creator(organization_id)
      and not exists (
        select 1 from public.organization_members existing
        where existing.organization_id = organization_members.organization_id
      )
    )
    or
    (
      -- Ongoing: an admin/owner can add members; only an owner can grant
      -- the owner role to someone else.
      public.is_org_admin(organization_id)
      and (role <> 'owner' or public.current_org_role(organization_id) = 'owner')
    )
  );

create policy "Owners can update membership roles"
  on public.organization_members for update
  to authenticated
  using (public.is_org_owner(organization_id))
  with check (public.is_org_owner(organization_id));

create policy "Owners can remove members, members can remove themselves"
  on public.organization_members for delete
  to authenticated
  using (public.is_org_owner(organization_id) or user_id = auth.uid());
