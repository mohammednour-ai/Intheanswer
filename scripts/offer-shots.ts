/**
 * Pictures of the plan section of a report, for looking at it after a change
 * to src/lib/offer.ts or src/lib/reports/offerSection.ts. Needs no database
 * and no running site: the sample report is rendered here.
 *
 *   npx tsx --env-file-if-exists=.env.local scripts/offer-shots.ts
 *
 * Writes output/shots/offer-section/: the section at phone, tablet and desktop
 * width for a clinic that has nothing yet, for one that has the report and for
 * one on Visibility; the "next step" block of a paid report; and the sample
 * report as a PDF (the cards as they are printed). Says so when a page scrolls
 * sideways. output/ is not committed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { launchBrowser } from "../src/lib/sitetest/browser";
import { htmlToPdf } from "../src/lib/reports/pdf";
import { sampleTeaser } from "../src/lib/reports/sample";
import { renderTeaser } from "../src/lib/reports/renderTeaser";
import { renderFullReport, type FullReportData } from "../src/lib/reports/fullReport";
import { fillOffer, type OfferContext } from "../src/lib/reports/offerSection";
import { LIVE_REVIEWS_MARKER } from "../src/lib/reviews/liveTable";
import { DEFAULT_SWITCHES } from "../src/lib/offer";
import { env } from "../src/lib/env";

const OUT = path.join("output", "shots", "offer-section");
const WIDTHS = [390, 768, 1280];
type Png = `${string}.png`;

const site = env().APP_URL.replace(/\/+$/, "");
const sample = sampleTeaser();
const ctx = (over: Partial<OfferContext> = {}): OfferContext => ({ buyBase: null, site, findingsTotal: sample.findingsTotal, has: null, switches: DEFAULT_SWITCHES, ...over });
const teaser = (c: OfferContext) => fillOffer(renderTeaser(sample).replace(LIVE_REVIEWS_MARKER, ""), c);

const full: FullReportData = {
  clinic: { id: "sample", name: sample.clinic.name, city: sample.clinic.city, domain: sample.clinic.domain, placeId: null },
  score: { recommended: sample.score.recommended, total: sample.score.total },
  testDate: "a sample date",
  findings: sample.findings.map((f) => ({ key: f.checkKey, label: f.title, seen: f.text, fix: "A fix file for this finding.", evidence: [] })),
  siteTest: null, reviews: null, pages: [], firstDraft: null, structuredData: { "@type": "Dentist", name: sample.clinic.name }, kitHtml: null,
  regulatorNote: sample.sector.regulatorNote,
};

const PAGES: { name: string; html: string; only: string }[] = [
  { name: "teaser-new", html: teaser(ctx()), only: "section[data-offer]" },
  { name: "teaser-has-report", html: teaser(ctx({ has: "report", buyBase: `${site}/buy/sample-token-000000` })), only: "section[data-offer]" },
  { name: "teaser-has-visibility", html: teaser(ctx({ has: "visibility", buyBase: `${site}/buy/sample-token-000000` })), only: "section[data-offer]" },
  { name: "full-next-step", html: fillOffer(renderFullReport(full, { web: true }).replace(LIVE_REVIEWS_MARKER, ""), ctx({ has: "report", buyBase: `${site}/buy/sample-token-000000` })), only: "section[data-offer]" },
];

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await launchBrowser();
  let sideways = 0;
  try {
    for (const p of PAGES) {
      for (const width of WIDTHS) {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
          await page.setContent(p.html, { waitUntil: "load" });
          await page.evaluate("document.fonts.ready");
          const over = (await page.evaluate("document.documentElement.scrollWidth - window.innerWidth")) as number;
          if (over > 0) sideways++;
          const el = await page.$(p.only);
          if (!el) throw new Error(`${p.name}: no plan section in the page`);
          const file = path.join(OUT, `${p.name}-${width}.png`) as Png;
          await el.screenshot({ path: file });
          console.log(`${file}${over > 0 ? `   SCROLLS SIDEWAYS by ${over}px` : ""}`);
        } finally {
          await page.close();
        }
      }
    }
    // the whole sample report once, at phone width, to see the section in its place
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 1 });
    await page.setContent(PAGES[0].html, { waitUntil: "load" });
    await page.screenshot({ path: path.join(OUT, "teaser-new-whole-390.png") as Png, fullPage: true });
    await page.close();
  } finally {
    await browser.close();
  }
  await fs.writeFile(path.join(OUT, "teaser-new.pdf"), await htmlToPdf(PAGES[0].html));
  console.log(path.join(OUT, "teaser-new.pdf"));
  if (sideways) {
    console.log(`\n${sideways} page(s) scroll sideways`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
