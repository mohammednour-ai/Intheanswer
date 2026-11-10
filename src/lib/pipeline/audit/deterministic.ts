import robotsParser from "robots-parser";
import type { SiteRead } from "../../site/crawl";
import { POSTAL_CODE_RE, STREET_RE } from "../../site/parse";
import type { CheckOutcome } from "./types";

/**
 * Checks that need no model: they read the raw HTML, robots.txt and the
 * contact record. Every result carries its evidence.
 */

const BUSINESS_TYPES = new Set([
  "Dentist", "MedicalClinic", "MedicalBusiness", "Physician", "LocalBusiness", "MedicalOrganization",
  "HealthAndBeautyBusiness", "DaySpa", "BeautySalon", "Optician", "Hospital", "DiagnosticLab", "HealthClub",
]);

function host(site: SiteRead) {
  return site.domain;
}

export function checkMetaDescription(site: SiteRead): CheckOutcome {
  const home = site.home!;
  const d = home.metaDescription;
  if (d && d.length >= 50) {
    return {
      key: "meta_description", result: "found", isGap: false, severity: 0,
      summary: "The home page has a page description.",
      evidence: [{ kind: "raw_source", url: home.url, quote: d.slice(0, 300) }],
    };
  }
  if (d) {
    return {
      key: "meta_description", result: "found", isGap: true, severity: 35,
      summary: `The home page description is only ${d.length} characters long.`,
      evidence: [{ kind: "raw_source", url: home.url, quote: d }],
      findingText: `The page description in your home page source is ${d.length} characters long ("${d}"). It does not say who you are, where you are or what you offer.`,
    };
  }
  return {
    key: "meta_description", result: "not_found", isGap: true, severity: 40,
    summary: "No page description was found in the home page source.",
    evidence: [{ kind: "raw_source", url: home.url, label: "no meta description tag in the HTML" }],
    findingText: `Your home page source has no page description (the short summary search tools and assistants show for a page).`,
  };
}

export function checkStructuredData(site: SiteRead): CheckOutcome {
  const blocks = site.pages.flatMap((p) => p.jsonLd.map((j) => ({ url: p.url, ...j })));
  const business = blocks.filter((b) => b.types.some((t) => BUSINESS_TYPES.has(t)));
  if (business.length) {
    const b = business[0];
    return {
      key: "structured_data", result: "found", isGap: false, severity: 0,
      summary: `Structured data describing the business (${[...new Set(b.types)].join(", ")}) is in the page source.`,
      evidence: [{ kind: "raw_source", url: b.url, quote: b.raw.slice(0, 400) }],
    };
  }
  const pagesRead = site.pages.map((p) => p.url);
  if (blocks.length) {
    const types = [...new Set(blocks.flatMap((b) => b.types))].join(", ") || "unparsed";
    return {
      key: "structured_data", result: "not_found", isGap: true, severity: 62,
      summary: `The page source has structured data (${types}) but none that describes the clinic as a local business.`,
      evidence: [{ kind: "raw_source", url: blocks[0].url, quote: blocks[0].raw.slice(0, 300) }, { kind: "pages_read", label: pagesRead.join(" ") }],
      findingText: `The structured data in your page source describes the site (${types}) but not the clinic itself: no business type, address, phone or hours in machine-readable form.`,
    };
  }
  return {
    key: "structured_data", result: "not_found", isGap: true, severity: 65,
    summary: `No structured data (JSON-LD) was found in the source of the ${site.pages.length} pages read.`,
    evidence: [{ kind: "pages_read", label: pagesRead.join(" ") }],
    findingText: `None of the ${site.pages.length} pages we read on ${host(site)} contain structured data (JSON-LD) describing the clinic, its address, phone or hours in machine-readable form.`,
  };
}

