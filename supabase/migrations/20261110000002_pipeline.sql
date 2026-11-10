-- Phase 2: pipeline details.

-- Places content other than place_id is purged after 30 days (Google Maps Platform terms).
alter table clinics
  add column places_fetched_at timestamptz,
  add column site_name text,                         -- the name as the clinic writes it on its own site
  add column phone_confirmed_on_site boolean not null default false,
  add column address_confirmed_on_site boolean not null default false;

-- What actually answered each question (a refusal fallback can change the model).
alter table test_answers
  add column served_model text,
  add column stop_reason text,
  add column usage jsonb;

-- The text of each finding as it appears in a report, with the check it came from.
alter table audit_checks
  add column finding_text text;
