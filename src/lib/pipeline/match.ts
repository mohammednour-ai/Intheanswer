/**
 * Matching a clinic to the clinics named in an assistant's answer.
 * Deterministic and conservative: a clinic is only counted as named when its
 * distinctive name tokens or its own domain appear.
 */

const GENERIC = new Set([
  "the", "and", "of", "at", "in", "on", "a", "an", "inc", "ltd", "llp", "pc", "professional", "corporation",
  "dental", "dentistry", "dentist", "dentists", "dds", "dmd", "office", "clinic", "clinics", "centre", "center", "centres",
  "medical", "medicine", "family", "walk", "walkin", "health", "healthcare", "care", "group", "practice", "associates",
  "spa", "medspa", "med", "aesthetics", "aesthetic", "laser", "skin", "cosmetic", "wellness", "studio", "institute",
  "dr", "doctor", "doctors", "drs", "smile", "smiles", "teeth", "oral", "and", "co",
]);

/**
 * Words that name a place, not a practice. Many clinics in one area share them
 * ("Simcoe Denture Clinic", "Simcoe Family Dentistry"), so sharing one proves nothing.
 * The clinic's own city is treated the same way (see distinctiveTokens).
 */
const PLACE = new Set([
  // directions and town-centre words
  "north", "south", "east", "west", "northern", "southern", "eastern", "western", "central", "downtown", "uptown",
  "midtown", "city", "town", "village", "community", "neighbourhood", "neighborhood", "main", "old", "new",
  // landforms and features common in place names
  "bay", "lake", "lakes", "lakeshore", "lakeside", "lakeview", "river", "riverside", "valley", "creek", "harbour",
  "harbor", "shore", "shores", "point", "park", "ridge", "heights", "hill", "hills", "grove", "woods", "forest",
  "meadow", "meadows", "escarpment", "island", "beach", "falls", "station", "junction", "crossing", "corners",
  "plaza", "square", "mall", "centre", "commons", "gate", "gateway",
  // streets
  "street", "st", "avenue", "ave", "road", "rd", "drive", "dr", "boulevard", "blvd", "line", "concession",
  // Ontario regions, counties and areas
  "ontario", "county", "region", "regional", "district", "gta", "simcoe", "georgian", "muskoka", "huronia",
  "kempenfelt", "allandale", "innisfil", "oro", "medonte", "springwater", "essa", "halton", "peel", "york",
  "durham", "niagara", "kawartha", "haliburton", "grey", "bruce", "dufferin", "wellington", "waterloo",
  "golden", "horseshoe", "trent", "ottawa", "hamilton", "toronto", "mississauga", "brampton", "oakville",
  "burlington", "milton", "barrie", "orillia", "collingwood", "wasaga", "midland", "bradford", "newmarket",
  "aurora", "vaughan", "markham", "richmond", "scarborough", "etobicoke",
]);

/** Legal and filler words ignored when two names must be the same name. */
const FILLER = new Set(["the", "inc", "ltd", "llp", "pc", "professional", "corporation", "co", "and"]);

/** Words a clinic's name may end with or leave off ("Simcoe Dental" = "Simcoe Dental Clinic"). */
const TRAILING = new Set(["clinic", "clinics", "office", "offices", "centre", "centres"]);

/**
 * A name reduced for an exact comparison: lower case, filler removed, centre and
 * center alike, and a trailing "Clinic", "Office" or "Centre" dropped.
 */
function sameNameKey(name: string): string {
  const t = nameTokens(name).filter((x) => !FILLER.has(x)).map((x) => (x === "center" ? "centre" : x === "centers" ? "centres" : x));
  while (t.length > 1 && TRAILING.has(t[t.length - 1])) t.pop();
  return t.join(" ");
}

export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** Tokens that identify this clinic rather than its category. */
export function distinctiveTokens(name: string, city?: string): string[] {
  const cityTokens = new Set(city ? nameTokens(city) : []);
  return nameTokens(name).filter((t) => !GENERIC.has(t) && !cityTokens.has(t) && t.length > 1);
}

function domainOfUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export interface NamedClinic {
  name: string;
  url: string | null;
  status: "recommended" | "listed_only";
  quote: string;
}

export interface MatchInput {
  clinicName: string;
  siteName?: string | null;
  domain: string | null;
  city: string;
}

export interface MatchResult {
  status: "recommended" | "listed_only" | "not_named";
  matchedAs: string | null;
  evidence: string | null;
}

export function namesMatch(a: string, b: string, city: string): boolean {
  const ta = distinctiveTokens(a, city);
  const tb = distinctiveTokens(b, city);
  if (ta.length === 0 || tb.length === 0) {
    // purely generic names ("Barrie Dental Centre"): require the full normalised names to be equal
    return nameTokens(a).join(" ") === nameTokens(b).join(" ");
  }
  const sa = new Set(ta);
  const sb = new Set(tb);
  const shared = [...sa].filter((t) => sb.has(t));
  // all distinctive tokens of the shorter name appear in the longer one
  if (shared.length === 0 || shared.length !== Math.min(sa.size, sb.size)) return false;
  // What they share must include a word that names the practice, not just the area.
  // When it is only place words, the two must be the same name ("Georgian Dental"
  // and "Georgian Dental Centre" yes; "Georgian Dental" and "Georgian Bay Dental" no).
  if (shared.some((t) => !PLACE.has(t))) return true;
  return sameNameKey(a) === sameNameKey(b);
}

export function matchClinic(
  c: MatchInput,
  answer: { text: string; named: NamedClinic[]; citedUrls: string[] },
): MatchResult {
  const names = [c.clinicName, c.siteName].filter(Boolean) as string[];
  let best: MatchResult = { status: "not_named", matchedAs: null, evidence: null };
  for (const n of answer.named) {
    const byDomain = c.domain && domainOfUrl(n.url) === c.domain;
    const byName = names.some((x) => namesMatch(x, n.name, c.city));
    if (byDomain || byName) {
      if (n.status === "recommended") return { status: "recommended", matchedAs: n.name, evidence: n.quote };
      best = { status: "listed_only", matchedAs: n.name, evidence: n.quote };
    }
  }
  if (best.status !== "not_named") return best;
  if (c.domain && answer.citedUrls.some((u) => domainOfUrl(u) === c.domain)) {
    return { status: "listed_only", matchedAs: c.domain, evidence: `The answer cites a page on ${c.domain}.` };
  }
  return best;
}
