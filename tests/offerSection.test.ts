import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWITCHES, ONLINE_TIERS, PILLAR_ORDER, PROMISE_ORDER, REPORT_CREDIT_TEXT, TIERS, TIER_ORDER,
  cad, emailOfferLines, priceText, termText, tierIncludes, type Switches,
} from "@/lib/offer";
import {
  NO_GUARANTEE_LINE, OFFER_MARKER, OFFER_UPGRADE_MARKER, fillOffer, needsOffer, renderOfferSection, renderOfferUpgrade, withoutOffer, type OfferContext,
} from "@/lib/reports/offerSection";
import { sampleTeaser } from "@/lib/reports/sample";
import { renderTeaser, siteOrigin } from "@/lib/reports/renderTeaser";
import { renderFullReport, type FullReportData } from "@/lib/reports/fullReport";
import { renderComparisonReport, type ComparisonData } from "@/lib/reports/monthly";
import { retestEmail } from "@/lib/retests/report";
import { buildFirstEmail } from "@/lib/emails/firstEmail";
import { scanLanguage } from "@/lib/pipeline/verify";
import { priceNote } from "@/lib/env";

const SITE = "https://intheanswer.test";
const BUY = `${SITE}/buy/teaser-token-0000001`;
const ctx = (over: Partial<OfferContext> = {}): OfferContext => ({ buyBase: BUY, site: SITE, findingsTotal: 6, has: null, switches: DEFAULT_SWITCHES, ...over });

/** A report page without its stylesheet and embedded fonts: what is checked is the document, and a failed check stays readable. */
const page = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, "");
/** What a reader sees: the markup, the drawn arrows and the escapes taken out. */
const text = (html: string) =>
  page(html).replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const cards = (html: string) => [...html.matchAll(/<article class="rp-plan( main)?"[^>]*>[\s\S]*?<\/article>/g)].map((m) => ({ html: m[0], main: !!m[1] }));
const cardNames = (html: string) => cards(html).map((c) => c.html.match(/class="rp-planname">([^<]+)</)![1]);
const links = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
/** The plans as written into a page: everything else on the page is what was stored. */
const SECTION = /<section[^>]*\sdata-offer[\s\S]*?<\/section>/g;
/** Every amount the offer publishes. */
const PUBLISHED = new Set(TIER_ORDER.flatMap((k) => [TIERS[k].oneTimeCents, TIERS[k].monthlyCents, TIERS[k].setupCents]).filter((c): c is number => c != null).map((c) => cad(c)));
/** A plan or a price that is no longer sold, or any way to buy, typed into a stored report. */
const FROZEN = /\d+ CAD|monthly reports|full service plan|\/buy\//i;

const full = (over: Partial<FullReportData> = {}): FullReportData => ({
  clinic: { id: "c1", name: "Maple Grove Dental", city: "Barrie", domain: "maplegrove.example", placeId: null },
  score: { recommended: 1, total: 6 },
  testDate: "November 10, 2026",
  findings: [{ key: "hours", label: "Opening hours", seen: "We did not find opening hours on the pages we read.", fix: "A single hours block used on every page and listing.", evidence: [] }],
  siteTest: null, reviews: null, pages: [], firstDraft: null, structuredData: { name: "Maple Grove Dental" }, kitHtml: null,
  regulatorNote: "Check all wording against the RCDSO advertising standards before publishing.",
  ...over,
});

