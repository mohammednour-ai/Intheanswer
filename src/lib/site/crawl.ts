import { fetchPage, siteDomain } from "../adapters/http";
import { parsePage, KEY_PAGE_HINTS, type ParsedPage } from "./parse";

export interface SiteRead {
  website: string;
  domain: string;
  home: ParsedPage | null;
  pages: ParsedPage[]; // includes home first
  failures: { url: string; reason: string }[];
  readable: boolean; // false if the site renders almost no text server-side
}

const SKIP_RE = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|mp4|mov)(\?|$)|\/(wp-admin|wp-login|cart|checkout|account|feed|tag|category|author)\b/i;

function score(link: { href: string; text: string }): number {
  const s = (link.href + " " + link.text).toLowerCase();
  let n = 0;
  for (const h of KEY_PAGE_HINTS) if (s.includes(h)) n++;
  return n;
}

/**
 * Read the clinic's own site: the home page plus the most relevant internal
 * pages linked from it (never guessed URLs). Respects robots.txt via fetchPage.
 */
export async function readSite(website: string, maxPages = 12): Promise<SiteRead> {
  const domain = siteDomain(website);
  const failures: SiteRead["failures"] = [];
  const homeFetch = await fetchPage(website);
  if (!homeFetch.robotsAllowed || homeFetch.status !== 200 || !homeFetch.body) {
    failures.push({ url: website, reason: homeFetch.error ?? `HTTP ${homeFetch.status}` });
    return { website, domain, home: null, pages: [], failures, readable: false };
  }
  const home = parsePage(homeFetch.finalUrl, homeFetch.body);
  const pages: ParsedPage[] = [home];

  const seen = new Set<string>([normalizeUrl(home.url), normalizeUrl(website)]);
  const candidates = home.links
    .filter((l) => {
      try {
        return siteDomain(l.href) === domain && !SKIP_RE.test(l.href);
      } catch {
        return false;
      }
    })
    .map((l) => ({ ...l, s: score(l) }))
    .filter((l) => l.s > 0)
    .sort((a, b) => b.s - a.s);

  for (const c of candidates) {
    if (pages.length >= maxPages) break;
    const key = normalizeUrl(c.href);
    if (seen.has(key)) continue;
    seen.add(key);
    const f = await fetchPage(c.href);
    if (!f.robotsAllowed || f.status !== 200 || !f.body || !/html/i.test(f.contentType || "text/html")) {
      failures.push({ url: c.href, reason: f.error ?? `HTTP ${f.status}` });
      continue;
    }
    pages.push(parsePage(f.finalUrl, f.body));
  }
  const readable = home.text.length >= 300;
  return { website, domain, home, pages, failures, readable };
}

function normalizeUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = "";
    let p = x.pathname.replace(/\/+$/, "");
    if (!p) p = "/";
    return `${x.hostname.replace(/^www\./, "")}${p}${x.search}`;
  } catch {
    return u;
  }
}
