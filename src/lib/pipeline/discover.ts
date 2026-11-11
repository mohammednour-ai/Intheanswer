import { db } from "../db";
import type { JobContext } from "../jobs/queue";
import { PermanentJobError } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { textSearch, PLACES_COST_PER_REQUEST_USD, type Place } from "../adapters/places";
import { siteDomain } from "../adapters/http";

/**
 * Step 1: discover clinics for one (sector, city).
 * Skips chains and businesses without a website of their own.
 * Stores place_id permanently; other Places fields are kept with
 * places_fetched_at and purged after 30 days (see purge_places_data).
 */

/** Hosts that are not a clinic's own website. */
const NOT_OWN_SITE = [
  "facebook.com", "instagram.com", "linktr.ee", "linkedin.com", "twitter.com", "x.com", "tiktok.com",
  "google.com", "business.site", "sites.google.com", "goo.gl", "g.page",
  "janeapp.com", "jane.app", "cliniko.com", "medeo.ca", "ocean.cognisantmd.com", "booking.com",
  "yelp.ca", "yelp.com", "ratemds.com", "yellowpages.ca", "411.ca", "opencare.com", "doctorsdirectory.ca",
  "wixsite.com", "square.site", "godaddysites.com", "mystrikingly.com", "weebly.com",
];

export interface DiscoverDecision {
  include: boolean;
  reason: string;
  domain?: string;
}

export function decidePlace(p: Place, chainPatterns: string[], domainCounts: Map<string, number>, cityName: string): DiscoverDecision {
  const name = p.displayName?.text ?? "";
  if (p.businessStatus && p.businessStatus !== "OPERATIONAL") return { include: false, reason: `business status ${p.businessStatus}` };
  if (!p.websiteUri) return { include: false, reason: "no website" };
  let domain: string;
  try {
    domain = siteDomain(p.websiteUri);
  } catch {
    return { include: false, reason: "invalid website" };
  }
  if (NOT_OWN_SITE.some((h) => domain === h || domain.endsWith("." + h))) return { include: false, reason: `website is not its own (${domain})` };
  const hay = `${name} ${domain}`.toLowerCase();
  const chain = chainPatterns.find((c) => hay.includes(c.toLowerCase()));
  if (chain) return { include: false, reason: `chain (${chain})` };
  if ((domainCounts.get(domain) ?? 0) > 1) return { include: false, reason: `shares website ${domain} with other locations (chain)` };
  try {
    const path = new URL(p.websiteUri).pathname;
    // a location page on a group site (e.g. brand.com/locations/barrie) indicates a multi-location group
    if (/\/(locations?|clinics?|offices?)\/[^/]+/i.test(path)) return { include: false, reason: "location page of a multi-location group" };
  } catch {
    /* ignore */
  }
  if (p.formattedAddress && !p.formattedAddress.toLowerCase().includes(cityName.toLowerCase()) && !/\bON\b/.test(p.formattedAddress)) {
    return { include: false, reason: "outside Ontario or city" };
  }
  return { include: true, reason: "ok", domain };
}

async function handleDiscover(ctx: JobContext) {
  const { sectorId, cityId } = ctx.job.payload as { sectorId: number; cityId: number };
  const sql = db();
  const [t] = await sql<{ query: string; included_type: string | null; city: string; lat: number | null; lng: number | null; radius_m: number }[]>`
    select replace(s.places_query, '{city}', c.name) as query, s.places_included_type as included_type,
           c.name as city, c.lat, c.lng, c.radius_m
    from sectors s, cities c where s.id = ${sectorId} and c.id = ${cityId}`;
  if (!t) throw new PermanentJobError("unknown sector/city");
  const res = await textSearch({ textQuery: t.query, includedType: t.included_type, lat: t.lat, lng: t.lng, radiusM: t.radius_m });
  await ctx.cost({ provider: "google_places", operation: "text_search", units: { requests: res.requests }, costUsd: res.requests * PLACES_COST_PER_REQUEST_USD });

  const chains = (await sql<{ pattern: string }[]>`select pattern from chain_patterns`).map((r) => r.pattern);
  const domainCounts = new Map<string, number>();
  for (const p of res.places) {
    try {
      if (p.websiteUri) domainCounts.set(siteDomain(p.websiteUri), (domainCounts.get(siteDomain(p.websiteUri)) ?? 0) + 1);
    } catch {
      /* ignore */
    }
  }
  const summary = { found: res.places.length, added: 0, excluded: 0, existing: 0, reasons: {} as Record<string, number> };
  for (const p of res.places) {
    const d = decidePlace(p, chains, domainCounts, t.city);
    if (!d.include) {
      summary.excluded++;
      summary.reasons[d.reason] = (summary.reasons[d.reason] ?? 0) + 1;
      continue;
    }
    // Only place_id and the website address are kept. The clinic is labelled by
    // its domain until the contact step reads the name from its own site.
    const rows = await sql<{ id: string; inserted: boolean }[]>`
      insert into clinics (place_id, name, city_id, sector_id, website, domain, source)
      values (${p.id}, ${d.domain ?? "(unnamed)"}, ${cityId}, ${sectorId},
              ${p.websiteUri ?? null}, ${d.domain ?? null}, 'places')
      on conflict (place_id) do update set updated_at = now()
      returning id, (xmax = 0) as inserted`;
    const row = rows[0];
    if (row.inserted) {
      summary.added++;
      await ctx.enqueue("find_contact", `contact:${row.id}`, { clinicId: row.id });
    } else summary.existing++;
  }
  await sql`update discovery_targets set last_run_at = now() where sector_id=${sectorId} and city_id=${cityId}`;
  await ctx.log("discovery done", summary);
  return summary;
}

/** Safety net: Places content is never stored; clear anything left by older versions. */
async function handlePurgePlaces(ctx: JobContext) {
  const sql = db();
  const r = await sql`
    update clinics set places_raw = null, rating = null, review_count = null
    where places_raw is not null or rating is not null or review_count is not null
    returning id`;
  await ctx.log("purged places data", { clinics: r.length });
  return { purged: r.length };
}

register("discover", handleDiscover);
register("purge_places_data", handlePurgePlaces);
