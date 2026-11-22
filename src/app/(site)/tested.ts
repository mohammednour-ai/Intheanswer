/**
 * What our own tests found, for the home page and /how-we-counted. A count, not an estimate:
 * every clinic we have tested, with its latest score (six questions each). It includes the clinics
 * we did not send a report to, so the figure is not limited to clinics that did badly. Counted on
 * the date below with:
 *
 *   with latest as (select distinct on (s.clinic_id) s.* from scores s order by s.clinic_id, s.created_at desc)
 *   select ci.name as city, se.name as sector, count(*) as clinics,
 *          count(*) filter (where l.recommended = 0) as not_recommended
 *   from latest l join clinics c on c.id = l.clinic_id
 *        join cities ci on ci.id = c.city_id join sectors se on se.id = c.sector_id
 *   group by rollup ((ci.name, se.name));
 *
 * One clinic is filed under North York; it is counted with Toronto. Every score asked six questions
 * (scores.total = 6), all with Claude (claude-opus-5-5) with web search on, from 13 to 22 November 2026.
 * Count again and change the date before quoting a newer figure; never round it or describe it more
 * strongly than the count allows. (Before 22 November 2026 the site quoted 178 of 250: that counted only
 * clinics that had been sent a report.)
 */
export const TESTED = {
  clinics: 288,
  notRecommended: 198,
  cities: 5,
  asOf: "22 November 2026",
  from: "13 November 2026",
  to: "22 November 2026",
  assistant: "Claude",
  questions: 6,
} as const;

/** The same count by city and type of clinic. The rows add up to TESTED. */
export const TESTED_BY_CITY: { city: string; dental: [number, number] | null; family: [number, number] | null; medspa: [number, number] | null }[] = [
  // [not recommended in any answer, clinics tested]
  { city: "Toronto", dental: [20, 27], family: [22, 27], medspa: [27, 34] },
  { city: "Barrie", dental: [21, 32], family: [4, 7], medspa: [23, 34] },
  { city: "Milton", dental: [19, 34], family: [5, 9], medspa: [18, 27] },
  { city: "Ottawa", dental: [17, 27], family: null, medspa: null },
  { city: "Windsor", dental: [19, 26], family: [3, 4], medspa: null },
];

/** The six questions asked in Barrie, word for word, as an example. Other cities used the same questions with their own name. */
export const BARRIE_QUESTIONS: { kind: string; questions: string[] }[] = [
  {
    kind: "Dental clinics",
    questions: [
      "I just moved to Barrie, Ontario. Can you recommend a good dentist that is accepting new patients?",
      "I am looking for a family dentist in Barrie who is good with kids. Who would you suggest?",
      "Which dentists in Barrie can see me the same day for a dental emergency?",
      "I do not have dental insurance. Which dental clinics in Barrie are affordable or list their prices?",
      "Which dentists in Barrie bill my insurance directly so I do not pay up front?",
      "Are there dentists in Barrie open evenings or Saturdays?",
    ],
  },
  {
    kind: "Walk-in and family clinics",
    questions: [
      "Where can I find a family doctor accepting new patients in Barrie, Ontario?",
      "Which walk-in clinics in Barrie would you recommend? I need to see a doctor today.",
      "Are there walk-in clinics in Barrie open on evenings or weekends?",
      "I am new to Barrie. Which medical clinic would you recommend for my family?",
      "Where in Barrie can I get a physical or a medical form completed if I do not have a family doctor?",
      "Which clinics in Barrie offer virtual appointments with a doctor?",
    ],
  },
  {
    kind: "Medspas",
    questions: [
      "Can you recommend a reputable medspa in Barrie, Ontario?",
      "Where can I get laser hair removal in Barrie? Who would you recommend?",
      "Which clinics in Barrie offer Botox done by a nurse or a doctor?",
      "Which aesthetic clinics in Barrie are run by medical professionals?",
      "Where can I get a skin treatment for acne scars in Barrie?",
      "I am looking for a medspa in Barrie that lists its prices. Any suggestions?",
    ],
  },
];
