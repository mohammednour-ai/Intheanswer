/**
 * Runs our own audit and site checks against our own public site.
 *   BASE=http://localhost:3200 npx tsx scripts/selfcheck.ts
 * Exits 1 if any check needs work. Claude-based checks are replaced by simple
 * text tests for the same facts (hours, fees, who runs it, languages, areas).
 */
import { parsePage } from "../src/lib/site/parse";
import type { SiteRead } from "../src/lib/site/crawl";
import type { Crawl, CrawledPage } from "../src/lib/sitetest/crawl";
import { checkAddressOnHome, checkAiCrawlers, checkContactEmail, checkMetaDescription, checkStructuredData } from "../src/lib/pipeline/audit/deterministic";
import * as C from "../src/lib/sitetest/checks";
import { findContacts } from "../src/lib/pipeline/contact";
import { launchBrowser, measureMobile, runAxe } from "../src/lib/sitetest/browser";

const BASE = process.env.BASE ?? "http://localhost:3200";
const PUBLIC = "https://intheanswer.ca";
const PATHS = ["/", "/how-it-works", "/pricing", "/sample", "/contact", "/privacy", "/bot", "/unsubscribe"];

async function main() {
  const pages: CrawledPage[] = [];
  for (const p of PATHS) {
    const res = await fetch(BASE + p);
    const html = await res.text();
    // checks see the public address, not the local one
    pages.push({ ...parsePage(PUBLIC + p, html.replaceAll(BASE, PUBLIC)), depth: p === "/" ? 0 : 1, status: res.status, finalUrl: PUBLIC + p });
  }
  const robotsTxt = await (await fetch(BASE + "/robots.txt")).text();
  const sitemap = await fetch(BASE + "/sitemap.xml");
  const site: SiteRead = { website: PUBLIC + "/", domain: "intheanswer.ca", home: pages[0], pages, failures: [], readable: true };
  const crawl: Crawl = { website: PUBLIC + "/", domain: "intheanswer.ca", home: pages[0], homeRedirectedToHttps: true, pages,
    statuses: new Map(pages.map((p) => [p.url, { status: p.status, foundOn: ["(start)"] }])), notVisited: [], robotsTxt, robotsStatus: 200, cap: 40 };
  const contact = findContacts(site);

  const browser = await launchBrowser();
  const render = await measureMobile(browser, BASE + "/");
  const axe = await runAxe(browser, PATHS.slice(0, 5).map((p) => BASE + p));
  await browser.close();

  const all = pages.map((p) => p.text).join("\n");
  const fact = (key: string, re: RegExp, what: string) => ({ key, result: re.test(all) ? "found" : "not_found", summary: what, isGap: !re.test(all) });
  const audit = [
    checkMetaDescription(site), checkStructuredData(site), checkAddressOnHome(site),
    checkContactEmail(site, contact.primary), checkAiCrawlers(site, robotsTxt),
    fact("hours", /Monday to Friday, 9:00 am to 5:00 pm/, "hours stated in text"),
    fact("fees", /200 CAD/, "prices stated in text"),
    fact("practitioners", /is run by /, "who runs the service is named"),
    fact("languages", /Service in English/, "language stated"),
    fact("areas_served", /across Ontario/, "area served stated"),
    fact("no_solicitation_free", /^(?![\s\S]*no solicitations)/i, "no accidental no-solicitation wording"),
  ];
  const siteChecks = [
    C.checkBookingPath(crawl), C.checkMobileLayout(crawl, render), C.checkRealText(crawl, render), C.checkAccessibility(axe.violations, axe.tested),
    C.checkAiBots(crawl), C.checkMixedContent(pages), C.checkAltText(pages), C.checkTitlesDescriptions(pages), C.checkHeadingOrder(pages),
    C.checkRobotsSitemap(crawl, { url: PUBLIC + "/sitemap.xml", status: sitemap.status }),
  ];
  let bad = 0;
  for (const a of audit) {
    const ok = !a.isGap && a.result !== "could_not_verify";
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  audit:${a.key}  ${a.summary}`);
  }
  for (const s of siteChecks) {
    // "no images" is not a failure for alt text
    const ok = s.result === "pass" || (s.key === "alt_text" && s.result === "could_not_test");
    if (!ok) bad++;
    console.log(`${ok ? "PASS" : "FAIL"}  site:${s.key}  ${s.line}`);
    if (!ok) s.evidence.slice(0, 4).forEach((e) => console.log(`        ${e.url ?? ""} ${e.label ?? e.quote ?? ""}`));
  }
  console.log(bad ? `\n${bad} check(s) need work` : "\nall checks pass");
  process.exit(bad ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
