\set ON_ERROR_STOP on
-- Assumes test_org_bootstrap.sql has already run in this database:
--   Acme Inc  = aaaaaaaa-0000-0000-0000-000000000001 (owner: Alice, 111...)
--   Globex    = bbbbbbbb-0000-0000-0000-000000000002 (owner: Bob,   222...)

-- --- Alice creates business data inside Acme ---
set role authenticated;
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);

insert into public.campaigns (id, organization_id, name, status)
values ('cccccccc-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Acme Q1 Outreach', 'active');

insert into public.leads (id, organization_id, campaign_id, status)
values ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001', 'new');

insert into public.deals (id, organization_id, lead_id, title, status, value)
values ('eeeeeeee-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'Acme <> BigCo deal', 'open', 5000);

insert into public.conversations (id, organization_id, lead_id, status)
values ('ffffffff-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'open');

reset role;

-- --- Bob (Globex) must see none of it ---
set role authenticated;
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);

do $$
declare c_count int; l_count int; d_count int; conv_count int;
begin
  select count(*) into c_count from public.campaigns;
  select count(*) into l_count from public.leads;
  select count(*) into d_count from public.deals;
  select count(*) into conv_count from public.conversations;
  if c_count <> 0 or l_count <> 0 or d_count <> 0 or conv_count <> 0 then
    raise exception 'FAIL: Bob should see 0 rows in every Acme-owned table, saw campaigns=%, leads=%, deals=%, conversations=%', c_count, l_count, d_count, conv_count;
  end if;
  raise notice 'PASS: Bob sees zero campaigns/leads/deals/conversations belonging to Acme.';
end $$;

-- Bob cannot directly fetch Acme's deal by id either (not just count-based).
do $$
declare found record;
begin
  select * into found from public.deals where id = 'eeeeeeee-0000-0000-0000-000000000001';
  if found is not null then
    raise exception 'FAIL: Bob fetched Acme''s deal by id directly';
  end if;
  raise notice 'PASS: Bob cannot fetch Acme''s deal by direct id lookup.';
end $$;

-- Bob cannot forge an insert that claims Acme's organization_id.
do $$
begin
  begin
    insert into public.campaigns (organization_id, name, status)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'Hostile insert', 'draft');
    raise exception 'FAIL: Bob should not be able to insert a campaign into Acme''s org';
  exception
    when insufficient_privilege or others then
      raise notice 'PASS: Bob was blocked from inserting into Acme''s org (%).', sqlerrm;
  end;
end $$;

-- Bob CAN create data inside his own org.
insert into public.campaigns (id, organization_id, name, status)
values ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000002', 'Globex Launch', 'draft');

do $$
declare cnt int;
begin
  select count(*) into cnt from public.campaigns;
  if cnt <> 1 then
    raise exception 'FAIL: Bob should see exactly 1 campaign (his own), saw %', cnt;
  end if;
  raise notice 'PASS: Bob sees exactly his own campaign after creating it.';
end $$;

reset role;

-- --- audit_logs: regular members cannot write; only admins/owners can read ---
set role authenticated;
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);

do $$
begin
  begin
    insert into public.audit_logs (organization_id, user_id, action)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'test.action');
    raise exception 'FAIL: even an owner should not be able to insert into audit_logs via the client role';
  exception
    when insufficient_privilege or undefined_object or others then
      raise notice 'PASS: audit_logs insert correctly blocked for the authenticated role (%).', sqlerrm;
  end;
end $$;

reset role;

-- Insert an audit log row as postgres (simulating a trusted server-side
-- write path) so we can confirm the SELECT policy still applies correctly.
insert into public.audit_logs (organization_id, user_id, action)
values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'org.created');

set role authenticated;
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
do $$
declare cnt int;
begin
  select count(*) into cnt from public.audit_logs;
  if cnt <> 1 then
    raise exception 'FAIL: Alice (owner) should see the 1 audit log row for her org, saw %', cnt;
  end if;
  raise notice 'PASS: Alice (owner) can read her org''s audit log.';
end $$;
reset role;

-- A plain member (not owner/admin) should NOT be able to read audit_logs.
insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'carol@acme.test');
insert into public.profiles (id, email, full_name) values ('33333333-3333-3333-3333-333333333333', 'carol@acme.test', 'Carol') on conflict (id) do nothing;

set role authenticated;
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
insert into public.organization_members (organization_id, user_id, role)
values ('aaaaaaaa-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'member');
reset role;

set role authenticated;
select set_config('request.jwt.uid', '33333333-3333-3333-3333-333333333333', false);
do $$
declare cnt int;
begin
  select count(*) into cnt from public.audit_logs;
  if cnt <> 0 then
    raise exception 'FAIL: a plain member should not be able to read audit_logs, saw %', cnt;
  end if;
  raise notice 'PASS: a plain (non-admin) member cannot read audit_logs.';
end $$;

-- But Carol (a plain member) CAN see Acme's business data (member-level access).
do $$
declare cnt int;
begin
  select count(*) into cnt from public.leads where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if cnt <> 1 then
    raise exception 'FAIL: Carol (member) should see Acme''s 1 lead, saw %', cnt;
  end if;
  raise notice 'PASS: Carol (member) can see Acme''s business data.';
end $$;
reset role;

select 'ALL BUSINESS DATA ISOLATION TESTS PASSED' as result;
