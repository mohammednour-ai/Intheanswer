import { esc } from "./html";
import { priceNote } from "../env";
import {
  DEFAULT_SWITCHES, REPORT_CREDIT_TEXT, TIERS, cad, emailOfferLines, isOnlineTier, offeredTo, priceText, termText, tierIncludes,
  type OnlineTier, type Switches, type TierKey,
} from "../offer";

/**
 * The plans at the end of a report.
 *
 * A stored report holds no plan name, price or term: it holds a marker, and
 * the section is written from src/lib/offer.ts each time the report is shown
 * or printed (the same way the live review table is, see reviews/liveTable.ts).
 * A report whose marker is never filled simply has no plan section.
 *
 * This file is wording and markup only: it reads no database. What a clinic
 * already has, its checkout link and the owner's switches are worked out by
 * the caller (src/lib/reports/offerContext.ts) and passed in.
 */

/** The plan cards of the free report. */
export const OFFER_MARKER = "<!--OFFER-->";
/** The short "next step" block of a paid report (full report, retest). */
export const OFFER_UPGRADE_MARKER = "<!--OFFER_UPGRADE-->";

export interface OfferContext {
  /**
   * "<APP_URL>/buy/<teaser token>": each button adds its plan. Null when there
   * is nobody to sell to (the sample report) or no teaser that passed the
   * gate: the buttons then go to the pricing page.
   */
  buyBase: string | null;
  /** The public site, without a trailing slash. */
  site: string;
  /** Confirmed findings in the clinic's report, when known. */
  findingsTotal?: number | null;
  /** What the clinic already has, as stored (a plan key, current or retired). It is not offered again. */
  has?: string | null;
  /** The owner's switches; the launch setting when left out. */
  switches?: Switches;
}

/** The one sentence about results that closes every plan section. It promises nothing. */
export const NO_GUARANTEE_LINE = "No one can guarantee what an AI assistant will say; we report what it said and fix what we can see.";
const KEEP_LINE = "The free report is yours to keep whether or not you buy anything.";
const ABOVE_LINE = "These are the plans above what you have now.";
const PRICING_LINK = "Contracts, cancelling and refunds are on the pricing page.";
/** The next step for a clinic that bought the one-time report (it closes the full report and the retest). */
const UPGRADE_HEAD = "On a monthly plan we do the work for you and retest every month.";
const UPGRADE_HEAD_PLAN = "The plans above the one you have now.";

const ARROW =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>';

const NUMBER = ["No", "One", "Two", "Three", "Four"];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const low = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** One row of a plan card: what is asked, and this plan's answer. */
function row(dt: string, dd: string, cls = ""): string {
  return `<div><dt>${dt}</dt><dd${cls ? ` class="${cls}"` : ""}>${dd}</dd></div>`;
}

/** Twelve cells, the first `months` filled: how long a plan commits you. None for a plan with no minimum. */
function meter(months: number | null): string {
  const on = Math.max(0, Math.min(12, months ?? 0));
  return `<span class="rp-meter" aria-hidden="true">${Array.from({ length: 12 }, (_, i) => `<span${i < on ? ' class="on"' : ""}></span>`).join("")}</span>`;
}

/** Where a plan's button goes: its checkout (or quote) page, or the pricing page when there is no clinic to sell to. */
function planUrl(ctx: OfferContext, k: TierKey): string {
  return ctx.buyBase ? `${ctx.buyBase.replace(/\/+$/, "")}/${k}` : `${ctx.site.replace(/\/+$/, "")}/pricing`;
}

/**
 * A published price in two parts: the amount, set large, and the words that
 * follow it ("a month", "plus 500 CAD setup"). Both come from priceText().
 */
function priceParts(k: TierKey): { amount: string; unit: string; extra: string[] } {
  const t = TIERS[k];
  const amount = cad(t.oneTimeCents ?? t.monthlyCents);
  const price = priceText(k);
  if (!price.startsWith(amount)) return { amount: price, unit: "", extra: [] };
  const [unit = "", ...extra] = price.slice(amount.length).replace(/^[\s,]+/, "").split(", ");
  return { amount, unit, extra };
}

