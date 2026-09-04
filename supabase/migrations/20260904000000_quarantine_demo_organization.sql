-- Remove the fabricated demo organization's data (audit P1 Fix #2).
--
-- Finding: a demo organization ("Sharma Digital Studio (Demo)", id
-- 453251c9-7952-458a-90b8-a36d78ca84a2) holds synthetic campaigns, leads,
-- conversations and messages left over from earlier development/testing.
-- It is a distinct organization row, not a flag on real data: every
-- organization-scoped table's organization_id column is declared
-- `references public.organizations(id) on delete cascade` (see
-- organizations_profiles_members.sql, campaign_foundation.sql,
-- leads_foundation.sql, outreach_and_conversations.sql, deals.sql,
-- agents_ops_audit.sql, business_knowledge_foundation.sql,
-- gmail_outreach.sql, conversation_agent.sql), so no table in this schema
-- can hold a row that is scoped to this organization while also being
-- reachable from, or mistaken for, a different (real) organization's data.
-- Deleting the organizations row is therefore both safe and complete:
-- Postgres cascades the delete directly into every one of those tables,
-- for this organization_id only, leaving zero orphaned rows and touching
-- nothing outside it. organization_members rows for this org are removed
-- the same way; the affected users' public.profiles rows are untouched
-- (profiles cascade from auth.users, not from organizations).
--
-- SAFETY GUARD: matches on both the specific id recorded by the audit and
-- a case-insensitive name check, so if that id is ever stale or wrong for
-- any reason this statement deletes zero rows instead of hitting an
-- unintended organization. Before applying, confirm the row this targets
-- really is the demo organization:
--
--   select id, name, created_by, created_at from public.organizations
--   where id = '453251c9-7952-458a-90b8-a36d78ca84a2';
--
-- and that no other, differently-named real organization shares that id.

delete from public.organizations
where id = '453251c9-7952-458a-90b8-a36d78ca84a2'
  and name ilike '%demo%';
