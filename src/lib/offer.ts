/**
 * The offer, stated once.
 *
 * Every plan, price, term, pillar and promise that In The Answer puts in front
 * of a clinic is defined here and nowhere else: the public pages, the plan
 * cards on a report, the emails, checkout and the phone agent all read this
 * file, so they cannot disagree. To change a price or a sentence, change it
 * here.
 *
 * This file is plain data and wording. It reads no database and no
 * environment, so any page or script can import it. Which pillars and
 * promises are currently offered is decided by the owner (Portal > Settings)
 * and passed in as `Switches`; see `src/lib/offerSwitches.ts`.
 *
 * Wording rules (tests/offer.test.ts checks every sentence against them): no
 * superlatives, no promise that a clinic will be named or ranked, and nothing
 * about patient numbers or revenue. We promise the work, the speed and the
 * reporting; results are measured and shown, not guaranteed.
 */

export type TierKey = "report" | "visibility" | "growth" | "transformation";
export type PillarKey = "found" | "website" | "front_desk" | "systems" | "proof";
export type PromiseKey = "support" | "changes" | "warranty" | "security" | "ownership" | "terms" | "current";

/** The plans a clinic can buy online. Transformation is quoted, never bought online. */
export type OnlineTier = Exclude<TierKey, "transformation">;
export type SubscriptionTier = Exclude<TierKey, "report">;

export const POSITIONING =
  "In The Answer is the AI transformation partner for clinics. We test how patients find you in the AI era, then we rebuild and run the systems that win them: website, AI tools, integrations and reporting, under one monthly plan.";

/** The answer to "what else do you do?": one line, then the service page, never a list. */
export const POSITIONING_SHORT =
  "We test how patients find a clinic through AI assistants, then rebuild and run what that depends on: the website, AI tools, integrations and reporting, under one monthly plan.";

// ---------------------------------------------------------------------------
// Pillars: what a clinic gets
// ---------------------------------------------------------------------------

export interface Pillar {
  key: PillarKey;
  title: string;
  /** One sentence for a page. */
  text: string;
  /** The one sentence the phone agent may use to connect a caller's own problem to this pillar. */
  bridge: string;
  /** The problem, in the caller's words, that this pillar answers. */
  pain: string;
}

export const PILLARS: Record<PillarKey, Pillar> = {
  found: {
    key: "found",
    title: "Be found in the AI era",
    text: "AI visibility testing, answer pages, listing and profile fixes, and a watch on the clinics named beside you.",
    bridge: "We publish the pages and fix the listings AI assistants read, then retest every month and show you the result.",
    pain: "The clinic is not coming up when patients ask an AI assistant.",
  },
  website: {
    key: "website",
    title: "A website that works for patients",
    text: "A full rebuild: fast, mobile-first, accessible, with a clear path to booking, and kept current every month.",
    bridge: "We rebuild the site fully, keep it fast and current, and you request changes by text or email.",
    pain: "The website is old, slow, or nobody looks after it.",
  },
  front_desk: {
    key: "front_desk",
    title: "AI working for the front desk",
    text: "An AI phone receptionist for after-hours and overflow calls, booking and reminder automation, review requests and reply drafts. Patient information goes only through privacy-compliant tools.",
    bridge: "We set up an AI receptionist that answers after-hours and overflow calls, books or takes messages, and says it's an AI.",
    pain: "Calls are missed after hours or when the front desk is busy; reviews are not asked for or answered.",
  },
  systems: {
    key: "systems",
    title: "Connected systems",
    text: "Integration with your booking, practice management, phone and forms, plus custom tools for your clinic's own workflow. Patient information goes only through privacy-compliant tools.",
    bridge: "We take over the web and integration work, so you have one partner and one monthly report.",
    pain: "Several companies handle the website, phones, booking and marketing, and the clinic coordinates them.",
  },
  proof: {
    key: "proof",
    title: "Proof every month",
    text: "A standing report: AI visibility, website speed, calls handled and review patterns, with the changes we made.",
    bridge: "Every month you get one report that shows what was tested, what changed and what we did.",
    pain: "The clinic cannot see what its current suppliers actually did.",
  },
};

