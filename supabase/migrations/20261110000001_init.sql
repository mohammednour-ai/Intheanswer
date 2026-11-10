-- In The Answer: initial schema.
-- Every table has row level security enabled. The only policy grants the owner
-- (the single account allowed to sign in) full access. Server jobs connect with
-- the service role / database owner, which bypasses RLS.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type send_mode as enum ('REVIEW', 'AUTO');
create type message_type as enum (
  'first_email', 'follow_up', 'interested_reply', 'question_answer',
  'full_report_delivery', 'monthly_report',
  -- always automatic, never queued for review:
  'payment_receipt', 'unsubscribe_confirmation',
  -- owner-facing:
  'owner_digest', 'owner_alert',
  -- retest after one-time purchase, uses the monthly_report switch:
  'retest_upgrade',
  -- self-serve teaser requested by the clinic itself
  'self_serve_teaser',
  -- intake / final files after the intake form
  'final_files'
);
create type message_status as enum (
  'draft', 'pending_review', 'held', 'approved', 'scheduled', 'sending',
  'sent', 'failed', 'expired', 'skipped', 'cancelled', 'blocked'
);
create type clinic_status as enum (
  'discovered', 'excluded', 'contact_found', 'no_contact', 'do_not_contact',
  'tested', 'audited', 'parked', 'teaser_built', 'held', 'queued',
  'contacted', 'replied', 'customer', 'suppressed', 'skipped', 'closed'
);
create type mention_status as enum ('recommended', 'listed_only', 'not_named');
create type check_result as enum ('found', 'not_found', 'could_not_verify');
create type job_status as enum ('queued', 'running', 'done', 'failed', 'dead', 'cancelled');
create type suppression_kind as enum ('address', 'domain');
create type reply_class as enum (
  'interested', 'question', 'not_interested', 'unsubscribe', 'auto_reply', 'other'
);
create type report_kind as enum ('teaser', 'full', 'final', 'retest', 'monthly', 'sample');

-- ---------------------------------------------------------------------------
-- Owner + settings
-- ---------------------------------------------------------------------------
create table app_settings (
  id boolean primary key default true check (id), -- singleton row
  owner_user_id uuid,                -- the only auth user allowed in
  owner_email text,
  kill_switch boolean not null default false,       -- global stop, set by owner
  auto_paused boolean not null default false,       -- set by bounce/complaint monitor
  auto_pause_reason text,
  auto_paused_at timestamptz,
  auto_pause_cleared_at timestamptz,             -- only events after this count toward a new pause
  dry_run boolean not null default true,            -- runs everything, sends nothing, charges nothing
  live_enabled boolean not null default false,      -- owner must flip this to go live
  warmup_start_date date,                           -- first day of sending on the subdomain
  warmup_start_per_day int not null default 10,
  warmup_step_per_week int not null default 5,
  warmup_ceiling int not null default 40,
  daily_cap_override int,                           -- optional manual lower cap
  send_window_start time not null default '09:30',  -- Toronto time, business days only
  send_window_end time not null default '16:30',
  timezone text not null default 'America/Toronto',
  claude_daily_spend_cap_usd numeric(10,2) not null default 25,
  pipeline_paused_for_spend boolean not null default false,
  auto_review_first_n int not null default 10,      -- default "first N still reviewed" after switching to AUTO
  pending_expiry_days int not null default 7,
  bounce_rate_threshold numeric(5,4) not null default 0.03,
  follow_up_business_days int not null default 5,
  retest_after_purchase_days int not null default 28,
  dns_verified boolean not null default false,
  dns_checked_at timestamptz,
  digest_hour_local int not null default 8,
  updated_at timestamptz not null default now()
);
insert into app_settings (id) values (true);

create table message_type_modes (
  type message_type primary key,
  mode send_mode not null default 'REVIEW',
  review_first_n int not null default 10,
  -- items created after switching to AUTO; the first review_first_n still go to review
  auto_since timestamptz,
  auto_created_count int not null default 0,
  updated_at timestamptz not null default now()
);
insert into message_type_modes (type) values
  ('first_email'), ('follow_up'), ('interested_reply'), ('question_answer'),
  ('full_report_delivery'), ('monthly_report');

