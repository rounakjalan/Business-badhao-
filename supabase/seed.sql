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
insert into public.campaigns (id, organization_id, name, description, objective, target_audience, status) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1',
   'Q1 Outbound', 'Cold outreach to local retailers', 'Book 20 demo calls', 'Retail store owners, Delhi NCR', 'active')
on conflict (id) do nothing;

insert into public.lead_sources (id, organization_id, name, type) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'Referral', 'referral'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'Website', 'website')
on conflict (id) do nothing;

insert into public.prospects (id, organization_id, campaign_id, lead_source_id, company_name, contact_name, email) values
  ('00000000-0000-0000-0000-0000000000ba', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'Sharma Retailers', 'Anjali Sharma', 'anjali@sharmaretail.example')
on conflict (id) do nothing;

insert into public.leads (id, organization_id, campaign_id, lead_source_id, status, qualification_status, current_score, intent, next_action) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'contacted', 'qualifying', 62, 'Interested', 'Send pricing sheet'),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b2', 'new', 'pending', null, null, null),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'qualified', 'qualified', 85, 'Ready to Buy', 'Schedule demo call')
on conflict (id) do nothing;

insert into public.contacts (organization_id, lead_id, full_name, email, phone, is_primary) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', 'Rohit Verma', 'rohit@retailerx.example', '+91 98100 00001', true),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d3', 'Priya Nair', 'priya@retailery.example', '+91 98100 00002', true)
on conflict do nothing;

insert into public.lead_research (organization_id, lead_id, summary, source) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d3', 'Priya runs a 3-store chain and is evaluating vendors this quarter.', 'manual')
on conflict do nothing;

insert into public.conversations (id, organization_id, lead_id, campaign_id, channel, status, intent) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', 'email', 'open', 'Interested')
on conflict (id) do nothing;

insert into public.messages (organization_id, conversation_id, lead_id, direction, channel, sender_type, body) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 'outbound', 'email', 'human', 'Hi Rohit, following up on our call — happy to send over pricing whenever useful.'),
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 'inbound', 'email', 'lead', 'Thanks! Yes please, send the pricing sheet across.')
on conflict do nothing;

insert into public.deals (id, organization_id, lead_id, campaign_id, title, status, value, currency, probability, expected_close_date) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c1',
   'Acme Demo Co <> Retailer X', 'negotiation', 45000, 'INR', 70, current_date + interval '30 days')
on conflict (id) do nothing;

insert into public.tasks (organization_id, title, status, due_at, related_entity_type, related_entity_id) values
  ('00000000-0000-0000-0000-0000000000a1', 'Send pricing sheet to Rohit Verma', 'pending', now() + interval '1 day', 'lead', '00000000-0000-0000-0000-0000000000d1'),
  ('00000000-0000-0000-0000-0000000000a1', 'Prepare demo deck for Priya Nair', 'pending', now() - interval '1 day', 'lead', '00000000-0000-0000-0000-0000000000d3')
on conflict do nothing;