/** A second bridge for the front desk pillar, for a caller whose problem is reviews, not calls. */
export const REVIEWS_BRIDGE = "We read every review, show you the patterns, and send review requests and reply drafts for your approval.";

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export interface Tier {
  key: TierKey;
  name: string;
  /** How the plan is named in a sentence: "the Growth plan". */
  inSentence: string;
  kind: "one_time" | "subscription";
  /** Cents, before HST. */
  oneTimeCents: number | null;
  monthlyCents: number | null;
  /** A one-time setup amount added to the first invoice. */
  setupCents: number | null;
  /** The monthly price is a starting point, set by quote. */
  priceFrom: boolean;
  minTermMonths: number | null;
  purchase: "online" | "quote";
  /** One sentence: what this plan is. */
  summary: string;
  /** What is included. A line tagged with a pillar is left out while that pillar is switched off. */
  includes: { text: string; pillar?: PillarKey }[];
  /** Who does the work, for the plan card. */
  whoDoesIt: string;
  retests: string;
  /** The words on the button. */
  action: string;
}

export const TIERS: Record<TierKey, Tier> = {
  report: {
    key: "report",
    name: "Full report and fix files",
    inSentence: "the full report and fix files",
    kind: "one_time",
    oneTimeCents: 20000,
    monthlyCents: null,
    setupCents: null,
    priceFrom: false,
    minTermMonths: null,
    purchase: "online",
    summary: "Every confirmed finding with its fix, ready for your own web person to install.",
    includes: [
      { text: "Every confirmed finding, each with its fix" },
      { text: "Fix files your web person can paste in" },
      { text: "One retest four weeks later" },
    ],
    whoDoesIt: "Your web person",
    retests: "One retest four weeks later",
    action: "Get the full report",
  },
  visibility: {
    key: "visibility",
    name: "Visibility",
    inSentence: "the Visibility plan",
    kind: "subscription",
    oneTimeCents: null,
    monthlyCents: 20000,
    setupCents: null,
    priceFrom: false,
    minTermMonths: null,
    purchase: "online",
    summary: "We do the AI visibility work every month and show you what changed.",
    includes: [
      { text: "The full report and fix files" },
      { text: "The same patient questions retested every month, with a before and after", pillar: "found" },
      { text: "Answer pages written for those questions and published on your site", pillar: "found" },
      { text: "Listing and profile fixes, and a watch on the clinics named beside you", pillar: "found" },
      { text: "A monthly report: what was tested, what changed and what we did", pillar: "proof" },
    ],
    whoDoesIt: "We do the work for you",
    retests: "Retested every month, with a before and after",
    action: "Start Visibility",
  },
  growth: {
    key: "growth",
    name: "Growth",
    inSentence: "the Growth plan",
    kind: "subscription",
    oneTimeCents: null,
    monthlyCents: 45000,
    setupCents: 50000,
    priceFrom: false,
    minTermMonths: 6,
    purchase: "online",
    summary: "Everything in Visibility, plus a rebuilt website and AI working for your front desk.",
    includes: [
      { text: "Everything in Visibility" },
      { text: "Your website rebuilt: fast, mobile-first, accessible, with a clear path to booking, and kept current every month", pillar: "website" },
      { text: "An AI phone receptionist for after-hours and overflow calls. It says it is an AI, takes messages and bookings, and hands anything clinical to your team", pillar: "front_desk" },
      { text: "Review requests to your patients, and reply drafts for your approval", pillar: "front_desk" },
      { text: "Website speed, calls handled and review patterns added to your monthly report", pillar: "proof" },
    ],
    whoDoesIt: "We do the work for you",
    retests: "Retested every month, with a before and after",
    action: "Start Growth",
  },
  transformation: {
    key: "transformation",
    name: "Transformation",
    inSentence: "the Transformation plan",
    kind: "subscription",
    oneTimeCents: null,
    monthlyCents: 90000,
    setupCents: null,
    priceFrom: true,
    minTermMonths: 6,
    purchase: "quote",
    summary: "Everything in Growth, plus integrations and custom tools, quoted after a review of how your clinic works.",
    includes: [
      { text: "Everything in Growth" },
      { text: "Integration with your booking, practice management, phone and forms", pillar: "systems" },
      { text: "Custom tools for your clinic's own workflow", pillar: "systems" },
      { text: "Priority support" },
    ],
    whoDoesIt: "We do the work for you",
    retests: "Retested every month, with a before and after",
    action: "Ask for a quote",
  },
};

