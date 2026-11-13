-- Phase 5: payments and fulfilment. Additive only.

-- An order points at the full report built for it (one build per order).
alter table orders
  add column report_id uuid references reports(id),
  add column amount_refunded_cents int not null default 0;
create index orders_clinic_idx on orders (clinic_id);
create index orders_payment_intent_idx on orders (stripe_payment_intent_id);

-- Stripe may deliver subscription events out of order: only a newer event is applied.
alter table subscriptions
  add column stripe_event_created timestamptz;
create index subscriptions_clinic_idx on subscriptions (clinic_id);

-- One intake form and one onboarding task per order.
alter table intake_forms
  add column attempt_count int not null default 0,       -- rate limit: tries in the current window
  add column attempt_window_start timestamptz;
create unique index intake_forms_order_idx on intake_forms (order_id) where order_id is not null;

alter table owner_tasks
  add column order_id uuid references orders(id);
create unique index owner_tasks_onboarding_order_idx on owner_tasks (order_id) where kind = 'onboarding' and order_id is not null;
