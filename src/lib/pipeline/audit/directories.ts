import { readWithWebFetch, type UsageLike } from "../../adapters/claude";
import { textContains } from "../../site/parse";
import { namesMatch } from "../match";
import type { CheckOutcome } from "./types";

/**
 * Name consistency across the directories that appeared in step 3.
 * Claude fetches those directory pages (web fetch, restricted to their
 * domains) and quotes the clinic's listing. Before any inconsistency is
 * reported, a listing must pass two checks:
 * - every quote is found in the document fetched for the URL the model
 *   attributes it to (never in some other fetched page);
 * - that listing is tied to this clinic: its own domain or the phone number
 *   confirmed on its site appears in the same document, close to the quoted
 *   name (a directory page can list many businesses).
 * Anything else is "could not verify", never a finding.
 */

export const DIRECTORY_DOMAINS = [
  "yelp.ca", "yelp.com", "ratemds.com", "opencare.com", "yellowpages.ca", "411.ca", "cylex.ca", "canpages.ca",
  "doctorsdirectory.ca", "dentistry.ca", "cdho.org", "rcdso.org", "cpso.on.ca", "facebook.com", "healthgrades.com",
  "zocdoc.com", "findadentist.ca", "ontariodentists.com", "bbb.org", "tripadvisor.ca", "threebestrated.ca",
  "medimap.ca", "cortico.ca", "clinicfinder.ca", "mapquest.com", "foursquare.com", "nicelocal.ca", "birdeye.com",
  "fresha.com", "treatwell.ca", "booksy.com", "vagaro.com", "realself.com",
];

export function isDirectory(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return DIRECTORY_DOMAINS.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
}

interface Listing {
  url: string;
  name_quote: string | null;
  address_quote: string | null;
  phone_quote: string | null;
}

function parseListings(text: string): Listing[] {
  const m = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/(\[[\s\S]*\])/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[1]);
    return Array.isArray(v) ? (v as Listing[]) : [];
  } catch {
    return [];
  }
}

const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const postal = (s: string) => (s.match(/[A-Z]\d[A-Z] ?\d[A-Z]\d/i)?.[0] ?? "").replace(/\s/g, "").toUpperCase();
const streetNo = (s: string) => s.match(/\b\d{1,6}[A-Z]?\b/i)?.[0] ?? "";

/** Same page, ignoring scheme, www, a trailing slash and any fragment. */
export function sameDocUrl(a: string, b: string): boolean {
  const key = (x: string) => {
    try {
      const u = new URL(x);
      return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    } catch {
      return null;
    }
  };
  const ka = key(a);
  return ka !== null && ka === key(b);
}

const flat = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ");
/** How far from the quoted name the clinic's domain or phone may be and still count as the same listing. */
const LISTING_WINDOW = 800;

/**
 * True when the clinic's own domain or its confirmed phone number appears in
 * the document within LISTING_WINDOW characters of the quoted name.
 */
export function listingIsClinics(docText: string, nameQuote: string, domain: string, sitePhone: string | null): boolean {
  const text = flat(docText);
  const name = flat(nameQuote).trim();
  if (!name) return false;
  const anchors: number[] = [];
  const dom = domain.toLowerCase().replace(/^www\./, "");
  if (dom) {
    // the domain as a whole host name, not as the tail of another one (notmaplegrove.example)
    const re = new RegExp(`(?<![a-z0-9-])${dom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`, "g");
    for (const m of text.matchAll(re)) anchors.push(m.index);
  }
  const phone = sitePhone ? digits(sitePhone) : "";
  if (phone.length === 10) {
    for (const m of text.matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g)) {
      if (digits(m[0]) === phone) anchors.push(m.index);
    }
  }
  if (!anchors.length) return false;
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    if (anchors.some((a) => Math.abs(a - at) <= LISTING_WINDOW)) return true;
  }
  return false;
}

