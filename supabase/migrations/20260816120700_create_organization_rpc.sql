-- Creating an organization and adding its creator as owner is logically one
-- operation. Doing it as two separate client-side inserts risks leaving an
-- orphaned organization behind if the second insert fails (e.g. a dropped
-- connection). This function performs both writes in a single transaction.
--
-- It is SECURITY DEFINER (bypassing RLS for its own inserts), but it only
-- ever creates a row owned by the caller (auth.uid()) with a hardcoded
-- 'owner' role, so it cannot be used to act on anyone else's behalf.
create or replace function public.create_organization_with_owner(org_name text)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org public.organizations;
begin
  if auth.uid() is null then
    raise exception 'Must be authenticated to create an organization';
  end if;

  insert into public.organizations (name, created_by)
  values (org_name, auth.uid())
  returning * into new_org;

  insert into public.organization_members (organization_id, user_id, role)
  values (new_org.id, auth.uid(), 'owner');

  return new_org;
end;
$$;

revoke all on function public.create_organization_with_owner(text) from public;
grant execute on function public.create_organization_with_owner(text) to authenticated;
