import { describe, expect, it } from "vitest";
import { parsePage } from "@/lib/site/parse";
import type { Crawl, CrawledPage } from "@/lib/sitetest/crawl";
import * as C from "@/lib/sitetest/checks";

// SYNTHETIC pages for an invented clinic.
function page(url: string, html: string, depth = 0): CrawledPage {
  return { ...parsePage(url, html), depth, status: 200, finalUrl: url };
}
function crawl(pages: CrawledPage[], over: Partial<Crawl> = {}): Crawl {
  const statuses = new Map(pages.map((p) => [p.url, { status: 200, foundOn: ["(start)"] }]));
  return { website: "https://x.example/", domain: "x.example", home: pages[0] ?? null, homeRedirectedToHttps: true, pages, statuses, notVisited: [], robotsTxt: "User-agent: *\nDisallow: /admin\nSitemap: https://x.example/sitemap.xml", robotsStatus: 200, cap: 40, ...over };
}
const HOME = (body: string, head = '<meta name="viewport" content="width=device-width, initial-scale=1"><title>X</title><meta name="description" content="d">') =>
  `<html><head>${head}</head><body>${body}</body></html>`;
const render = (o: Partial<C.RenderMetrics> = {}): C.RenderMetrics => ({
  url: "https://x.example/", viewport: { width: 390, height: 844 }, scrollWidth: 390, innerWidth: 390, textElements: 100, smallTextElements: 2,
  smallTextExamples: [], tapTargets: 30, smallTapTargets: 0, smallTapExamples: [], renderedTextLength: 2000, ...o,
});

describe("booking path within two taps", () => {
  it("passes with a tap-to-call link on the home page", () => {
    expect(C.checkBookingPath(crawl([page("https://x.example/", HOME('<a href="tel:7055550100">Call</a>'))])).result).toBe("pass");
  });
  it("passes with a booking link one page away", () => {
    const c = crawl([page("https://x.example/", HOME('<a href="/contact">Contact</a>')), page("https://x.example/contact", HOME('<a href="https://x.janeapp.com">Book online</a>'), 1)]);
    expect(C.checkBookingPath(c)).toMatchObject({ result: "pass" });
  });
  it("needs work when neither is reachable, could not test when nothing was read", () => {
    const c = crawl([page("https://x.example/", HOME('<a href="/about">About</a>')), page("https://x.example/about", HOME("<p>About us</p>"), 1)]);
    expect(C.checkBookingPath(c)).toMatchObject({ result: "needs_work" });
    expect(C.checkBookingPath(crawl([])).result).toBe("could_not_test");
  });
});

describe("links and images", () => {
  it("only a real 404/410 counts as broken; unreachable is not tested", () => {
    const c = crawl([page("https://x.example/", HOME("<p>hi</p>"))]);
    c.statuses.set("https://x.example/old", { status: 404, foundOn: ["https://x.example/"] });
    const r = C.checkBrokenLinks(c, [{ url: "https://other.example/", status: 0, reason: "blocked", foundOn: "https://x.example/" }]);
    expect(r).toMatchObject({ result: "needs_work", metrics: { broken: 1, untested: 1 } });
    const ok = C.checkBrokenLinks(crawl([page("https://x.example/", HOME("<p>hi</p>"))]), [{ url: "https://o.example", status: 0, foundOn: "" }]);
    expect(ok.result).toBe("pass");
    expect(C.checkBrokenImages([{ url: "i", status: 0, foundOn: "p" }]).result).toBe("could_not_test");
    expect(C.checkBrokenImages([{ url: "i", status: 410, foundOn: "p" }]).result).toBe("needs_work");
  });
});

describe("content checks", () => {
  it("titles and descriptions, alt text, heading order", () => {
    const a = page("https://x.example/", HOME('<h1>A</h1><h3>skip</h3><img src="/a.png"><img src="/b.png" alt="">', "<title>Same</title>"));
    const b = page("https://x.example/b", HOME("<h1>B</h1><h2>ok</h2>", "<title>Same</title>"), 1);
    expect(C.checkTitlesDescriptions([a, b])).toMatchObject({ result: "needs_work", metrics: { noDesc: 2, duplicateTitles: 1 } });
    expect(C.checkAltText([a, b])).toMatchObject({ result: "needs_work", metrics: { images: 2, missing: 1 } });
    // a skipped level alone is counted but not reported; a missing main heading is
    expect(C.checkHeadingOrder([a, b])).toMatchObject({ result: "pass", metrics: { withIssues: 0, withSkippedLevels: 1 } });
    const noH1 = page("https://x.example/c", HOME("<h2>Only a sub heading</h2>"), 1);
    expect(C.checkHeadingOrder([a, noH1])).toMatchObject({ result: "needs_work", metrics: { withIssues: 1 } });
    expect(C.headingProblems([1, 2, 3, 2])).toEqual([]);
    expect(C.headingProblems([2, 3])).toEqual(["no main heading (h1)"]);
  });
});

