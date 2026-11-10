import { db } from "../db";
import type { JobContext } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { recordCost } from "../jobs/queue";
import { findPlaceId, PLACES_ID_SEARCH_USD } from "./placesLive";
import { fetchOwnReviews, computeMetrics, analyseThemes, storeSnapshot } from "./gbp";
import type { NamedClinic } from "../pipeline/match";

/**
 * review_lookup: map the clinic and every clinic recommended in its city test
 * to a Places place_id (the only Places field that may be stored).
 * review_analysis: monthly clients with a connected Business Profile.
 * Either failing leaves the clinic in the pipeline without the review section.
 */
async function handleReviewLookup(ctx: JobContext) {
  const { clinicId, testRunId } = ctx.job.payload as { clinicId: string; testRunId: string };
  const sql = db();
  const [c] = await sql<{ name: string; site_name: string | null; place_id: string | null; city_id: number; city: string }[]>`
    select c.name, c.site_name, c.place_id, c.city_id, ci.name as city from clinics c join cities ci on ci.id=c.city_id where c.id=${clinicId}`;
  let lookups = 0;
  if (!c.place_id) {
    const id = await findPlaceId(c.site_name ?? c.name, c.city);
    lookups++;
    if (id) await sql`update clinics set place_id=${id} where id=${clinicId} and place_id is null`;
  }
  const answers = await sql<{ clinics_named: NamedClinic[] }[]>`select clinics_named from test_answers where test_run_id=${testRunId}`;
  const names = [...new Set(answers.flatMap((a) => a.clinics_named.filter((n) => n.status === "recommended").map((n) => n.name)))];
  for (const n of names) {
    const [have] = await sql`select 1 from competitor_places where city_id=${c.city_id} and answer_name=${n}`;
    if (have) continue;
    const id = await findPlaceId(n, c.city);
    lookups++;
    await sql`insert into competitor_places (city_id, answer_name, place_id, match_note)
              values (${c.city_id}, ${n}, ${id}, ${id ? "top Places text search result" : "no match"}) on conflict do nothing`;
  }
  await recordCost(ctx.job.id, { provider: "google_places", operation: "place_id_lookup", units: { requests: lookups }, costUsd: lookups * PLACES_ID_SEARCH_USD, clinicId });
  return { lookups, competitors: names.length };
}

async function handleReviewAnalysis(ctx: JobContext) {
  const { clinicId, runLabel } = ctx.job.payload as { clinicId: string; runLabel: string };
  const { reviews, total, average } = await fetchOwnReviews(clinicId);
  const m = computeMetrics(reviews, total, average);
  const t = await analyseThemes(reviews, m.level);
  if (t) await ctx.cost({ provider: "anthropic", operation: "review_themes", units: t.usage as never, costUsd: t.costUsd, clinicId });
  const id = await storeSnapshot(clinicId, runLabel, m, t?.themes ?? null, t?.analysed ?? 0);
  return { snapshotId: id, total: m.total, level: m.level };
}

register("review_lookup", handleReviewLookup);
register("review_analysis", handleReviewAnalysis);