-- ---------------------------------------------------------------------------
-- Config: sectors, cities, targets, question sets, approved answers
-- ---------------------------------------------------------------------------
create table sectors (
  id serial primary key,
  slug text unique not null,
  name text not null,                -- e.g. "dental clinic"
  patient_noun text not null,        -- e.g. "dentist"
  places_query text not null,        -- text search query template, {city}
  places_included_type text,         -- optional Places type
  regulator_note text not null,      -- e.g. RCDSO advertising standards
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table cities (
  id serial primary key,
  name text not null,
  province text not null default 'ON',
  lat double precision,
  lng double precision,
  radius_m int not null default 15000,
  active boolean not null default true,
  unique (name, province)
);

create table discovery_targets (
  id serial primary key,
  sector_id int not null references sectors(id),
  city_id int not null references cities(id),
  active boolean not null default true,
  last_run_at timestamptz,
  unique (sector_id, city_id)
);

create table question_sets (
  id serial primary key,
  sector_id int not null references sectors(id),
  version int not null default 1,
  questions jsonb not null,          -- array of strings with {city}
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (sector_id, version)
);

create table approved_answers (
  id serial primary key,
  key text unique not null,
  question text not null,            -- canonical question
  match_hints text[] not null default '{}',
  answer text not null,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table chain_patterns (
  id serial primary key,
  pattern text unique not null,      -- case-insensitive substring of the business name or domain
  note text
);

-- ---------------------------------------------------------------------------
-- Clinics and contact discovery
-- ---------------------------------------------------------------------------
create table clinics (
  id uuid primary key default gen_random_uuid(),
  place_id text unique,
  name text not null,
  address text,
  city_id int references cities(id),
  sector_id int references sectors(id),
  phone text,
  website text,
  domain text,
  rating numeric(2,1),
  review_count int,
  status clinic_status not null default 'discovered',
  status_reason text,
  source text not null default 'places' check (source in ('places', 'self_serve', 'seed')),
  contact_count int not null default 0,      -- unsolicited contacts sent, max 2 ever
  replied boolean not null default false,
  places_raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index clinics_status_idx on clinics(status);
create index clinics_domain_idx on clinics(domain);

create table page_cache (
  id bigserial primary key,
  url text unique not null,
  domain text not null,
  fetched_at timestamptz not null default now(),
  http_status int,
  content_type text,
  body text,
  body_sha256 text,
  robots_allowed boolean not null default true,
  error text
);
create index page_cache_domain_idx on page_cache(domain);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  email text not null,
  source_url text not null,                  -- exact page where the address is published
  source_snippet text,                       -- the surrounding text as evidence
  on_own_domain boolean not null,
  found_at timestamptz not null default now(),
  is_primary boolean not null default false,
  unique (clinic_id, email)
);

-- ---------------------------------------------------------------------------
-- Tests (step 3): one run per (sector, city, question set), shared by clinics
-- ---------------------------------------------------------------------------
create table test_runs (
  id uuid primary key default gen_random_uuid(),
  sector_id int not null references sectors(id),
  city_id int not null references cities(id),
  question_set_id int not null references question_sets(id),
  assistant text not null,                   -- e.g. "Claude"
  model text not null,                       -- exact model id
  run_label text not null,                   -- e.g. 2026-11 or a one-off id; idempotency
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (sector_id, city_id, question_set_id, run_label)
);

create table test_answers (
  id uuid primary key default gen_random_uuid(),
  test_run_id uuid not null references test_runs(id) on delete cascade,
  question_index int not null,
  question text not null,
  answer_text text not null,
  sources jsonb not null default '[]',       -- [{url,title}]
  clinics_named jsonb not null default '[]', -- [{name, url?, prominence:'recommended'|'listed_only'}]
  raw jsonb,
  asked_at timestamptz not null default now(),
  unique (test_run_id, question_index)
);

create table clinic_test_results (
  id bigserial primary key,
  clinic_id uuid not null references clinics(id) on delete cascade,
  test_answer_id uuid not null references test_answers(id) on delete cascade,
  status mention_status not null,
  matched_as text,                           -- the name as it appeared in the answer
  evidence text,                             -- quote from the answer
  unique (clinic_id, test_answer_id)
);

-- ---------------------------------------------------------------------------
-- Site audit (step 4)
-- ---------------------------------------------------------------------------
create table audits (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  run_at timestamptz not null default now(),
  pages_read text[] not null default '{}',
  superseded boolean not null default false
);
create index audits_clinic_idx on audits(clinic_id, run_at desc);

create table audit_checks (
  id bigserial primary key,
  audit_id uuid not null references audits(id) on delete cascade,
  check_key text not null,
  result check_result not null,
  summary text not null,                     -- one plain sentence of what was observed
  evidence jsonb not null default '[]',      -- [{url, quote}]
  -- whether this is a concrete gap the clinic could fix (used for selection)
  is_gap boolean not null default false,
  severity int not null default 0,           -- higher is more concrete
  unique (audit_id, check_key)
);

-- ---------------------------------------------------------------------------
-- Scores (step 5)
-- ---------------------------------------------------------------------------
create table scores (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  test_run_id uuid not null references test_runs(id),
  audit_id uuid not null references audits(id),
  recommended int not null,
  listed_only int not null,
  not_named int not null,
  total int not null,
  confirmed_findings int not null,
  qualifies boolean not null,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (clinic_id, test_run_id, audit_id)
);

-- ---------------------------------------------------------------------------
-- Reports (teaser, full, retest, monthly)
-- ---------------------------------------------------------------------------
create table reports (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete cascade,
  kind report_kind not null,
  token text unique not null,                -- unguessable URL token
  score_id uuid references scores(id),
  previous_report_id uuid references reports(id),
  data jsonb not null,                       -- the structured content the HTML renders from
  html text not null,
  pdf_path text,                             -- storage path
  pdf_bytes int,
  created_at timestamptz not null default now(),
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count int not null default 0,
  superseded boolean not null default false
);

create table report_views (
  id bigserial primary key,
  report_id uuid not null references reports(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  ua_hash text,
  is_owner boolean not null default false
);

-- ---------------------------------------------------------------------------
-- Messages, approvals, audit log, suppression
-- ---------------------------------------------------------------------------
create table messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id) on delete set null,
  type message_type not null,
  status message_status not null default 'draft',
  to_email text not null,
  contact_source_url text,                   -- where the address was published (cold mail)
  subject text not null,
  body_text text not null,
  body_html text,
  report_id uuid references reports(id),
  attach_pdf boolean not null default false,
  claims jsonb not null default '[]',        -- [{claim, evidence:[{kind,url,quote}] }]
  flags jsonb not null default '[]',         -- verification gate flags
  gate_passed boolean,
  requires_review boolean not null default true,
  review_reason text,
  mode_at_creation send_mode,
  in_reply_to uuid references messages(id),
  inbound_id uuid,
  expires_at timestamptz,
  scheduled_for timestamptz,
  sent_at timestamptz,
  provider_message_id text unique,
  content_hash text,
  idempotency_key text unique,
  last_error text,
  delivered_at timestamptz,
  opened_at timestamptz,
  bounced_at timestamptz,
  complained_at timestamptz,
  replied_at timestamptz,
  dry_run boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index messages_status_idx on messages(status, type);
create index messages_clinic_idx on messages(clinic_id);
create index messages_sent_idx on messages(sent_at);

create table message_events (
  id bigserial primary key,
  message_id uuid references messages(id) on delete cascade,
  provider_event_id text unique,
  type text not null,                        -- delivered, opened, clicked, bounced, complained, ...
  occurred_at timestamptz not null default now(),
  payload jsonb
);

-- one row per send attempt that left (or would have left, in dry run)
create table send_audit_log (
  id bigserial primary key,
  message_id uuid not null references messages(id),
  recipient text not null,
  recipient_source_url text,
  sent_at timestamptz not null default now(),
  content_hash text not null,
  unsubscribe_status text not null,          -- e.g. "not_suppressed; link included"
  dry_run boolean not null,
  provider_message_id text
);

create table approval_log (
  id bigserial primary key,
  message_id uuid not null references messages(id) on delete cascade,
  action text not null check (action in (
    'approve', 'edit', 'regenerate', 'skip', 'never_contact', 'bulk_approve', 'expire', 'auto_send'
  )),
  actor_user_id uuid,
  actor_email text,
  at timestamptz not null default now(),
  before jsonb,
  after jsonb
);

create table suppressions (
  id bigserial primary key,
  kind suppression_kind not null,
  value text not null,                       -- lowercased email or domain
  reason text not null,
  source text not null,                      -- unsubscribe_link, reply, bounce, complaint, owner, do_not_contact_notice
  created_at timestamptz not null default now(),
  unique (kind, value)
);

-- ---------------------------------------------------------------------------
-- Inbound replies
-- ---------------------------------------------------------------------------
create table inbound_messages (
  id uuid primary key default gen_random_uuid(),
  provider_id text unique,
  from_email text not null,
  to_email text,
  subject text,
  body_text text,
  received_at timestamptz not null default now(),
  clinic_id uuid references clinics(id) on delete set null,
  related_message_id uuid references messages(id),
  classification reply_class,
  classification_reason text,
  matched_answer_key text,
  drafted_reply text,
  handled boolean not null default false,
  escalated boolean not null default false,
  raw jsonb
);

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
create table stripe_events (
  id text primary key,                       -- Stripe event id; idempotency
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  payload jsonb not null
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id),
  kind text not null check (kind in ('one_time', 'subscription')),
  stripe_checkout_session_id text unique,
  stripe_customer_id text,
  stripe_payment_intent_id text,
  stripe_subscription_id text,
  amount_cents int,
  currency text not null default 'cad',
  status text not null default 'pending',    -- pending, paid, failed, refunded, partially_refunded
  customer_email text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  refunded_at timestamptz
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references clinics(id),
  stripe_subscription_id text unique not null,
  stripe_customer_id text,
  status text not null,                      -- active, past_due, canceled, unpaid, incomplete...
  current_period_end timestamptz,
  min_term_end timestamptz,
  cancel_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table intake_forms (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id),
  order_id uuid references orders(id),
  token text unique not null,
  answers jsonb,
  submitted_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Owner tasks (onboarding, escalations)
-- ---------------------------------------------------------------------------
create table owner_tasks (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('onboarding', 'escalation', 'held_review', 'alert')),
  clinic_id uuid references clinics(id),
  title text not null,
  body text,
  report_id uuid references reports(id),
  inbound_id uuid references inbound_messages(id),
  status text not null default 'open' check (status in ('open', 'done', 'dismissed')),
  created_at timestamptz not null default now(),
  done_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Self-serve requests from the public site
-- ---------------------------------------------------------------------------
create table self_serve_requests (
  id uuid primary key default gen_random_uuid(),
  website text not null,
  email text not null,
  ip_hash text,
  status text not null default 'received',   -- received, rejected, running, sent, held
  reason text,
  clinic_id uuid references clinics(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Job queue + logs + costs
-- ---------------------------------------------------------------------------
create table jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  idempotency_key text unique not null,
  payload jsonb not null default '{}',
  status job_status not null default 'queued',
  priority int not null default 100,
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_claim_idx on jobs(status, run_after, priority);

create table job_logs (
  id bigserial primary key,
  job_id uuid references jobs(id) on delete cascade,
  at timestamptz not null default now(),
  level text not null default 'info',
  message text not null,
  data jsonb
);

create table cost_records (
  id bigserial primary key,
  job_id uuid references jobs(id) on delete set null,
  clinic_id uuid references clinics(id) on delete set null,
  provider text not null,                    -- anthropic, google_places, resend, stripe
  operation text not null,
  units jsonb not null default '{}',         -- tokens, searches, requests
  cost_usd numeric(12,6) not null default 0,
  at timestamptz not null default now()
);
create index cost_records_at_idx on cost_records(at);

create table owner_notifications (
  id bigserial primary key,
  kind text not null,
  day date not null,
  sent_at timestamptz not null default now(),
  detail jsonb,
  unique (kind, day)
);

-- ---------------------------------------------------------------------------
-- Job queue functions
-- ---------------------------------------------------------------------------
create or replace function claim_jobs(p_worker text, p_limit int, p_kinds text[] default null)
returns setof jobs language plpgsql as $$
begin
  return query
  with c as (
    select id from jobs
    where status = 'queued' and run_after <= now()
      and (p_kinds is null or kind = any(p_kinds))
    order by priority, run_after
    for update skip locked
    limit p_limit
  )
  update jobs j set status = 'running', locked_at = now(), locked_by = p_worker,
                    attempts = j.attempts + 1
  from c where j.id = c.id
  returning j.*;
end $$;

-- requeue jobs whose worker died
create or replace function reap_stale_jobs(p_older_than interval default '15 minutes')
returns int language sql as $$
  with r as (
    update jobs set status = case when attempts >= max_attempts then 'dead'::job_status else 'queued'::job_status end,
                    locked_at = null, locked_by = null,
                    last_error = coalesce(last_error, '') || ' [reaped]'
    where status = 'running' and locked_at < now() - p_older_than
    returning 1
  ) select count(*)::int from r;
$$;

-- ---------------------------------------------------------------------------
-- Row level security: only the owner
-- ---------------------------------------------------------------------------
create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_settings s
    where s.owner_user_id is not null and s.owner_user_id = auth.uid()
  );
$$;

do $$
declare t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;

-- anon gets nothing; public pages go through server routes using the service role.
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
