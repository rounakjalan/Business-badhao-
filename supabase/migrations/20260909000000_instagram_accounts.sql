-- =============================================================================
-- instagram_accounts
-- One connected Instagram professional (Business/Creator) account per
-- organization, via Facebook Login for Business. Used ONLY to verify a
-- prospect's Instagram handle that existing web/Tavily/Exa discovery already
-- found (Instagram Graph API's Business Discovery field, a lookup by known
-- username) — never to search or browse Instagram, which the official API
-- does not support and this app does not attempt to work around.
--
-- Same RLS posture as email_accounts/whatsapp_accounts: enabled, but NO
-- policy is granted to `authenticated` at all. access_token is a live
-- credential; the only code path that may touch this table is a trusted
-- server context using the service-role client (src/lib/supabase/admin.ts),
-- which bypasses RLS and is never reachable from a request that carries
-- untrusted input. Every read there is scoped by organization_id manually.
-- =============================================================================
create table public.instagram_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connected_by uuid references public.profiles(id) on delete set null,
  -- The connected Instagram professional account's own id — Business
  -- Discovery lookups are made against this id (GET /{this}?fields=
  -- business_discovery.username(...)), not against the org's own username.
  ig_business_account_id text not null check (char_length(btrim(ig_business_account_id)) > 0),
  ig_username text not null check (char_length(btrim(ig_username)) > 0),
  -- The Facebook Page the Instagram account is linked through — kept for
  -- reference/debugging a broken connection; never used to post or read on
  -- the org's behalf.
  facebook_page_id text not null check (char_length(btrim(facebook_page_id)) > 0),
  access_token text not null,
  token_expires_at timestamptz not null,
  scope text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One connected account per org — reconnecting overwrites it rather than
  -- creating a second, ambiguous verification identity.
  unique (organization_id)
);

create trigger instagram_accounts_set_updated_at
  before update on public.instagram_accounts
  for each row execute function public.set_updated_at();

alter table public.instagram_accounts enable row level security;
-- Intentionally no select/insert/update/delete policy for `authenticated`.
