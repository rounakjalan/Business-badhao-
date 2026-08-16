-- Small additive fields needed by the dashboard UI. All nullable/optional
-- so existing rows and code remain valid; status checks are widened rather
-- than replaced, per the "text + CHECK, not enum" design in the original
-- schema (adding a stage is a one-line migration).

alter table public.deals
  drop constraint deals_status_check,
  add constraint deals_status_check check (status in ('open', 'negotiation', 'won', 'lost'));

alter table public.deals
  add column probability integer check (probability >= 0 and probability <= 100);

alter table public.leads
  add column intent text,
  add column next_action text;

alter table public.campaigns
  add column target_audience text;
