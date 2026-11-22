# In The Answer

Automated service for intheanswer.ca. It finds local clinics in Ontario, tests whether AI assistants name
them when patients ask for a recommendation, sends each clinic a free personalised report, sells the fix,
delivers it, and retests every month.

Status: **all six phases are built; dry run only.** Nothing is sent or charged until the owner goes live
(see "Going live"). Not yet proven against the real services: Resend, Stripe, Supabase and Vercel have only
been exercised through fakes and a local Postgres.

| Phase | Scope | State |
|---|---|---|
| 1 | Data model, RLS, job queue, portal shell | done |
| 2 | Pipeline steps 1 to 7 (discover → verify), teasers | done; needs `ANTHROPIC_API_KEY` |
| 3 | Public site, self-serve box, unsubscribe | done |
| 4 | Sending (Resend), bounces and complaints, DNS gate, replies, follow-up | done; needs Resend keys and DNS |
| 5 | Stripe checkout and webhook, full report, intake form | done; needs Stripe keys and prices |
| 6 | Scheduled discovery, monthly retests, retest after purchase, alerts, digest, retention | done |
| + | Review analysis, full site test, answer pages | done |
| + | Phone agent: explains a report by phone, on request only | done; needs Twilio keys, a number and the migration |

## Local development

Works the same on Windows, macOS and Linux. Needs Node 22 and any Postgres 15+ (Docker is the easy way).

```bash
npm install
docker run -d --name ita-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
cp .env.example .env.local               # set DATABASE_URL=postgres://postgres:postgres@localhost:5432/intheanswer
                                         # and PORTAL_DEV_BYPASS=1, APP_URL=http://localhost:3000
npm run db:local                         # drops and rebuilds the LOCAL database: shim + migrations + seed
npm run dev                              # site at http://localhost:3000, portal at /portal
npm run worker                           # runs the jobs and the scheduler (the cron route does this in production)
npm test                                 # rebuilds and uses intheanswer_test (TEST_DATABASE_URL to override)
npm run typecheck && npm run lint
```

On Windows run `npm test` from PowerShell or cmd, not Git Bash. `supabase/local/00_supabase_shim.sql` mimics
the Supabase `auth.uid()` function and roles so RLS can be tested on plain Postgres. Never apply it to a
Supabase project; `npm run db:local` refuses any host other than localhost. `.github/workflows/ci.yml` runs
typecheck, lint, tests and the build on every push.

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

## Public site

Pages under `src/app/(site)`: home (with the self-serve box), how it works, pricing, sample report
(invented clinic, labelled), contact, privacy, unsubscribe, and `/bot` (about the crawler). `robots.txt`
and `sitemap.xml` are generated; AI crawlers are allowed.

- **Self-serve box** (`src/lib/selfServe.ts`): a clinic enters its website, email, type and city and
  goes through the same pipeline. Public https sites only, 3 requests per visitor per day, one per site
  per 14 days, honeypot. The email is used only if it is on the site's domain or published on the site;
  otherwise the request is held for the owner. Self-serve clinics are never parked.
- **Unsubscribe**: `/unsubscribe/<token>` (signed link, confirm button, no login), `/unsubscribe` (by
  address) and `POST /api/unsubscribe/<token>` for one-click unsubscribe from mail clients. Takes effect
  at once: suppresses the address, cancels unsent messages, closes the clinic.
- **Our own site passes our own checks**: with the site running, `BASE=http://localhost:3000 npx tsx
  scripts/selfcheck.ts` runs the audit and site checks against it and exits 1 on any failure. The
  address check needs the real owner details in the environment at build time.

## Send order

Every eligible clinic is contacted eventually; the daily queue is filled highest priority first
(`src/lib/sending/priority.ts`). The score is computed in the scoring step from rows already stored:
strong reviews and not recommended (+2), weak website from the site test (+3), fewer than 30 reviews
(+2), conflicting hours or name (+1), public email on its own site (+1). A waiting item gains a point a
week so a low score is delayed, never dropped. The portal queue shows the score with its breakdown and
has Top / Up / Down / Use score buttons; a hand order wins over the score. The two review lines need
stored review numbers, which exist only for a clinic that connected its own Business Profile (Google
Maps ratings are never stored), so for other clinics they show "not available".

