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
  const inter = [...sa].filter((t) => sb.has(t)).length;
  // all distinctive tokens of the shorter name appear in the longer one
  return inter > 0 && inter === Math.min(sa.size, sb.size);
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
