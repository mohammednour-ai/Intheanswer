import robotsParser from "robots-parser";
import type { Crawl, CrawledPage } from "./crawl";
import { normalize } from "./crawl";
import { AI_AGENTS } from "../pipeline/audit/deterministic";
import { A11Y_LABEL, IMPACT, type SiteCheck } from "./types";
import type { Evidence } from "../pipeline/audit/types";

/**
 * Site test checks. Each returns pass / needs_work / could_not_test with
 * evidence and one plain line. "could not test" is used whenever a fact could
 * not be established; it is never worded as a problem.
 */

const BOOKING_RE =
  /\b(book|booking|appointment|schedule|request a visit|reserve)\b|janeapp\.com|jane\.app|cortico\.|ocean\.cognisantmd|zocdoc|medeo\.|cliniko|vagaro|fresha|booksy|squareup\.com\/appointments|acuityscheduling|calendly|dentrix|nexhealth|localmed/i;
const PHONE_TEXT_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

const cnt = (key: string, category: SiteCheck["category"], line: string, evidence: Evidence[] = []): SiteCheck => ({
  key, category, result: "could_not_test", impact: IMPACT[key] ?? 0, line, evidence,
});
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[], n = 3) => xs.slice(0, n).join(", ") + (xs.length > n ? ` and ${xs.length - n} more` : "");

// ---------------------------------------------------------------------------
export function checkBookingPath(c: Crawl): SiteCheck {
  const key = "booking_path";
  if (!c.home) return cnt(key, "booking", "The home page could not be read, so the path to booking could not be tested.");
  const isBooking = (l: { href: string; text: string }) => BOOKING_RE.test(l.href) || BOOKING_RE.test(l.text);
  const homeBook = c.home.links.find(isBooking);
  if (c.home.telLinks.length || homeBook) {
    const ev: Evidence[] = [];
    if (c.home.telLinks.length) ev.push({ kind: "raw_source", url: c.home.url, quote: c.home.telLinks[0], label: "tap-to-call link on the home page" });
    if (homeBook) ev.push({ kind: "raw_source", url: c.home.url, quote: `${homeBook.text || "(link)"} -> ${homeBook.href}`, label: "booking link on the home page" });
    return { key, category: "booking", result: "pass", impact: IMPACT[key], line: "A booking link or tap-to-call phone number is on the home page (one tap).", evidence: ev };
  }
  const level1 = c.pages.filter((p) => p.depth === 1);
  const second = level1.find((p) => p.telLinks.length || p.links.some(isBooking));
  if (second) {
    return {
      key, category: "booking", result: "pass", impact: IMPACT[key],
      line: "Booking or a tap-to-call number is one link away from the home page (two taps).",
      evidence: [{ kind: "raw_source", url: second.url, label: second.telLinks.length ? `tap-to-call: ${second.telLinks[0]}` : "booking link on this page" }],
    };
  }
  const phoneText = c.home.text.match(PHONE_TEXT_RE);
  if (phoneText) {
    return {
      key, category: "booking", result: "pass", impact: IMPACT[key],
      line: `The phone number appears as text on the home page ("${phoneText[0]}"), though not as a tap-to-call link.`,
      evidence: [{ kind: "page_quote", url: c.home.url, quote: phoneText[0] }],
      metrics: { tapToCall: false },
    };
  }
  if (level1.length === 0) return cnt(key, "booking", "No pages linked from the home page could be read, so the second tap could not be tested.");
  return {
    key, category: "booking", result: "needs_work", impact: IMPACT[key],
    line: "No booking link or phone number was found on the home page or the pages it links to.",
    findingText: `From your home page and the ${plural(level1.length, "page")} it links to, we did not find a booking link or a phone number a patient can tap.`,
    evidence: [{ kind: "pages_read", label: [c.home.url, ...level1.map((p) => p.url)].join(" ") }],
  };
}