const comparison = (kind: "monthly" | "retest"): ComparisonData => ({
  kind, verified: true, cycle: kind === "monthly" ? "2026-11" : "order-1",
  clinic: { id: "c1", name: "Maple Grove Dental", city: "Barrie", domain: "maplegrove.example" },
  test: { assistant: "Claude", model: "claude-test", date: "November 11, 2026", runLabel: "2026-11", testRunId: "t2" },
  score: { id: "s2", auditId: "a2", recommended: 1, listedOnly: 1, total: 3 },
  previous: { reportId: null, reportKind: null, scoreId: "s1", testRunId: "t1", auditId: "a1", recommended: 0, listedOnly: 1, total: 3, date: "October 5, 2026" },
  rows: [{ questionIndex: 0, question: "Who is a good dentist in Barrie?", answerId: "x", now: "recommended", before: "not_named", previousAnswerId: "y" }],
  installed: [], fixed: [], services: { reviews: null, siteChanges: [], pages: [] },
  summary: ["On November 11, 2026, Maple Grove Dental was recommended in 1 of 3 answers.", "At the previous test on October 5, 2026 it was recommended in 0 of 3."],
  limits: "This report reflects one assistant on one day.",
  owner: { name: "Sam Owner", businessName: "In The Answer Inc.", mailingAddress: "1 Main St, Barrie ON", phone: "705-555-0100", email: "hello@intheanswer.test" },
  claims: [],
});