export function checkAddressOnHome(site: SiteRead): CheckOutcome {
  const home = site.home!;
  const m = home.text.match(POSTAL_CODE_RE) ?? home.text.match(STREET_RE);
  if (m) {
    const i = m.index ?? 0;
    const quote = home.text.slice(Math.max(0, i - 60), i + m[0].length + 20).replace(/\n/g, " ").trim();
    return {
      key: "address_on_home", result: "found", isGap: false, severity: 0,
      summary: "The street address or postal code appears in the home page text.",
      evidence: [{ kind: "page_quote", url: home.url, quote }],
    };
  }
  if (!site.readable) {
    return {
      key: "address_on_home", result: "could_not_verify", isGap: false, severity: 0,
      summary: "The home page renders too little text to check for an address.",
      evidence: [{ kind: "pages_read", url: home.url }],
    };
  }
  return {
    key: "address_on_home", result: "not_found", isGap: true, severity: 50,
    summary: "No street address or postal code was found in the home page text.",
    evidence: [{ kind: "pages_read", url: home.url, label: "home page text checked for a street address and a postal code" }],
    findingText: `Your home page text does not include your street address or postal code (an address shown only in an image or a map is not read as text).`,
  };
}

export function checkContactEmail(site: SiteRead, primary: { email: string; sourceUrl: string; onOwnDomain: boolean } | null): CheckOutcome {
  if (!primary) {
    return {
      key: "contact_email_own_domain", result: "not_found", isGap: false, severity: 0,
      summary: "No email address is published on the pages read.",
      evidence: [{ kind: "pages_read", label: site.pages.map((p) => p.url).join(" ") }],
    };
  }
  if (primary.onOwnDomain) {
    return {
      key: "contact_email_own_domain", result: "found", isGap: false, severity: 0,
      summary: `The published contact email (${primary.email}) is on the clinic's own domain.`,
      evidence: [{ kind: "contact", url: primary.sourceUrl, quote: primary.email }],
    };
  }
  return {
    key: "contact_email_own_domain", result: "not_found", isGap: true, severity: 20,
    summary: `The published contact email (${primary.email}) uses a different domain from the website (${site.domain}).`,
    evidence: [{ kind: "contact", url: primary.sourceUrl, quote: primary.email }],
    findingText: `The contact email on your site (${primary.email}) uses a different domain from your website (${site.domain}).`,
  };
}

/** AI crawlers named here are the ones assistants use to read and cite pages. */
export const AI_AGENTS = ["ClaudeBot", "Claude-SearchBot", "Claude-User", "GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Google-Extended"];

export function checkAiCrawlers(site: SiteRead, robotsTxt: string): CheckOutcome {
  const robotsUrl = new URL("/robots.txt", site.website).toString();
  if (!robotsTxt) {
    return {
      key: "ai_crawlers", result: "found", isGap: false, severity: 0,
      summary: "There is no robots.txt, so no crawler is asked to stay away.",
      evidence: [{ kind: "robots", url: robotsUrl, label: "no robots.txt" }],
    };
  }
  const robots = robotsParser(robotsUrl, robotsTxt);
  const home = new URL("/", site.website).toString();
  const blocked = AI_AGENTS.filter((a) => robots.isAllowed(home, a) === false);
  if (blocked.length === 0) {
    return {
      key: "ai_crawlers", result: "found", isGap: false, severity: 0,
      summary: "robots.txt allows the main AI crawlers to read the home page.",
      evidence: [{ kind: "robots", url: robotsUrl, label: `checked: ${AI_AGENTS.join(", ")}` }],
    };
  }
  return {
    key: "ai_crawlers", result: "not_found", isGap: true, severity: 88,
    summary: `robots.txt asks these AI crawlers not to read the site: ${blocked.join(", ")}.`,
    evidence: [{ kind: "robots", url: robotsUrl, label: `disallowed for: ${blocked.join(", ")}` }],
    findingText: `Your robots.txt asks these AI crawlers not to read your site: ${blocked.join(", ")}.`,
  };
}
