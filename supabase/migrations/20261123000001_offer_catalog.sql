-- The offer is now stated once, in src/lib/offer.ts: Full report, Visibility, Growth, Transformation.
-- This makes room for it. Additive: the retired plan values ('reports', 'monthly') stay valid, so an
-- old order or subscription row still reads; nothing is rewritten.

-- Plans an order or a subscription can name.
alter table orders drop constraint if exists orders_plan_check;
alter table orders add constraint orders_plan_check
  check (plan in ('report', 'visibility', 'growth', 'transformation', 'reports', 'monthly'));

-- A subscription made by hand in Stripe (a quoted Transformation plan) may arrive naming no plan:
-- it is stored without one, not silently called something it is not.
alter table subscriptions drop constraint if exists subscriptions_plan_check;
alter table subscriptions alter column plan drop default;
alter table subscriptions alter column plan drop not null;
alter table subscriptions add constraint subscriptions_plan_check
  check (plan in ('visibility', 'growth', 'transformation', 'reports', 'monthly'));

-- The report credit: a clinic that paid for the full report and starts a plan within 30 days has
-- the report's price taken off its first payment. The order that used a credit points at the
-- report order it came from, so one report is credited once.
alter table orders add column if not exists credit_cents int not null default 0;
alter table orders add column if not exists credit_order_id uuid references orders(id);
create index if not exists orders_credit_order_idx on orders (credit_order_id) where credit_order_id is not null;

-- A request for a quote (the Transformation plan is quoted, never bought online).
alter table owner_tasks drop constraint if exists owner_tasks_kind_check;
alter table owner_tasks add constraint owner_tasks_kind_check
  check (kind in ('onboarding', 'escalation', 'held_review', 'alert', 'quote_request'));

-- Which promises and pillars are stated right now (keys from src/lib/offer.ts), chosen in
-- Portal > Settings > The offer. The defaults are the launch setting of 22 November 2026: the
-- security list and the quarterly tools review stay off until the work behind them is in place.
alter table app_settings add column if not exists offer_promises text[] not null default '{support,changes,warranty,ownership,terms}';
alter table app_settings add column if not exists offer_pillars text[] not null default '{found,website,front_desk,systems,proof}';

-- An email a caller asked for on the phone (their report, or the checkout link for a plan). Every word
-- of it is written by the program from src/lib/offer.ts, so it is sent at once, like a receipt; an
-- email the AI words itself (the call summary) stays 'interested_reply' and waits for the owner.
alter type message_type add value if not exists 'requested_on_call';

-- Approved answers. Some are worded for a phone call and must never be drafted into an email, and
-- no answer types a price any more: a placeholder is filled in from src/lib/offer.ts when it is read.
alter table approved_answers add column if not exists channel text not null default 'any' check (channel in ('any', 'phone'));
update approved_answers set answer = '{{price_answer}}', updated_at = now() where key = 'price';

-- The answers to the objections the phone assistant hears most (the call playbook). Each acknowledges,
-- gives one fact and asks one question. Inserted once: later edits in Portal > Answers are kept.
insert into approved_answers (key, question, match_hints, answer, channel) values
  ('web_company', 'We already have a web company.', array[]::text[],
   'That makes sense. The test looked at what AI assistants say, which most web work does not cover yet. Would it help to see the full results and share them with your web company?', 'phone'),
  ('too_expensive', 'It is too expensive.', array[]::text[],
   'Understood. The Visibility plan is {{price:visibility}}, and the one-time report is credited to your first month if you start a plan within {{credit_days}} days. Which part matters most to you right now?', 'phone'),
  ('no_time', 'We do not have time for a project.', array[]::text[],
   'We do the work; you approve it. We ask for about an hour at the start and a few minutes a month after that. What would you want off your plate first?', 'phone'),
  ('receptionist_safe', 'Is an AI phone agent safe with patients?', array[]::text[],
   'It says it is an AI, takes messages and bookings, and hands anything clinical to your team. Patient information goes only through privacy-compliant tools. Would it help to hear how a call is handed over?', 'phone'),
  ('leaving', 'What if we want to leave?', array[]::text[],
   'After the minimum term it is month to month, and you keep your site, your domain and your data. Is there a term you would be comfortable with?', 'phone'),
  ('send_something', 'Send me something.', array[]::text[],
   'Of course. Shall I email the report and the plans to the address your report was sent to?', 'phone')
on conflict (key) do nothing;
