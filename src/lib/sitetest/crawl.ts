import { fetchPage, siteDomain, getRobots } from "../adapters/http";
import { parsePage, type ParsedPage } from "../site/parse";

/**
 * Breadth-first crawl of the clinic's own site for the site test.
 * Polite: robots.txt respected (inside fetchPage), one request per host every
 * few seconds, a hard page cap (default 40), same site only, pages cached.
 */

export interface CrawledPage extends ParsedPage {
  depth: number;
  status: number;
  finalUrl: string;
}

export interface Crawl {
  website: string;
  domain: string;
  home: CrawledPage | null;
  homeRedirectedToHttps: boolean | null;
  pages: CrawledPage[];
  /** Internal URLs we requested and their status (0 = could not be requested). */
  statuses: Map<string, { status: number; reason?: string; foundOn: string[] }>;
  /** Internal links found but not fetched because the cap was reached. */
  notVisited: string[];
  robotsTxt: string;
  robotsStatus: number;
  cap: number;
}

const SKIP_RE = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|mp4|mov|ics)(\?|$)|\/(wp-admin|wp-login|cart|checkout|account|feed|wp-json)\b|[?&](replytocom|share|print)=/i;

export function normalize(u: string): string {
  const x = new URL(u);
  x.hash = "";
  let p = x.pathname.replace(/\/+$/, "") || "/";
  p = p.replace(/\/index\.(html?|php)$/i, "") || "/";
  return `${x.protocol}//${x.hostname.replace(/^www\./, "")}${p}${x.search}`;
}

export async function crawlSite(website: string, cap = 40): Promise<Crawl> {
  const domain = siteDomain(website);
  const origin = new URL(website).origin;
  const robots = await getRobots(origin);
  const statuses: Crawl["statuses"] = new Map();
  const pages: CrawledPage[] = [];
  const queue: { url: string; depth: number; from: string }[] = [{ url: website, depth: 0, from: "(start)" }];
  const seen = new Set<string>([normalize(website)]);
  const notVisited: string[] = [];

  while (queue.length) {
    const next = queue.shift()!;
    if (pages.length >= cap) {
      notVisited.push(next.url);
      continue;
    }
    const f = await fetchPage(next.url);
    const key = normalize(next.url);
    const prev = statuses.get(key);
    statuses.set(key, {
      status: f.robotsAllowed ? f.status : 0,
      reason: f.robotsAllowed ? f.error : "disallowed by robots.txt",
      foundOn: [...(prev?.foundOn ?? []), next.from],
    });
    if (!f.robotsAllowed || f.status !== 200 || !f.body || !/html/i.test(f.contentType || "text/html")) continue;
    const parsed = parsePage(f.finalUrl, f.body);
    const page: CrawledPage = { ...parsed, depth: next.depth, status: f.status, finalUrl: f.finalUrl };
    pages.push(page);
    for (const l of parsed.links) {
      let host: string;
      try {
        host = siteDomain(l.href);
      } catch {
        continue;
      }
      if (host !== domain || SKIP_RE.test(l.href)) continue;
      const k = normalize(l.href);
      if (seen.has(k)) {
        const st = statuses.get(k);
        if (st && !st.foundOn.includes(page.url)) st.foundOn.push(page.url);
        continue;
      }
      seen.add(k);
      queue.push({ url: l.href, depth: next.depth + 1, from: page.url });
    }
  }

  const home = pages.find((p) => p.depth === 0) ?? null;
  let homeRedirectedToHttps: boolean | null = null;
  if (home) {
    if (website.startsWith("http://")) homeRedirectedToHttps = home.finalUrl.startsWith("https://");
    else homeRedirectedToHttps = home.finalUrl.startsWith("https://") ? true : false;
  }
  return { website, domain, home, homeRedirectedToHttps, pages, statuses, notVisited, robotsTxt: robots.txt, robotsStatus: robots.status, cap };
}
