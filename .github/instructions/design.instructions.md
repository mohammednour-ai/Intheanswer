---
applyTo: "src/app/**/*.css,src/app/**/*.tsx"
---

# Design rules for the In The Answer pages

These rules apply to every page a clinic sees: `src/app/(site)`, `src/app/buy`, `src/app/call`, `src/app/intake` and `src/app/approve`. The reader is a clinic owner or office manager in Ontario deciding whether to trust a stranger's report. The pages must look like the work of an established company: confident, well photographed and careful. Never like a template, and never plain to the point of looking dated (the owner's word for the earlier, picture-free version was "Hotmail").

Run `npm run design:check` after any change to a stylesheet or a page. It fails on the mechanical rules below. Then look at the page: `npm run shots -- <label>` saves pictures at phone, tablet and desktop width under `output/shots/<label>/`.

## The look, in seven sentences

White ground, near-black ink, one blue. The main pages open with a picture band: a photograph of a well-equipped clinic room across the full width, with the headline on it in white. Photographs of high-value clinic equipment carry the visual weight; the answer mark (three lines of a list with the middle line in blue) is the only drawn illustration. Flat colour only: no gradients, no shadows, no blur, no glass. Structure comes from type and from rules (a 2px ink line opens a block, 1px grey lines separate rows), not from boxes around everything. Text is left-aligned. Nothing moves except hover and focus states.

## Hard rules (the check enforces these)

1. **Colours are named once**, in the `:root` block of `src/app/globals.css`. Never type a hex colour anywhere else, in CSS or in TSX. To colour an inline SVG, give it a class or use `var(--blue)`; `ResultMark.tsx` shows how.
2. **Type sizes are named**: `font-size` is always `var(--text-…)`. An `em` value is allowed only for a part of a larger figure, such as the "of 6" beside the score.
3. **Corner radii are named**: `border-radius` is always `var(--radius-…)`.
4. **Fonts are named**: `var(--font-head)` for headings and figures, `var(--font-body)` for everything else. Never name a typeface directly, so that the heading font can change in one place.
5. **No gradient, shadow, blur, `@keyframes` or `animation`.**
6. **No inline `fontSize`, `fontFamily`, `borderRadius` or `boxShadow`** on a public page. Put it in the page's stylesheet.

If a design seems to need a value that has no name, it almost always needs an existing name instead. Add a new name to `globals.css` only when a new role appears, and say so in your summary.

## Named values and when to use each

**Text**

| Name | Use |
|---|---|
| `--text-caps` | Uppercase labels only (with `letter-spacing: .8px`, weight 700). Use the class `site.eyebrow`. |
| `--text-xs` | Notes and captions under something. |
| `--text-s` | Small text; navigation and footer. |
| `--text-m` | Secondary text, list items, descriptions. |
| `--text-base` | Body text. |
| `--text-l` | A sentence that needs slightly more weight than body. |
| `--text-lead` | The one paragraph under a page headline. |
| `--text-h4`, `--text-h3` | Headings inside a card or a row. |
| `--text-subtitle` | A panel title; the label on the blue line. |
| `--text-title` | A small section heading. |
| `--text-h2` | A section heading (`site.h2`). |
| `--text-display` | A statement set large (`site.display`): the limits band, the closing band. |
| `--text-h1`, `--text-h1-s` | The page headline (`site.h1`); the smaller one is for plain pages. |
| `--text-num`, `--text-num-l` | Step and question numbers, in blue, beside a heading. |
| `--text-figure`, `--text-figure-l`, `--text-figure-xl` | A price in a card, the price at checkout, the report score. |

**Corners**: `--radius-s` buttons and fields · `--radius-m` a card inside a panel · `--radius-l` a panel · `--radius-pill` anything fully round · `--radius-bubble` and `--radius-xs` chat bubbles (the tail corner is the small one).

