-- =============================================================================
-- RLS performance fix (Supabase advisor: "Auth RLS Initialization Plan",
-- auth_rls_initplan).
--
-- Six policies call auth.uid() directly in their own USING/WITH CHECK text,
-- which Postgres's planner re-evaluates once per row scanned instead of
-- once per query. The standard Supabase fix is to wrap the call in a
-- scalar subquery — (select auth.uid()) — which has no correlated
-- reference to the outer row, so the planner hoists it into an InitPlan
-- and evaluates it exactly once per query. This changes nothing about
-- WHO the expression allows; auth.uid() and (select auth.uid()) return
-- the exact same value for the exact same session, always.
--
-- This is the only change in this migration. The helper functions these
-- same policies also call (is_org_creator, is_org_admin, is_org_owner,
-- current_org_role, shares_org_with) are NOT touched: each already calls
-- auth.uid() inside its own SECURITY DEFINER body, which is opaque to the
-- policy text the advisor scans — not part of this finding, and changing
-- them is out of scope for this fix.
--
-- Verified against the original definitions in
-- 20260816120100_organizations_profiles_members.sql: every WITH CHECK/
-- USING expression below is copied verbatim from that migration, with
-- only the bare `auth.uid()` occurrences wrapped. No operand order,
-- boolean structure, role list (`to authenticated`), or helper-function
-- call was changed.
-- =============================================================================

-- organizations ---------------------------------------------------------------
alter policy "Authenticated users can create organizations"
  on public.organizations
  with check (created_by = (select auth.uid()));

-- profiles ----------------------------------------------------------------
alter policy "Users can view their own profile"
  on public.profiles
  using (id = (select auth.uid()) or public.shares_org_with(id));

alter policy "Users can insert their own profile"
  on public.profiles
  with check (id = (select auth.uid()));

alter policy "Users can update their own profile"
  on public.profiles
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- organization_members -----------------------------------------------------
alter policy "Bootstrap owner or admins can add members"
  on public.organization_members
  with check (
    (
      user_id = (select auth.uid())
      and role = 'owner'
      and public.is_org_creator(organization_id)
      and not exists (
        select 1 from public.organization_members existing
        where existing.organization_id = organization_members.organization_id
      )
    )
    or
    (
      public.is_org_admin(organization_id)
      and (role <> 'owner' or public.current_org_role(organization_id) = 'owner')
    )
  );

alter policy "Owners can remove members, members can remove themselves"
  on public.organization_members
  using (public.is_org_owner(organization_id) or user_id = (select auth.uid()));
