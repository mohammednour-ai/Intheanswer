/**
 * What our own tests found, for the home page. A count, not an estimate: the latest free report
 * for each clinic in production, and how many of them have a score of 0 recommended. Counted on
 * the date below with:
 *
 *   select count(*) as clinics,
 *          count(*) filter (where (data->'score'->>'recommended')::int = 0) as not_recommended,
 *          count(distinct data->'clinic'->>'city') as cities
 *   from (select distinct on (clinic_id) data from reports
 *         where not superseded and kind = 'teaser' and (data->'score'->>'total') is not null
 *         order by clinic_id, created_at desc) latest;
 *
 * Every one of those reports asked six questions. Count again and change the date before quoting
 * a newer figure; never round it or describe it more strongly than the count allows.
 */
export const TESTED = { clinics: 250, notRecommended: 178, cities: 6, asOf: "22 November 2026" } as const;