**Space**: fixed gaps come from `--space-half` (2px), `--space-1` (4px) to `--space-6` (24px), and `--space-8` (32px). Fluid space comes from `--fluid-s` (between cards, inside a small card), `--fluid-m` (inside a panel, between blocks), `--fluid-l` (between the parts of a section), `--gap-cols` and `--gap-cols-l` (between two columns), `--band-y` (top and bottom of a section), `--hero-top` and `--hero-bottom` (around a page headline), `--banner-h` and `--banner-h-s` (the height of the picture band on the home page and on an inner page). Do not write a new `clamp()` for spacing.

**Colour**: `--ink` text · `--ink-2` secondary text · `--muted` labels and notes · `--line` and `--line-strong` rules and borders · `--field-line` form field borders · `--soft` the grey ground of a band or panel · `--blue` the one accent, for the answer, links and the main button · `--blue-on-ink` blue on the ink band · `--list-grey` the grey lines of the answer mark · `--warn`, `--bad`, `--ok` and their `-soft` and `-line` partners for the three results and for notices. Blue means "the answer" or "act here". Do not use it for decoration.

## Photographs

The photographs are in `src/app/(site)/images/`. They are generated images, and the footer of every public page says so ("The photographs on this site are generated images. They do not show real clinics."). Keep that sentence in the footer for as long as one generated photograph is on the site.

There are two sets, and each has one look:

| File | Where | Look |
|---|---|---|
| `banner-treatment-room.jpg` | Home page picture band, and the share card | Evening |
| `banner-imaging-room.jpg` | How it works picture band | Evening |
| `banner-reception.jpg` | Pricing picture band | Evening |
| `room-dental.jpg`, `room-family.jpg`, `room-medspa.jpg` | The three clinic cards on the home page | Daylight |
| `detail-ultrasound.jpg` | Under the four steps on How it works | Daylight |
| `detail-microscope.jpg` | Beside "Built for healthcare" on the home page | Daylight |

- **Evening** (picture bands): a state-of-the-art clinic room at dusk, matte charcoal walls, warm walnut, one slim line of cool blue light along the ceiling. The equipment stands on the right third. The left half is a dark, almost empty wall, because the headline sits there.
- **Daylight** (cards and details): a premium, spotless room in soft daylight, pale oak and white, with high-value equipment in clear view (a treatment chair with microscope and scanner, an ultrasound cart, an aesthetic laser).
- The owner rejected an earlier set of plain, ordinary rooms as unattractive. A new photograph must look expensive and show equipment a clinic owner would recognise as costly.
- A picture band is the `Banner` component: `next/image` with `fill`, a flat layer of ink over it, white text. Never put text over the bright part of a photograph, and never use a gradient to make it readable. If the text reaches the equipment at some width, narrow the text.
- Other photographs use `next/image` with a static import, so the size is known and the page does not jump. Give them `alt=""`: they are decoration.
- A new photograph needs the owner's approval before it goes on a page, and must match one of the two looks.
- Never a person, a face or hands. Never readable text, a logo or a sign; screens are switched off. Never anything that could be taken for a real clinic or a real client.
- Do not add stock photos, icon sets or drawn illustrations. One picture band at the top of a page is enough; do not put one on every section.

## Reuse before you write

Shared classes are in `src/app/(site)/site.module.css`; page-only styles go in that page's own `.module.css`. Check these first:

- Layout: `site.container`, `site.band` with `site.bandRule`, `site.bandSoft` or `site.bandInk`, `site.stack`, `site.split`.
- Type: `site.eyebrow`, `site.h1`, `site.accent`, `site.h2`, `site.display`, `site.lead`, `site.body2`, `site.fine`, `site.link`.
- Buttons: `site.btnPrimary`, `site.btnOutline`, grouped in `site.actions`. One primary button per view.
- Forms: `site.form`, `site.field`, `site.check`, `site.go`. Fields are styled globally; do not restyle them.
- Pieces: `site.bubble` and `site.bubbleSmall` (what a patient asks), the plan cards (`site.plans`, `site.plan`), `site.prose` for a plain text page.
- Components: `Banner.tsx` (the picture band at the top of a page; its lead paragraph is `site.bannerLead`), `ClosingBand.tsx` (the last band of a page), `Snapshot.tsx` (one assistant, five or six questions, one day), `ResultMark.tsx` (the mark drawn for one result), `Offers.tsx` (the plans, read from `src/lib/offer.ts`), `Promises.tsx` (the promises that are switched on), `TalkToAnsa.tsx` (the "Talk to Ansa" button fixed in the bottom corner of every public page, with its own `talk.module.css`; it is the one thing that stays on screen, so do not add a second fixed element), `buy/Shell.tsx` (the frame for checkout and one-task pages).
- One-task pages (checkout, intake, phone call, page approval) use `Shell` with `s.intro`, `s.panel`, `s.panelSoft`, `s.notice` and `s.h2` from `src/app/buy/buy.module.css`.

