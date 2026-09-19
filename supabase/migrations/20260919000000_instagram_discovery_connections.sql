-- =============================================================================
-- instagram_discovery_connections
--
-- One dedicated Instagram account/browser-session CONNECTION per
-- organization, for Hermes browser-based lead DISCOVERY (finding NEW
-- prospects) — entirely separate from instagram_accounts (Meta Graph API
-- OAuth + Business Discovery, used only to verify/enrich a handle another
-- source already found; see that table's own migration). Conflating the two
-- would mix a Graph API OAuth token with a browser-session reference, two
-- genuinely different credential types backing two genuinely different
-- capabilities — kept in separate tables on purpose.
--
-- This table NEVER stores an Instagram password, a raw browser cookie, or a
-- session token of any kind — only CONNECTION STATE. The actual authenticated
-- browser session lives on a separate, always-available browser runtime an
-- organization's operator runs outside this deployment (Vercel's serverless
-- execution model cannot host a persistent authenticated browser session —
-- see this project's own discovery-architecture audit). That runtime reports
-- its own session state back through an authenticated server-to-server
-- endpoint (see src/app/api/instagram-discovery/session-report/route.ts),
-- which — together with a user's own "Connect"/"Disconnect" action in
-- Settings — is the only code path permitted to write to this table.
--
-- Same RLS posture as instagram_accounts/email_accounts/whatsapp_accounts:
-- enabled, but NO policy is granted to `authenticated` at all. A
-- browser_profile_ref, even though it is not a credential itself, is still an
-- identifier that should never be reachable by an ordinary client-side query.
-- Every read/write goes through the service-role admin client
-- (src/lib/supabase/admin.ts), scoped by organization_id explicitly.
-- =============================================================================
create table public.instagram_discovery_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  requested_by uuid references public.profiles(id) on delete set null,
  status text not null default 'authentication_required'
    check (status in ('authentication_required', 'connecting', 'connected', 'session_expired', 'error')),
  -- Opaque identifier the external browser runtime assigns to this
  -- organization's dedicated Chromium profile — never a password, cookie, or
  -- session token itself; just a name/id the runtime uses to look up its own
  -- locally-stored profile. Business Badhao never interprets this value,
  -- only stores and returns it.
  browser_profile_ref text,
  -- Safe to display in Settings once the runtime reports a successful
  -- connection — never used to authenticate anything.
  connected_username text,
  last_error text,
  requested_at timestamptz not null default now(),
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One Instagram discovery connection per org, same posture as
  -- instagram_accounts — reconnecting overwrites it rather than creating a
  -- second, ambiguous connection.
  unique (organization_id)
);

create trigger instagram_discovery_connections_set_updated_at
  before update on public.instagram_discovery_connections
  for each row execute function public.set_updated_at();

alter table public.instagram_discovery_connections enable row level security;
-- Intentionally no select/insert/update/delete policy for `authenticated`.
