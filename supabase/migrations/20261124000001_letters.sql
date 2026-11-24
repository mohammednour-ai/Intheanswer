-- Letters by post (owner's decision of 23 November 2026): one printed letter per clinic, ever, for a
-- clinic that was emailed and did not answer, open its report, call or opt out within
-- `letter_after_days`. Every letter waits for the owner's approval in the portal before it is mailed.
-- Printing and posting: PostGrid (src/lib/letters/provider.ts).

alter table app_settings
  add column if not exists letters_enabled boolean not null default false,      -- pick clinics and prepare letters each business day
  add column if not exists letters_live boolean not null default false,         -- false: letters go to the owner's own address only
  add column if not exists letter_after_days int not null default 14,
  add column if not exists letters_per_day int not null default 10,             -- letters prepared a day (each still needs approval)
  add column if not exists letter_mailing_class text not null default 'ca_post_lettermail',
  add column if not exists letter_cost_usd numeric(6,2) not null default 2.22,  -- per letter, for the monthly limit
  add column if not exists letters_monthly_budget_usd numeric(8,2) not null default 100;

create table if not exists letters (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references clinics(id) on delete cascade,
  report_id uuid not null references reports(id),
  after_message_id uuid references messages(id),
  -- printed on the letter: intheanswer.ca/l/<code> opens the clinic's report; /l/<code>/stop stops all contact
  code text not null unique,
  status text not null default 'review'
    check (status in ('review', 'held', 'approved', 'sent', 'cancelled', 'failed')),
  to_name text not null,
  to_address text not null,            -- as published on the clinic's own site
  html text not null,                  -- the letter as rendered when prepared (what the owner approved)
  flags jsonb not null default '[]',
  gate_passed boolean not null default false,
  reject_reason text,
  provider text,
  provider_contact_id text,
  provider_order_id text unique,
  provider_status text,
  address_status text,                 -- verified | corrected | failed (the provider's check)
  address_normalized text,
  live boolean,                        -- true when the provider really prints and posts it
  mailing_class text,
  cost_usd numeric(6,2),
  test_orders jsonb not null default '[]', -- copies sent to the owner's own address
  last_error text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  sent_at timestamptz,
  completed_at timestamptz,            -- the provider handed it to Canada Post
  first_visit_at timestamptz,
  visit_count int not null default 0,
  stopped_at timestamptz,              -- the clinic asked at /l/<code>/stop to stop all contact
  updated_at timestamptz not null default now()
);
create index if not exists letters_status_idx on letters (status, created_at);
-- one letter per clinic, ever, unless it was cancelled or failed before posting
create unique index if not exists letters_one_per_clinic on letters (clinic_id) where status not in ('cancelled', 'failed');

do $$
begin
  alter table public.letters enable row level security;
  drop policy if exists owner_all on public.letters;
  create policy owner_all on public.letters for all to authenticated using (public.is_owner()) with check (public.is_owner());
  revoke all on public.letters from anon;
  grant select, insert, update, delete on public.letters to authenticated;
end $$;