describe("the plan section of a report", () => {
  it("is written from the offer: three cards, each with its price, term, contents and checkout link", () => {
    const html = renderOfferSection(ctx());
    const seen = text(html);
    expect(seen).toContain("Three ways to fix it");
    expect(cardNames(html)).toEqual(ONLINE_TIERS.map((k) => TIERS[k].name));
    for (const [i, k] of ONLINE_TIERS.entries()) {
      const card = text(cards(html)[i].html);
      const t = TIERS[k];
      // the price is set in two sizes, so its words are looked for one by one; the short list states it whole
      for (const part of priceText(k).split(", ")) for (const word of part.split(/(?<=CAD) /)) expect(card, `${k}: ${word}`).toContain(word);
      expect(seen).toContain(`${t.name} ${priceText(k)} · `);
      expect(card).toContain(termText(k));
      expect(card).toContain(t.whoDoesIt);
      expect(card).toContain(t.retests);
      expect(card).toContain(t.action);
      for (const line of tierIncludes(k)) expect(card, `${k}: ${line}`).toContain(line);
      expect(links(cards(html)[i].html)).toEqual([`${BUY}/${k}`]);
    }
    // Visibility is the highlighted card, and the only one
    expect(cards(html).filter((c) => c.main).map((c) => cardNames(c.html)[0])).toEqual([TIERS.visibility.name]);
  });

  it("shows how long each plan commits: nothing filled for no minimum, six cells for the six-month minimum", () => {
    const filled = cards(renderOfferSection(ctx())).map((c) => (c.html.match(/<span class="on">/g) ?? []).length);
    expect(filled).toEqual(ONLINE_TIERS.map((k) => TIERS[k].minTermMonths ?? 0));
    expect(filled).toEqual([0, 0, 6]);
    for (const c of cards(renderOfferSection(ctx()))) expect((c.html.match(/<span class="rp-meter"[^>]*>(<span[^>]*><\/span>)+/)![0].match(/<span(?: class="on")?><\/span>/g) ?? [])).toHaveLength(12);
  });

  it("gives the quoted plan one row, with its starting price and the page where a quote is asked for", () => {
    const html = renderOfferSection(ctx());
    const seen = text(html);
    expect(priceText("transformation")).toBe("from 900 CAD a month, quoted after a review");
    expect(seen).toContain(`${TIERS.transformation.name} From 900 CAD a month, quoted after a review · ${termText("transformation")}`);
    expect(seen).toContain(tierIncludes("transformation").join(" · "));
    expect(html).toContain(`href="${BUY}/transformation">${TIERS.transformation.action}`);
    // it is not a fourth card
    expect(cards(html)).toHaveLength(3);
  });

  it("closes with the currency, the report credit, what is never promised and the pricing page", () => {
    const html = renderOfferSection(ctx());
    const note = text(html.match(/<p class="rp-note">[\s\S]*?<\/p>/)![0]);
    expect(note).toBe(`${priceNote()} ${REPORT_CREDIT_TEXT} ${NO_GUARANTEE_LINE} Contracts, cancelling and refunds are on the pricing page.`);
    expect(html).toContain(`href="${SITE}/pricing"`);
    expect(text(html)).toContain("The free report is yours to keep whether or not you buy anything. The full report covers all 6 confirmed findings.");
    // without a count, the count is not said
    expect(text(renderOfferSection(ctx({ findingsTotal: null })))).not.toMatch(/covers all/);
    expect(text(renderOfferSection(ctx({ findingsTotal: 1 })))).toContain("covers all 1 confirmed finding.");
  });

  it("states no amount the offer does not publish, and words nothing against the rules", () => {
    for (const has of [null, "report", "visibility", "growth", "monthly"]) {
      for (const html of [renderOfferSection(ctx({ has })), renderOfferUpgrade(ctx({ has }))]) {
        const seen = text(html);
        for (const amount of seen.match(/\d+ CAD/g) ?? []) expect(PUBLISHED.has(amount), `${has}: ${amount}`).toBe(true);
        expect(seen).not.toMatch(/\b150 CAD|\b50 CAD|monthly reports|full service plan/i);
        expect(scanLanguage(seen, "plan section"), `${has}: ${seen}`).toEqual([]);
      }
    }
  });

  it("leaves out what the clinic already has, and counts the cards it shows", () => {
    // on Visibility: Growth, and the quoted plan
    const onVisibility = renderOfferSection(ctx({ has: "visibility" }));
    expect(cardNames(onVisibility)).toEqual([TIERS.growth.name]);
    expect(text(onVisibility)).toContain("One way to go further");
    expect(text(onVisibility)).toContain(TIERS.transformation.name);
    expect(links(onVisibility)).toEqual([`${BUY}/growth`, `${BUY}/transformation`, `${SITE}/pricing`]);
    expect(text(onVisibility)).not.toContain(REPORT_CREDIT_TEXT);
    expect(text(onVisibility)).not.toContain("whether or not you buy");
    // a retired plan counts as the plan that replaced it
    expect(cardNames(renderOfferSection(ctx({ has: "monthly" })))).toEqual([TIERS.growth.name]);
    expect(cardNames(renderOfferSection(ctx({ has: "reports" })))).toEqual([TIERS.growth.name]);

    const hasReport = renderOfferSection(ctx({ has: "report" }));
    expect(cardNames(hasReport)).toEqual([TIERS.visibility.name, TIERS.growth.name]);
    expect(text(hasReport)).toContain("Two ways to go further");
    expect(text(hasReport)).toContain(REPORT_CREDIT_TEXT);

    const onGrowth = renderOfferSection(ctx({ has: "growth" }));
    expect(cards(onGrowth)).toHaveLength(0);
    expect(text(onGrowth)).toContain("Going further");
    expect(links(onGrowth)).toEqual([`${BUY}/transformation`, `${SITE}/pricing`]);

    expect(renderOfferSection(ctx({ has: "transformation" }))).toBe("");
    expect(fillOffer(`<main>${OFFER_MARKER}</main>`, ctx({ has: "transformation" }))).toBe("<main></main>");
  });

  it("describes only the pillars that are switched on", () => {
    const noFrontDesk: Switches = { promises: [...PROMISE_ORDER], pillars: PILLAR_ORDER.filter((p) => p !== "front_desk") };
    const html = text(renderOfferSection(ctx({ switches: noFrontDesk })));
    expect(html).not.toMatch(/receptionist|Review requests/);
    expect(html).toMatch(/Your website rebuilt/);
    expect(text(renderOfferSection(ctx()))).toMatch(/receptionist/);
    expect(text(renderOfferUpgrade(ctx({ has: "report", switches: noFrontDesk })))).not.toMatch(/receptionist/);
  });

  it("sends the buttons to the pricing page when there is nobody to sell to", () => {
    const html = renderOfferSection(ctx({ buyBase: null }));
    expect(links(html)).toEqual([`${SITE}/pricing`, `${SITE}/pricing`, `${SITE}/pricing`, `${SITE}/pricing`, `${SITE}/pricing`]);
    expect(html).not.toContain("/buy/");
  });
});

