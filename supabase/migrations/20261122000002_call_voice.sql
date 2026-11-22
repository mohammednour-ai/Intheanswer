-- The voice the phone agent speaks in, chosen in Settings > Phone calls.
-- Null means the built-in default (src/lib/calls/voices.ts).
alter table app_settings add column if not exists call_voice text;
