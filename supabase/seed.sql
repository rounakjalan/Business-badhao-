-- =============================================================================
-- LOCAL DEVELOPMENT SEED DATA — NEVER RUN AGAINST PRODUCTION
--
-- This file is only ever executed by `supabase db reset` / `supabase start`,
-- which apply exclusively to your local Supabase stack (a Postgres instance
-- running in Docker on your machine). It is not part of `supabase db push`
-- and is never applied to a linked remote project.
--
-- It creates one confirmed dev user, an organization they own, and a small
-- amount of sample campaign/lead/conversation/deal data so the dashboard
-- has something real to render while developing locally.
--
-- Dev login (once seeded): dev@businessbadhao.test / password123
-- =============================================================================

-- --- Dev user -----------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, recovery_token
) values (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'dev@businessbadhao.test',
  crypt('password123', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Dev User"}',
  now(),
  now(),
  '',
  ''
)
on conflict (id) do nothing;

insert into auth.identities (
  id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '{"sub":"00000000-0000-0000-0000-000000000001","email":"dev@businessbadhao.test"}',
  'email',
  now(),
  now(),
  now()
)
on conflict (provider, provider_id) do nothing;

-- The handle_new_user trigger creates the matching public.profiles row
-- automatically on insert into auth.users above.

-- --- Organization (inserted directly as postgres, bypassing RLS, since
-- this script runs outside of any authenticated request context) --------
insert into public.organizations (id, name, created_by) values
  ('00000000-0000-0000-0000-0000000000a1', 'Acme Demo Co', '00000000-0000-0000-0000-000000000001')
on conflict (id) do nothing;

insert into public.organization_members (organization_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'owner')
on conflict (organization_id, user_id) do nothing;

-- --- Sample business data -------------------------------------------------
insert into public.campaigns (id, organization_id, name, description, objective, status) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1',
   'Q1 Outbound', 'Cold outreach to local retailers', 'Book 20 demo calls', 'active')
on conflict (id) do nothing;

insert into public.leads (id, organization_id, campaign_id, status, qualification_status, current_score) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'contacted', 'qualifying', 62),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'new', 'pending', null),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'qualified', 'qualified', 85)
on conflict (id) do nothing;

insert into public.conversations (id, organization_id, lead_id, campaign_id, channel, status, intent) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'email', 'open', 'pricing_question')
on conflict (id) do nothing;

insert into public.deals (id, organization_id, lead_id, campaign_id, title, status, value, currency, expected_close_date) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1',
   'Acme Demo Co <> Retailer X', 'open', 45000, 'INR', current_date + interval '30 days')
on conflict (id) do nothing;
