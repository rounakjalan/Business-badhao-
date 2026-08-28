-- Deals phase: a proper 6-stage pipeline (New -> Qualified -> Proposal /
-- Product Info -> Payment Pending -> Won -> Lost), plus the direct links a
-- deal needs back to the conversation and contact it came from. lead_id and
-- campaign_id already exist; company is reached through lead_id -> prospect.
--
-- Existing rows are remapped to the new stage names before the constraint
-- is narrowed: 'open' (no activity yet) becomes 'new', and 'negotiation'
-- (active back-and-forth) becomes 'proposal', the closest of the new
-- stages. 'won' and 'lost' are untouched. The constraint is widened to a
-- superset first — the current constraint doesn't allow the new stage
-- names, so writing them (even as a one-time migration update) would be
-- rejected until it does; it's then narrowed to the final 6 stages once no
-- row holds an old value any more.
alter table public.deals
  drop constraint deals_status_check,
  add constraint deals_status_check
    check (status in ('open', 'negotiation', 'new', 'qualified', 'proposal', 'payment_pending', 'won', 'lost'));

update public.deals set status = 'new' where status = 'open';
update public.deals set status = 'proposal' where status = 'negotiation';

alter table public.deals
  drop constraint deals_status_check,
  add constraint deals_status_check
    check (status in ('new', 'qualified', 'proposal', 'payment_pending', 'won', 'lost'));

alter table public.deals
  alter column status set default 'new';

alter table public.deals
  add column conversation_id uuid references public.conversations(id) on delete set null,
  add column contact_id uuid references public.contacts(id) on delete set null,
  add column notes text;

create index deals_conversation_id_idx on public.deals(conversation_id);
create index deals_contact_id_idx on public.deals(contact_id);
