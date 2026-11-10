/**
 * Page templates keyed by patient intent. Every clinical, pricing or
 * availability fact is a [BRACKETED PLACEHOLDER] the clinic must confirm.
 * No outcome promises, no superlatives, no comparisons, no promotional claims
 * about prescription treatments.
 */
export interface IntentTemplate {
  intent: string;
  match: RegExp;
  /** Title phrased as the patient's question. {clinic} {city} */
  title: string;
  /** Direct answer: exactly two sentences, placeholders for every fact. */
  answer: [string, string];
  details: string[];
  /** Words that show an existing page already covers this (URL, title or h1). */
  covered: RegExp;
  prescription?: boolean;
}

export const INTENTS: IntentTemplate[] = [
  {
    intent: "new_patients", match: /new patient|accepting/i, covered: /new[- ]patient|accepting/i,
    title: "Is {clinic} accepting new patients in {city}?",
    answer: ["[YES OR NO: is the clinic accepting new patients?] {clinic} [is / is not] accepting new patients at this time.", "To register, [HOW TO REGISTER: call, book online or visit], and bring [WHAT TO BRING: health card, insurance details]."],
    details: ["Who we see: [AGE GROUPS OR PATIENT TYPES SEEN].", "Wait time for a first appointment: [TYPICAL WAIT].", "If we are not accepting new patients: [WAITLIST OR ALTERNATIVE]."],
  },
  {
    intent: "emergency", match: /emergenc|same day|today/i, covered: /emergenc|same[- ]day|urgent/i,
    title: "Can I get a same-day appointment at {clinic} in {city}?",
    answer: ["[YES OR NO: does the clinic offer same-day or emergency visits?] {clinic} [offers / does not offer] same-day appointments for [WHICH SITUATIONS].", "Call [PHONE] as early as possible on the day; [HOW SAME-DAY SLOTS ARE GIVEN]."],
    details: ["Hours for same-day visits: [HOURS].", "After hours: [WHAT TO DO OUTSIDE HOURS, e.g. nearest emergency department or Health811].", "What to bring: [WHAT TO BRING]."],
  },
  {
    intent: "cost", match: /afford|price|cost|fee|without insurance|do not have .*insurance|list .*prices/i, covered: /fee|price|cost|pricing|payment/i,
    title: "How much does a visit cost at {clinic} without insurance?",
    answer: ["A [SERVICE, e.g. new patient exam] at {clinic} costs [PRICE] for patients without insurance.", "Fees follow [FEE GUIDE OR BASIS], and we accept [PAYMENT METHODS]."],
    details: ["Common services and fees: [SERVICE: PRICE], [SERVICE: PRICE], [SERVICE: PRICE].", "Payment options: [PAYMENT PLANS OR NONE].", "Government programs accepted: [e.g. CDCP, OHIP, or none]."],
  },
  {
    intent: "kids", match: /kid|child/i, covered: /child|kid|pediatric|paediatric|family/i,
    title: "Does {clinic} see children in {city}?",
    answer: ["{clinic} [sees / does not see] children from age [MINIMUM AGE].", "A first visit for a child includes [WHAT THE FIRST VISIT INCLUDES]."],
    details: ["Practitioners who see children: [NAMES AND CREDENTIALS].", "How to prepare a child for a visit: [GUIDANCE].", "Coverage for children: [e.g. CDCP, parents' insurance]."],
  },
  {
    intent: "direct_billing", match: /bill .*insurance|direct(ly)? bill|pay up front/i, covered: /billing|insurance|direct bill/i,
    title: "Does {clinic} bill insurance directly?",
    answer: ["[YES OR NO: does the clinic bill insurance directly?] {clinic} [bills / does not bill] insurance directly for [WHICH PLANS].", "Bring [WHAT TO BRING: insurance card, plan and member numbers] to your visit."],
    details: ["Insurers we bill directly: [LIST].", "When you pay up front: [SITUATIONS].", "Government programs: [e.g. CDCP]."],
  },
  {
    intent: "hours", match: /evening|saturday|weekend|open on|open late/i, covered: /hour|schedule|open/i,
    title: "Is {clinic} open evenings or weekends?",
    answer: ["{clinic} is open [EVENING DAYS AND TIMES] and [WEEKEND DAYS AND TIMES].", "Appointments in these hours are [HOW TO BOOK THEM]."],
    details: ["Full hours: [ONE HOURS BLOCK, the same on every page and listing].", "Holiday hours: [DATED NOTICE AREA]."],
  },
  {
    intent: "walk_in", match: /walk-?in/i, covered: /walk[- ]?in/i,
    title: "Can I see a doctor today at {clinic} walk-in clinic in {city}?",
    answer: ["The walk-in clinic at {clinic} is open [WALK-IN HOURS], and patients are seen [IN ORDER OF ARRIVAL / BY BOOKING].", "The walk-in may close early when it reaches capacity, so [HOW TO CHECK: call PHONE or online wait time]."],
    details: ["What to bring: [Ontario health card and WHAT ELSE].", "Services at the walk-in: [LIST].", "When to go to an emergency department instead: [GUIDANCE]."],
  },
  {
    intent: "virtual", match: /virtual|online appointment|telehealth/i, covered: /virtual|online|tele/i,
    title: "Does {clinic} offer virtual appointments?",
    answer: ["{clinic} [offers / does not offer] virtual appointments by [PHONE / VIDEO].", "To book one, [HOW TO BOOK]."],
    details: ["What a virtual visit can be used for: [LIST].", "Who can book: [ROSTERED PATIENTS ONLY / ANYONE]."],
  },
  {
    intent: "forms", match: /physical|form|sick note|medical note/i, covered: /form|physical|third[- ]party|sick note/i,
    title: "Can I get a physical or a medical form completed at {clinic}?",
    answer: ["{clinic} completes [WHICH FORMS AND PHYSICALS] for [WHO: patients of the clinic / anyone].", "Some of these are not covered by OHIP and have a fee: [FORM: FEE]."],
    details: ["How to book: [HOW].", "Fees for uninsured services: [LIST]."],
  },
  {
    intent: "practitioners", match: /reputable|run by medical|medical professional|nurse or a doctor|by a nurse|by a doctor/i, covered: /team|about|staff|doctor|nurse/i,
    title: "Who performs treatments at {clinic}?",
    answer: ["Treatments at {clinic} are performed by [NAMES, ROLES AND REGULATORY COLLEGE].", "[WHO ASSESSES PATIENTS BEFORE TREATMENT, e.g. a physician or nurse practitioner] assesses each patient before treatment."],
    details: ["Credentials: [REGISTRATION NUMBERS OR LINKS TO PUBLIC REGISTERS].", "Medical director: [NAME, if any]."],
  },
  {
    intent: "price_list", match: /lists? (its|their)? ?prices|pricing|transparent/i, covered: /price|pricing|cost|fee/i,
    title: "How much do treatments cost at {clinic}?",
    answer: ["Prices at {clinic} start at [PRICE] for [TREATMENT] and [PRICE] for [TREATMENT].", "A consultation costs [PRICE OR FREE] and [IS / IS NOT] applied to treatment."],
    details: ["Price list: [TREATMENT: PRICE] for each treatment.", "Payment options: [OPTIONS]."],
  },
];

