-- Direct mail channel, QR codes, consent, channel settings and routing.
-- Owner-only row level security on every table, like the rest.

-- Offers: prices are read from here, never hard-coded.
create table offers (
  key text primary key,                      -- monthly | full_report
  name text not null,
  price_cents int not null,
  currency text not null default 'CAD',
  billing text not null check (billing in ('one_time', 'monthly')),
  sort int not null default 0,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into offers (key, name, price_cents, billing, sort) values
  ('monthly', 'Monthly plan', 20000, 'monthly', 1),
  ('full_report', 'Full report and fix files', 20000, 'one_time', 2);

-- One unguessable code per clinic. Never expires unless revoked.
create table qr_codes (
  code text primary key check (length(code) >= 10),
  clinic_id uuid not null references clinics(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index qr_codes_one_live on qr_codes (clinic_id) where revoked_at is null;

create table page_visits (
  id bigserial primary key,
  code text references qr_codes(code) on delete cascade,
  clinic_id uuid references clinics(id) on delete cascade,
  at timestamptz not null default now(),
  source text not null check (source in ('qr', 'typed', 'email')),
  device text not null check (device in ('phone', 'tablet', 'computer', 'unknown'))
);
create index page_visits_clinic_idx on page_visits (clinic_id, at);

-- Consent to an automated call: exact wording, when, from where. 30 days, revocable.
create table call_consents (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  phone text not null,
  contact_name text not null,
  contact_role text,
  consent_text text not null,
  consented_at timestamptz not null default now(),
  ip text,
  page_url text,
  expires_at timestamptz not null default now() + interval '30 days',
  revoked_at timestamptz
);

create table call_requests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  consent_id uuid not null references call_consents(id) on delete cascade,
  preferred_date date not null,
  window_start time not null,
  window_end time not null,
  status text not null default 'waiting' check (status in ('waiting', 'called', 'no_answer', 'cancelled')),
  source_channel text,
  notes text,
  created_at timestamptz not null default now(),
  handled_at timestamptz
);

-- Express consent to email, given on the teaser page.
create table email_consents (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  email text not null,
  consent_text text not null,
  consented_at timestamptz not null default now(),
  ip text,
  page_url text,
  source_channel text,
  revoked_at timestamptz
);

-- An opt-out from any channel stops mail, email and calls to that clinic.
create table optouts (
  id bigserial primary key,
  clinic_id uuid references clinics(id) on delete cascade,
  channel text not null,                     -- where it came from: mail, email, call, web
  source text not null,                      -- optout_page, unsubscribe_link, phone, owner, reply
  detail text,
  created_at timestamptz not null default now()
);
alter table clinics
  add column opted_out_at timestamptz,
  add column address_bad boolean not null default false,
  add column address_bad_reason text;

-- All channel logic is read from here.
create table channel_settings (
  channel text primary key,                  -- email | letter | inbound | call_me | reply_consent | routing
  values jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
create table settings_audit_log (
  id bigserial primary key,
  scope text not null,                       -- channel:<name> | routing | kill_switch | qr | mail_batch
  actor text not null,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);

create table routing_assignments (
  id bigserial primary key,
  clinic_id uuid not null references clinics(id) on delete cascade,
  channel text not null check (channel in ('letter', 'email', 'skipped')),
  test_arm text,                             -- letter | email when the split assigned it, else null
  rule int not null,
  reason text not null,
  batch_label text,
  assigned_at timestamptz not null default now()
);
create index routing_assignments_clinic_idx on routing_assignments (clinic_id, assigned_at desc);

create table mail_batches (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  city_id int references cities(id),
  kind text not null default 'letter' check (kind in ('letter', 'postcard')),
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'sending', 'sent')),
  test_mode boolean not null default true,   -- every piece goes to the owner's own address
  reject_reason text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table mail_pieces (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  batch_id uuid not null references mail_batches(id) on delete cascade,
  type text not null check (type in ('letter', 'postcard')),
  status text not null default 'draft' check (status in (
    'draft', 'held', 'approved', 'rejected', 'skipped', 'submitted', 'printing', 'mailed', 'delivered_est', 'returned', 'cancelled', 'failed')),
  status_reason text,
  headline_variant text,                     -- A | B
  data jsonb not null,                       -- the content the PDF was built from
  claims jsonb not null default '[]',
  gate_flags jsonb not null default '[]',
  gate_passed boolean not null default false,
  address_text text,                         -- as confirmed on the clinic's own site
  address_status text,                       -- verified | corrected | failed | unverified
  provider text,
  provider_id text unique,
  provider_contact_id text,
  cost_cents int not null default 0,         -- USD cents, as the provider bills
  pdf_path text,
  approved_by text,
  approved_at timestamptz,
  mailed_at timestamptz,
  returned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index mail_pieces_clinic_idx on mail_pieces (clinic_id);
create index mail_pieces_batch_idx on mail_pieces (batch_id);

-- Defaults. Letters are locked to REVIEW in code as well.
insert into channel_settings (channel, values) values
  ('email',         '{"on": true,  "pause_until": null, "daily_cap": 40,  "monthly_spend_cap_usd": 50,  "mode": "REVIEW"}'),
  ('letter',        '{"on": false, "pause_until": null, "daily_cap": 50,  "monthly_spend_cap_usd": 150, "mode": "REVIEW",
                      "cost_letter_cents": 222, "cost_postcard_cents": 212, "color": true, "mailing_class": "first_class",
                      "address_placement": "top_first_page", "first_batch_max": 50, "followup_days": 14, "max_pieces": 2,
                      "headline_test": false}'),
  ('inbound',       '{"on": false, "pause_until": null, "daily_cap": 200, "monthly_spend_cap_usd": 50,  "mode": "AUTO", "number": "[INBOUND NUMBER]"}'),
  ('call_me',       '{"on": true,  "pause_until": null, "daily_cap": 20,  "monthly_spend_cap_usd": 50,  "mode": "REVIEW"}'),
  ('reply_consent', '{"on": true,  "pause_until": null, "daily_cap": 40,  "monthly_spend_cap_usd": 20,  "mode": "REVIEW"}'),
  ('routing',       '{"score_threshold": 5, "split_on": false, "split_letter_pct": 50, "cooldown_days": 30}');

do $$
declare t text;
begin
  foreach t in array array['offers', 'qr_codes', 'page_visits', 'call_consents', 'call_requests', 'email_consents', 'optouts',
                           'channel_settings', 'settings_audit_log', 'routing_assignments', 'mail_batches', 'mail_pieces']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to authenticated;
