-- Phone agent (In The Answer Copilot on the phone).
--
-- It explains a clinic's own report and the paid options, by voice. It only
-- ever calls a number someone at the clinic asked us to call: every outbound
-- call needs a call_consents row. Calls a clinic makes to us are answered by
-- the same agent. Nothing here places a cold call.
-- Additive only.

alter table app_settings
  add column if not exists calls_enabled boolean not null default false,   -- owner switch; off until Twilio is set up
  add column if not exists calls_daily_cap int not null default 20,        -- outbound calls started per Toronto day
  add column if not exists call_max_minutes int not null default 10,       -- a call is wound up after this long
  add column if not exists call_requests_per_report_per_day int not null default 2;

-- A short code printed beside the report's call link, so a clinic that phones
-- us can say which report it is calling about.
alter table reports add column if not exists call_code text;
create unique index if not exists reports_call_code_idx on reports (call_code) where call_code is not null;

-- ---------------------------------------------------------------------------
-- Consent to be called. Kept as evidence: who asked, how, when, and the exact
-- wording they agreed to. An outbound call without one of these is refused.
-- ---------------------------------------------------------------------------
create table if not exists call_consents (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete cascade,
  report_id uuid references reports(id) on delete set null,
  phone text not null,                         -- E.164
  source text not null check (source in ('web_form', 'email_reply', 'phone_request', 'in_person')),
  wording text not null,                       -- the consent text shown, or what the owner attested
  contact_name text,
  ip_hash text,                                -- web form only: keyed hash, never the address
  note text,
  recorded_by text,                            -- 'clinic' (web form) or the owner's email
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text
);
create index if not exists call_consents_clinic_idx on call_consents (clinic_id, granted_at desc);
create index if not exists call_consents_phone_idx on call_consents (phone);
create index if not exists call_consents_ip_idx on call_consents (ip_hash, granted_at);

-- Numbers we must never call again. Checked before every outbound call.
create table if not exists call_suppressions (
  phone text primary key,                      -- E.164
  reason text not null,
  source text not null,                        -- call, owner, wrong_number
  clinic_id uuid references clinics(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Calls and their transcripts
-- ---------------------------------------------------------------------------
create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  token text unique not null,                  -- unguessable; the id used in provider webhook URLs
  direction text not null check (direction in ('outbound', 'inbound')),
  status text not null default 'queued' check (status in (
    'queued', 'dialing', 'in_progress', 'completed', 'no_answer', 'busy', 'voicemail', 'failed', 'cancelled', 'blocked'
  )),
  clinic_id uuid references clinics(id) on delete set null,
  report_id uuid references reports(id) on delete set null,
  consent_id uuid references call_consents(id) on delete set null,
  phone text not null,                         -- the other party (E.164 when known)
  contact_name text,
  provider_call_sid text unique,
  attempts int not null default 0,
  scheduled_for timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds int,
  -- the facts the agent was given, frozen for this call (so a transcript can be checked against them)
  brief jsonb,
  state jsonb not null default '{}',           -- small per-call state: silences, blocked lines, code attempts
  signals jsonb not null default '{}',         -- what happened: wants_human, email_links, do_not_call, ...
  outcome text,
  summary text,                                -- written after the call, for the owner
  review_flags jsonb not null default '[]',    -- agent lines the after-call check could not support
  dry_run boolean not null default true,
  last_error text,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists calls_status_idx on calls (status, scheduled_for);
create index if not exists calls_clinic_idx on calls (clinic_id, created_at desc);
create index if not exists calls_started_idx on calls (started_at);

create table if not exists call_turns (
  id bigserial primary key,
  call_id uuid not null references calls(id) on delete cascade,
  seq int not null,
  role text not null check (role in ('agent', 'caller', 'system')),
  text text not null,
  action text,                                 -- agent turns: continue, end_call, handoff, ...
  blocked_text text,                           -- what the model wrote when the spoken-word check replaced it
  flags jsonb not null default '[]',
  at timestamptz not null default now(),
  unique (call_id, seq)
);

-- ---------------------------------------------------------------------------
-- Row level security: only the owner, as everywhere else.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['call_consents', 'call_suppressions', 'calls', 'call_turns']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_all on public.%I', t);
    execute format(
      'create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to authenticated;