// ---------------------------------------------------------------------------
export interface Probe {
  url: string;
  status: number;
  reason?: string;
  foundOn: string;
}

const isBroken = (s: number) => s === 404 || s === 410;

export function checkBrokenLinks(c: Crawl, external: Probe[]): SiteCheck {
  const key = "broken_links";
  const internal: Probe[] = [...c.statuses.entries()].map(([u, v]) => ({ url: u, status: v.status, reason: v.reason, foundOn: v.foundOn[0] ?? "" }));
  const all = [...internal, ...external];
  const tested = all.filter((p) => p.status > 0);
  const broken = tested.filter((p) => isBroken(p.status));
  const untested = all.length - tested.length;
  if (tested.length === 0) return cnt(key, "links", "No links could be tested.");
  if (broken.length) {
    return {
      key, category: "links", result: "needs_work", impact: IMPACT[key],
      line: `${plural(broken.length, "link")} returned "not found" out of ${tested.length} tested.`,
      findingText: `${plural(broken.length, "link")} on your site ${broken.length === 1 ? "leads" : "lead"} to a "page not found" error, for example ${broken[0].url} (linked from ${broken[0].foundOn}).`,
      evidence: broken.slice(0, 10).map((b) => ({ kind: "raw_source" as const, url: b.foundOn, label: `link to ${b.url} returned HTTP ${b.status}` })),
      metrics: { tested: tested.length, broken: broken.length, untested },
    };
  }
  return {
    key, category: "links", result: "pass", impact: IMPACT[key],
    line: `All ${tested.length} links tested responded${untested ? ` (${untested} could not be tested)` : ""}.`,
    evidence: [], metrics: { tested: tested.length, broken: 0, untested },
  };
}

export function checkBrokenImages(probes: Probe[]): SiteCheck {
  const key = "broken_images";
  const tested = probes.filter((p) => p.status > 0);
  if (tested.length === 0) return cnt(key, "links", probes.length ? "Images could not be requested, so they could not be tested." : "No images were found on the pages read.");
  const broken = tested.filter((p) => isBroken(p.status));
  if (broken.length) {
    return {
      key, category: "links", result: "needs_work", impact: IMPACT[key],
      line: `${plural(broken.length, "image")} did not load (not found) out of ${tested.length} tested.`,
      findingText: `${plural(broken.length, "image")} on your site ${broken.length === 1 ? "does" : "do"} not load, for example ${broken[0].url} on ${broken[0].foundOn}.`,
      evidence: broken.slice(0, 10).map((b) => ({ kind: "raw_source" as const, url: b.foundOn, label: `image ${b.url} returned HTTP ${b.status}` })),
      metrics: { tested: tested.length, broken: broken.length },
    };
  }
  return { key, category: "links", result: "pass", impact: IMPACT[key], line: `All ${tested.length} images tested loaded.`, evidence: [], metrics: { tested: tested.length } };
}

// ---------------------------------------------------------------------------
export function checkTitlesDescriptions(pages: CrawledPage[]): SiteCheck {
  const key = "titles_descriptions";
  if (!pages.length) return cnt(key, "content", "No pages could be read.");
  const noTitle = pages.filter((p) => !p.title);
  const noDesc = pages.filter((p) => !p.metaDescription);
  const titleCounts = new Map<string, number>();
  pages.forEach((p) => p.title && titleCounts.set(p.title, (titleCounts.get(p.title) ?? 0) + 1));
  const dupes = [...titleCounts.entries()].filter(([, n]) => n > 1);
  if (!noTitle.length && !noDesc.length && !dupes.length) {
    return { key, category: "content", result: "pass", impact: IMPACT[key], line: `All ${pages.length} pages read have a title and a description.`, evidence: [] };
  }
  const parts = [
    noTitle.length ? `${plural(noTitle.length, "page")} without a title` : "",
    noDesc.length ? `${plural(noDesc.length, "page")} without a description` : "",
    dupes.length ? `${plural(dupes.length, "title")} used on more than one page` : "",
  ].filter(Boolean);
  return {
    key, category: "content", result: "needs_work", impact: IMPACT[key],
    line: `Of ${pages.length} pages read: ${parts.join("; ")}.`,
    findingText: `Of the ${pages.length} pages we read, ${parts.join("; ")}. Search tools and assistants use these to describe each page.`,
    evidence: [
      ...noTitle.slice(0, 5).map((p) => ({ kind: "raw_source" as const, url: p.url, label: "no <title>" })),
      ...noDesc.slice(0, 5).map((p) => ({ kind: "raw_source" as const, url: p.url, label: "no meta description" })),
      ...dupes.slice(0, 3).map(([t, n]) => ({ kind: "raw_source" as const, quote: t, label: `title used on ${n} pages` })),
    ],
    metrics: { pages: pages.length, noTitle: noTitle.length, noDesc: noDesc.length, duplicateTitles: dupes.length },
  };
}