function card(k: OnlineTier, ctx: OfferContext, main: boolean, alone: boolean): string {
  const t = TIERS[k];
  const p = priceParts(k);
  // the row answers "how long": the first half of the term ("6-month minimum"); the whole term is under the price
  const commit = termText(k).split(", ")[0];
  const sub = [...p.extra, termText(k)].join(" · ");
  const who = t.kind === "subscription" ? `<span class="rp-wedo">${esc(t.whoDoesIt)}</span>` : `<span class="rp-big">${esc(t.whoDoesIt)}</span>`;
  return `<article class="rp-plan${main ? " main" : ""}"${alone ? ' style="max-width:560px"' : ""}>
      <div class="rp-planhead"><h3 class="rp-planname">${esc(t.name)}</h3><p class="rp-price">${esc(p.amount)}${p.unit ? ` <small>${esc(p.unit)}</small>` : ""}</p><p class="rp-plansub">${esc(sub)}</p></div>
      <dl class="rp-dl">
        ${row("Who installs the fixes", who, "rp-installs")}
        ${row("How long you commit", `<span class="rp-big">${esc(cap(commit))}</span>${meter(t.minTermMonths)}`, "rp-term")}
        ${row("Retests", esc(t.retests), "rp-retest")}
      </dl>
      <ul>${tierIncludes(k, ctx.switches ?? DEFAULT_SWITCHES).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <a class="rp-btn" href="${esc(planUrl(ctx, k))}">${esc(t.action)}${ARROW}</a>
    </article>`;
}

/** The plan that is quoted, never bought online: one ruled row under the cards. */
function quoteRow(ctx: OfferContext): string {
  const t = TIERS.transformation;
  const includes = tierIncludes("transformation", ctx.switches ?? DEFAULT_SWITCHES);
  // a ruled row, not a fourth card: it opens with the ink line, and the note's own line closes it
  return `<div style="border-top:2px solid var(--ink);padding-top:16px;display:flex;flex-wrap:wrap;align-items:center;gap:14px 32px;break-inside:avoid">
    <div style="flex:5 1 420px;min-width:0;display:flex;flex-direction:column;gap:4px">
      <h3 class="rp-planname">${esc(t.name)}</h3>
      <p><strong>${esc(cap(priceText("transformation")))}</strong> · ${esc(termText("transformation"))}</p>
      <p style="font-size:.94em;color:var(--body2);text-wrap:pretty">${esc(includes.join(" · "))}</p>
    </div>
    <a class="rp-btn" style="margin:0;flex:0 1 auto" href="${esc(planUrl(ctx, "transformation"))}">${esc(t.action)}${ARROW}</a>
  </div>`;
}

/** What is said under the plans: the currency, the report credit while it can apply, and what is never promised. */
function note(ctx: OfferContext, offered: TierKey[]): string {
  // the credit is for a clinic that has not yet started a plan
  const credit = (!ctx.has || ctx.has === "report") && offered.some((k) => TIERS[k].kind === "subscription");
  return [priceNote(), credit ? REPORT_CREDIT_TEXT : "", NO_GUARANTEE_LINE].filter(Boolean).map(esc).join(" ");
}

/**
 * The plan section of the free report: a card for each plan bought online
 * that the clinic does not have, and one row for the plan that is quoted.
 * Empty when there is nothing left to offer.
 */
export function renderOfferSection(ctx: OfferContext): string {
  const offered = offeredTo(ctx.has);
  const cards = offered.filter(isOnlineTier);
  const quote = offered.includes("transformation");
  if (!cards.length && !quote) return "";
  const main = cards.includes("visibility") ? "visibility" : cards[cards.length - 1];
  const n = cards.length;
  const heading = ctx.has
    ? (n ? `${NUMBER[n]} ${n === 1 ? "way" : "ways"} to go further` : "Going further")
    : `${NUMBER[n]} ${n === 1 ? "way" : "ways"} to fix it`;
  const total = ctx.findingsTotal ?? 0;
  const intro = ctx.has
    ? ABOVE_LINE
    : `${KEEP_LINE}${total > 0 && cards.includes("report") ? ` The full report covers all ${total} confirmed ${total === 1 ? "finding" : "findings"}.` : ""}`;
  const glance = cards
    .map((k) => `<li><strong>${esc(TIERS[k].name)}</strong>${esc([priceText(k), low(TIERS[k].whoDoesIt), termText(k)].join(" · "))}</li>`)
    .join("");
  return `<section class="rp-band rp-plansec" data-offer aria-labelledby="plans-h"><div class="rp-wrap rp-stack">
  <div class="rp-planshead">
    <h2 id="plans-h" class="rp-h2">${esc(heading)}</h2>
    <p>${esc(intro)}</p>
  </div>
  ${n ? `<ul class="rp-glance" aria-label="The ${n === 1 ? "option" : `${NUMBER[n].toLowerCase()} options`} in short">${glance}</ul>
  <div class="rp-plans">
    ${cards.map((k) => card(k, ctx, k === main, n === 1)).join("\n    ")}
  </div>` : ""}
  ${quote ? quoteRow(ctx) : ""}
  <p class="rp-note">${note(ctx, offered)} <a href="${esc(ctx.site.replace(/\/+$/, ""))}/pricing">${PRICING_LINK}</a></p>
</div></section>`;
}

