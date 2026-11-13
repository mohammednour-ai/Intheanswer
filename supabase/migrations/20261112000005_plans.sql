-- Three paid plans: the one-time report, monthly reports only, and the full service.
-- Additive only. Rows written before this are the full service plan.
alter table orders
  add column plan text check (plan in ('report', 'reports', 'monthly'));
alter table subscriptions
  add column plan text not null default 'monthly' check (plan in ('reports', 'monthly'));