export const TIER_ORDER: TierKey[] = ["report", "visibility", "growth", "transformation"];
export const ONLINE_TIERS: OnlineTier[] = ["report", "visibility", "growth"];

export const isTierKey = (x: string | null | undefined): x is TierKey => !!x && Object.prototype.hasOwnProperty.call(TIERS, x);
export const isOnlineTier = (x: string | null | undefined): x is OnlineTier => isTierKey(x) && TIERS[x].purchase === "online";
export const isSubscriptionTier = (x: string | null | undefined): x is SubscriptionTier => isTierKey(x) && TIERS[x].kind === "subscription";

/**
 * Plans that are no longer sold. An old link or an old row still means
 * something: both retired plans were the monthly AI visibility work, which is
 * now the Visibility plan (website work moved to Growth).
 */
export const LEGACY_PLAN: Record<string, TierKey> = { monthly: "visibility", reports: "visibility" };
export const LEGACY_NAMES: Record<string, string> = { monthly: "Full service plan (retired)", reports: "Monthly reports (retired)" };

/** The name of a plan as stored on an order or a subscription, current or retired. */
export function planName(stored: string | null | undefined): string {
  if (isTierKey(stored)) return TIERS[stored].name;
  return (stored && LEGACY_NAMES[stored]) || "Plan";
}

/**
 * The one-time report is credited against the first month of a plan started
 * within this many days of paying for it. This is a published term, not a
 * discount: it is said in these words only.
 */
export const REPORT_CREDIT = { cents: TIERS.report.oneTimeCents!, days: 30 } as const;
export const REPORT_CREDIT_TEXT = `If you start a monthly plan within ${REPORT_CREDIT.days} days of buying the full report, the ${REPORT_CREDIT.cents / 100} CAD you paid for it is credited to your first month.`;

// ---------------------------------------------------------------------------
// Promises: worded so they can always be kept
// ---------------------------------------------------------------------------

export interface OfferPromise {
  key: PromiseKey;
  title: string;
  /** The exact wording, for pages and emails. */
  text: string;
  /** The same promise as a clause the phone agent's one reassurance sentence is built from. */
  spoken: string;
}

export const PROMISES: Record<PromiseKey, OfferPromise> = {
  support: {
    key: "support",
    title: "Support around the clock",
    text: "An AI support line and monitoring run 24 hours a day, 7 days a week. A person answers an urgent website issue within 1 business hour.",
    spoken: "support around the clock for urgent issues",
  },
  changes: {
    key: "changes",
    title: "Easy changes",
    text: "Ask for a change by email or text. Small changes are done within 1 business day and are included.",
    spoken: "changes within a business day",
  },
  warranty: {
    key: "warranty",
    title: "Warranty",
    text: "Anything we build that breaks is fixed free for as long as you are subscribed. A new website carries a 30-day launch warranty.",
    spoken: "anything we build is fixed free while you're with us",
  },
  security: {
    key: "security",
    title: "Security",
    text: "SSL, daily backups, updates applied, uptime monitoring and two-factor admin access. Patient health information goes only through Canadian privacy-compliant tools.",
    spoken: "daily backups and monitoring on your site",
  },
  ownership: {
    key: "ownership",
    title: "You own it",
    text: "You own your domain, your content and your data. We hand everything over if you leave.",
    spoken: "you own your site and data",
  },
  terms: {
    key: "terms",
    title: "No lock-in surprises",
    text: "Growth and Transformation have a 6-month minimum, then run month to month. Visibility is month to month from the start.",
    spoken: "after the minimum term it's month to month",
  },
  current: {
    key: "current",
    title: "Always current",
    text: "We review new AI tools each quarter and apply the ones that fit, inside your plan.",
    spoken: "new AI tools reviewed every quarter",
  },
};

export const PROMISE_ORDER: PromiseKey[] = ["support", "changes", "warranty", "security", "ownership", "terms", "current"];
export const PILLAR_ORDER: PillarKey[] = ["found", "website", "front_desk", "systems", "proof"];

/** What is never promised, on any surface. */
export const NEVER_PROMISED =
  "We do not promise AI mentions, rankings, patient numbers or revenue. We promise the work, the speed and the reporting; results are measured and shown, not guaranteed.";

