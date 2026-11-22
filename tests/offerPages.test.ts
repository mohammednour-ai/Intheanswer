import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db, closeDb } from "@/lib/db";
import { GET as reportPage } from "@/app/r/[token]/route";
import { GET as samplePage } from "@/app/sample-report/route";
import { sampleTeaser } from "@/lib/reports/sample";
import { renderTeaser } from "@/lib/reports/renderTeaser";
import { renderFullReport } from "@/lib/reports/fullReport";
import { OFFER_MARKER, OFFER_UPGRADE_MARKER } from "@/lib/reports/offerSection";
import { offerContextFor } from "@/lib/reports/offerContext";
import { REPORT_CREDIT_TEXT, TIERS } from "@/lib/offer";
import { resetData, makeClinic } from "./helpers";

// SYNTHETIC data: an invented clinic. The report pages are opened as a clinic would open them (no cookies).

const SITE = "https://intheanswer.test";
const open = async (token: string) => {
  const res = await reportPage(new NextRequest(`${SITE}/r/${token}`, { headers: { "user-agent": "Mozilla/5.0 (test reader)" } }), { params: Promise.resolve({ token }) } as never);
  return { status: res.status, html: body(await res.text()) };
};
/** The page without its stylesheet and embedded fonts, so a failed check prints something a person can read. */
const body = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "");
const cardNames = (html: string) => [...html.matchAll(/<article class="rp-plan[^>]*>\s*<div class="rp-planhead"><h3 class="rp-planname">([^<]+)</g)].map((m) => m[1]);
const planLinks = (html: string) => [...html.matchAll(/class="(?:rp-btn|btn)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);

async function clinicWithTeaser(token: string, over: { verified?: boolean; superseded?: boolean; html?: (h: string) => string } = {}) {
  const sql = db();
  const clinicId = await makeClinic({ name: "Maple Grove Dental", domain: "maplegrove.example", website: "https://maplegrove.example/", status: "contacted" });
  const data = { ...sampleTeaser(), kind: "teaser" as const, clinic: { id: clinicId, name: "Maple Grove Dental", city: "Barrie", website: "https://maplegrove.example/", domain: "maplegrove.example" } };
  const html = (over.html ?? ((h: string) => h))(renderTeaser(data));
  await sql`insert into reports (clinic_id, kind, token, data, html, superseded)
            values (${clinicId}, 'teaser', ${token}, ${sql.json({ ...data, verified: over.verified ?? true } as never)}, ${html}, ${over.superseded ?? false})`;
  return { clinicId, data };
}

describe("the plans on a report page", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  it("are written in when the free report is opened, with the clinic's own checkout links, and never stored", async () => {
    const token = "teaser-token-0000001";
    await clinicWithTeaser(token);
    const { status, html } = await open(token);
    expect(status).toBe(200);
    expect(html).not.toContain(OFFER_MARKER);
    expect(cardNames(html)).toEqual([TIERS.report.name, TIERS.visibility.name, TIERS.growth.name]);
    expect(planLinks(html)).toEqual(["report", "visibility", "growth", "transformation"].map((k) => `${SITE}/buy/${token}/${k}`));
    expect(html).toContain("Three ways to fix it");
    expect(html).toContain("The full report covers all 6 confirmed findings.");
    expect(html).toContain("450 CAD");
    expect(html).toContain(REPORT_CREDIT_TEXT);
    // the stored report is still the marker: what is shown tomorrow is tomorrow's offer
    const [stored] = await db()<{ html: string }[]>`select html from reports where token=${token}`;
    expect(body(stored.html)).toContain(OFFER_MARKER);
    expect(body(stored.html)).not.toMatch(/[0-9]+ CAD|[/]buy[/]/);
  });

  it("leave out what the clinic already has", async () => {
    const token = "teaser-token-0000001";
    const { clinicId } = await clinicWithTeaser(token);
    await db()`insert into subscriptions (clinic_id, stripe_subscription_id, status, plan) values (${clinicId}, 'sub_1', 'active', 'visibility')`;
    const { html } = await open(token);
    expect(cardNames(html)).toEqual([TIERS.growth.name]);
    expect(planLinks(html)).toEqual([`${SITE}/buy/${token}/growth`, `${SITE}/buy/${token}/transformation`]);
    expect(html).toContain("One way to go further");
    expect(html).not.toContain(REPORT_CREDIT_TEXT);
    // a clinic still on a retired plan is treated as on the plan that replaced it
    await db()`update subscriptions set plan='monthly' where clinic_id=${clinicId}`;
    expect(cardNames((await open(token)).html)).toEqual([TIERS.growth.name]);
    // on the largest plan there is nothing to offer, and no empty section
    await db()`update subscriptions set plan='transformation' where clinic_id=${clinicId}`;
    const top = (await open(token)).html;
    expect(top).not.toMatch(/data-offer|rp-plansec/);
    expect(top).not.toContain(OFFER_MARKER);
  });

  it("replace the cards frozen into a report stored before the plans changed", async () => {
    const token = "teaser-token-0000001";
    const oldCards = `<section class="rp-band rp-plansec" aria-labelledby="plans-h"><div class="rp-wrap rp-stack">
  <article class="rp-plan"><h3 class="rp-planname">Monthly reports</h3><p class="rp-price">150 CAD</p><a class="rp-btn" href="${SITE}/buy/${token}/reports">Start monthly reports</a></article>
</div></section>`;
    await clinicWithTeaser(token, { html: (h) => h.replace(OFFER_MARKER, oldCards) });
    const { html } = await open(token);
    expect(html).not.toMatch(/\b150 CAD|Monthly reports|\/reports"/);
    expect(cardNames(html)).toEqual([TIERS.report.name, TIERS.visibility.name, TIERS.growth.name]);
  });

  it("a paid report closes with the plans above the report, linked through the clinic's teaser that passed the gate", async () => {
    const sql = db();
    const { clinicId, data } = await clinicWithTeaser("teaser-token-0000001");
    // a newer teaser that has not passed the gate cannot be bought from: it is not used
    await sql`insert into reports (clinic_id, kind, token, data, html, created_at) values (${clinicId}, 'teaser', 'teaser-token-0000002', ${sql.json({ verified: false })}, '', now() + interval '1 minute')`;
    await sql`insert into orders (clinic_id, kind, plan, status, amount_cents) values (${clinicId}, 'one_time', 'report', 'paid', 20000)`;
    const full = renderFullReport({
      clinic: { id: clinicId, name: data.clinic.name, city: "Barrie", domain: "maplegrove.example", placeId: null }, score: { recommended: 1, total: 6 }, testDate: "November 10, 2026",
      findings: [], siteTest: null, reviews: { level: "none", total: 4, average: null, count90d: null, replyRate: null, latest: null, themes: [] }, pages: [], firstDraft: null,
      structuredData: {}, kitHtml: null, regulatorNote: "",
    }, { web: true });
    expect(full).toContain(OFFER_UPGRADE_MARKER);
    await sql`insert into reports (clinic_id, kind, token, data, html) values (${clinicId}, 'full', 'full-token-000000001', ${sql.json({ kind: "full", verified: true })}, ${full})`;

    const { html } = await open("full-token-000000001");
    expect(html).not.toContain(OFFER_UPGRADE_MARKER);
    expect(planLinks(html)).toEqual(["visibility", "growth", "transformation"].map((k) => `${SITE}/buy/teaser-token-0000001/${k}`));
    expect(html).toContain("Growth: 450 CAD a month, plus 500 CAD setup, 6-month minimum, then month to month.");
    expect(html).toContain(REPORT_CREDIT_TEXT);
    expect(html).not.toMatch(/full service plan|\b150 CAD/i);

    expect(await offerContextFor({ clinicId })).toMatchObject({ buyBase: `${SITE}/buy/teaser-token-0000001`, site: SITE, has: "report" });
    // no teaser that passed the gate: the buttons go to the pricing page
    await sql`update reports set data = ${sql.json({ verified: false })} where token='teaser-token-0000001'`;
    expect(planLinks((await open("full-token-000000001")).html)).toEqual([`${SITE}/pricing`, `${SITE}/pricing`, `${SITE}/pricing`]);
  });

  it("the sample report shows the cards, with every button on the pricing page", async () => {
    const res = await samplePage();
    const html = body(await res.text());
    expect(res.status).toBe(200);
    expect(html).toContain("SAMPLE REPORT");
    expect(cardNames(html)).toEqual([TIERS.report.name, TIERS.visibility.name, TIERS.growth.name]);
    expect(planLinks(html)).toEqual([`${SITE}/pricing`, `${SITE}/pricing`, `${SITE}/pricing`, `${SITE}/pricing`]);
    expect(html).not.toContain(OFFER_MARKER);
    expect(html).not.toContain("/buy/");
  });
});
