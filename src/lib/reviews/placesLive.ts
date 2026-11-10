import { env } from "../env";
import { db } from "../db";
import { recordCost } from "../jobs/queue";
import { localDate } from "../time";

/**
 * Google Places, used under the Maps Platform terms (checked 2026-11-11):
 * only place_id is stored. Rating and review count are fetched live when a
 * report is viewed, shown with Google attribution, and never written to the
 * database, a PDF or an email.
 */

/** Place Details with rating/userRatingCount bills at the Enterprise SKU. Confirm in Google Cloud billing. */
export const PLACES_DETAILS_USD = 0.025;
/** Text Search requesting only places.id bills at the Essentials (IDs only) SKU. */
export const PLACES_ID_SEARCH_USD = 0.005;

export interface LiveRating {
  placeId: string;
  rating: number | null;
  count: number | null;
  mapsUri: string | null;
}

async function underSpendCap(): Promise<boolean> {
  const sql = db();
  const [s] = await sql<{ cap: number }[]>`select claude_daily_spend_cap_usd as cap from app_settings where id`;
  const [t] = await sql<{ usd: number | null }[]>`
    select sum(cost_usd)::float as usd from cost_records
    where (at at time zone 'America/Toronto')::date = ${localDate(new Date())}::date`;
  return (t.usd ?? 0) < s.cap;
}

/** Live lookup, never stored. Returns null when Places is not configured, over the spend cap, or fails. */
export async function fetchLiveRatings(placeIds: string[], clinicId: string | null): Promise<LiveRating[] | null> {
  const key = env().GOOGLE_PLACES_API_KEY;
  if (!key || placeIds.length === 0) return null;
  if (!(await underSpendCap())) return null;
  try {
    const out = await Promise.all(
      placeIds.map(async (id) => {
        const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`, {
          headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "id,rating,userRatingCount,googleMapsUri" },
        });
        if (!res.ok) throw new Error(`Places ${res.status}`);
        const j = (await res.json()) as { id: string; rating?: number; userRatingCount?: number; googleMapsUri?: string };
        return { placeId: j.id, rating: j.rating ?? null, count: j.userRatingCount ?? null, mapsUri: j.googleMapsUri ?? null };
      }),
    );
    await recordCost(null, { provider: "google_places", operation: "live_ratings", units: { requests: placeIds.length }, costUsd: placeIds.length * PLACES_DETAILS_USD, clinicId });
    return out;
  } catch {
    return null;
  }
}

/** Find a place_id for a business name in a city (only the id is requested and stored). */
export async function findPlaceId(name: string, city: string): Promise<string | null> {
  const key = env().GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not set");
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "places.id" },
    body: JSON.stringify({ textQuery: `${name}, ${city}, Ontario`, pageSize: 1, regionCode: "CA" }),
  });
  if (!res.ok) throw new Error(`Places ${res.status}`);
  const j = (await res.json()) as { places?: { id: string }[] };
  return j.places?.[0]?.id ?? null;
}

/** Link a patient uses to leave a Google review, built from the storable place_id. */
export function writeReviewUrl(placeId: string): string {
  return `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
}
