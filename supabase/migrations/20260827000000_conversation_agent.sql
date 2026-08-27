-- =============================================================================
-- Phase 6: Conversation Agent
--
-- conversations.owner tracks whether the AI or a human currently controls a
-- conversation. Defaults to 'ai' — every existing conversation was AI/human
-- outreach-driven with no prior ownership concept, and defaulting to 'ai'
-- means the inbound-reply handler starts generating real replies for them
-- immediately, which is the correct behavior (nothing regresses to silence).
-- A human takes over explicitly (see conversations/actions.ts); replying
-- from the conversation UI also takes over automatically.
--
-- conversations.buying_intent / leads.buying_intent are the persisted
-- three-level classification (low/medium/high) the conversation agent
-- updates after every inbound message. Deliberately separate from the
-- existing free-text `intent` column (still written by the manual "Detect
-- Intent" button with its own richer 10-category vocabulary) — adding a
-- second column costs nothing and keeps that existing behavior unchanged.
-- =============================================================================
alter table public.conversations
  add column owner text not null default 'ai' check (owner in ('ai', 'human')),
  add column buying_intent text check (buying_intent is null or buying_intent in ('low', 'medium', 'high'));

alter table public.leads
  add column buying_intent text check (buying_intent is null or buying_intent in ('low', 'medium', 'high'));

create index conversations_owner_idx on public.conversations(owner);

-- =============================================================================
-- whatsapp_accounts
-- One connected WhatsApp Business number per organization — same role as
-- email_accounts, but WhatsApp Cloud API's simplest integration path is a
-- permanent system-user access token issued directly from Meta Business
-- Manager, not an OAuth authorization-code flow, so there is no "connect"
-- redirect: an org admin enters the phone_number_id and access_token they
-- already obtained from Meta directly (see Settings > Integrations).
--
-- Inbound webhooks are received on one app-wide endpoint (Meta subscribes a
-- single callback URL per Meta App, not per phone number); every inbound
-- payload carries the sending phone_number_id, which is how the webhook
-- resolves which organization it belongs to — hence phone_number_id must be
-- unique across the whole table, not just per org.
--
-- RLS is enabled but NO policy is granted to `authenticated`, identical to
-- email_accounts: only the service-role admin client may ever touch this
-- table, and every read is scoped by organization_id manually in code.
-- =============================================================================
create table public.whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connected_by uuid references public.profiles(id) on delete set null,
  phone_number_id text not null check (char_length(btrim(phone_number_id)) > 0),
  business_account_id text,
  display_phone_number text,
  access_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id),
  unique (phone_number_id)
);

create trigger whatsapp_accounts_set_updated_at
  before update on public.whatsapp_accounts
  for each row execute function public.set_updated_at();

alter table public.whatsapp_accounts enable row level security;
-- Intentionally no select/insert/update/delete policy for `authenticated`.
