-- =============================================================================
-- outreach_campaigns
-- A concrete send/sequence layer under a parent `campaign` (e.g. "cold
-- email sequence #1"). Deliberately channel-agnostic; no provider is wired
-- up in this phase.
-- =============================================================================
create table public.outreach_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  channel text not null default 'email'
    check (channel in ('email', 'sms', 'whatsapp', 'instagram', 'linkedin', 'phone', 'other')),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger outreach_campaigns_set_updated_at
  before update on public.outreach_campaigns
  for each row execute function public.set_updated_at();

create index outreach_campaigns_organization_id_idx on public.outreach_campaigns(organization_id);
create index outreach_campaigns_campaign_id_idx on public.outreach_campaigns(campaign_id);
create index outreach_campaigns_status_idx on public.outreach_campaigns(status);

-- =============================================================================
-- conversations
-- One thread per lead per channel. `intent` is a free-text label written
-- by a future intent-detection agent.
-- =============================================================================
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  channel text not null default 'email'
    check (channel in ('email', 'sms', 'whatsapp', 'instagram', 'linkedin', 'phone', 'web_chat', 'other')),
  status text not null default 'open'
    check (status in ('open', 'pending', 'resolved', 'closed')),
  intent text,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

create index conversations_organization_id_idx on public.conversations(organization_id);
create index conversations_lead_id_idx on public.conversations(lead_id);
create index conversations_status_idx on public.conversations(status);
create index conversations_created_at_idx on public.conversations(created_at);

-- =============================================================================
-- messages
-- Individual messages, optionally attached to a conversation once one
-- exists (outbound-only outreach may not have a conversation yet).
-- =============================================================================
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  outreach_campaign_id uuid references public.outreach_campaigns(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  direction text not null check (direction in ('inbound', 'outbound')),
  channel text not null default 'email'
    check (channel in ('email', 'sms', 'whatsapp', 'instagram', 'linkedin', 'phone', 'web_chat', 'other')),
  sender_type text not null default 'system' check (sender_type in ('lead', 'agent', 'human', 'system')),
  body text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index messages_organization_id_idx on public.messages(organization_id);
create index messages_conversation_id_idx on public.messages(conversation_id);
create index messages_lead_id_idx on public.messages(lead_id);
create index messages_created_at_idx on public.messages(created_at);

-- =============================================================================
-- conversation_events
-- Timeline/audit trail for a conversation (status changes, intent
-- detected, notes, assignment, etc).
-- =============================================================================
create table public.conversation_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index conversation_events_organization_id_idx on public.conversation_events(organization_id);
create index conversation_events_conversation_id_idx on public.conversation_events(conversation_id);
create index conversation_events_created_at_idx on public.conversation_events(created_at);

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.outreach_campaigns enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.conversation_events enable row level security;

create policy "Members can view outreach campaigns"
  on public.outreach_campaigns for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create outreach campaigns"
  on public.outreach_campaigns for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update outreach campaigns"
  on public.outreach_campaigns for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete outreach campaigns"
  on public.outreach_campaigns for delete to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view conversations"
  on public.conversations for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create conversations"
  on public.conversations for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update conversations"
  on public.conversations for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete conversations"
  on public.conversations for delete to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view messages"
  on public.messages for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create messages"
  on public.messages for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can delete messages"
  on public.messages for delete to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view conversation events"
  on public.conversation_events for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create conversation events"
  on public.conversation_events for insert to authenticated
  with check (public.is_org_member(organization_id));
