import * as cheerio from "cheerio";

export interface ParsedPage {
  url: string;
  title: string;
  metaDescription: string | null;
  text: string; // visible text, whitespace-normalised
  homeTextLength: number;
  links: { href: string; text: string }[];
  emails: { email: string; context: string; viaMailto: boolean }[];
  jsonLd: { raw: string; parsed: unknown | null; types: string[] }[];
  hasMicrodata: boolean;
  h1: string[];
  /** Raw page facts used by the site test. */
  images: { src: string; alt: string | null }[];
  headings: { level: number; text: string }[];
  viewport: string | null;
  lang: string | null;
  /** http:// resources loaded by an https page (mixed content). */
  insecureResources: string[];
  telLinks: string[];
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g;
const JUNK_EMAIL_RE =
  /(\.(png|jpe?g|gif|webp|svg|css|js)$)|(^(example|email|name|your|user|test)@)|@(example\.(com|org)|domain\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|yourdomain\.com|email\.com)$/i;

export function normalizeSpace(s: string): string {
  return s.replace(/ /g, " ").replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

function typesOf(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => typesOf(n, out));
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    const t = o["@type"];
    if (typeof t === "string") out.push(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && out.push(x));
    if (o["@graph"]) typesOf(o["@graph"], out);
  }
  return out;
}

export function parsePage(url: string, html: string): ParsedPage {
  const $ = cheerio.load(html);

  const jsonLd: ParsedPage["jsonLd"] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    let parsed: unknown | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    jsonLd.push({ raw, parsed, types: parsed ? typesOf(parsed) : [] });
  });
  const hasMicrodata = $("[itemtype]").length > 0;
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[name="Description"]').attr("content")?.trim() ||
    null;
  const title = normalizeSpace($("title").first().text());

  const emails: ParsedPage["emails"] = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const addr = decodeURIComponent(href.replace(/^mailto:/i, "").split("?")[0]).trim();
    const ctx = normalizeSpace($(el).parent().text()).slice(0, 200);
    if (addr) emails.push({ email: addr, context: ctx, viaMailto: true });
  });

  const links: ParsedPage["links"] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    try {
      const abs = new URL(href, url).toString().split("#")[0];
      links.push({ href: abs, text: normalizeSpace($(el).text()).slice(0, 80) });
    } catch {
      /* ignore bad href */
    }
  });

  const h1 = $("h1")
    .map((_, el) => normalizeSpace($(el).text()))
    .get()
    .filter(Boolean);

  const images: ParsedPage["images"] = [];
  $("img").each((_, el) => {
    const raw = $(el).attr("src") ?? $(el).attr("data-src") ?? "";
    if (!raw || raw.startsWith("data:")) return;
    let src = raw;
    try {
      src = new URL(raw, url).toString();
    } catch {
      /* keep raw */
    }
    const alt = $(el).attr("alt");
    images.push({ src, alt: alt === undefined ? null : alt });
  });
  const headings: ParsedPage["headings"] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    headings.push({ level: Number(el.tagName.slice(1)), text: normalizeSpace($(el).text()).slice(0, 120) });
  });
  const viewport = $('meta[name="viewport"]').attr("content")?.trim() ?? null;
  const lang = $("html").attr("lang") ?? null;
  const insecureResources: string[] = [];
  if (url.startsWith("https://")) {
    $("img[src], script[src], iframe[src], source[src], video[src], audio[src], link[rel=stylesheet][href]").each((_, el) => {
      const v = $(el).attr("src") ?? $(el).attr("href") ?? "";
      if (/^http:\/\//i.test(v)) insecureResources.push(v);
    });
  }
  const telLinks = $('a[href^="tel:"]')
    .map((_, el) => $(el).attr("href") ?? "")
    .get();

  $("script, style, noscript, svg, template, iframe").remove();
  // keep line structure from block elements
  $("br").replaceWith("\n");
  $("p, div, li, h1, h2, h3, h4, h5, h6, tr, section, article, header, footer, address, dd, dt").each((_, el) => {
    $(el).append("\n");
  });
  const text = normalizeSpace($("body").text() || $.root().text());

  for (const m of text.matchAll(EMAIL_RE)) {
    const idx = m.index ?? 0;
    emails.push({ email: m[0], context: text.slice(Math.max(0, idx - 80), idx + m[0].length + 80).replace(/\n/g, " "), viaMailto: false });
  }

  const cleaned = emails
    .map((e) => ({ ...e, email: e.email.trim().toLowerCase().replace(/^[.]+|[.]+$/g, "") }))
    .filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(e.email) && !JUNK_EMAIL_RE.test(e.email));

  return {
    url, title, metaDescription, text, homeTextLength: text.length, links, emails: cleaned, jsonLd, hasMicrodata, h1,
    images, headings, viewport, lang, insecureResources, telLinks,
  };
}

/** Exact-substring evidence check, tolerant of whitespace and case. */
export function textContains(haystack: string, needle: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  const n = norm(needle);
  return n.length > 0 && norm(haystack).includes(n);
}

export const POSTAL_CODE_RE = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/i;
export const STREET_RE =
  /\b\d{1,6}[A-Za-z]?\s+(?:[A-Z][\w'.-]*\s){0,4}(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Drive|Dr\.?|Boulevard|Blvd\.?|Way|Lane|Ln\.?|Crescent|Cres\.?|Court|Ct\.?|Parkway|Pkwy|Highway|Hwy|Line|Place|Pl\.?|Trail|Square|Sq\.?|Circle|Terrace|Gate)\b/;
export const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;

/** Words that mark a page as relevant for the audit, used to pick which internal links to read. */
export const KEY_PAGE_HINTS = [
  "contact", "about", "team", "doctor", "dentist", "staff", "provider", "practitioner", "physician",
  "service", "fee", "price", "pricing", "cost", "insurance", "billing", "new-patient", "new patient",
  "patients", "hours", "location", "faq", "book", "appointment", "walk-in", "treatments", "menu",
];