export function checkAltText(pages: CrawledPage[]): SiteCheck {
  const key = "alt_text";
  const imgs = new Map<string, { src: string; alt: string | null; url: string }>();
  pages.forEach((p) => p.images.forEach((i) => imgs.has(i.src) || imgs.set(i.src, { ...i, url: p.url })));
  if (!imgs.size) return cnt(key, "accessibility", "No images were found on the pages read.");
  const missing = [...imgs.values()].filter((i) => i.alt === null);
  if (!missing.length) return { key, category: "accessibility", result: "pass", impact: IMPACT[key], line: `All ${imgs.size} images have an alt attribute.`, evidence: [] };
  return {
    key, category: "accessibility", result: "needs_work", impact: IMPACT[key],
    line: `${missing.length} of ${imgs.size} images have no alt attribute.`,
    findingText: `${missing.length} of the ${imgs.size} images on your site have no text description (alt text), so screen readers and assistants cannot tell what they show.`,
    evidence: missing.slice(0, 8).map((m) => ({ kind: "raw_source" as const, url: m.url, label: `image without alt: ${m.src}` })),
    metrics: { images: imgs.size, missing: missing.length },
  };
}

export function headingProblems(levels: number[]): string[] {
  const out: string[] = [];
  const h1 = levels.filter((l) => l === 1).length;
  if (h1 === 0) out.push("no main heading (h1)");
  if (h1 > 1) out.push(`${h1} main headings (h1)`);
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) {
      out.push(`heading level jumps from h${levels[i - 1]} to h${levels[i]}`);
      break;
    }
  }
  return out;
}

export function checkHeadingOrder(pages: CrawledPage[]): SiteCheck {
  const key = "heading_order";
  if (!pages.length) return cnt(key, "accessibility", "No pages could be read.");
  const bad = pages.map((p) => ({ p, issues: headingProblems(p.headings.map((h) => h.level)) })).filter((x) => x.issues.length);
  if (!bad.length) return { key, category: "accessibility", result: "pass", impact: IMPACT[key], line: `Headings are in order on all ${pages.length} pages read.`, evidence: [] };
  return {
    key, category: "accessibility", result: "needs_work", impact: IMPACT[key],
    line: `${bad.length} of ${pages.length} pages have heading order problems.`,
    findingText: `${bad.length} of the ${pages.length} pages we read have headings out of order (for example ${bad[0].issues[0]} on ${bad[0].p.url}).`,
    evidence: bad.slice(0, 8).map((b) => ({ kind: "raw_source" as const, url: b.p.url, label: b.issues.join("; ") })),
    metrics: { pages: pages.length, withIssues: bad.length },
  };
}