describe("the next step of a paid report", () => {
  it("lists the plans above the report, each with its price, its term and its link", () => {
    const html = renderOfferUpgrade(ctx({ has: "report" }));
    const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));
    const lines = emailOfferLines({ has: "report", withQuote: true }).map((l) => l.replace(/^- /, ""));
    // the term follows each plan once: a line that already states it (Growth) is not given it a second time
    expect(items).toEqual((["visibility", "growth", "transformation"] as const).map((k, i) => (lines[i].includes(termText(k)) ? lines[i] : `${lines[i]} ${termText(k).charAt(0).toUpperCase()}${termText(k).slice(1)}.`)));
    expect(items[1]).toBe("Growth: 450 CAD a month, plus 500 CAD setup, 6-month minimum, then month to month. Everything in Visibility, plus a rebuilt website that we keep current and an AI receptionist for missed calls.");
    expect(items[0]).toMatch(/Month to month.$/);
    expect(links(html)).toEqual([`${BUY}/visibility`, `${BUY}/growth`, `${BUY}/transformation`]);
    expect(text(html)).toContain(REPORT_CREDIT_TEXT);
    expect(text(html)).toContain(NO_GUARANTEE_LINE);
    // a report with nobody's plan on record is still a paid report: the report itself is not offered
    expect(renderOfferUpgrade(ctx({ has: null }))).toBe(html);
  });

  it("offers a subscriber only what is above their plan, and the largest plan nothing", () => {
    const html = renderOfferUpgrade(ctx({ has: "visibility" }));
    expect(links(html)).toEqual([`${BUY}/growth`, `${BUY}/transformation`]);
    expect(text(html)).not.toContain(REPORT_CREDIT_TEXT);
    expect(text(html)).not.toMatch(/^.*Visibility: /);
    expect(renderOfferUpgrade(ctx({ has: "transformation" }))).toBe("");
  });
});

