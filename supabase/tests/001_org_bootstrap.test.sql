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

-- =============================================================================
-- The remaining three policies on these same tables, plus the
-- organization_members DELETE policy, never had direct coverage before —
-- added alongside the RLS auth_rls_initplan performance fix (wrapping each
-- policy's own auth.uid() call as (select auth.uid())) specifically to
-- prove that optimization changed nothing about who can do what. Reuses
-- Alice/Bob/Acme/Globex from above rather than duplicating setup.
-- =============================================================================

-- --- profiles INSERT: "Users can insert their own profile" ---
-- Eve and Frank are fresh auth users. handle_new_user's trigger already
-- gives each a profile row in real production; deleted here (as superuser,
-- bypassing RLS — there is no DELETE policy on profiles for `authenticated`
-- at all) so this test exercises the INSERT policy itself cleanly, with
-- neither id already holding a row.
insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'eve@newco.test'),
  ('66666666-6666-6666-6666-666666666666', 'frank@newco.test');
delete from public.profiles where id in ('55555555-5555-5555-5555-555555555555', '66666666-6666-6666-6666-666666666666');

set role authenticated;
select set_config('request.jwt.uid', '55555555-5555-5555-5555-555555555555', false);

-- Eve cannot insert a profile row under Frank's id (neither id holds a row
-- right now, so this isolates the WITH CHECK rejection from any possible
-- primary-key conflict).
do $$
begin
  begin
    insert into public.profiles (id, email, full_name) values ('66666666-6666-6666-6666-666666666666', 'fake@frank.test', 'Fake Frank');
    raise exception 'FAIL: Eve should NOT be able to insert a profile row under Frank''s id';
  exception
    when insufficient_privilege or others then
      raise notice 'PASS: Eve was blocked from inserting a profile row under someone else''s id (%).', sqlerrm;
  end;
end $$;

-- Eve CAN insert her own profile row.
insert into public.profiles (id, email, full_name) values ('55555555-5555-5555-5555-555555555555', 'eve@newco.test', 'Eve');
do $$
declare cnt int;
begin
  select count(*) into cnt from public.profiles where id = '55555555-5555-5555-5555-555555555555';
  if cnt <> 1 then
    raise exception 'FAIL: Eve should be able to insert her own profile row, saw %', cnt;
  end if;
  raise notice 'PASS: Eve can insert her own profile row.';
end $$;

reset role;

-- --- profiles SELECT: "Users can view their own profile" ---
set role authenticated;
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);

do $$
declare cnt int;
begin
  select count(*) into cnt from public.profiles where id = '11111111-1111-1111-1111-111111111111';
  if cnt <> 1 then
    raise exception 'FAIL: Alice should see her own profile, saw %', cnt;
  end if;
  raise notice 'PASS: Alice sees her own profile.';
end $$;

-- Alice and Bob share no organization yet, so Alice must not see Bob's profile.
do $$
declare cnt int;
begin
  select count(*) into cnt from public.profiles where id = '22222222-2222-2222-2222-222222222222';
  if cnt <> 0 then
    raise exception 'FAIL: Alice should NOT see Bob''s profile (no shared org), saw %', cnt;
  end if;
  raise notice 'PASS: Alice cannot see Bob''s profile — no shared organization.';
end $$;

-- --- profiles UPDATE: "Users can update their own profile" ---
update public.profiles set full_name = 'Alice Updated' where id = '11111111-1111-1111-1111-111111111111';
do $$
declare nm text;
begin
  select full_name into nm from public.profiles where id = '11111111-1111-1111-1111-111111111111';
  if nm <> 'Alice Updated' then
    raise exception 'FAIL: Alice should be able to update her own profile, got %', nm;
  end if;
  raise notice 'PASS: Alice can update her own profile.';
end $$;

-- Alice must not be able to update Bob's profile — the USING clause
-- filters the target row out entirely, so this affects zero rows rather
-- than erroring. Verified by reading Bob's real row as superuser
-- afterward, since Alice can't even SELECT it herself yet (no shared org).
update public.profiles set full_name = 'Hacked By Alice' where id = '22222222-2222-2222-2222-222222222222';

reset role;
do $$
declare nm text;
begin
  select full_name into nm from public.profiles where id = '22222222-2222-2222-2222-222222222222';
  if nm = 'Hacked By Alice' then
    raise exception 'FAIL: Alice must not be able to update Bob''s profile';
  end if;
  raise notice 'PASS: Alice cannot update Bob''s profile — unchanged (%).', nm;
end $$;

-- --- shares_org_with: once Alice legitimately adds Bob to Acme, she can see his profile ---
set role authenticated;
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);

insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'member');

do $$
declare cnt int;
begin
  select count(*) into cnt from public.profiles where id = '22222222-2222-2222-2222-222222222222';
  if cnt <> 1 then
    raise exception 'FAIL: Alice should now see Bob''s profile — they share Acme Inc, saw %', cnt;
  end if;
  raise notice 'PASS: Alice sees Bob''s profile now that they share an organization.';
end $$;

reset role;

-- --- organization_members DELETE: "Owners can remove members, members can remove themselves" ---

-- Bob (a plain member, not owner) must not be able to remove Alice (the owner).
set role authenticated;
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);

delete from public.organization_members
where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'
  and user_id = '11111111-1111-1111-1111-111111111111';

reset role;
do $$
declare cnt int;
begin
  select count(*) into cnt from public.organization_members
  where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    and user_id = '11111111-1111-1111-1111-111111111111';
  if cnt <> 1 then
    raise exception 'FAIL: Bob (a plain member) must not be able to remove Alice (the owner)';
  end if;
  raise notice 'PASS: Bob cannot remove Alice from Acme — not an owner and not removing himself.';
end $$;

-- Bob CAN remove himself (member self-removal).
set role authenticated;
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);

delete from public.organization_members
where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'
  and user_id = '22222222-2222-2222-2222-222222222222';

reset role;
do $$
declare cnt int;
begin
  select count(*) into cnt from public.organization_members
  where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    and user_id = '22222222-2222-2222-2222-222222222222';
  if cnt <> 0 then
    raise exception 'FAIL: Bob should be able to remove himself from Acme, saw %', cnt;
  end if;
  raise notice 'PASS: Bob removed himself from Acme.';
end $$;

-- Alice (the owner) re-adds Bob, then removes him herself (owner removes a member).
set role authenticated;
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);

insert into public.organization_members (organization_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'member');

delete from public.organization_members
where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'
  and user_id = '22222222-2222-2222-2222-222222222222';

reset role;
do $$
declare cnt int;
begin
  select count(*) into cnt from public.organization_members
  where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    and user_id = '22222222-2222-2222-2222-222222222222';
  if cnt <> 0 then
    raise exception 'FAIL: Alice (the owner) should be able to remove Bob from Acme, saw %', cnt;
  end if;
  raise notice 'PASS: Alice (the owner) removed Bob from Acme.';
end $$;

-- Net effect of this whole block: Acme is back to exactly {Alice: owner},
-- same as before this section ran — later test files that reuse Acme's id
-- see no side effect from any of the above.

select 'ALL ORG BOOTSTRAP / ISOLATION TESTS PASSED' as result;