// ---------------------------------------------------------------------------
export function checkRobotsSitemap(c: Crawl, sitemap: { url: string; status: number } | null): SiteCheck {
  const key = "crawl_robots_sitemap";
  const robotsUrl = new URL("/robots.txt", c.website).toString();
  if (c.robotsStatus === 0) return cnt(key, "crawlability", "robots.txt could not be requested.");
  const robots = robotsParser(robotsUrl, c.robotsTxt || "");
  const blocksAll = c.robotsTxt ? robots.isAllowed(new URL("/", c.website).toString(), "Googlebot") === false : false;
  const declared = robots.getSitemaps();
  const hasSitemap = declared.length > 0 || (sitemap?.status ?? 0) === 200;
  const ev: Evidence[] = [{ kind: "robots", url: robotsUrl, label: c.robotsTxt ? `robots.txt present (HTTP ${c.robotsStatus})` : `no robots.txt (HTTP ${c.robotsStatus})` }];
  if (declared.length) ev.push({ kind: "robots", url: robotsUrl, quote: `Sitemap: ${declared[0]}` });
  else if (sitemap) ev.push({ kind: "raw_source", url: sitemap.url, label: `HTTP ${sitemap.status}` });
  if (blocksAll) {
    return { key, category: "crawlability", result: "needs_work", impact: IMPACT[key], line: "robots.txt asks search engines not to read the home page.",
      findingText: "Your robots.txt asks search engines not to read your home page.", evidence: ev };
  }
  if (!hasSitemap && sitemap && sitemap.status === 0) return cnt(key, "crawlability", "The sitemap could not be requested.", ev);
  if (!hasSitemap) {
    return { key, category: "crawlability", result: "needs_work", impact: IMPACT[key], line: "No sitemap was found (none listed in robots.txt and none at /sitemap.xml).",
      findingText: "We did not find a sitemap for your site (none listed in robots.txt and none at /sitemap.xml).", evidence: ev };
  }
  return { key, category: "crawlability", result: "pass", impact: IMPACT[key], line: "robots.txt allows search engines and a sitemap is available.", evidence: ev };
}

export function checkAiBots(c: Crawl): SiteCheck {
  const key = "crawl_ai_bots";
  const robotsUrl = new URL("/robots.txt", c.website).toString();
  if (c.robotsStatus === 0) return cnt(key, "crawlability", "robots.txt could not be requested.");
  if (!c.robotsTxt) return { key, category: "crawlability", result: "pass", impact: IMPACT[key], line: "No robots.txt, so no AI crawler is asked to stay away.", evidence: [{ kind: "robots", url: robotsUrl, label: "no robots.txt" }] };
  const robots = robotsParser(robotsUrl, c.robotsTxt);
  const home = new URL("/", c.website).toString();
  const blocked = AI_AGENTS.filter((a) => robots.isAllowed(home, a) === false);
  if (!blocked.length) return { key, category: "crawlability", result: "pass", impact: IMPACT[key], line: "robots.txt allows the main AI crawlers.", evidence: [{ kind: "robots", url: robotsUrl, label: `checked: ${AI_AGENTS.join(", ")}` }] };
  return {
    key, category: "crawlability", result: "needs_work", impact: IMPACT[key],
    line: `robots.txt asks these AI crawlers not to read the site: ${blocked.join(", ")}.`,
    findingText: `Your robots.txt asks these AI crawlers not to read your site: ${blocked.join(", ")}.`,
    evidence: [{ kind: "robots", url: robotsUrl, label: `disallowed for: ${blocked.join(", ")}` }],
  };
}

export interface RenderMetrics {
  url: string;
  viewport: { width: number; height: number };
  scrollWidth: number;
  innerWidth: number;
  textElements: number;
  smallTextElements: number;
  smallTextExamples: string[];
  tapTargets: number;
  smallTapTargets: number;
  smallTapExamples: string[];
  renderedTextLength: number;
}

