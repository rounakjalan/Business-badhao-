-- =============================================================================
-- agent_runs
-- One row per invocation of a (future) AI agent. `agent_type` is a free
-- string on purpose so new agent types don't require a migration.
-- =============================================================================
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_type text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed')),
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index agent_runs_organization_id_idx on public.agent_runs(organization_id);
create index agent_runs_status_idx on public.agent_runs(status);
create index agent_runs_created_at_idx on public.agent_runs(created_at);

-- =============================================================================
-- agent_actions
-- Individual actions taken within an agent run, optionally pointing at the
-- entity the action affected (polymorphic via type + id, no FK since the
-- target table varies).
-- =============================================================================
create table public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_run_id uuid not null references public.agent_runs(id) on delete cascade,
  action_type text not null,
  target_entity_type text,
  target_entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index agent_actions_organization_id_idx on public.agent_actions(organization_id);
create index agent_actions_agent_run_id_idx on public.agent_actions(agent_run_id);
create index agent_actions_created_at_idx on public.agent_actions(created_at);

-- =============================================================================
-- tasks
-- Generic task/to-do queue shared by humans and future agents.
-- =============================================================================
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null check (char_length(btrim(title)) > 0),
  description text,
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  related_entity_type text,
  related_entity_id uuid,
  assigned_to uuid references public.profiles(id) on delete set null,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

create index tasks_organization_id_idx on public.tasks(organization_id);
create index tasks_status_idx on public.tasks(status);
create index tasks_created_at_idx on public.tasks(created_at);

-- =============================================================================
-- model_usage
-- AI usage/cost tracking. `provider`/`model` are free text so the app
-- never hard-codes a single AI vendor.
-- =============================================================================
create table public.model_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  provider text not null,
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_usd numeric(10, 4) not null default 0 check (cost_usd >= 0),
  created_at timestamptz not null default now()
);

create index model_usage_organization_id_idx on public.model_usage(organization_id);
create index model_usage_agent_run_id_idx on public.model_usage(agent_run_id);
create index model_usage_created_at_idx on public.model_usage(created_at);

-- =============================================================================
-- audit_logs
-- Append-only trail of important actions. Deliberately NOT writable by the
-- `authenticated` role via RLS (see policies below) — only admins/owners
-- can even read it in this phase, and no INSERT/UPDATE/DELETE policy is
-- granted to end users at all, so writes must come from a trusted server
-- context (e.g. a SECURITY DEFINER function or the service role) added in
-- a later phase. This keeps the audit trail tamper-resistant from day one.
-- =============================================================================
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_organization_id_idx on public.audit_logs(organization_id);
create index audit_logs_created_at_idx on public.audit_logs(created_at);

-- =============================================================================
-- RLS
-- =============================================================================
alter table public.agent_runs enable row level security;
alter table public.agent_actions enable row level security;
alter table public.tasks enable row level security;
alter table public.model_usage enable row level security;
alter table public.audit_logs enable row level security;

create policy "Members can view agent runs"
  on public.agent_runs for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create agent runs"
  on public.agent_runs for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update agent runs"
  on public.agent_runs for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy "Members can view agent actions"
  on public.agent_actions for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create agent actions"
  on public.agent_actions for insert to authenticated
  with check (public.is_org_member(organization_id));

create policy "Members can view tasks"
  on public.tasks for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can create tasks"
  on public.tasks for insert to authenticated
  with check (public.is_org_member(organization_id));
create policy "Members can update tasks"
  on public.tasks for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
create policy "Members can delete tasks"
  on public.tasks for delete to authenticated
  using (public.is_org_member(organization_id));

create policy "Members can view model usage"
  on public.model_usage for select to authenticated
  using (public.is_org_member(organization_id));
create policy "Members can record model usage"
  on public.model_usage for insert to authenticated
  with check (public.is_org_member(organization_id));

-- audit_logs: read-only for org admins/owners; no write policy for
-- `authenticated` at all (intentional — see comment on the table above).
create policy "Admins can view audit logs"
  on public.audit_logs for select
  to authenticated
  using (organization_id is not null and public.is_org_admin(organization_id));
