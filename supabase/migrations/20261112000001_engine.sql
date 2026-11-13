-- Phase 4 groundwork: queue claim order, DNS check detail, lookups used by
-- sending, webhooks and replies.

-- The claim orders by priority then run_after.
drop index if exists jobs_claim_idx;
create index jobs_claim_idx on jobs (status, priority, run_after);

alter table app_settings
  add column dns_detail jsonb;               -- last SPF / DKIM / DMARC check, record by record

-- Lookups by address (unsubscribe, replies, webhooks).
create index messages_to_email_idx on messages (lower(to_email));
create index contacts_email_idx on contacts (lower(email));
create index inbound_received_idx on inbound_messages (received_at desc);
create index message_events_message_idx on message_events (message_id);