export function checkRealText(c: Crawl, render: RenderMetrics | null): SiteCheck {
  const key = "crawl_real_text";
  if (!c.home) return cnt(key, "crawlability", "The home page could not be read.");
  if (!render) return cnt(key, "crawlability", "The home page could not be rendered in a browser, so script-only content could not be tested.");
  const raw = c.home.text.length;
  const rendered = render.renderedTextLength;
  const ratio = rendered > 0 ? raw / rendered : 1;
  const ev: Evidence[] = [{ kind: "raw_source", url: c.home.url, label: `text in the page source: ${raw} characters; after scripts run: ${rendered} characters` }];
  if (rendered >= 400 && ratio < 0.3) {
    return {
      key, category: "crawlability", result: "needs_work", impact: IMPACT[key],
      line: `Most home page text only appears after scripts run (${raw} of ${rendered} characters are in the page source).`,
      findingText: `Most of the text on your home page only appears after scripts run in a browser (${raw} of ${rendered} characters are in the page source). Tools that read the source see little of it.`,
      evidence: ev, metrics: { raw, rendered },
    };
  }
  return { key, category: "crawlability", result: "pass", impact: IMPACT[key], line: "The home page's text is in the page source, not only added by scripts.", evidence: ev, metrics: { raw, rendered } };
}

// ---------------------------------------------------------------------------
export function checkHttps(c: Crawl, httpProbe: { finalUrl: string; status: number } | null): SiteCheck {
  const key = "https";
  if (!c.home) return cnt(key, "security", "The home page could not be read.");
  const ev: Evidence[] = [{ kind: "raw_source", url: c.home.finalUrl, label: `home page served at ${c.home.finalUrl}` }];
  if (!c.home.finalUrl.startsWith("https://")) {
    return { key, category: "security", result: "needs_work", impact: IMPACT[key], line: "The home page is served without HTTPS.",
      findingText: `Your home page is served without HTTPS (${c.home.finalUrl}); browsers mark it "Not secure".`, evidence: ev };
  }
  if (httpProbe && httpProbe.status > 0 && !httpProbe.finalUrl.startsWith("https://")) {
    ev.push({ kind: "raw_source", url: httpProbe.finalUrl, label: "http:// address does not redirect to https://" });
    return { key, category: "security", result: "needs_work", impact: IMPACT[key], line: "The site uses HTTPS, but the http:// address does not redirect to it.",
      findingText: "Your site uses HTTPS, but the plain http:// address does not redirect to the secure one.", evidence: ev };
  }
  return { key, category: "security", result: "pass", impact: IMPACT[key], line: "The site is served over HTTPS.", evidence: ev };
}

export function checkMixedContent(pages: CrawledPage[]): SiteCheck {
  const key = "mixed_content";
  const https = pages.filter((p) => p.finalUrl.startsWith("https://"));
  if (!https.length) return cnt(key, "security", "No HTTPS pages were read.");
  const hits = https.flatMap((p) => p.insecureResources.map((r) => ({ page: p.url, r })));
  if (!hits.length) return { key, category: "security", result: "pass", impact: IMPACT[key], line: `No insecure (http://) resources on the ${https.length} HTTPS pages read.`, evidence: [] };
  return {
    key, category: "security", result: "needs_work", impact: IMPACT[key],
    line: `${plural(hits.length, "resource")} on HTTPS pages load over insecure http://.`,
    findingText: `${plural(hits.length, "file")} on your secure pages still load over insecure http:// (for example ${hits[0].r}).`,
    evidence: hits.slice(0, 8).map((h) => ({ kind: "raw_source" as const, url: h.page, quote: h.r })),
  };
}

