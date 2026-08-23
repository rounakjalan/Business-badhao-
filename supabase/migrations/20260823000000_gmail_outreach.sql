-- =============================================================================
-- email_accounts
-- One connected Gmail mailbox per organization, used to send personalized
-- outreach and to poll for replies. Deliberately org-scoped rather than
-- per-user: outreach in this app is a shared org activity (like the rest of
-- the CRM), not a personal inbox, so one authorized sending account per org
-- keeps "who does a reply belong to" unambiguous.
--
-- RLS is enabled but NO policy is granted to `authenticated` at all — same
-- pattern as audit_logs above. access_token/refresh_token are live
-- credentials; the only code path that may touch this table is a trusted
-- server context using the service-role client (src/lib/supabase/admin.ts),
-- which bypasses RLS and is never reachable from a request that carries
-- untrusted input. Every read there is scoped by organization_id manually,
-- since RLS is not there to do it. This also means the tokens are never
-- fetchable from the browser via supabase-js, even by an org member.
-- =============================================================================
create table public.email_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connected_by uuid references public.profiles(id) on delete set null,
  email_address text not null check (char_length(btrim(email_address)) > 0),
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  scope text,
  -- Gmail's own cursor for incremental sync (users.history.list). Null
  -- until the first successful reply-check; from then on, only messages
  -- newer than this are fetched.
  last_history_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One connected mailbox per org — reconnecting overwrites it rather than
  -- creating a second, ambiguous sending identity.
  unique (organization_id)
);

create trigger email_accounts_set_updated_at
  before update on public.email_accounts
  for each row execute function public.set_updated_at();

alter table public.email_accounts enable row level security;
-- Intentionally no select/insert/update/delete policy for `authenticated`.

-- =============================================================================
-- messages: additive columns for real outbound email delivery.
--
-- All nullable — every existing row (manually-recorded messages, seeded
-- demo conversations) stays valid with no backfill. `metadata` already
-- covered ad-hoc detail; these are pulled out into real columns because
-- they need to be queried and constrained: `status` drives "never claim
-- sent unless Gmail confirmed it", and `send_idempotency_key` is what
-- makes duplicate-send protection an actual database guarantee rather
-- than a best-effort client-side check.
-- =============================================================================
alter table public.messages
  add column subject text,
  add column to_address text,
  add column from_address text,
  -- Gmail's own message id for the sent message — lets a later reply
  -- lookup or a support conversation reference the exact provider message.
  add column external_id text,
  add column status text check (status is null or status in ('sent', 'failed')),
  add column send_idempotency_key text;

-- Partial unique index: only outbound sends carry a key, so retried or
-- double-submitted sends of the *same* attempt collide here instead of
-- creating a second email. Rows with no key (every existing/manual
-- message) are unaffected.
create unique index messages_send_idempotency_key_uidx
  on public.messages (send_idempotency_key)
  where send_idempotency_key is not null;

create index messages_external_id_idx on public.messages (external_id) where external_id is not null;
