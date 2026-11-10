import { env } from "../env";
import { withRecording } from "./recorder";

/**
 * Google Places API (New) Text Search.
 * POST https://places.googleapis.com/v1/places:searchText
 * Headers: X-Goog-Api-Key, X-Goog-FieldMask. Body: textQuery, locationBias, includedType, pageSize, pageToken.
 */
export const PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.rating",
  "places.userRatingCount",
  "places.types",
  "places.businessStatus",
  "nextPageToken",
].join(",");

/** Cost per request at the tier the field mask bills (nationalPhoneNumber → Enterprise). Confirm in Google Cloud billing. */
export const PLACES_COST_PER_REQUEST_USD = 0.035;

export interface Place {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  types?: string[];
  businessStatus?: string;
}

export interface TextSearchInput {
  textQuery: string;
  includedType?: string | null;
  lat?: number | null;
  lng?: number | null;
  radiusM?: number;
  maxPages?: number;
}

export async function textSearch(input: TextSearchInput): Promise<{ places: Place[]; requests: number }> {
  return withRecording("places", input, async () => {
    const key = env().GOOGLE_PLACES_API_KEY;
    if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not set");
    const places: Place[] = [];
    let pageToken: string | undefined;
    let requests = 0;
    for (let page = 0; page < (input.maxPages ?? 3); page++) {
      const body: Record<string, unknown> = {
        textQuery: input.textQuery,
        pageSize: 20,
        regionCode: "CA",
        languageCode: "en",
      };
      if (input.includedType) body.includedType = input.includedType;
      if (input.lat != null && input.lng != null) {
        body.locationBias = { circle: { center: { latitude: input.lat, longitude: input.lng }, radius: input.radiusM ?? 15000 } };
      }
      if (pageToken) body.pageToken = pageToken;
      const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": PLACES_FIELD_MASK },
        body: JSON.stringify(body),
      });
      requests++;
      if (!res.ok) throw new Error(`Places ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { places?: Place[]; nextPageToken?: string };
      places.push(...(json.places ?? []));
      if (!json.nextPageToken) break;
      pageToken = json.nextPageToken;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { places, requests };
  });
}