If the same block is needed on a second page, move it to `site.module.css` or make it a component. Never copy a block between page stylesheets.

## Layout habits

- A section is a `site.band` holding a `site.container`. The home, How it works and Pricing pages open with a `Banner`; the plain text pages (contact, privacy, crawler, unsubscribe, sample) open with `site.prose` and no picture.
- Two columns are a wrapping flex row (`flex: 5 1 420px` beside `flex: 4 1 320px`), so they stack on a phone without a media query.
- Running text is at most 60 to 62 characters wide. Headings use `text-wrap: balance`; paragraphs use `text-wrap: pretty`.
- Anything a finger taps is at least 44px high.
- A result is always written as a word (Recommended, Listed only, Not named). Colour alone never carries meaning.
- The page must not scroll sideways at 390px. `npm run shots` reports it when it does.

## What makes a page look machine-made (do not do these)

- Gradients, glows, glass panels, soft shadows under cards.
- Emoji used as icons, or a row of three identical icon cards.
- Everything centred, or a pill badge floating above the headline.
- The same rounded box around every block. A box is for one thing that is separate from the rest.
- Decorative numbers. Number things only when the order is real (the three steps, the five price questions).
- Scroll animations, hover lifts, counters that tick up.
- Invented testimonials, client logos, statistics or star ratings.
- Hype words: unlock, elevate, seamless, effortless, supercharge, game-changing, cutting-edge.

## Content rules

- Use the real content: the sample report in `src/lib/reports/sample.ts`, the owner details from `ownerDetails()`, the real prices. Never placeholder text.
- The site speaks as a company ("we"), not as one person. In The Answer is presented as an Ontario company with three lines of work: websites and systems, AI integration, and AI marketing. Do not invent a team size, a founding year, clients or awards.
- A web page identifies the company by `ownerDetails().businessName`, its mailing address, phone and email. It does not print the owner's personal name (`ownerDetails().name`). Emails and reports are different: they keep a named contact, and every email must contain the business name and the mailing address or the send gate in `src/lib/sending/send.ts` blocks it.
- Anything invented is labelled where it appears ("Illustration", "invented clinic", "Sample report").
- Plans, prices, terms, pillars and promises come only from `src/lib/offer.ts`. Never type a price, a plan name, a term or a promise on a page: read `TIERS`, `priceText()`, `termText()`, `tierIncludes()`, `pillarsOn()` and `promisesOn()`. `Offers.tsx` draws the plans and `Promises.tsx` the promises; both take the owner's switches from `siteSwitches()` in `src/app/(site)/switches.ts`, and a page that calls it sets `export const revalidate = 600`.
- A figure about our own tests comes from `src/app/(site)/tested.ts`, which records the count, the date and the query that produced it. Quote it as a count with its date ("178 of 250, counted on 22 November 2026"), never as "most clinics", and count again before changing it.
- A claim about how the service behaves (what the AI says, what is checked, what the clinic approves) must match the code or the terms on the pricing page. The "Built for healthcare" list on the home page names where each one is enforced.
- Say what the service does and what it cannot do. Never promise that a clinic will be named.
- Plain sentences, the way the owner would say them to a clinic manager on the phone.

## When asked to design or redesign a section

1. Say in two or three lines what the reader must understand first, second and third. Build that order with size and position before adding anything else.
2. Build it from the shared classes and named values above. List any new class you add and why an existing one did not fit.
3. Change one section at a time. If the layout is unclear, describe two options and ask before building.
4. Run `npm run design:check`, then `npm run shots -- <label>` and look at the pictures at all three widths before saying the work is done.
