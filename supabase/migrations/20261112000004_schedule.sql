-- Phase 6: scheduling, monthly retests, retest after a one-time purchase,
-- retention and owner alerts. No new tables; columns and indexes only.

alter table app_settings
  add column if not exists discovery_targets_per_day int not null default 2;   -- stagger: targets discovered per business day

-- Set when the retest after a one-time purchase has been handled (sent, or
-- skipped because the clinic subscribed, unsubscribed or was refunded).
-- Finished jobs are deleted after 60 days, so the order itself keeps the mark.
alter table orders
  add column if not exists retest_done_at timestamptz,
  add column if not exists retest_note text;

-- Scheduler lookups (run every minute).
create index if not exists jobs_discover_day_idx on jobs ((payload->>'day')) where kind = 'discover';
create index if not exists jobs_dead_idx on jobs (kind) where status = 'dead';
create index if not exists subscriptions_status_idx on subscriptions (status);
create index if not exists orders_retest_due_idx on orders (paid_at) where kind = 'one_time' and retest_done_at is null;

-- Retention deletes by age.
create index if not exists page_cache_fetched_idx on page_cache (fetched_at);
create index if not exists job_logs_at_idx on job_logs (at);
create index if not exists jobs_finished_idx on jobs (finished_at) where status in ('done', 'cancelled');
create index if not exists report_views_viewed_idx on report_views (viewed_at);
create index if not exists api_cache_expires_idx on api_cache (expires_at);
create index if not exists self_serve_created_idx on self_serve_requests (created_at);

-- Owner alerts and digest.
create index if not exists owner_tasks_open_idx on owner_tasks (kind, created_at) where status = 'open';
create index if not exists reports_clinic_kind_idx on reports (clinic_id, kind, created_at desc);