// ---------------------------------------------------------------------------
export function checkMobileLayout(c: Crawl, render: RenderMetrics | null): SiteCheck {
  const key = "mobile_layout";
  if (!c.home) return cnt(key, "mobile", "The home page could not be read.");
  const vp = c.home.viewport;
  const vpOk = !!vp && /width\s*=\s*device-width/i.test(vp);
  if (!render) {
    if (!vpOk) {
      return { key, category: "mobile", result: "needs_work", impact: IMPACT[key], line: "The home page has no mobile viewport setting.",
        findingText: "Your home page has no mobile viewport setting, so phones show a shrunken desktop page.",
        evidence: [{ kind: "raw_source", url: c.home.url, label: vp ? `viewport: ${vp}` : "no <meta name=viewport>" }] };
    }
    return cnt(key, "mobile", "The page could not be rendered on a simulated phone, so layout could not be tested.", [{ kind: "raw_source", url: c.home.url, quote: vp ?? "" }]);
  }
  const issues: string[] = [];
  if (!vpOk) issues.push("no mobile viewport setting");
  const overflow = render.scrollWidth - render.innerWidth;
  if (overflow > 4) issues.push(`the page is ${overflow}px wider than the screen (sideways scrolling)`);
  const smallShare = render.textElements ? render.smallTextElements / render.textElements : 0;
  if (smallShare > 0.25) issues.push(`${Math.round(smallShare * 100)}% of text is smaller than 12px`);
  if (render.smallTapTargets >= 5) issues.push(`${render.smallTapTargets} buttons or links are smaller than 24 by 24 pixels`);
  const ev: Evidence[] = [
    { kind: "raw_source", url: c.home.url, label: `rendered at ${render.viewport.width}x${render.viewport.height}; viewport meta: ${vp ?? "none"}` },
    ...render.smallTapExamples.slice(0, 3).map((t) => ({ kind: "raw_source" as const, url: c.home!.url, label: `small tap target: ${t}` })),
  ];
  const metrics = { overflow, smallTextShare: smallShare, smallTapTargets: render.smallTapTargets, tapTargets: render.tapTargets, viewport: vp };
  if (!issues.length) return { key, category: "mobile", result: "pass", impact: IMPACT[key], line: "On a simulated phone the home page fits the screen with readable text and tap targets.", evidence: ev, metrics };
  return {
    key, category: "mobile", result: "needs_work", impact: IMPACT[key],
    line: `On a simulated phone (${render.viewport.width}px wide): ${issues.join("; ")}.`,
    findingText: `On a simulated phone ${render.viewport.width} pixels wide, your home page has ${issues.join("; ")}.`,
    evidence: ev, metrics,
  };
}

// ---------------------------------------------------------------------------
export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: number;
  pages: string[];
}

export function checkAccessibility(violations: AxeViolation[] | null, pagesTested: string[]): SiteCheck {
  const key = "accessibility";
  if (!violations) return cnt(key, "accessibility", `Accessibility could not be tested in a browser (${A11Y_LABEL}).`);
  const ev: Evidence[] = [{ kind: "pages_read", label: `tested: ${pagesTested.join(" ")}` }];
  if (!violations.length) {
    return { key, category: "accessibility", result: "pass", impact: IMPACT[key],
      line: `No issues found by automated WCAG 2.0 AA checks on ${plural(pagesTested.length, "page")} (${A11Y_LABEL}).`, evidence: ev };
  }
  const order = { critical: 0, serious: 1, moderate: 2, minor: 3 } as Record<string, number>;
  const sorted = [...violations].sort((a, b) => (order[a.impact ?? "minor"] ?? 4) - (order[b.impact ?? "minor"] ?? 4) || b.nodes - a.nodes);
  return {
    key, category: "accessibility", result: "needs_work", impact: IMPACT[key],
    line: `Automated WCAG 2.0 AA checks found ${plural(violations.length, "type")} of issue (${A11Y_LABEL}): ${list(sorted.map((v) => v.help))}.`,
    findingText: `Automated WCAG 2.0 AA checks (${A11Y_LABEL}) found ${plural(violations.length, "type")} of issue on your site, for example: ${sorted[0].help.toLowerCase()} (${plural(sorted[0].nodes, "element")}).`,
    evidence: [...sorted.slice(0, 8).map((v) => ({ kind: "raw_source" as const, url: v.pages[0], label: `${v.id} (${v.impact ?? "n/a"}): ${v.help}; ${plural(v.nodes, "element")}` })), ...ev],
    metrics: { violations: violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes })) },
  };
}

