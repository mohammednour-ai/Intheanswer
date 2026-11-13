# In The Answer

Automated service for intheanswer.ca. It finds local clinics in Ontario, tests whether AI assistants name
them when patients ask for a recommendation, sends each clinic a free personalised report, sells the fix,
delivers it, and retests every month.

Status: **built in phases, dry run only.** Nothing is sent or charged until the owner says go live.

| Phase | Scope | State |
|---|---|---|
| 1 | Data model, RLS, job queue, portal shell | done |
| 2 | Pipeline steps 1 to 7 (discover → verify), teasers | built; real teasers need `ANTHROPIC_API_KEY` |
| 3 | Public site | done |
| 4 | Sending, approval queue, replies | |
| 5 | Stripe and full-report delivery | |
| 6 | Monthly retests | |
| + | Added services: review analysis, full site test, answer pages | built, dry run on seeds |
| + | Direct mail channel, QR results page, consent, channel settings and routing | built, test mode only |

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

## Direct mail and channels

Flow: letter or email -> results page at `/r/CODE` -> "Request a call" or "Email me the full results",
each with consent -> call or email -> sale. Every step is recorded per clinic and per channel.

### Setup
1. Create a PostGrid account (print and mail). Put the **test** key in `POSTGRID_API_KEY` first.
2. In PostGrid, create a webhook to `{APP_URL}/api/webhooks/postgrid` for `letter.created`,
   `letter.updated`, `postcard.created`, `postcard.updated`; put its secret in `POSTGRID_WEBHOOK_SECRET`.
3. Portal > Settings > Channels: set the inbound number, switch the letter channel on, set caps.
4. Portal > Mail: build a batch in **test mode** and send it. With the test key nothing is printed. With
   a live key a test-mode batch is printed and mailed **to your own address only**, to check print
   quality. Real mailing also needs live mode switched on in Settings.

### Cost per piece (PostGrid's published Canada prices, USD, read 2026-11-13)
| Piece | Lettermail (first class) | Personalized Mail (standard class) |
|---|---|---|
| Letter, black and white | 2.12 | 1.37 |
| Letter, colour | 2.22 | 1.47 |
| Postcard 4x6 | 2.12 | 1.25 |

Printing, envelope and postage are included; an extra page is 0.20 to 0.30. Address verification is
included when a contact is created with a live key (Canada Post SERP certified). PostGrid lists
Lettermail as for non-marketing mail and Personalized Mail as marketing only with a **minimum of 200
pieces**: confirm with PostGrid which class a 50-letter first batch may use. Their published delivery
times (5 to 7 business days first class, 10 to 15 standard) are listed for US mail; ask for Canadian
times. The cost used in the portal is a setting (default 2.22 per letter, 2.12 per postcard).

### Things PostGrid does differently from the brief
- **Envelope:** the default is a standard double-window envelope with the addresses printed at the top
  of page one. A plain, windowless envelope needs a custom envelope arranged with PostGrid support. The
  letter keeps the top of the page clear for the address; if PostGrid finds content there it cancels
  the order.
- **Returned mail:** PostGrid reports returns only for US mail. A Canadian letter that comes back
  arrives at your return address; record it with "Mark returned" on the batch page, which marks the
  address bad.

### How consent is stored
- **Call:** `call_consents` holds the number, name, role, the exact wording shown beside the box, the
  time, IP and page URL. It lasts 30 days and can be revoked. `dial()` in `src/lib/calls/consent.ts` is
  the only way a call may start; it refuses without valid consent, outside Monday to Friday 9:30 am to
  5:00 pm, when the clinic opted out, or when the call-me channel is closed. No voice agent is
  connected yet: the portal's "Start call" runs the same check and then shows the number.
- **Email:** `email_consents` holds the address, the exact wording (naming the sender and how to
  unsubscribe) and the same evidence. Only an address with a row here may be emailed after a letter.
- Both boxes are unticked by default and required, in the browser and on the server.
- **Opt-out:** `/optout` (code from the letter, or email), the unsubscribe link, or the owner. Any of
  them stops all mail, email and calls to that clinic (`src/lib/channels/optout.ts`).

### How routing works
Rules live in `channel_settings` (row `routing`) and are applied in order by `route()` in
`src/lib/channels/routing.ts`: exclusions; lead score threshold (the send priority; default 5); no
email -> letter, no address confirmed on the clinic's own site -> email, neither -> skipped; optional
random test split that ignores the threshold; cool-down (default 30 days, minimum 14) before the other
channel; consent contact is never blocked; one piece per clinic. The settings screen previews the next
100 clinics under the current and the new rules before saving. Mailing addresses come from the clinic's
own website (never Google Places) and are verified by PostGrid before sending.

### How to pause a channel
Portal > Settings > Channels: switch a channel off, set a pause-until date, or lower its daily or
monthly spend cap. "Stop all outbound now" is the kill switch for every channel. Every change is in the
change log on that page (`settings_audit_log`).

### Mail rules in code
Nothing is mailed until a batch is approved and Send is pressed. First real batch: at most 50 letters,
one city. Two mail pieces per clinic, ever (letter, then one postcard if the code was not visited within
14 days). A visit with no action triggers nothing automatic. Letters carry no prices and no review
numbers, and every letter passes the verification gate before it can be queued.

## Safety rules in code

- Only public addresses are fetched; private, loopback and link-local hosts are refused, including
  after a redirect (`assertPublicUrl`).
- The worker runs one job at a time inside a time budget (`runWorkerBudget`); `vercel.json` calls it
  every minute. Site tests need a function limit of 300 s; Chromium on Vercel is untested, so run site
  tests from a small separate worker (`npm run worker`) if it fails there.
- Queued items expire after 7 days and the clinic's audit is queued again.
- Sending is not built yet: approved items wait in the queue.

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
