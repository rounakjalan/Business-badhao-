-- Automatic WhatsApp outreach: per-org approved template config, and a
-- per-campaign kill switch.
--
-- template_name/template_language: WhatsApp Cloud API's real platform rule
-- (Meta's "customer service window") forbids a free-form text message to
-- anyone who hasn't messaged this business in the last 24 hours — which by
-- definition is every newly discovered lead. Automatic COLD outreach is
-- therefore only possible using a pre-approved message template (Meta
-- Business Manager > Account Tools > Message Templates); there is no way
-- around this from application code, and this deployment cannot create or
-- get a template approved on an organization's behalf (that is an external,
-- human-reviewed process on Meta's side, unrelated to this codebase). Both
-- columns are nullable: an org with WhatsApp connected but no template
-- configured yet simply has no automatic cold-outreach channel (see
-- selectOutreachChannel in lead-pipeline.ts) — inbound replies and
-- continuing an existing conversation are entirely unaffected, since those
-- use free-form text within the 24h window and were already working before
-- this migration.
alter table public.whatsapp_accounts
  add column template_name text,
  add column template_language text not null default 'en_US';

-- Lets an organization turn off automatic WhatsApp outreach for one specific
-- campaign without disconnecting WhatsApp for every other campaign. Defaults
-- to true so a campaign becomes WhatsApp-eligible the moment WhatsApp and a
-- template are configured, with nothing new to click — consistent with how
-- automatic discovery/research/qualification already require no per-campaign
-- opt-in beyond a saved ICP.
alter table public.campaigns
  add column whatsapp_auto_outreach_enabled boolean not null default true;
