import { db } from "../db";
import { esc } from "../reports/html";
import { fetchLiveRatings } from "./placesLive";
import { isLowVolume } from "./thresholds";

/**
 * The teaser's review comparison table: rendered at VIEW time on the web
 * report only, from live Places data, with Google Maps attribution. Nothing
 * here is stored, and it never appears in the PDF or an email. When Places is
 * unavailable the section is simply left out.
 */
export const LIVE_REVIEWS_MARKER = "<!--LIVE_REVIEWS-->";

export async function renderLiveReviewTable(input: {
  clinicId: string;
  clinicName: string;
  clinicPlaceId: string | null;
  cityId: number;
  competitorNames: string[];
}): Promise<string> {
  if (!input.clinicPlaceId) return "";
  const sql = db();
  const comps = input.competitorNames.length
    ? await sql<{ answer_name: string; place_id: string }[]>`
        select answer_name, place_id from competitor_places
        where city_id=${input.cityId} and answer_name = any(${input.competitorNames}) and place_id is not null`
    : [];
  const ids = [input.clinicPlaceId, ...comps.map((c) => c.place_id)];
  const live = await fetchLiveRatings(ids, input.clinicId);
  if (!live) return "";
  const byId = new Map(live.map((l) => [l.placeId, l]));
  const rows = [
    { name: input.clinicName, id: input.clinicPlaceId, you: true },
    ...comps.map((c) => ({ name: c.answer_name, id: c.place_id, you: false })),
  ];
  const me = byId.get(input.clinicPlaceId);
  const low = me?.count != null && isLowVolume(me.count);
  const fmt = (v: number | null | undefined, d = 1) => (v == null ? "n/a" : v.toFixed(d));
  return `<section class="live-reviews" style="border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:#fff">
  <h2>Reviews on Google: your clinic and the clinics named</h2>
  <div class="table-wrap"><table>
    <thead><tr><th scope="col">Clinic</th><th scope="col">Rating</th><th scope="col">Number of reviews</th></tr></thead>
    <tbody>${rows
      .map((r) => {
        const l = byId.get(r.id);
        return `<tr><td>${r.you ? `<strong>${esc(r.name)}</strong> (you)` : esc(r.name)}</td><td>${fmt(l?.rating)}</td><td>${l?.count ?? "n/a"}</td></tr>`;
      })
      .join("")}</tbody>
  </table></div>
  ${low && me ? `<p class="key">Google shows ${me.count} review${me.count === 1 ? "" : "s"} for your clinic. With fewer than 30, there are too few to analyse what patients say.</p>` : ""}
  <p class="key">Ratings and counts as shown on <span translate="no">Google Maps</span> when this page was opened (${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC). Reviews in the last 90 days and owner replies are not available from this source.</p>
</section>`;
}