## Safety rules in code

- Only public addresses are fetched; private, loopback and link-local hosts are refused, including
  after a redirect (`assertPublicUrl`).
- The worker runs one job at a time inside a time budget (`runWorkerBudget`); `vercel.json` calls it
  every minute. Site tests need a function limit of 300 s; Chromium on Vercel is untested, so run site
  tests from a small separate worker (`npm run worker`) if it fails there.
- Queued items expire after 7 days and the clinic's audit is queued again.

## Added services

### Full site test (audit stage)
Job `site_test`, run after the contact step. Polite crawl of the clinic's own site (robots.txt respected,
one request per host every few seconds, page cap `crawl_page_cap`, default 40). Checks, each stored in
`site_test_checks` with evidence, one plain line and a result of **pass / needs work / could not test**,
sorted by patient impact:

| Check | How |
|---|---|
| Booking or phone within two taps | links and tel: links on the home page and pages one link away |
| Mobile layout | headless Chromium at 390x844 with a phone user agent: viewport, sideways scroll, text under 12px, tap targets under 24x24px |
| Speed and Core Web Vitals, mobile and desktop | PageSpeed Insights when `PAGESPEED_API_KEY` is set (lab + real-visitor data); otherwise a local Lighthouse lab run, labelled as such |
| Broken links and images | internal links from the crawl, up to 25 external links and 40 images; only a real 404/410 counts as broken |
| Titles, descriptions, alt text, heading order | from the page source |
| Accessibility | axe-core, WCAG 2.0 A/AA rules. Always labelled "automated checks, not a full accessibility audit" |
| Crawlability | robots.txt, sitemap, AI crawlers blocked, text in the source vs only added by scripts |
| Security | HTTPS, http->https redirect, mixed content |

"Could not test" is never written as a problem, by the checks or by the verification gate. A render
where a stylesheet or an own-site script failed to load is treated as "could not test" (the page would
not look like what patients see). Speed and PageSpeed results are cached in `api_cache` for
`api_cache_days` (default 7). A full run takes a few minutes per site; on Vercel run the worker with a
long enough `maxDuration` (or from Supabase/a small VM) for site tests.

### Review analysis
Google's Maps Platform terms (checked 2026-11-11) allow storing only the **place_id**; they forbid
saving business names, addresses or user reviews and creating content derived from them, and the
Places API returns at most 5 reviews (no owner replies, no 90-day count). So:

- **Clinics we contact:** rating and review count for the clinic and the clinics named in its test are
  fetched **live** when the web report is opened, shown with "Google Maps" attribution, and never
  stored or put in a PDF or email (`src/lib/reviews/liveTable.ts`). The gate blocks review numbers in
  stored reports and emails. Only place_ids are stored (`clinics.place_id`, `competitor_places`).
- **Monthly clients:** the clinic connects its **own** Google Business Profile with a link (no account
  with us; portal > clinic > Reviews > "Create connect link"). From its reviews we compute total,
  average, latest date, last-90-days count and owner-reply rate, and run text analysis by volume:
  30+ full, 10 to 29 "small sample", under 10 none (the low count is the finding). Review text is
  processed in memory only; only numbers and short theme labels are stored, never reviewer names or
  health details (`review_snapshots`, `review_themes`).
- **Competitor service words** come from the assistant's own answers (our data), matched to the
  questions each clinic was named in. Counts only, no judgement.
- **Review-request kit** (fix file when volume is low): message text and a printable card with a QR
  code to the clinic's Google review link; it states: ask every patient, no incentive, no filtering by
  satisfaction.

