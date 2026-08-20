-- Lead Discovery reuses the existing agent_runs/agent_actions tables for
-- run tracking (no new run/task table needed — agent-runs.ts's
-- recordAgentAction was already built anticipating this exact use case)
-- and the existing prospects/leads/lead_sources tables for persistence
-- (prospects.raw_data jsonb already exists for exactly this — "Raw,
-- unqualified prospect data" — so discovery evidence needs no new
-- columns). The one genuinely necessary change: agent_runs.status can't
-- currently represent a run where some searches succeeded and others
-- failed. Same one-line "text + CHECK, not enum" widening already used
-- for deals.status in 20260816130000_dashboard_design_fields.sql.
alter table public.agent_runs
  drop constraint agent_runs_status_check,
  add constraint agent_runs_status_check check (status in ('pending', 'running', 'completed', 'failed', 'partially_completed'));