/** Generic service page template (one per service the clinic offers). */
export const SERVICE_TEMPLATE = {
  title: "{service} at {clinic} in {city}: what to expect",
  answer: [
    "{clinic} offers {service} [FOR WHOM / WHICH CASES].",
    "A typical appointment takes [DURATION] and costs [PRICE OR HOW COST IS SET].",
  ] as [string, string],
  details: [
    "What happens at the appointment: [STEPS, factual only].",
    "Who provides it: [PRACTITIONER NAMES AND CREDENTIALS].",
    "Coverage: [INSURANCE OR GOVERNMENT PROGRAMS].",
    "Before and after: [PREPARATION AND AFTERCARE, as your regulator allows].",
  ],
};

/** Prescription treatments: factual description only, no promotional claims. */
export const PRESCRIPTION_RE = /\b(botox|neuromodulator|botulinum|filler|dysport|xeomin|semaglutide|ozempic|prescription)\b/i;

export function intentFor(question: string): IntentTemplate | null {
  return INTENTS.find((i) => i.match.test(question)) ?? null;
}

export function fill(t: string, v: { clinic: string; city: string; service?: string }): string {
  return t.replaceAll("{clinic}", v.clinic).replaceAll("{city}", v.city).replaceAll("{service}", v.service ?? "");
}

export function placeholdersIn(...texts: string[]): string[] {
  const out = new Set<string>();
  // a placeholder starts with a capital letter or "e.g." and has no braces or quotes (so JSON arrays never match)
  for (const t of texts) for (const m of t.matchAll(/\[(?:[A-Z]|e\.g\.)[^[\]{}"]*\]/g)) out.add(m[0]);
  return [...out];
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70);
}
