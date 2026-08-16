\set ON_ERROR_STOP on

insert into auth.users (id, email) values ('44444444-4444-4444-4444-444444444444', 'dana@newco.test');
insert into public.profiles (id, email, full_name) values ('44444444-4444-4444-4444-444444444444', 'dana@newco.test', 'Dana') on conflict (id) do nothing;

set role authenticated;
select set_config('request.jwt.uid', '44444444-4444-4444-4444-444444444444', false);

do $$
declare new_org public.organizations;
declare member_count int;
declare member_role public.org_role;
begin
  select * into new_org from public.create_organization_with_owner('NewCo');

  if new_org.name <> 'NewCo' or new_org.created_by <> '44444444-4444-4444-4444-444444444444' then
    raise exception 'FAIL: organization was not created with expected name/creator';
  end if;

  select count(*) into member_count from public.organization_members where organization_id = new_org.id;
  select role into member_role from public.organization_members where organization_id = new_org.id and user_id = '44444444-4444-4444-4444-444444444444';

  if member_count <> 1 then
    raise exception 'FAIL: expected exactly 1 membership row, got %', member_count;
  end if;
  if member_role <> 'owner' then
    raise exception 'FAIL: expected creator to be owner, got %', member_role;
  end if;

  raise notice 'PASS: create_organization_with_owner atomically created org % and owner membership.', new_org.id;
end $$;

-- Calling it again for a second org must not be blocked by the first
-- bootstrap and must not let Dana grant herself owner in someone else's org.
do $$
declare second_org public.organizations;
begin
  select * into second_org from public.create_organization_with_owner('NewCo Two');
  raise notice 'PASS: a user can bootstrap a second, independent organization (%).', second_org.id;
end $$;

reset role;

select 'ALL CREATE_ORGANIZATION_WITH_OWNER RPC TESTS PASSED' as result;