/**
 * What the owner has switched on. A promise is stated only once the operation
 * behind it exists; a pillar is described only once it is offered.
 */
export interface Switches {
  promises: PromiseKey[];
  pillars: PillarKey[];
}

/** The launch setting (22 November 2026): the security list and the quarterly review are off until the owner turns them on. */
export const DEFAULT_SWITCHES: Switches = {
  promises: ["support", "changes", "warranty", "ownership", "terms"],
  pillars: ["found", "website", "front_desk", "systems", "proof"],
};

export const isPromiseKey = (x: string): x is PromiseKey => Object.prototype.hasOwnProperty.call(PROMISES, x);
export const isPillarKey = (x: string): x is PillarKey => Object.prototype.hasOwnProperty.call(PILLARS, x);

/** Switches as stored (two lists of keys), with anything unknown dropped. Missing lists mean the launch setting. */
export function readSwitches(stored: { promises?: unknown; pillars?: unknown } | null | undefined): Switches {
  const list = <T extends string>(v: unknown, ok: (x: string) => x is T, order: T[], fallback: T[]): T[] =>
    Array.isArray(v) ? order.filter((k) => v.includes(k) && ok(k)) : fallback;
  return {
    promises: list(stored?.promises, isPromiseKey, PROMISE_ORDER, DEFAULT_SWITCHES.promises),
    pillars: list(stored?.pillars, isPillarKey, PILLAR_ORDER, DEFAULT_SWITCHES.pillars),
  };
}

export const promisesOn = (s: Switches = DEFAULT_SWITCHES): OfferPromise[] => PROMISE_ORDER.filter((k) => s.promises.includes(k)).map((k) => PROMISES[k]);
export const pillarsOn = (s: Switches = DEFAULT_SWITCHES): Pillar[] => PILLAR_ORDER.filter((k) => s.pillars.includes(k)).map((k) => PILLARS[k]);

