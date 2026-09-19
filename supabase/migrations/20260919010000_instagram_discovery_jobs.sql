-- =============================================================================
-- instagram_discovery_jobs
--
-- The dispatch/result queue between Business Badhao's Vercel deployment and
-- an organization's own external Hermes browser runtime (see
-- instagram_discovery_connections' own migration for why that runtime cannot
-- live inside Vercel's serverless execution model).
--
-- Vercel cannot call out to a runtime it doesn't host, and the runtime is not
-- always the one initiating contact — so a discovery request from
-- HermesLeadDiscoveryAgent (one query, exactly like a Tavily/Exa call) is
-- written here as a `pending` job; the runtime polls
-- POST /api/instagram-discovery/jobs/claim for work, performs one real
-- Instagram search using that organization's own authenticated browser
-- profile, and reports real, structured results (or a real failure) back via
-- POST /api/instagram-discovery/jobs/complete. The calling request then reads
-- this same row back (bounded polling — see
-- src/lib/instagram-discovery/jobs.ts) to get real candidates or an honest
-- empty/failed result if the runtime never answers in time.
--
-- `criteria` holds only the single search query text and does not carry
-- Business Knowledge/ICP verbatim — the runtime does not need those to
-- perform a real Instagram search; extraction of prospects from whatever the
-- runtime finds still happens through the EXISTING Nemotron extraction step
-- (extractProspectsFromResults), unchanged, the same way it already does for
-- Tavily/Exa hits.
--
-- `candidates` holds only what the runtime actually found on real Instagram
-- pages — never a credential, cookie, or session token. Same RLS posture as
-- every other automation table in this schema: enabled, no policy for
-- `authenticated`, service-role admin client only, scoped by organization_id
-- explicitly in every query.
-- =============================================================================
create table public.instagram_discovery_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'completed', 'failed', 'expired')),
  criteria jsonb not null,
  -- Set only once the runtime completes the job — an array of
  -- {username, displayName, bio, category, externalUrl, profileUrl}, each
  -- field present only when actually found on a real Instagram page. Never
  -- fabricated by this application; this table only stores what a real
  -- runtime reports.
  candidates jsonb,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  -- The calling request only waits so long (see jobs.ts's bounded poll) — a
  -- job the runtime hasn't even claimed by the time its own caller gave up
  -- must never be claimed later and have its stale results silently
  -- attributed to a request that already returned.
  expires_at timestamptz not null
);

create index instagram_discovery_jobs_claim_idx
  on public.instagram_discovery_jobs (status, expires_at)
  where status = 'pending';

alter table public.instagram_discovery_jobs enable row level security;
-- Intentionally no select/insert/update/delete policy for `authenticated`.