/**
 * The short "next step" block at the end of a paid report: one line for each
 * plan above what the clinic has, each with its price, its term and its link.
 * Empty when there is nothing left to offer.
 */
export function renderOfferUpgrade(ctx: OfferContext): string {
  const switches = ctx.switches ?? DEFAULT_SWITCHES;
  // whoever reads a paid report has at least the report: it is never offered here
  const has = ctx.has ?? "report";
  const offered = offeredTo(has);
  // one line per plan, in the same order, as an email states them: its name, its price and what it is
  const lines = emailOfferLines({ has, switches, withQuote: true }).map((l) => l.replace(/^- /, ""));
  if (!offered.length || lines.length !== offered.length) return "";
  return `<section class="offer main" data-offer style="gap:12px">
  <div><div class="label">Next step</div><div class="price" style="font-size:22px">${esc(has === "report" ? UPGRADE_HEAD : UPGRADE_HEAD_PLAN)}</div></div>
  <ul>${offered.map((k, i) => `<li>${esc(lines[i])}${lines[i].includes(termText(k)) ? "" : ` ${esc(cap(termText(k)))}.`}</li>`).join("")}</ul>
  <p style="color:inherit">${note({ ...ctx, has }, offered)}</p>
  <div style="display:flex;flex-wrap:wrap;gap:8px">${offered.map((k) => `<a class="btn" href="${esc(planUrl(ctx, k))}">${esc(TIERS[k].action)}</a>`).join("")}</div>
</section>`;
}

/**
 * Reports stored before the plans moved to src/lib/offer.ts carry the old
 * cards in their HTML. They are swapped for the current section when the
 * report is shown, so an old link never shows a retired plan or price.
 * A section written by this file is marked `data-offer` and is never matched.
 */
const STORED_SECTION = /<section class="rp-band rp-plansec" aria-labelledby="plans-h">[\s\S]*?<\/section>/;
const STORED_UPGRADE = /<section class="offer main" style="gap:12px">[\s\S]*?<\/section>/;

/** Whether this report has a place for the plans (so a caller can skip working out the context). */
export function needsOffer(html: string): boolean {
  return html.includes(OFFER_MARKER) || html.includes(OFFER_UPGRADE_MARKER) || STORED_SECTION.test(html) || STORED_UPGRADE.test(html);
}

/**
 * Put the plans into a report that is about to be shown or printed. A report
 * without a marker comes back unchanged, and so does one already filled.
 */
export function fillOffer(html: string, ctx: OfferContext): string {
  if (!needsOffer(html)) return html;
  let out = html;
  if (out.includes(OFFER_MARKER)) out = out.split(OFFER_MARKER).join(renderOfferSection(ctx));
  if (out.includes(OFFER_UPGRADE_MARKER)) out = out.split(OFFER_UPGRADE_MARKER).join(renderOfferUpgrade(ctx));
  return out.replace(STORED_SECTION, () => renderOfferSection(ctx)).replace(STORED_UPGRADE, () => renderOfferUpgrade(ctx));
}

/**
 * The report with no plans at all: its markers taken out, and so are cards
 * stored before the plans changed. For when what the clinic has cannot be
 * read: a page without plans is better than one that offers the wrong ones.
 */
export function withoutOffer(html: string): string {
  return fillOffer(html, { buyBase: null, site: "", has: "transformation" });
}