export async function checkDirectories(opts: {
  clinicName: string;
  siteName: string | null;
  sitePhone: string | null;
  siteAddress: string | null;
  domain: string;
  city: string;
  directoryUrls: string[];
}): Promise<{ outcome: CheckOutcome; usage: UsageLike | null; costUsd: number }> {
  const urls = [...new Set(opts.directoryUrls)].slice(0, 5);
  if (urls.length === 0) {
    return {
      outcome: {
        key: "directory_consistency", result: "could_not_verify", isGap: false, severity: 0,
        summary: "No directory pages appeared in the assistant's sources for this city.",
        evidence: [],
      },
      usage: null,
      costUsd: 0,
    };
  }
  const prompt = `Fetch each URL below. On each page, find the listing for the clinic "${opts.siteName ?? opts.clinicName}" (website ${opts.domain}) in ${opts.city}, Ontario.
For each page where it is listed, copy exactly as written on that page: its name, its address and its phone number (null if not shown).
Reply with only a JSON array in a \`\`\`json block: [{"url": "...", "name_quote": "...", "address_quote": "...", "phone_quote": "..."}]. Use [] if it is not listed on any page. Do not guess.`;
  const r = await readWithWebFetch(prompt, urls);
  if (r.incomplete) {
    return {
      outcome: {
        key: "directory_consistency", result: "could_not_verify", isGap: false, severity: 0,
        summary: `The directory pages could not be read (the reading stopped early: ${r.incomplete}).`,
        evidence: urls.map((u) => ({ kind: "directory_quote" as const, url: u, label: "page not read" })),
      },
      usage: r.usage,
      costUsd: r.costUsd,
    };
  }
  const listings = parseListings(r.text).filter((l) => l && typeof l.url === "string" && urls.some((u) => sameDocUrl(u, l.url)));
  // Only the document fetched for that exact page counts; no fallback to other pages.
  const docText = (u: string) => r.docs.find((d) => sameDocUrl(d.url, u))?.text ?? "";
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const verified = listings
    .map((l) => {
      const doc = docText(l.url);
      const q = (v: unknown) => {
        const s = str(v);
        return s && doc && textContains(doc, s) ? s : null;
      };
      return { url: l.url, doc, name_quote: q(l.name_quote), address_quote: q(l.address_quote), phone_quote: q(l.phone_quote) };
    })
    .filter((l) => l.name_quote && listingIsClinics(l.doc, l.name_quote, opts.domain, opts.sitePhone));

  if (verified.length === 0) {
    return {
      outcome: {
        key: "directory_consistency", result: "could_not_verify", isGap: false, severity: 0,
        summary: `The clinic's listing could not be confirmed on the ${urls.length} directory page(s) the assistant used.`,
        evidence: urls.map((u) => ({ kind: "directory_quote" as const, url: u, label: "page read, listing not confirmed" })),
      },
      usage: r.usage,
      costUsd: r.costUsd,
    };
  }

  const diffs: { url: string; what: string; theirs: string; ours: string }[] = [];
  const ourName = opts.siteName ?? opts.clinicName;
  for (const l of verified) {
    if (l.name_quote && !namesMatch(ourName, l.name_quote, opts.city)) diffs.push({ url: l.url, what: "name", theirs: l.name_quote, ours: ourName });
    if (l.phone_quote && opts.sitePhone && digits(l.phone_quote) && digits(l.phone_quote) !== digits(opts.sitePhone))
      diffs.push({ url: l.url, what: "phone", theirs: l.phone_quote, ours: opts.sitePhone });
    if (l.address_quote && opts.siteAddress) {
      const pa = postal(l.address_quote), pb = postal(opts.siteAddress);
      const sa = streetNo(l.address_quote), sb = streetNo(opts.siteAddress);
      if ((pa && pb && pa !== pb) || (sa && sb && sa !== sb)) diffs.push({ url: l.url, what: "address", theirs: l.address_quote, ours: opts.siteAddress });
    }
  }
  const evidence = verified.map((l) => ({
    kind: "directory_quote" as const,
    url: l.url,
    quote: [l.name_quote, l.address_quote, l.phone_quote].filter(Boolean).join(" | "),
  }));
  if (diffs.length === 0) {
    return {
      outcome: {
        key: "directory_consistency", result: "not_found", isGap: false, severity: 0,
        summary: `Name, address and phone match on the ${verified.length} directory listing(s) checked.`,
        evidence,
      },
      usage: r.usage,
      costUsd: r.costUsd,
    };
  }
  const d = diffs[0];
  const host = new URL(d.url).hostname.replace(/^www\./, "");
  return {
    outcome: {
      key: "directory_consistency", result: "found", isGap: true, severity: 85,
      summary: `${diffs.length} difference(s) between your site and directory listings the assistant used.`,
      evidence: [
        ...evidence,
        ...diffs.map((x) => ({ kind: "directory_quote" as const, url: x.url, label: `${x.what}: directory "${x.theirs}" vs site "${x.ours}"` })),
      ],
      findingText: `The ${d.what} on ${host}, a directory the assistant used, reads "${d.theirs}". Your site gives "${d.ours}".`,
    },
    usage: r.usage,
    costUsd: r.costUsd,
  };
}
