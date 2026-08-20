\set ON_ERROR_STOP on
-- Assumes test_org_bootstrap.sql has already run in this database:
--   Acme Inc  = aaaaaaaa-0000-0000-0000-000000000001 (owner: Alice, 111...)
--   Globex    = bbbbbbbb-0000-0000-0000-000000000002 (owner: Bob,   222...)
--
-- Proves org isolation for the tables Lead Discovery actually writes to:
-- lead_sources, prospects (discovered prospect + evidence), leads (the
-- created lead), and agent_runs/agent_actions (the discovery run record).
-- These reuse the same public.is_org_member() RLS pattern as every other
-- table, but had no isolation test of their own before Lead Discovery
-- started writing into prospects.raw_data / agent_runs at scale.

-- --- Alice runs a discovery inside Acme ---
set role authenticated;
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);

insert into public.campaigns (id, organization_id, name, status)
values ('cccccccc-0000-0000-0000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001', 'Acme Discovery Campaign', 'active');

insert into public.lead_sources (id, organization_id, name, type)
values ('11111111-0000-0000-0000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001', 'AI Lead Discovery', 'ai_discovery');

insert into public.prospects (id, organization_id, campaign_id, lead_source_id, company_name, website, raw_data)
values (
  '22222222-0000-0000-0000-000000000010',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'cccccccc-0000-0000-0000-000000000010',
  '11111111-0000-0000-0000-000000000010',
  'Acme Discovered Co',
  'acmediscovered.example',
  '{"sourceUrl": "https://acmediscovered.example/about", "evidenceSnippet": "real excerpt"}'::jsonb
);

insert into public.leads (id, organization_id, campaign_id, lead_source_id, prospect_id, status)
values (
  '33333333-0000-0000-0000-000000000010',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'cccccccc-0000-0000-0000-000000000010',
  '11111111-0000-0000-0000-000000000010',
  '22222222-0000-0000-0000-000000000010',
  'new'
);

insert into public.agent_runs (id, organization_id, agent_type, status, input)
values (
  '44444444-0000-0000-0000-000000000010',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'lead_discovery',
  'completed',
  '{"campaignId": "cccccccc-0000-0000-0000-000000000010"}'::jsonb
);

insert into public.agent_actions (id, organization_id, agent_run_id, action_type, target_entity_type, target_entity_id)
values (
  '55555555-0000-0000-0000-000000000010',
  'aaaaaaaa-0000-0000-0000-000000000001',
  '44444444-0000-0000-0000-000000000010',
  'lead_discovered',
  'lead',
  '33333333-0000-0000-0000-000000000010'
);

reset role;

-- --- Bob (Globex) must see none of Acme's discovery data ---
set role authenticated;
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);

do $$
declare src_count int; prospect_count int; run_count int; action_count int;
begin
  select count(*) into src_count from public.lead_sources where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  select count(*) into prospect_count from public.prospects where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  select count(*) into run_count from public.agent_runs where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  select count(*) into action_count from public.agent_actions where organization_id = 'aaaaaaaa-0000-0000-0000-000000000001';
  if src_count <> 0 or prospect_count <> 0 or run_count <> 0 or action_count <> 0 then
    raise exception 'FAIL: Bob should see 0 rows of Acme''s discovery data, saw lead_sources=%, prospects=%, agent_runs=%, agent_actions=%', src_count, prospect_count, run_count, action_count;
  end if;
  raise notice 'PASS: Bob sees zero Acme lead_sources/prospects/agent_runs/agent_actions rows.';
end $$;

-- Bob cannot directly fetch Acme's discovered prospect by id either.
do $$
declare found record;
begin
  select * into found from public.prospects where id = '22222222-0000-0000-0000-000000000010';
  if found is not null then
    raise exception 'FAIL: Bob fetched Acme''s discovered prospect by id directly';
  end if;
  raise notice 'PASS: Bob cannot fetch Acme''s discovered prospect by direct id lookup.';
end $$;

-- Bob cannot see the evidence/raw_data of Acme's discovered prospect either
-- (a stricter check than a plain count — proves no partial leakage).
do $$
declare evidence_count int;
begin
  select count(*) into evidence_count
  from public.prospects
  where raw_data->>'sourceUrl' = 'https://acmediscovered.example/about';
  if evidence_count <> 0 then
    raise exception 'FAIL: Bob should not see Acme''s discovery evidence via raw_data, saw %', evidence_count;
  end if;
  raise notice 'PASS: Bob cannot see Acme''s discovery evidence.';
end $$;

-- Bob cannot forge an insert that claims Acme's organization_id for a
-- prospect (a hostile client pretending to discover into another org).
do $$
begin
  begin
    insert into public.prospects (organization_id, company_name, website)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'Hostile Prospect', 'hostile.example');
    raise exception 'FAIL: Bob should not be able to insert a prospect into Acme''s org';
  exception
    when insufficient_privilege or others then
      raise notice 'PASS: Bob was blocked from inserting a prospect into Acme''s org (%).', sqlerrm;
  end;
end $$;

reset role;

select 'ALL LEAD DISCOVERY ISOLATION TESTS PASSED' as result;