/** What a plan includes right now: lines of a switched-off pillar are left out. */
export function tierIncludes(key: TierKey, s: Switches = DEFAULT_SWITCHES): string[] {
  return TIERS[key].includes.filter((l) => !l.pillar || s.pillars.includes(l.pillar)).map((l) => l.text);
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/** "200 CAD". */
export const cad = (cents: number | null | undefined): string => `${Math.round((cents ?? 0) / 100)} CAD`;

/** "450 CAD a month, plus 500 CAD setup" / "200 CAD, one time" / "from 900 CAD a month, quoted after a review". */
export function priceText(key: TierKey): string {
  const t = TIERS[key];
  if (t.kind === "one_time") return `${cad(t.oneTimeCents)}, one time`;
  if (t.priceFrom) return `from ${cad(t.monthlyCents)} a month, quoted after a review`;
  return `${cad(t.monthlyCents)} a month${t.setupCents ? `, plus ${cad(t.setupCents)} setup` : ""}`;
}

/** "6-month minimum, then month to month" / "month to month" / "no contract". */
export function termText(key: TierKey): string {
  const t = TIERS[key];
  if (t.kind === "one_time") return "no contract";
  return t.minTermMonths ? `${t.minTermMonths}-month minimum, then month to month` : "month to month";
}

/** What is charged at checkout, before HST: the first month, any setup, less a report credit. Never below zero. */
export function firstPaymentCents(key: OnlineTier, creditCents = 0): number {
  const t = TIERS[key];
  const full = (t.oneTimeCents ?? 0) + (t.monthlyCents ?? 0) + (t.setupCents ?? 0);
  return Math.max(0, full - (t.kind === "subscription" ? creditCents : 0));
}

/** The plans a clinic can still be offered, given what it already has (stored value, current or retired). */
export function offeredTo(has: string | null | undefined): TierKey[] {
  const current: TierKey | null = isTierKey(has) ? has : (has && LEGACY_PLAN[has]) || null;
  if (!current) return TIER_ORDER;
  return TIER_ORDER.slice(TIER_ORDER.indexOf(current) + 1);
}

/** One line per plan, for an email. With `buyBase` (".../buy/<token>") each line ends in its link. */
export function emailOfferLines(opts: { buyBase?: string; has?: string | null; switches?: Switches; withQuote?: boolean } = {}): string[] {
  const s = opts.switches ?? DEFAULT_SWITCHES;
  const short: Record<TierKey, string> = {
    report: "Every finding with its fix, for your own web person to install.",
    visibility: "We publish the answer pages, fix the listings and retest every month.",
    growth: `Everything in Visibility, plus ${[
      s.pillars.includes("website") ? "a rebuilt website that we keep current" : "",
      s.pillars.includes("front_desk") ? "an AI receptionist for missed calls" : "",
    ].filter(Boolean).join(" and ") || "more of the work done for you"}.`,
    transformation: "Integrations and custom tools.",
  };
  return offeredTo(opts.has)
    .filter((k) => k !== "transformation" || opts.withQuote)
    .map((k) => `- ${TIERS[k].name}: ${priceText(k)}${TIERS[k].minTermMonths && !TIERS[k].priceFrom ? `, ${termText(k)}` : ""}. ${short[k]}${opts.buyBase ? ` ${opts.buyBase}/${k}` : ""}`);
}

/** The owner's answer to "how much does it cost?", generated so it can never repeat an old price. */
export function priceAnswer(hst: boolean): string {
  return [
    `There are three plans${hst ? ", all plus HST" : ""}.`,
    `${TIERS.visibility.name} is ${priceText("visibility")}: we do the AI visibility work every month and show you what changed.`,
    `${TIERS.growth.name} is ${priceText("growth")}, with a ${termText("growth")}: it adds a rebuilt website and AI for your front desk.`,
    `${TIERS.transformation.name} is ${priceText("transformation")}, for integrations and custom tools.`,
    `You can also buy the full report and fix files on its own for ${priceText("report")}. ${REPORT_CREDIT_TEXT}`,
    "The links in the report go straight to checkout.",
  ].join(" ");
}

// ---------------------------------------------------------------------------
// The phone
// ---------------------------------------------------------------------------

/** Dollar amounts the phone agent may say. The Transformation price is not one of them: it is quoted by the founder. */
export function speakableAmounts(): number[] {
  const cents = ONLINE_TIERS.flatMap((k) => [TIERS[k].oneTimeCents, TIERS[k].monthlyCents, TIERS[k].setupCents]);
  return [...new Set(cents.filter((c): c is number => c != null).map((c) => c / 100))].sort((a, b) => a - b);
}

/** "200 dollars a month" for a voice. */
const dollars = (cents: number | null | undefined) => `${Math.round((cents ?? 0) / 100)} dollars`;

/** A plan's price and term as the agent says them. Transformation has no spoken price. */
export function spokenPrice(key: TierKey): string {
  const t = TIERS[key];
  if (t.purchase === "quote") return "quoted after a short review with the founder";
  if (t.kind === "one_time") return `${dollars(t.oneTimeCents)}, one time`;
  const term = t.minTermMonths ? `, with a ${t.minTermMonths}-month minimum, then month to month` : ", month to month";
  return `${dollars(t.monthlyCents)} a month${t.setupCents ? ` plus ${dollars(t.setupCents)} setup` : ""}${term}`;
}

/** The plans as facts for the agent's brief: what each is, its price and its term. */
export function phoneOfferLines(has: string | null | undefined, s: Switches = DEFAULT_SWITCHES): string[] {
  return offeredTo(has).map((k) => {
    const t = TIERS[k];
    const included = tierIncludes(k, s).join("; ");
    return t.purchase === "quote"
      ? `${t.name}: ${t.summary} It is never priced on a call. The next step is a short review call with the founder, who gives the quote. Includes: ${included}.`
      : `${t.name}: ${priceText(k)}, ${termText(k)}. ${t.summary} Includes: ${included}.`;
  });
}

/**
 * The line the program itself says before any checkout link is sent, so the
 * plan, the price and the term a caller agrees to are always the published
 * ones. The link goes out only after a clear yes to this.
 */
export function readBack(key: OnlineTier): string {
  return `Just to confirm: ${TIERS[key].inSentence}, ${spokenPrice(key)}. I'll email the checkout link to the address your report was sent to. Is that right?`;
}

/** The one reassurance sentence, built only from promises that are switched on. Null when none is. */
export function reassurance(s: Switches = DEFAULT_SWITCHES): string | null {
  const parts = promisesOn(s).map((p) => p.spoken);
  if (!parts.length) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  return `Everything is covered in the plan: ${list}.`;
}
