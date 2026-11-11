-- Review fixes.

-- The Places business name is not kept: clear names that came from Places and
-- were never replaced by the clinic's own site (they show the domain instead).
update clinics set name = coalesce(site_name, domain, name) where source = 'places';

-- Live review lookups are capped per report per day so a report URL cannot be
-- used to run up Places cost.
alter table reports
  add column live_fetch_day date,
  add column live_fetch_count int not null default 0;
alter table app_settings
  add column live_reviews_per_report_per_day int not null default 15;