describe("crawlability", () => {
  it("robots and sitemap", () => {
    const c = crawl([page("https://x.example/", HOME("<p>x</p>"))]);
    expect(C.checkRobotsSitemap(c, null).result).toBe("pass");
    expect(C.checkRobotsSitemap({ ...c, robotsTxt: "User-agent: *\nDisallow:" }, { url: "u", status: 404 }).result).toBe("needs_work");
    expect(C.checkRobotsSitemap({ ...c, robotsTxt: "User-agent: *\nDisallow: /" }, null).result).toBe("needs_work");
    expect(C.checkRobotsSitemap({ ...c, robotsStatus: 0 }, null).result).toBe("could_not_test");
  });
  it("AI crawlers: real blocks only", () => {
    const c = crawl([page("https://x.example/", HOME("<p>x</p>"))]);
    expect(C.checkAiBots({ ...c, robotsTxt: "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow:" }).result).toBe("needs_work");
    expect(C.checkAiBots({ ...c, robotsTxt: "User-agent: GPTBot\nUser-agent: *\nDisallow: /config" }).result).toBe("pass");
  });
  it("real text vs script-rendered", () => {
    const c = crawl([page("https://x.example/", HOME("<p>short</p>"))]);
    expect(C.checkRealText(c, render({ renderedTextLength: 3000 })).result).toBe("needs_work");
    expect(C.checkRealText(crawl([page("https://x.example/", HOME("<p>" + "word ".repeat(400) + "</p>"))]), render({ renderedTextLength: 2100 })).result).toBe("pass");
    expect(C.checkRealText(c, null).result).toBe("could_not_test");
  });
});

describe("security", () => {
  it("https, redirect and mixed content", () => {
    const c = crawl([page("https://x.example/", HOME('<img src="http://cdn.example/a.png">'))]);
    expect(C.checkHttps(c, { finalUrl: "https://x.example/", status: 200 }).result).toBe("pass");
    expect(C.checkHttps(c, { finalUrl: "http://x.example/", status: 200 }).result).toBe("needs_work");
    expect(C.checkMixedContent(c.pages)).toMatchObject({ result: "needs_work" });
    const http = crawl([{ ...page("http://x.example/", HOME("<p>x</p>")), finalUrl: "http://x.example/" }]);
    expect(C.checkHttps(http, null).result).toBe("needs_work");
  });
});

describe("mobile layout", () => {
  const c = crawl([page("https://x.example/", HOME("<p>x</p>"))]);
  it("passes when it fits, needs work on overflow, small text or tap targets", () => {
    expect(C.checkMobileLayout(c, render()).result).toBe("pass");
    expect(C.checkMobileLayout(c, render({ scrollWidth: 600 })).line).toMatch(/wider than the screen/);
    expect(C.checkMobileLayout(c, render({ smallTextElements: 40 })).line).toMatch(/smaller than 12px/);
    expect(C.checkMobileLayout(c, render({ smallTapTargets: 7 })).line).toMatch(/24 by 24/);
  });
  it("without a render it can only flag a missing viewport; otherwise could not test", () => {
    expect(C.checkMobileLayout(c, null).result).toBe("could_not_test");
    const noVp = crawl([page("https://x.example/", HOME("<p>x</p>", "<title>X</title>"))]);
    expect(C.checkMobileLayout(noVp, null).result).toBe("needs_work");
  });
});

describe("accessibility (automated subset)", () => {
  it("is always labelled as automated checks, not a full audit", () => {
    const r = C.checkAccessibility([{ id: "color-contrast", impact: "serious", help: "Elements must meet minimum color contrast ratio thresholds", nodes: 12, pages: ["https://x.example/"] }], ["https://x.example/"]);
    expect(r.result).toBe("needs_work");
    expect(r.line).toContain("automated checks, not a full accessibility audit");
    expect(r.findingText).toContain("automated checks, not a full accessibility audit");
    expect(C.checkAccessibility(null, []).line).toContain("not a full accessibility audit");
    expect(C.checkAccessibility([], ["u"]).line).toContain("not a full accessibility audit");
  });
});

describe("speed", () => {
  const base: C.PerfResult = { source: "lighthouse_local", strategy: "mobile", url: "https://x.example/", score: 0.9, lab: { lcpMs: 2000, cls: 0.02, tbtMs: 100, fcpMs: 900 }, field: null, fetchedAt: "2026-11-11T00:00:00Z" };
  it("uses Google's thresholds and names the source", () => {
    expect(C.checkSpeed(base, "mobile").result).toBe("pass");
    const slow = C.checkSpeed({ ...base, lab: { ...base.lab, lcpMs: 3900 } }, "mobile");
    expect(slow.result).toBe("needs_work");
    expect(slow.findingText).toMatch(/3\.9 s.*Lighthouse lab test/);
    expect(C.checkSpeed({ ...base, source: "pagespeed", field: { category: "SLOW", lcpMs: 4100, inpMs: 150, cls: 0.05 } }, "mobile").findingText).toMatch(/real visitors/);
    expect(C.checkSpeed(null, "desktop").result).toBe("could_not_test");
  });
  it("sorts needs work by patient impact, could not test last", () => {
    const s = C.sortByImpact([
      { key: "a", category: "content", result: "could_not_test", impact: 99, line: "", evidence: [] },
      { key: "b", category: "content", result: "needs_work", impact: 40, line: "", evidence: [] },
      { key: "c", category: "content", result: "needs_work", impact: 90, line: "", evidence: [] },
      { key: "d", category: "content", result: "pass", impact: 100, line: "", evidence: [] },
    ]);
    expect(s.map((x) => x.key)).toEqual(["c", "b", "d", "a"]);
  });
  it("could-not-test checks never carry a finding sentence", () => {
    const c = crawl([]);
    for (const r of [C.checkBookingPath(c), C.checkRealText(c, null), C.checkSpeed(null, "mobile"), C.checkAccessibility(null, [])]) {
      expect(r.result).toBe("could_not_test");
      expect(r.findingText).toBeUndefined();
    }
  });
});
