-- ensureConversation (src/lib/outreach/conversation.ts) already treats "one
-- conversation per lead+channel, ever" as the invariant — it finds the most
-- recent one on (organization_id, lead_id, channel) before creating a new
-- one, regardless of status. Nothing in the database enforced that
-- invariant, so two concurrent first-sends on a brand-new lead (a
-- double-click, a retried request) could each miss the other's insert and
-- create two conversations for the same thread. A unique index makes the
-- second insert fail instead, so the caller can fall back to the winner —
-- same reserve-then-resolve shape as messages.send_idempotency_key.
create unique index conversations_org_lead_channel_key
  on public.conversations (organization_id, lead_id, channel);
