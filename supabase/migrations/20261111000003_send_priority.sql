-- Send order: the daily queue is filled highest priority first. Every eligible
-- clinic is still contacted eventually (waiting items gain a point a week).
alter table clinics
  add column priority_score int not null default 0,
  add column priority_breakdown jsonb not null default '[]',
  add column priority_manual numeric;            -- set when the owner reorders by hand; higher goes first
create index clinics_priority_idx on clinics (priority_manual desc nulls last, priority_score desc);
