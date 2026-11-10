# In The Answer

Automated service for intheanswer.ca. It finds local clinics in Ontario, tests whether AI assistants name
them when patients ask for a recommendation, sends each clinic a free personalised report, sells the fix,
delivers it, and retests every month.

Status: **built in phases, dry run only.** Nothing is sent or charged until the owner says go live.

| Phase | Scope | State |
|---|---|---|
| 1 | Data model, RLS, job queue, portal shell | done |
| 2 | Pipeline steps 1 to 7 (discover → verify), teasers | next |
| 3 | Public site | |
| 4 | Sending, approval queue, replies | |
| 5 | Stripe and full-report delivery | |
| 6 | Monthly retests | |

## Local development

```bash
npm install
sudo pg_ctlcluster 16 main start        # or any Postgres 15+
npm run db:local                         # recreates the local DB: Supabase shim + migrations + seed
cp .env.example .env.local               # set DATABASE_URL=postgres://postgres:postgres@localhost:5432/intheanswer
PORTAL_DEV_BYPASS=1 npm run dev          # portal at http://localhost:3000/portal without Supabase Auth
npm test                                 # builds a separate intheanswer_test database
npm run typecheck
```

`supabase/local/00_supabase_shim.sql` mimics Supabase's `auth.uid()` and roles so RLS can be tested on
plain Postgres. Never apply it to a Supabase project.

## Architecture

- `supabase/migrations`: schema. Every table has row level security; the only policy lets the owner
  (`app_settings.owner_user_id`) in. Server code connects as the database owner and checks the owner
  session first.
- `src/lib/jobs`: Postgres job queue. Each pipeline stage is a job: idempotent (unique key), retried with
  backoff, reaped if a worker dies, logged (`job_logs`) and costed (`cost_records`). The worker runs from
  `/api/cron/worker` (every minute) or `npm run worker` locally. Claude jobs stop for the day when the
  daily spend cap is reached; pipeline jobs stop on the kill switch.
- `src/lib/sending`: sending rules (warm-up 10/day +5 per week to 40, business hours Toronto, spacing,
  suppression by address and domain, max two cold contacts per clinic ever, auto-pause on >3% bounces or
  any complaint, DNS gate), per-type REVIEW/AUTO modes with "first N still reviewed", owner actions.
- `src/app/portal`: owner portal (mobile first). Queue, Held, Sent, Replies, Overview, Settings.

## Design

Report and brand designs live on the owner's design canvas ("In The Answer — Report Designs (Teaser +
Full)"). `src/lib/brand.ts` holds its palette and the three-bar mark; `src/lib/reports/renderTeaser.ts`
follows the teaser artboard. Report wording is always generated from stored evidence, never copied from
the mock-up.

## Only the owner can sign in

1. Supabase > Authentication > Providers > Email: enable; **disable "Allow new users to sign up"**.
2. Supabase > Authentication > Users > Add user: create `OWNER_EMAIL`.
3. Set `OWNER_EMAIL`. The first sign-in with that address records its user id; after that only that id is
   accepted, by the app and by RLS.

## How to pause

- Portal > Settings > **Stop all sending now** (kill switch). Stops all outbound sales mail and new
  pipeline work. Payment receipts and unsubscribe confirmations still go out.
- Sending auto-pauses itself on any spam complaint or bounces above 3%, and notifies the owner.
- Set `DRY_RUN=1` in the environment: nothing is sent or charged regardless of portal settings.

More sections (DNS, adding a sector or city, env vars) are completed as phases land.
