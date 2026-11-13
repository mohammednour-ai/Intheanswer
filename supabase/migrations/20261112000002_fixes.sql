-- Review fixes: cache redirect target, skipped test questions, one primary
-- contact, self-serve and unsubscribe abuse limits, connect-link expiry,
-- missing indexes, and foreign keys that blocked erasing a clinic.

-- ---------------------------------------------------------------------------
-- page_cache keeps the address a request ended on (after redirects). Rows
-- cached before this column existed have null: the HTTPS checks treat that as
-- "could not test", never as a finding.
-- ---------------------------------------------------------------------------
alter table page_cache add column if not exists final_url text;

-- ---------------------------------------------------------------------------
-- A question that was refused or kept failing is recorded on the run and is
-- not a test_answers row, so every count of answers is a count of answered
-- questions. [{index, question, reason}]
-- ---------------------------------------------------------------------------
alter table test_runs
  add column if not exists skipped_questions jsonb not null default '[]',
  add column if not exists error text;

-- ---------------------------------------------------------------------------
-- At most one primary contact per clinic. Demote duplicates first: keep the
-- address on the clinic's own domain, then the oldest.
-- ---------------------------------------------------------------------------
update contacts set is_primary = false
where is_primary
  and id not in (
    select distinct on (clinic_id) id from contacts
    where is_primary
    order by clinic_id, on_own_domain desc, found_at, id
  );
create unique index if not exists contacts_one_primary_idx on contacts (clinic_id) where is_primary;

-- ---------------------------------------------------------------------------
-- Self-serve: global daily cap, and enough on the request to run it later if
-- it was held.
-- ---------------------------------------------------------------------------
alter table app_settings
  add column if not exists self_serve_daily_cap int not null default 20;
alter table self_serve_requests
  add column if not exists sector_id int references sectors(id),
  add column if not exists city text;
create index if not exists self_serve_ip_idx on self_serve_requests (ip_hash, created_at);
create index if not exists self_serve_website_idx on self_serve_requests (website);
create index if not exists self_serve_created_idx on self_serve_requests (created_at);

-- ---------------------------------------------------------------------------
-- Unsubscribe by address: attempts per visitor (hashed IP), for rate limiting.
-- No address is stored here.
-- ---------------------------------------------------------------------------
create table if not exists unsubscribe_attempts (
  id bigserial primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists unsubscribe_attempts_ip_idx on unsubscribe_attempts (ip_hash, created_at);

alter table public.unsubscribe_attempts enable row level security;
drop policy if exists owner_all on public.unsubscribe_attempts;
create policy owner_all on public.unsubscribe_attempts for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
revoke all on public.unsubscribe_attempts from anon;
grant select, insert, update, delete on public.unsubscribe_attempts to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- ---------------------------------------------------------------------------
-- Business Profile connect links expire 14 days after they are created. The
-- portal replaces connect_token on the same row, so a trigger stamps the time.
-- ---------------------------------------------------------------------------
alter table gbp_connections
  add column if not exists link_created_at timestamptz not null default now();

create or replace function public.gbp_link_stamp() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.connect_token is distinct from old.connect_token then
    new.link_created_at := now();
  end if;
  return new;
end $$;

drop trigger if exists gbp_link_stamp on gbp_connections;
create trigger gbp_link_stamp before update on gbp_connections
  for each row execute function public.gbp_link_stamp();

-- ---------------------------------------------------------------------------
-- Report views are deduplicated per report and browser per hour.
-- ---------------------------------------------------------------------------
create index if not exists report_views_report_idx on report_views (report_id, ua_hash, viewed_at desc);
create index if not exists reports_clinic_idx on reports (clinic_id);
create index if not exists job_logs_job_idx on job_logs (job_id);

-- ---------------------------------------------------------------------------
-- Erasing a clinic (privacy request) must not be blocked by rows that point
-- at it or at its reports. Rows that still mean something without the clinic
-- keep existing with the reference cleared; an intake form does not.
-- send_audit_log is the legal record of what was sent: it is always kept.
-- ---------------------------------------------------------------------------
alter table messages drop constraint if exists messages_report_id_fkey;
alter table messages add constraint messages_report_id_fkey
  foreign key (report_id) references reports(id) on delete set null;

alter table orders drop constraint if exists orders_clinic_id_fkey;
alter table orders add constraint orders_clinic_id_fkey
  foreign key (clinic_id) references clinics(id) on delete set null;

alter table subscriptions drop constraint if exists subscriptions_clinic_id_fkey;
alter table subscriptions add constraint subscriptions_clinic_id_fkey
  foreign key (clinic_id) references clinics(id) on delete set null;

alter table intake_forms drop constraint if exists intake_forms_clinic_id_fkey;
alter table intake_forms add constraint intake_forms_clinic_id_fkey
  foreign key (clinic_id) references clinics(id) on delete cascade;

alter table owner_tasks drop constraint if exists owner_tasks_clinic_id_fkey;
alter table owner_tasks add constraint owner_tasks_clinic_id_fkey
  foreign key (clinic_id) references clinics(id) on delete set null;
alter table owner_tasks drop constraint if exists owner_tasks_report_id_fkey;
alter table owner_tasks add constraint owner_tasks_report_id_fkey
  foreign key (report_id) references reports(id) on delete set null;
alter table owner_tasks drop constraint if exists owner_tasks_inbound_id_fkey;
alter table owner_tasks add constraint owner_tasks_inbound_id_fkey
  foreign key (inbound_id) references inbound_messages(id) on delete set null;

alter table self_serve_requests drop constraint if exists self_serve_requests_clinic_id_fkey;
alter table self_serve_requests add constraint self_serve_requests_clinic_id_fkey
  foreign key (clinic_id) references clinics(id) on delete set null;

alter table send_audit_log alter column message_id drop not null;
alter table send_audit_log drop constraint if exists send_audit_log_message_id_fkey;
alter table send_audit_log add constraint send_audit_log_message_id_fkey
  foreign key (message_id) references messages(id) on delete set null;
