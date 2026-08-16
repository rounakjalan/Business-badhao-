\set ON_ERROR_STOP on

-- Two auth users, simulating two separate businesses signing up.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@acme.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@globex.test');

insert into public.profiles (id, email, full_name) values
  ('11111111-1111-1111-1111-111111111111', 'alice@acme.test', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'bob@globex.test', 'Bob')
on conflict (id) do nothing;

-- --- Simulate Alice's session ---
set role authenticated;
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);

insert into public.organizations (id, name, created_by) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Acme Inc', '11111111-1111-1111-1111-111111111111');

insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner');

-- Alice should see exactly her org.
do $$
declare cnt int;
begin
  select count(*) into cnt from public.organizations;
  if cnt <> 1 then
    raise exception 'FAIL: Alice should see exactly 1 org, saw %', cnt;
  end if;
  raise notice 'PASS: Alice sees exactly her own org (%).', cnt;
end $$;

reset role;

-- --- Simulate Bob's session ---
set role authenticated;
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);

insert into public.organizations (id, name, created_by) values
  ('bbbbbbbb-0000-0000-0000-000000000002', 'Globex Corp', '22222222-2222-2222-2222-222222222222');

insert into public.organization_members (organization_id, user_id, role) values
  ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'owner');

-- Bob must NOT see Alice's org.
do $$
declare cnt int;
declare acme_visible int;
begin
  select count(*) into cnt from public.organizations;
  select count(*) into acme_visible from public.organizations where name = 'Acme Inc';
  if cnt <> 1 then
    raise exception 'FAIL: Bob should see exactly 1 org, saw %', cnt;
  end if;
  if acme_visible <> 0 then
    raise exception 'FAIL: Bob should NOT be able to see Acme Inc';
  end if;
  raise notice 'PASS: Bob sees exactly his own org and cannot see Acme Inc.';
end $$;

-- Bob must not be able to insert himself into Alice's org (privilege escalation attempt).
do $$
begin
  begin
    insert into public.organization_members (organization_id, user_id, role)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'owner');
    raise exception 'FAIL: Bob should NOT be able to add himself to Acme Inc';
  exception
    when insufficient_privilege or others then
      raise notice 'PASS: Bob was blocked from joining Acme Inc (%).', sqlerrm;
  end;
end $$;

-- Bob must not be able to read Alice's organization_members rows directly.
do $$
declare cnt int;
begin
  select count(*) into cnt from public.organization_members where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if cnt <> 0 then
    raise exception 'FAIL: Bob should not see Acme''s membership rows, saw %', cnt;
  end if;
  raise notice 'PASS: Bob cannot see Acme''s membership rows.';
end $$;

reset role;

-- --- Back to Alice: a second bootstrap insert into her own org must fail (already has a member) ---
set role authenticated;
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  begin
    insert into public.organization_members (organization_id, user_id, role)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'owner');
    raise exception 'FAIL: duplicate bootstrap insert should have failed (unique constraint)';
  exception
    when unique_violation then
      raise notice 'PASS: duplicate membership insert correctly rejected by unique constraint.';
  end;
end $$;

reset role;

select 'ALL ORG BOOTSTRAP / ISOLATION TESTS PASSED' as result;
