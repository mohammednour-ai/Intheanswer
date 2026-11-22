-- Real-time voice (Twilio ConversationRelay over a live connection). Off by default; "listed" tries it
-- only on calls to or from the numbers listed (the owner's own phone first), "all" uses it on every call.
-- Every other call keeps the HTTP path. Chosen in Portal > Settings > Phone calls.
alter table app_settings add column if not exists call_relay text not null default 'off'
  check (call_relay in ('off', 'listed', 'all'));
alter table app_settings add column if not exists call_relay_numbers text[] not null default '{}';