// ---------------------------------------------------------------------------
export interface PerfResult {
  source: "pagespeed" | "lighthouse_local";
  strategy: "mobile" | "desktop";
  url: string;
  score: number | null;
  lab: { lcpMs: number | null; cls: number | null; tbtMs: number | null; fcpMs: number | null };
  field: { category: string | null; lcpMs: number | null; inpMs: number | null; cls: number | null } | null;
  fetchedAt: string;
}

/** Google's published "good" thresholds: LCP 2.5 s, CLS 0.1, INP 200 ms; TBT 200 ms is Lighthouse's lab proxy. */
export function checkSpeed(perf: PerfResult | null, strategy: "mobile" | "desktop"): SiteCheck {
  const key = strategy === "mobile" ? "speed_mobile" : "speed_desktop";
  if (!perf) return cnt(key, "speed", `Speed on ${strategy} could not be measured.`);
  const sourceLabel = perf.source === "pagespeed" ? "PageSpeed Insights" : "a Lighthouse lab test run from our server";
  const issues: string[] = [];
  const f = perf.field;
  if (f && f.lcpMs != null && f.lcpMs > 2500) issues.push(`real visitors' main content took ${(f.lcpMs / 1000).toFixed(1)} s to appear (good is 2.5 s or less)`);
  if (f && f.inpMs != null && f.inpMs > 200) issues.push(`real visitors waited ${f.inpMs} ms for the page to respond to taps (good is 200 ms or less)`);
  if (f && f.cls != null && f.cls > 0.1) issues.push(`real visitors saw the layout shift (score ${f.cls}; good is 0.1 or less)`);
  const l = perf.lab;
  if (l.lcpMs != null && l.lcpMs > 2500) issues.push(`in the lab test the main content took ${(l.lcpMs / 1000).toFixed(1)} s to appear (good is 2.5 s or less)`);
  if (l.cls != null && l.cls > 0.1) issues.push(`in the lab test the layout shifted (score ${l.cls.toFixed(2)}; good is 0.1 or less)`);
  if (l.tbtMs != null && l.tbtMs > 200) issues.push(`in the lab test the page was busy for ${Math.round(l.tbtMs)} ms before it could respond (good is 200 ms or less)`);
  const ev: Evidence[] = [{ kind: "raw_source", url: perf.url, label: `${sourceLabel}, ${strategy}, ${perf.fetchedAt.slice(0, 10)}; score ${perf.score ?? "n/a"}; LCP ${l.lcpMs ?? "n/a"} ms, CLS ${l.cls ?? "n/a"}, TBT ${l.tbtMs ?? "n/a"} ms${f ? `; field: ${f.category ?? "n/a"}` : "; no real-visitor (field) data"}` }];
  const metrics = { ...perf };
  if (!issues.length) {
    return { key, category: "speed", result: "pass", impact: IMPACT[key], line: `The home page meets Google's speed guidance on ${strategy} (${sourceLabel}).`, evidence: ev, metrics };
  }
  return {
    key, category: "speed", result: "needs_work", impact: IMPACT[key],
    line: `On ${strategy}, ${issues[0]} (${sourceLabel}).`,
    findingText: `On a ${strategy === "mobile" ? "simulated phone" : "desktop"}, ${issues[0]} (${sourceLabel} of your home page).`,
    evidence: ev, metrics,
  };
}

/** Sort for reports: needs work first, by patient impact; could-not-test last. */
export function sortByImpact(checks: SiteCheck[]): SiteCheck[] {
  const rank = { needs_work: 0, pass: 1, could_not_test: 2 } as const;
  return [...checks].sort((a, b) => rank[a.result] - rank[b.result] || b.impact - a.impact);
}

export { normalize };
