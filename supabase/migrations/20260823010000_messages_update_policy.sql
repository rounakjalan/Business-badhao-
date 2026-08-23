-- messages never had an UPDATE policy at all — every prior write path only
-- ever inserted a message, so this went unnoticed until the outreach send
-- path started reserving a row before calling Gmail and resolving it to
-- sent/failed afterward (see sendLeadOutreachAction). Without this, that
-- resolving UPDATE silently matches zero rows under RLS: a message stays
-- at status=null forever, with no external_id even on a real, confirmed
-- Gmail send.
create policy "Members can update messages"
  on public.messages for update to authenticated
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));