### Answer pages (monthly plan)
`propose_pages` proposes the pages a clinic is missing (one per patient question it was not
recommended for or has no page on, one per service it mentions but has no page for) and drafts the
first one. Drafts: the question as the title, a direct answer in two sentences, details, an hours and
contact block (facts only when confirmed verbatim on the clinic's site), and FAQPage or MedicalWebPage
structured data. Every clinical or pricing fact is a [BRACKETED PLACEHOLDER]; the language rules
(no superlatives, promises, comparisons, prescription promotion) are enforced on every version.

Workflow, every step recorded in `answer_page_events`:
draft -> your review (portal > Pages) -> clinic approval by link (no account; they can fill the
bracketed facts) -> you publish and enter the live URL -> **live**. A page cannot go live with
placeholders left. `pages_per_month` (default 2) plans how many go out each month. Each monthly run
records the latest result for the question a live page targets (`updateLivePageResults`).

### Settings (portal > Settings)
`pages_per_month` (2), `crawl_page_cap` (40), `api_cache_days` (7), and the daily spend cap, which now
covers every paid API (Claude and Places), not only Claude.

## Sending, replies and follow-up (phase 4)

- **One way out.** Every outbound message is a `messages` row created by the teaser job or by
  `queueMessage` (`src/lib/sending/outbox.ts`, idempotent). Approval only queues the `send_message` job;
  the job (`src/lib/sending/send.ts`) re-applies every rule at the moment of sending, under a lock so the
  daily cap and spacing cannot be overrun, and refuses a message that lost the sender name, the mailing
  address or the unsubscribe link (also checked when the owner edits).
- **Dry run.** The message is marked sent with `dry_run = true`, a `send_audit_log` row is written, nothing
  leaves and no contact is counted. A message created or approved during a dry run stays a dry-run message
  after going live, so switching to live never releases a backlog.
- **Provider.** Resend through `src/lib/adapters/mail.ts`. Mail carries `List-Unsubscribe` and one-click
  headers. `POST /api/resend/webhook` (signature checked) records delivery events; a hard bounce or a
  complaint suppresses the address at once, and any complaint or bounces above 3% pause all sending and
  mail the owner.
- **DNS gate.** `src/lib/sending/dns.ts` checks SPF, DKIM and DMARC for `SENDING_DOMAIN` (the Resend
  verification result when `RESEND_DOMAIN_ID` is set). Portal > Settings > "Check DNS now"; it is also
  rechecked daily and whenever a send is refused for it. Live sending is refused until it passes.
- **Replies.** Inbound mail arrives on the same webhook (`email.received`). A reply stops the cold
  sequence for that clinic and is forwarded to the owner. Unsubscribe wording and automatic replies are
  recognised without a model; the rest is classified (`classify_reply`). A question that matches an
  approved answer, or an interested reply, gets a draft in the queue; anything else is escalated with no
  draft. Portal > Replies lets the owner write the answer or mark it handled.
- **Follow-up.** One reminder, once, `follow_up_business_days` after a first email with no reply. It is
  reviewed like any other item and counts toward the two-contact limit.

## The offer

Every plan, price, term, pillar and promise is stated once, in `src/lib/offer.ts`, and nowhere else. The
public pages, the plan cards on a report, the emails, checkout and the phone agent all read it, so they
cannot disagree. To change a price or a sentence, change it there; `tests/offer.test.ts` runs every
sentence through the email wording rules and the phone's spoken-word check.

- **Plans:** Full report (200 CAD once), Visibility (200 a month, no minimum), Growth (450 a month plus
  500 setup, 6-month minimum), Transformation (from 900 a month, quoted, never bought online: its buy
  page is a "ask for a quote" form that makes a task for the owner). The retired plans ("Monthly
  reports", "Full service plan") stay valid in old rows and old links lead to Visibility.
- **Report credit:** the 200 CAD is credited to the first month of a plan started within 30 days of
  paying for the report. It is one Stripe coupon, attached only by our server for a clinic that qualifies.
- **Switches:** which promises (support, changes, warranty, security, ownership, terms, quarterly
  review) and which of the five pillars are stated is the owner's choice in Portal > Settings > The
  offer (`app_settings.offer_promises`, `offer_pillars`). A promise is said or shown only while it is on.
- **Report cards are not stored.** A report's plan section is filled in when the page is served or
  printed, like the live ratings, so a price change needs no re-rendering.
- **Approved answers** (Portal > Answers, `src/lib/answers.ts`) never type a price: a placeholder such
  as `{{price:visibility}}` is filled in from the offer when the answer is read.

## Phone agent

Ansa, the phone voice of In The Answer Copilot, explains a clinic's report by phone and follows the call
playbook (`src/lib/calls`). It is off until Twilio is configured and the owner turns it on (Portal >
Settings > Phone calls). The line and the voices have been tried on real Twilio calls, and the playbook
with the real model through `npm run call:sim`.

- **The playbook** (`playbook.ts`): opening (who is calling, that it is an AI, that the call is
  transcribed, one ice-breaker chosen by the program), role (not the owner or manager: reach that
  person, do not sell), the clinic's facts one at a time, discovery, a bridge to at most two parts of
  the service, one reassurance sentence, the offer, the close. The model reports its stage and the
  problems the caller's own words showed; the engine enforces the rules: a part of the service is named
  only when the caller's answer points to it; support, warranty and security only in the published
  sentence, once; one offer per call; the Transformation price is never said; a checkout link goes out
  only after the program's own read-back of plan, price and term and a clear yes. A line that breaks a
  playbook rule is replaced and the call goes on; the after-call review checks the model's reports
  against what was said.
- **Emails from a call:** the report and a checkout link use fixed wording built from `offer.ts` and are
  sent at once (message type `requested_on_call`). A summary of the call is written by the model after
  the call and waits for the owner's approval, as does the one follow-up a caller may agree to (three
  business days later, never a second).
- **Never said:** review counts or ratings (Maps terms: they are shown live on the web report only), a
  promised result, a price that is not published, "recorded" (nothing is recorded: calls are transcribed).

- **Consent only, no cold calls.** The voice is synthesized. The CRTC's Unsolicited Telecommunications
  Rules allow a solicitation call that conveys a synthesized voice only with the express consent of the
  person called, and calls to businesses are exempt from the do-not-call list but not from that rule
  (the CRTC is reviewing how the rule applies to AI voices: notice 2026-132). So every outbound call
  needs a `call_consents` row, and there is no other way to queue one:
  1. the clinic asks on `/call/<report token>`, linked from its report page ("Have it call me"): it
     types the number and ticks the consent wording, which is stored with the request;
  2. the owner records that a clinic asked another way (Portal > clinic > "This clinic asked to be
     called"), with a note of what they said.
  Do not add a cold-calling mode without legal advice.
- **Calls to our number** are answered by the same agent (`POST /api/voice/incoming`). A caller is
  matched by a number that asked for a call before, by the number the clinic publishes on its own site,
  by the six-digit report code (shown with our number on the report page and on `/call`), or by the
  clinic's name: the caller says it, `lookup.ts` matches it loosely against clinics that have a
  verified report (speech recognition garbles names), and the agent asks "is that your clinic?" before
  the report is used. The lookup and those lines are the engine's, not the model's. A match by name is
  the caller's word only, and Portal > Calls says so. Otherwise the agent can only explain the service.
- **What it may say.** Each call gets a brief built from stored data only (`brief.ts`): the report as
  saved after the verification gate, the published prices, the owner's approved answers. The model
  (`agent.ts`) is told to state nothing else and to say it is an AI. Every line then passes the
  spoken-word check (`guard.ts`) before the caller hears it: the email gate's wording rules, only the
  published prices, no review numbers, never passing for a person. A line that fails is replaced by a
  fixed one and kept in the transcript; two in one call end the call and hand over to the owner.
- **Actions.** The model picks one per turn; the engine carries it out: hand over to the owner (task +
  alert), email the report and checkout links (an `interested_reply` message, through the usual review
  and sending rules), do not call, do not contact at all, wrong number, voicemail (hang up, no message).
  "Stop calling" is also recognised without the model and acted on at once.
- **Rules at dial time** (`rules.ts`): recorded consent no older than 14 days, number and clinic not
  suppressed, calls on, kill switch off, business hours (the sending window), daily call cap, daily spend
  cap, two attempts at most. An answering machine is hung up on without a message.
- **After the call** (`review_call`): a summary for the owner, and a strict reading of every sentence the
  agent spoke against its brief; anything unsupported becomes an owner task. Transcripts (text only, no
  audio) are deleted after 180 days. Portal > Calls shows calls, transcripts and the do-not-call list.
- **Dry run.** No call is placed (recorded as a dry-run call, like email). Calls *to* our number are
  still answered once calls are on, so the owner can test by phoning it.
- **Try it without a phone:** `npm run call:sim` (sample report), `npm run call:sim -- <report token>`,
  or `-- --general` (a call to our number: name a clinic from the database to reach its report). Same
  brief, model call and wording check; nothing is stored or sent.
- **How a call runs.** Twilio speaks each line (`<Say>` inside `<Gather input="speech dtmf">`) and posts
  what it heard to `/api/voice/turn/<call token>`; one model call per turn, cut off at 10 seconds. This
  works on serverless (no WebSocket) at the cost of a pause before each reply. The live conversation
  runs on `claude-haiku-5-5` (`VOICE_MODEL` changes it) to keep that pause short; the after-call check
  runs on `CLAUDE_MODEL`. Every webhook checks the Twilio signature against `APP_URL`.
- **Voice.** Chosen in Portal > Settings > Phone calls from the list in `voices.ts` (stored in
  `app_settings.call_voice`); the default is an ElevenLabs voice, which sounds closest to a person.
  ElevenLabs voices in `<Say>` are a Twilio public beta: if one stops working, pick a Google or Amazon
  voice from the same list. Every listed voice was tried on a real call. Twilio has no Canadian English
  voice, and Canadian English is not in its listed speech-recognition languages, so both stay `en-US`.
  The voice never changes what is said: the opening line says it is an AI assistant, whatever the
  voice. `VOICE_TTS_VOICE` is only used for a line spoken when the settings cannot be read.

## Payments and delivery (phase 5)

- Report buttons go to `/buy/<report token>/report`, `/visibility`, `/growth` and `/transformation` (a
  quote form, no payment). The Stripe session is created only when the visitor presses the button.
  Checkout is closed (with a plain notice) in dry run, while Stripe is not configured, and when a Stripe
  price or the credit coupon is not exactly what `src/lib/offer.ts` publishes (the owner is alerted). The
  page shows what is due today, with the setup amount and any report credit; if that amount changes
  before the button is pressed, nothing is created and the page is shown again. A clinic is never
  charged twice for the same thing.
- `POST /api/stripe/webhook`: signature checked, every event stored once (`stripe_events`), replays are
  no-ops. Payment makes the clinic a customer, stops cold mail, queues a receipt and starts fulfilment.
  Refunds, failed renewals and cancellations update the records and alert the owner.
- One-time: `build_full_report` builds the full report from stored evidence, runs it through the gate,
  renders the PDF and queues a `full_report_delivery` email (owner-reviewable). Visibility: the same
  first delivery plus an onboarding task (arrange access, so we can publish). Growth: also an intake
  form (`/intake/<token>`, no login, no passwords). A report buyer who starts a plan with the credit
  is not sent a second full report.
- Portal > Customers lists orders, subscriptions and onboarding tasks.

## Schedule, retests and alerts (phase 6)

`runScheduleTick` (`src/lib/schedule/tick.ts`) runs with every worker call and only enqueues idempotent
jobs: discovery per active target once a month (`discovery_targets_per_day` a day; skipped without a Places
key), a monthly retest and report for each subscriber on its anniversary day, one retest
`retest_after_purchase_days` after a one-time purchase, daily retention, the follow-up and DNS tasks, and
owner alerts (dead jobs, auto-pause, spend cap, items stuck in review) plus a morning digest. Portal >
System shows the schedule, failing jobs with a retry button, and open alerts. Other modules add a task with
`registerScheduled({ name, every, run })`.

## Going live

Everything stays a dry run until all of this is true. Do it in this order.

1. **Supabase**: create the project; apply `supabase/migrations/*.sql` in order, then `supabase/seed.sql`
   (never the local shim). Create the private storage bucket `reports`. Disable public sign-ups and add the
   owner user (see "Only the owner can sign in").
2. **Vercel**: deploy; set every variable in `.env.example`. `APP_SECRET` must be 32+ random characters
   (signing refuses to work otherwise) and `CRON_SECRET` protects the worker route. Supabase pg_cron
   calls the worker every minute (Vercel Hobby allows a cron only once a day, so `vercel.json` keeps a
   daily call as a safety net). Site tests and PDFs use headless Chromium: check one on Vercel, and if it fails there
   run `npm run worker` on a small always-on machine instead.
3. **Domain (GoDaddy DNS)**: point `intheanswer.ca` and `www` at Vercel. Leave the existing MX and SPF
   records on the root domain alone (they belong to the GoDaddy mailbox). Add the records Resend gives for
   `mail.intheanswer.ca` (SPF, DKIM, and the MX for receiving replies), plus a DMARC record. Then Portal >
   Settings > "Check DNS now".
4. **Resend**: add the domain `mail.intheanswer.ca`, turn on receiving, create an API key and a webhook to
   `https://intheanswer.ca/api/resend/webhook` for the email events (sent, delivered, bounced, complained,
   failed, suppressed, received). Set `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `RESEND_DOMAIN_ID`, and
   `MAIL_REPLY_TO` to an address on the receiving domain so replies reach the portal.
5. **Stripe**: prices of exactly 200.00 CAD one-time (`STRIPE_PRICE_ONE_TIME`), 200.00 CAD monthly
   (`STRIPE_PRICE_VISIBILITY_MONTHLY`), 450.00 CAD monthly (`STRIPE_PRICE_GROWTH_MONTHLY`) and 500.00 CAD
   one-time (`STRIPE_PRICE_GROWTH_SETUP`), and a coupon of 200.00 CAD off, once
   (`STRIPE_COUPON_REPORT_CREDIT`); webhook to
   `https://intheanswer.ca/api/stripe/webhook` for `checkout.session.completed`, `.expired`,
   `.async_payment_succeeded`, `.async_payment_failed`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.created`, `.updated`, `.deleted`, `charge.refunded`. Optional
   `STRIPE_TAX_RATE_ID` for HST. Turn on the receipts Stripe emails so renewals get one.
6. **Owner details**: the real name, registered business name, mailing address, phone and minimum term.
   Live sending is refused while any is a placeholder.
   **Phone agent (optional)**: apply `supabase/migrations/20261122000001_calls.sql`; buy a Canadian Twilio
   number; set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`; on the number set "A call
   comes in" to POST `{APP_URL}/api/voice/incoming` and "Call status changes" to POST
   `{APP_URL}/api/voice/incoming/status`; try `npm run call:sim`, then Portal > Settings > Phone calls >
   Turn calls on and phone the number yourself. Before the first real call, check the CRTC's current
   telemarketing rules (or ask a lawyer) for anything else that applies to you, such as registering
   with the National DNCL operator: this code enforces consent, hours and do-not-call, not registration.
7. **Switch on**: `DRY_RUN=0` in the environment, then Portal > Settings > go live. Keep every message type
   on REVIEW at first; the warm-up starts at 10 a day.

## Design

Report and brand designs live on the owner's design canvas ("In The Answer — Report Designs (Teaser +
Full)"). `src/lib/brand.ts` holds its palette and the three-bar mark; `src/lib/reports/renderTeaser.ts`
follows the teaser artboard. Report wording is always generated from stored evidence, never copied from
the mock-up.

The pages a clinic sees follow written rules in `.github/instructions/design.instructions.md`. Colours,
type sizes, corner radii and shared spacing are named once in `src/app/globals.css`. Three commands go
with them:

```bash
npm run design:check             # fails on a hand-typed colour, size, radius or font, and on gradients and shadows (also runs in CI)
npm run shots -- before          # with `npm run dev` running: pictures of every public page at 390, 768 and 1280px in output/shots/before/
npm run shots -- --compare before after   # how much each picture changed; changes in red in output/shots/before-vs-after/
npm run brand:assets             # redraws the tab icons and the share card after a change to the mark, colours, heading font or home banner photo
```

Reports are styled separately (`src/lib/reports/html.ts`, with fonts embedded in each report), so a
brand change has to be made there as well as in `globals.css`. The heading font is Atkinson
Hyperlegible Next: it is named in `--font-head` (globals.css), imported in `src/app/layout.tsx`, set as
`HEAD_FONT` in `src/lib/reports/html.ts`, and its files are listed in `next.config.ts` so that the
deployment includes them.

The photographs on the public pages (`src/app/(site)/images/`) are generated images, labelled as such
in the site footer. The design rules describe the two looks they follow and where each one is used.

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
