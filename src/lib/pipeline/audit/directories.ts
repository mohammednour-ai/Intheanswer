import { readWithWebFetch, type UsageLike } from "../../adapters/claude";
import { textContains } from "../../site/parse";
import { namesMatch } from "../match";
import type { CheckOutcome } from "./types";

/**
 * Name consistency across the directories that appeared in step 3.
 * Claude fetches those directory pages (web fetch, restricted to their
 * domains) and quotes the clinic's listing. Quotes are verified against the
 * fetched documents before any inconsistency is reported.
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
  const listings = parseListings(r.text);
  const docText = (u: string) => r.docs.find((d) => d.url === u)?.text ?? r.docs.map((d) => d.text).join("\n");
  const verified = listings
    .map((l) => ({
      ...l,
      name_quote: l.name_quote && textContains(docText(l.url), l.name_quote) ? l.name_quote : null,
      address_quote: l.address_quote && textContains(docText(l.url), l.address_quote) ? l.address_quote : null,
      phone_quote: l.phone_quote && textContains(docText(l.url), l.phone_quote) ? l.phone_quote : null,
    }))
    .filter((l) => l.name_quote);

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
