-- Added services: full site test, review analysis, answer pages.
-- Same RLS model as everything else: owner-only policy on every new table.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
alter table app_settings
  add column pages_per_month int not null default 2,          -- monthly plan: new answer pages per month
  add column crawl_page_cap int not null default 40,          -- site test crawl limit per site
  add column api_cache_days int not null default 7;           -- PageSpeed / Lighthouse cache

-- The daily cap now covers every paid API (Claude, Places, ...), not only Claude.
comment on column app_settings.claude_daily_spend_cap_usd is 'Daily spend cap in USD across all paid APIs; pauses the pipeline when reached.';

-- ---------------------------------------------------------------------------
-- Google Places compliance: only place_id may be stored (Maps Platform terms,
-- checked 2026-11-11). Remove the Places fields stored by the first version.
-- ---------------------------------------------------------------------------
update clinics set places_raw = null, rating = null, review_count = null,
  phone = case when phone_confirmed_on_site then phone else null end,
  address = case when address_confirmed_on_site then address else null end;
comment on column clinics.places_raw is 'Deprecated: Places content is not stored. Always null.';
comment on column clinics.rating is 'Deprecated: fetched live from Places, never stored.';
comment on column clinics.review_count is 'Deprecated: fetched live from Places, never stored.';

-- Clinics named in the question test, mapped to a Places place_id (the only storable Places field).
create table competitor_places (
  id bigserial primary key,
  city_id int not null references cities(id),
  answer_name text not null,                 -- the name as the assistant wrote it (our data)
  place_id text,                             -- null if no confident match
  match_note text,
  looked_up_at timestamptz not null default now(),
  unique (city_id, answer_name)
);

-- ---------------------------------------------------------------------------
-- Cache for PageSpeed / Lighthouse results (not for Places content)
-- ---------------------------------------------------------------------------
create table api_cache (
  key text primary key,
  provider text not null,
  value jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- ---------------------------------------------------------------------------
-- Full site test
-- ---------------------------------------------------------------------------
create type site_check_result as enum ('pass', 'needs_work', 'could_not_test');

create table site_test_runs (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  run_label text not null,
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  page_cap int not null,
  pages_crawled int not null default 0,
  perf_source text,                          -- 'pagespeed' | 'lighthouse_local' | null
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (clinic_id, run_label)
);

create table site_test_checks (
  id bigserial primary key,
  run_id uuid not null references site_test_runs(id) on delete cascade,
  check_key text not null,
  category text not null,                    -- speed, mobile, links, content, accessibility, booking, crawlability, security
  result site_check_result not null,
  impact int not null,                       -- patient impact, higher first
  line text not null,                        -- one plain-language sentence of what was observed
  finding_text text,                         -- report sentence when result = needs_work
  evidence jsonb not null default '[]',
  metrics jsonb not null default '{}',
  unique (run_id, check_key)
);

-- ---------------------------------------------------------------------------
-- Reviews: only from a clinic's own Google Business Profile (monthly clients).
-- Review text is processed in memory and never stored; no reviewer names, no
-- health details. Only numbers and theme labels with counts are kept.
-- ---------------------------------------------------------------------------
create table gbp_connections (
  clinic_id uuid primary key references clinics(id) on delete cascade,
  location_name text,                        -- accounts/*/locations/*
  refresh_token_enc text,                    -- AES-GCM with a key derived from APP_SECRET
  connect_token text unique not null,        -- link the clinic opens to connect (no account)
  status text not null default 'pending' check (status in ('pending', 'connected', 'revoked', 'error')),
  connected_at timestamptz,
  last_error text
);

create table review_snapshots (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  run_label text not null,
  source text not null default 'gbp' check (source in ('gbp')),
  average_rating numeric(3,2),
  total_count int not null,
  latest_review_at timestamptz,
  count_90d int,
  reply_rate numeric(4,3),                   -- share of reviews with an owner reply
  analysis_level text not null check (analysis_level in ('full', 'light', 'none')),
  analysed_count int not null default 0,
  created_at timestamptz not null default now(),
  unique (clinic_id, run_label)
);

create table review_themes (
  id bigserial primary key,
  snapshot_id uuid not null references review_snapshots(id) on delete cascade,
  kind text not null check (kind in ('praise', 'complaint', 'service')),
  theme text not null,                       -- short label, no names, no health details
  mentions int not null
);

-- ---------------------------------------------------------------------------
-- Answer pages (monthly plan deliverable)
-- ---------------------------------------------------------------------------
create type page_status as enum (
  'proposed', 'draft', 'owner_reviewed', 'sent_to_clinic', 'changes_requested',
  'clinic_approved', 'live', 'rejected'
);

create table answer_pages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  kind text not null check (kind in ('question', 'service')),
  intent text not null,                      -- template key, e.g. new_patients, emergency, service
  target_question text not null,             -- the patient question this page answers
  question_index int,                        -- index in the clinic's question set, when it came from the test
  service text,                              -- for service pages
  title text not null,
  slug text not null,
  priority int not null default 0,
  reason text not null,                      -- why it was proposed (with the evidence ids)
  evidence jsonb not null default '[]',
  status page_status not null default 'proposed',
  planned_month text,                        -- YYYY-MM slot under pages_per_month
  clinic_token text unique,                  -- approval link for the clinic (no account)
  live_url text,
  latest_test_status mention_status,
  latest_test_at timestamptz,
  latest_test_answer_id uuid references test_answers(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, slug)
);

create table answer_page_versions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references answer_pages(id) on delete cascade,
  version int not null,
  content jsonb not null,                    -- sections: title, direct answer, details, contact block
  html text not null,
  json_ld jsonb not null,
  placeholders text[] not null default '{}', -- bracketed facts the clinic must confirm
  created_by text not null,                  -- system | owner
  created_at timestamptz not null default now(),
  unique (page_id, version)
);

create table answer_page_events (
  id bigserial primary key,
  page_id uuid not null references answer_pages(id) on delete cascade,
  from_status page_status,
  to_status page_status not null,
  actor text not null check (actor in ('system', 'owner', 'clinic')),
  actor_detail text,
  note text,
  at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS for the new tables (same owner-only policy)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['competitor_places', 'api_cache', 'site_test_runs', 'site_test_checks', 'gbp_connections',
                           'review_snapshots', 'review_themes', 'answer_pages', 'answer_page_versions', 'answer_page_events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
grant usage, select on all sequences in schema public to authenticated;