describe("what a stored report holds", () => {
  const sample = sampleTeaser();
  const stored = {
    teaser: page(renderTeaser(sample)),
    "full report (web)": page(renderFullReport(full(), { web: true })),
    "full report (print)": page(renderFullReport(full(), { web: false })),
    retest: page(renderComparisonReport(comparison("retest"))),
    monthly: page(renderComparisonReport(comparison("monthly"))),
  };

  it("no plan name, no price and no checkout link: only the place they are written into", () => {
    for (const [name, html] of Object.entries(stored)) expect(text(html), name).not.toMatch(FROZEN);
    for (const [name, html] of Object.entries(stored)) expect(html, name).not.toMatch(/\/buy\//);
    expect(stored.teaser).toContain(OFFER_MARKER);
    expect(stored["full report (web)"]).toContain(OFFER_UPGRADE_MARKER);
    expect(stored["full report (print)"]).toContain(OFFER_UPGRADE_MARKER);
    expect(stored.retest).toContain(OFFER_UPGRADE_MARKER);
    // a subscriber's monthly report offers nothing, and neither does the full report of a clinic that came in on a plan
    expect(needsOffer(stored.monthly)).toBe(false);
    expect(needsOffer(page(renderFullReport(full({ onMonthlyPlan: true }), { web: true })))).toBe(false);
  });

  it("once shown, carries prices in the plan section and nowhere else", () => {
    for (const [name, html] of Object.entries(stored)) {
      const shown = fillOffer(html, ctx({ has: name === "teaser" ? null : "report" }));
      expect(shown, name).not.toContain(OFFER_MARKER);
      expect(shown, name).not.toContain(OFFER_UPGRADE_MARKER);
      const sections: string[] = shown.match(SECTION) ?? [];
      expect(sections, name).toHaveLength(name === "monthly" ? 0 : 1);
      for (const s of sections) expect(text(s), name).toMatch(/450 CAD a month/);
      expect(text(shown.replace(SECTION, "")), name).not.toMatch(FROZEN);
      expect(text(shown), name).not.toMatch(/\b150 CAD|\b50 CAD|monthly reports|full service plan/i);
    }
  });

  it("a report without a marker comes back as it was, and filling twice changes nothing", () => {
    const plain = "<!doctype html><html><body><main><p>No plans here: 3 clinics, 2 answers.</p></main></body></html>";
    expect(fillOffer(plain, ctx())).toBe(plain);
    expect(needsOffer(plain)).toBe(false);
    for (const [name, html] of Object.entries(stored)) {
      const once = fillOffer(html, ctx({ has: name === "teaser" ? null : "report" }));
      expect(fillOffer(once, ctx({ has: name === "teaser" ? null : "report" })), name).toBe(once);
      expect(needsOffer(once), name).toBe(false);
    }
  });

  it("can be shown with no plans at all, when what the clinic has cannot be read", () => {
    for (const [name, html] of Object.entries(stored)) {
      const bare = withoutOffer(html);
      expect(needsOffer(bare), name).toBe(false);
      expect(bare, name).not.toMatch(/data-offer|<!--OFFER/);
      expect(text(bare), name).not.toMatch(FROZEN);
      expect(bare.length, name).toBeLessThanOrEqual(html.length);
    }
    // cards frozen into an older report go too
    const old = stored.teaser.replace(OFFER_MARKER, `<section class="rp-band rp-plansec" aria-labelledby="plans-h"><p class="rp-price">150 CAD</p></section>`);
    expect(withoutOffer(old)).toBe(withoutOffer(stored.teaser));
    expect(text(withoutOffer(old))).not.toMatch(FROZEN);
  });

  it("the sample report shows the cards, with its buttons on the pricing page", () => {
    const shown = fillOffer(stored.teaser, ctx({ buyBase: null, findingsTotal: sample.findingsTotal }));
    expect(cardNames(shown)).toEqual(ONLINE_TIERS.map((k) => TIERS[k].name));
    expect(text(shown)).toContain("SAMPLE REPORT");
    expect(text(shown)).toContain("Three ways to fix it");
    expect(text(shown)).toContain("The full report covers all 6 confirmed findings.");
    expect(shown).not.toContain("/buy/");
    expect(shown.match(/class="rp-btn"[^>]*href="[^"]+"/g)!.every((a) => a.endsWith(`href="${SITE}/pricing"`))).toBe(true);
  });

  it("a teaser stored with its old checkout links still renders, and the links are not used", () => {
    const { siteUrl: _siteUrl, ...rest } = sample;
    void _siteUrl;
    const old = { ...rest, offers: { oneTimeUrl: "https://old.intheanswer.test/buy/tok/report", reportsUrl: "https://old.intheanswer.test/buy/tok/reports", monthlyUrl: "https://old.intheanswer.test/buy/tok/monthly", minTerm: "12 months", reportsMinTerm: "3 months" } };
    expect(siteOrigin(old)).toBe("https://old.intheanswer.test");
    const html = page(renderTeaser(old));
    expect(html).toContain('href="https://old.intheanswer.test/"');
    expect(html).not.toMatch(/\/buy\/|12 months|3 months/);
    expect(html).toContain(OFFER_MARKER);
    // new data names its site plainly; data with neither falls back to the public site
    expect(siteOrigin(sample)).toBe(SITE);
    expect(siteOrigin({})).toBe("https://intheanswer.ca");
    expect(siteOrigin({ offers: { oneTimeUrl: "not a url" } })).toBe("https://intheanswer.ca");
  });

  it("the cards of a report stored before the plans changed are swapped when it is shown", () => {
    const oldCards = `<section class="rp-band rp-plansec" aria-labelledby="plans-h"><div class="rp-wrap rp-stack">
  <h2 id="plans-h" class="rp-h2">Three ways to fix it</h2>
  <article class="rp-plan"><h3 class="rp-planname">Monthly reports</h3><p class="rp-price">150 CAD <small>first month</small></p><a class="rp-btn" href="${BUY}/reports">Start monthly reports</a></article>
  <article class="rp-plan main"><h3 class="rp-planname">Full service plan</h3><p class="rp-price">200 CAD</p><a class="rp-btn" href="${BUY}/monthly">Start the full service plan</a></article>
</div></section>`;
    const oldTeaser = stored.teaser.replace(OFFER_MARKER, oldCards);
    expect(needsOffer(oldTeaser)).toBe(true);
    const shown = fillOffer(oldTeaser, ctx());
    expect(shown).toBe(fillOffer(stored.teaser, ctx()));
    expect(fillOffer(shown, ctx())).toBe(shown);

    const oldNextStep = `<section class="offer main" style="gap:12px">
  <div class="row"><div class="label">Full service plan</div><div class="price">200 CAD <span>per month</span></div></div>
  <a class="btn" href="${BUY}/monthly">Start the full service plan</a>
</section>`;
    const oldFull = stored["full report (web)"].replace(OFFER_UPGRADE_MARKER, oldNextStep);
    expect(fillOffer(oldFull, ctx({ has: "report" }))).toBe(fillOffer(stored["full report (web)"], ctx({ has: "report" })));
  });
});

describe("the offer in emails", () => {
  it("the first email states the plans that are switched on, without a link to buy", () => {
    const d = { ...sampleTeaser(), kind: "teaser" as const };
    const opts = { toEmail: "info@maplegrove.example", sourceUrl: "https://maplegrove.example/", reportUrl: `${SITE}/r/tok` };
    const body = buildFirstEmail(d, opts).bodyText;
    for (const l of emailOfferLines()) expect(body).toContain(`\n${l}\n`);
    expect(body).not.toMatch(/\/buy\/|\b150 CAD|\b50 CAD|Monthly reports|Full service plan/);
    const noFrontDesk: Switches = { promises: [], pillars: ["found", "website", "proof"] };
    const quiet = buildFirstEmail(d, { ...opts, switches: noFrontDesk }).bodyText;
    expect(quiet).not.toMatch(/receptionist/);
    for (const l of emailOfferLines({ switches: noFrontDesk })) expect(quiet).toContain(`\n${l}\n`);
  });

  it("the retest email lists the monthly plans with the clinic's checkout links, or the pricing page without them", () => {
    const d = comparison("retest");
    const mail = retestEmail(d, `${SITE}/r/retest-token`, ctx({ has: "report" }));
    const lines = emailOfferLines({ buyBase: BUY, has: "report" });
    expect(lines).toHaveLength(2);
    expect(mail.bodyText).toContain(`these are the monthly plans:\n${lines.join("\n")}\n\n`);
    expect(mail.bodyText).toContain(`${BUY}/visibility`);
    expect(mail.bodyText).toContain(`${BUY}/growth`);
    expect(mail.bodyText).not.toMatch(/full service plan|\/monthly\b|\/reports\b|\b150 CAD/i);
    expect(scanLanguage(mail.subject + "\n" + mail.bodyText.split("\n--\n")[0], "email", { names: [d.clinic.name] })).toEqual([]);

    const noLink = retestEmail(d, `${SITE}/r/retest-token`, ctx({ has: "report", buyBase: null }));
    expect(noLink.bodyText).toContain(emailOfferLines({ has: "report" }).join("\n"));
    expect(noLink.bodyText).toContain(`Plans and terms: ${SITE}/pricing`);
    expect(noLink.bodyText).not.toContain("/buy/");
  });
});
