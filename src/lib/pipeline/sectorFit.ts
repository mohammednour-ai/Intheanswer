import { db } from "../db";
import { parsePage } from "../site/parse";

/**
 * Is this clinic really the kind of clinic its sector is? Google's search for "medical spa in Barrie"
 * also returns physiotherapy and massage clinics and day spas; emailed as a medspa, such a clinic is
 * told it was not recommended for Botox questions it never answers (Evergreen Wellness Studio,
 * 24 November 2026: "we are not a medspa"). The clinic's own site decides: it must name the sector's
 * services, and not mainly another kind of care.
 *
 * Counted on the visible text of the pages read (title, description, body). A clinic fits when the
 * sector's services are named at least MIN_OWN times and the other kind is named no more than
 * OTHER_RATIO times as often (a medspa that also does manicures, or a walk-in clinic with a medspa,
 * still fits).
 */

interface Vocab {
  /** What the sector is called in a reason the owner reads. */
  label: string;
  /** The sector's own services. */
  own: RegExp;
  /** Services of a different kind of clinic that Google's search for this sector also returns. */
  other: RegExp;
}

const THERAPY = String.raw`physiotherap\w*|chiropract\w*|registered massage|massage therap\w*|\bRMTs?\b|naturopath\w*|acupunct\w*|osteopath\w*|psychotherap\w*|counsell?ing|pelvic floor|kinesiolog\w*|orthotics?`;

const VOCAB: Record<string, Vocab> = {
  medspa: {
    label: "medspa",
    own: new RegExp(
      String.raw`botox|neurotoxins?|dysport|xeomin|injectables?|dermal fillers?|lip fillers?|\bfillers?\b|med ?spas?|medi ?spas?|medical spas?|medical aesthetics?|aesthetic medicine|laser hair removal|laser resurfacing|laser skin|microneedling|chemical peels?|hydra ?facials?|coolsculpt\w*|fat freezing|skin tightening|morpheus ?8|\bPRP\b|\bIPL\b|photofacials?|tattoo removal|skin rejuvenation`,
      "gi",
    ),
    other: new RegExp(String.raw`${THERAPY}|day spa|pedicures?|manicures?|head spa|scalp treatments?|hot stone`, "gi"),
  },
  dental: {
    label: "dental clinic",
    own: new RegExp(String.raw`dentists?|dentistry|dental|teeth|tooth|orthodont\w*|invisalign|root canals?|hygienists?|implants?|crowns?|fillings?|endodont\w*|periodont\w*`, "gi"),
    other: new RegExp(String.raw`${THERAPY}|denturists?`, "gi"),
  },
  family: {
    label: "family or walk-in clinic",
    own: new RegExp(String.raw`family doctors?|family physicians?|family medicine|family practice|walk[- ]in|primary care|physicians?|medical clinic|nurse practitioners?|\bdoctors?\b`, "gi"),
    other: new RegExp(String.raw`${THERAPY}|dentists?|dentistry|med ?spa|botox|injectables?`, "gi"),
  },
};

export const MIN_OWN = 3;
/** A clinic with some of the sector's services is set aside only when another kind of care clearly dominates. */
export const OTHER_RATIO = 2;
const MIN_TEXT = 500;

export interface SectorFit {
  ok: boolean;
  /** No word list for this sector: nothing is decided. */
  unknown?: boolean;
  own: number;
  other: number;
  ownTerms: string[];
  otherTerms: string[];
  reason: string;
}

function tally(re: RegExp, text: string): { n: number; terms: string[] } {
  const counts = new Map<string, number>();
  let n = 0;
  for (const m of text.matchAll(re)) {
    n++;
    const k = m[0].toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const terms = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k);
  return { n, terms };
}

export function sectorFit(slug: string, texts: string[]): SectorFit {
  const v = VOCAB[slug];
  if (!v) return { ok: true, unknown: true, own: 0, other: 0, ownTerms: [], otherTerms: [], reason: `no word list for sector ${slug}` };
  const text = texts.join("\n");
  const own = tally(v.own, text);
  const other = tally(v.other, text);
  // too little readable text (a site drawn by script) says nothing either way
  if (text.replace(/\s+/g, " ").length < MIN_TEXT) {
    return { ok: true, unknown: true, own: own.n, other: other.n, ownTerms: own.terms, otherTerms: other.terms, reason: "too little readable text on the site to tell" };
  }
  const ok = own.n >= MIN_OWN && other.n <= OTHER_RATIO * own.n;
  const named = (t: string[]) => t.map((x) => `"${x}"`).join(", ");
  let reason: string;
  if (ok) reason = `its site names ${v.label} services ${own.n} times (${named(own.terms)})`;
  else if (other.n > OTHER_RATIO * own.n)
    reason = `its site is mainly about other care: ${named(other.terms)} (${other.n} mentions) against ${own.n} for ${v.label} services${own.n ? ` (${named(own.terms)})` : ""}`;
  else reason = `its site names ${v.label} services only ${own.n} time(s)${own.n ? ` (${named(own.terms)})` : ""}`;
  return { ok, own: own.n, other: other.n, ownTerms: own.terms, otherTerms: other.terms, reason: ok ? reason : `not a ${v.label}: ${reason}` };
}

/** The text a parsed page shows a reader. */
export function pageText(p: { title: string; metaDescription: string | null; text: string }): string {
  return [p.title, p.metaDescription ?? "", p.text].join("\n");
}

/** The check on what we already hold of the clinic's site (the pages its audit and site test read). */
export async function sectorFitForClinic(clinicId: string): Promise<SectorFit | null> {
  const sql = db();
  const [c] = await sql<{ domain: string | null; slug: string }[]>`
    select c.domain, s.slug from clinics c join sectors s on s.id = c.sector_id where c.id = ${clinicId}`;
  if (!c?.domain) return null;
  const pages = await sql<{ url: string; body: string }[]>`
    select url, body from page_cache where domain = ${c.domain} and http_status = 200 and body is not null
    order by length(url) limit 40`;
  if (!pages.length) return null;
  const texts: string[] = [];
  for (const p of pages) {
    try {
      texts.push(pageText(parsePage(p.url, p.body)));
    } catch {
      /* an unparsable page says nothing either way */
    }
  }
  return texts.length ? sectorFit(c.slug, texts) : null;
}
