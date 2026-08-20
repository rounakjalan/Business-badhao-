-- Business Knowledge foundation: business/workspace-level context (not
-- campaign-specific) that future AI agents (Conversation, Qualification,
-- Outreach, Deal) will read from. This migration only adds the data model
-- and storage — no agent reads from any of this yet.
--
-- Six tables, all organization-scoped, RLS via the existing is_org_member
-- helper (same "any org member has full CRUD" pattern already used by
-- business_goals/ideal_customer_profiles/campaigns) — no new permission
-- model introduced. business_profiles and ai_communication_rules are
-- one-row-per-organization (organization_id is unique), matching how
-- settings-like singletons should behave; the rest are many-per-organization
-- content tables.
--
-- "Documents" (the 7th requirement) is folded into media_assets rather than
-- a near-duplicate table — media_assets already models "a file, its
-- metadata, and a category" (including 'document'/'brochure'/'catalogue'/
-- 'price_list'), which is exactly a basic document/asset record. No RAG
-- (chunking/embeddings) is added — out of scope for this phase.

-- =============================================================================
-- business_profiles
-- =============================================================================
create table public.business_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  business_name text,
  business_description text,
  business_category text,
  website text,
  phone text,
  email text,
  whatsapp text,
  address text,
  service_area text,
  opening_hours text,
  about text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger business_profiles_set_updated_at
  before update on public.business_profiles
  for each row execute function public.set_updated_at();

-- =============================================================================
-- products_services
-- =============================================================================
create table public.products_services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  description text,
  category text,
  price numeric check (price is null or price >= 0),
  pricing_type text not null default 'fixed'
    check (pricing_type in ('fixed', 'starting_at', 'hourly', 'per_unit', 'custom')),
  features jsonb not null default '[]'::jsonb,
  benefits jsonb not null default '[]'::jsonb,
  availability text not null default 'available'
    check (availability in ('available', 'out_of_stock', 'seasonal', 'coming_soon')),
  special_offers text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger products_services_set_updated_at
  before update on public.products_services
  for each row execute function public.set_updated_at();

create index products_services_organization_id_idx on public.products_services(organization_id);

-- =============================================================================
-- media_assets
-- Metadata only — the file itself lives in the "business-assets" Storage
-- bucket created below, at storage_path. Immutable once uploaded (delete +
-- re-upload to replace), so no updated_at.
-- =============================================================================
create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  category text not null
    check (category in ('logo', 'product', 'service', 'location', 'video', 'brochure', 'catalogue', 'price_list', 'document', 'other')),
  storage_path text not null unique,
  file_name text not null,
  mime_type text,
  file_size bigint,
  title text,
  description text,
  product_service_id uuid references public.products_services(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index media_assets_organization_id_idx on public.media_assets(organization_id);
create index media_assets_category_idx on public.media_assets(category);
create index media_assets_product_service_id_idx on public.media_assets(product_service_id);

-- =============================================================================
-- faqs
-- =============================================================================
create table public.faqs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  question text not null check (char_length(btrim(question)) > 0),
  answer text not null check (char_length(btrim(answer)) > 0),
  category text,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger faqs_set_updated_at
  before update on public.faqs
  for each row execute function public.set_updated_at();

create index faqs_organization_id_idx on public.faqs(organization_id);

-- =============================================================================
-- business_policies
-- =============================================================================
create table public.business_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  policy_type text not null
    check (policy_type in ('refund', 'cancellation', 'delivery', 'admission', 'payment', 'other')),
  title text not null check (char_length(btrim(title)) > 0),
  content text not null check (char_length(btrim(content)) > 0),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger business_policies_set_updated_at
  before update on public.business_policies
  for each row execute function public.set_updated_at();

create index business_policies_organization_id_idx on public.business_policies(organization_id);

-- =============================================================================
-- ai_communication_rules
-- One row per organization — business-specific instructions the future
-- Conversation/Outreach/Deal agents will read (not written by this phase).
-- =============================================================================
create table public.ai_communication_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  brand_voice text,
  preferred_language text,
  formality text,
  key_selling_points jsonb not null default '[]'::jsonb,
  must_emphasize jsonb not null default '[]'::jsonb,
  must_never_claim jsonb not null default '[]'::jsonb,
  competitor_comparison_rules text,
  discount_authority text,
  escalation_rules text,
  handoff_triggers jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger ai_communication_rules_set_updated_at
  before update on public.ai_communication_rules
  for each row execute function public.set_updated_at();

-- =============================================================================
-- RLS — same is_org_member pattern already used throughout the schema.
-- =============================================================================
alter table public.business_profiles enable row level security;
alter table public.products_services enable row level security;
alter table public.media_assets enable row level security;
alter table public.faqs enable row level security;
alter table public.business_policies enable row level security;
alter table public.ai_communication_rules enable row level security;

create policy "Members can view business profile"
  on public.business_profiles for select
  to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create business profile"
  on public.business_profiles for insert
  to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update business profile"
  on public.business_profiles for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete business profile"
  on public.business_profiles for delete
  to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view products and services"
  on public.products_services for select
  to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create products and services"
  on public.products_services for insert
  to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update products and services"
  on public.products_services for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete products and services"
  on public.products_services for delete
  to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view media assets"
  on public.media_assets for select
  to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create media assets"
  on public.media_assets for insert
  to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can delete media assets"
  on public.media_assets for delete
  to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view faqs"
  on public.faqs for select
  to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create faqs"
  on public.faqs for insert
  to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update faqs"
  on public.faqs for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete faqs"
  on public.faqs for delete
  to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view business policies"
  on public.business_policies for select
  to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create business policies"
  on public.business_policies for insert
  to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update business policies"
  on public.business_policies for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete business policies"
  on public.business_policies for delete
  to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view ai communication rules"
  on public.ai_communication_rules for select
  to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create ai communication rules"
  on public.ai_communication_rules for insert
  to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update ai communication rules"
  on public.ai_communication_rules for update
  to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete ai communication rules"
  on public.ai_communication_rules for delete
  to authenticated
  using (public.is_org_member(organization_id));

-- =============================================================================
-- Storage — a private bucket for business assets. Objects are keyed
-- "{organization_id}/{category}/{filename}"; RLS on storage.objects checks
-- org membership against the first path segment (storage.foldername(name))
-- — the standard Supabase pattern for per-tenant storage isolation. Private
-- (not public), so files are only ever reachable via a signed URL the
-- server generates for a member of that organization — never a guessable
-- public URL.
-- =============================================================================
insert into storage.buckets (id, name, public)
values ('business-assets', 'business-assets', false)
on conflict (id) do nothing;

create policy "Members can view their organization's business assets"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'business-assets' and public.is_org_member(((storage.foldername(name))[1])::uuid));

create policy "Members can upload their organization's business assets"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'business-assets' and public.is_org_member(((storage.foldername(name))[1])::uuid));

create policy "Members can delete their organization's business assets"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'business-assets' and public.is_org_member(((storage.foldername(name))[1])::uuid));
