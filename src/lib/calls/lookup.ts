import { db } from "../db";

/**
 * Finding a caller's clinic from its name as spoken.
 *
 * A caller who has no report code says which clinic they are from. The name
 * reaches us through speech recognition, so it is matched loosely: spelling
 * slips ("Blur" for "Bloor"), a shortened name, the city said along with it.
 * The match is only ever a suggestion: the caller is asked to confirm before a
 * report is attached to the call.
 */

export interface ClinicCandidate {
  id: string;
  /** The name as the clinic writes it on its own site, else the listing name: the one the brief uses and the agent says. */
  name: string;
  /** Other names the clinic goes by (the listing name when the site name differs). */
  aliases?: string[];
  city: string | null;
}

export interface ClinicMatch {
  id: string;
  name: string;
  city: string | null;
  score: number;
}

/** A name this close is offered to the caller as "is that your clinic?". */
export const PLAUSIBLE = 0.5;
/** A name this close, with nothing else near it, is offered alone. */
const STRONG = 0.72;
const MAX_OFFERED = 3;

/** Words a caller wraps a name in, and words that carry no identity. */
const DROP = new Set([
  "the", "of", "and", "at", "a", "an", "for", "to", "in", "on", "inc", "ltd", "llc", "corp", "co",
  "its", "it", "is", "called", "name", "named", "our", "my", "we", "are", "from", "im", "calling", "ontario", "canada",
]);
const SAME: Record<string, string> = { centre: "center", clinique: "clinic", dr: "doctor", drs: "doctors", saint: "st", street: "st", avenue: "ave", healthcare: "health" };
/** Words most clinic names share: they count for little, so "dental clinic" alone matches nobody. */
const GENERIC = new Set([
  "clinic", "clinics", "medical", "medicine", "center", "health", "care", "dental", "dentistry", "dentist", "dentists", "family",
  "physiotherapy", "physio", "chiropractic", "wellness", "walk", "group", "associates", "office", "practice", "doctor", "doctors",
  "spa", "med", "medspa", "optometry", "eye", "vision", "rehab", "rehabilitation", "therapy", "massage", "aesthetics", "cosmetic",
  "laser", "skin", "orthodontics", "pharmacy", "services", "professional", "corporation",
]);

export function nameTokens(s: string): string[] {
  const all = s
    .normalize("NFD").replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['‘’.]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((t) => SAME[t] ?? t);
  const kept = all.filter((t) => !DROP.has(t));
  return kept.length ? kept : all;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** A rough "sounds like" key: first letter, then consonants, similar ones merged ("bloor" and "blur" both give "blr"). */
function sound(t: string): string {
  const s = t.replace(/ph/g, "f").replace(/ck|c|q/g, "k").replace(/x/g, "ks").replace(/z/g, "s").replace(/gh/g, "");
  return (s[0] + s.slice(1).replace(/[aeiouyhw]/g, "")).replace(/(.)\1+/g, "$1");
}

/** How alike two words are, 0 to 1. */
export function wordLikeness(a: string, b: string): number {
  if (a === b) return 1;
  const short = Math.min(a.length, b.length);
  const long = Math.max(a.length, b.length);
  if (short >= 4) {
    let p = 0;
    while (p < short && a[p] === b[p]) p++;
    if (p === short) return 0.85;                       // "physio" for "physiotherapy", "walk" for "walking"
    if (p >= 4 && p / short >= 0.66) return 0.7;        // "dental" and "dentistry"
  }
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return 0;     // a number is that number or it is not
  if (long >= 5) {
    const d = editDistance(a, b);
    if (d <= (long >= 8 ? 2 : 1)) return 1 - d / long;
  }
  if (short >= 3 && sound(a).length >= 2 && sound(a) === sound(b)) return 0.75;
  return 0;
}

/**
 * Rank clinics against a spoken name. Each word is weighted by how rare it is
 * among the candidates, so the distinctive part of a name decides. The score
 * rewards covering the clinic's name (most) and wasting none of what was said.
 */
export function rankClinics(said: string, candidates: ClinicCandidate[]): ClinicMatch[] {
  const q = [...new Set(nameTokens(said))];
  if (!q.length || !candidates.length) return [];

  const prepared = candidates.map((c) => ({
    c,
    names: [c.name, ...(c.aliases ?? [])].map(nameTokens).filter((t) => t.length),
    city: c.city ? nameTokens(c.city) : [],
  }));
  const df = new Map<string, number>();
  for (const p of prepared) for (const t of new Set(p.names.flat())) df.set(t, (df.get(t) ?? 0) + 1);
  const n = prepared.length;
  const weight = (t: string) => Math.log(1 + n / (df.get(t) ?? 1)) * (GENERIC.has(t) ? 0.3 : 1);
  const cityWords = new Set(prepared.flatMap((p) => p.city));
  const saidCities = q.filter((t) => cityWords.has(t));

  const out: ClinicMatch[] = [];
  for (const p of prepared) {
    let best = 0;
    for (const name of p.names) {
      const covered = name.reduce((sum, t) => sum + weight(t) * Math.max(...q.map((x) => wordLikeness(t, x))), 0) / name.reduce((sum, t) => sum + weight(t), 0);
      // what the caller said that this clinic accounts for; its city counts, since people say "..., in Barrie"
      const used = q.reduce((sum, x) => sum + weight(x) * Math.max(p.city.includes(x) ? 1 : 0, ...name.map((t) => wordLikeness(x, t))), 0) / q.reduce((sum, x) => sum + weight(x), 0);
      best = Math.max(best, covered ** 0.7 * used ** 0.3);
    }
    // the caller named a city, and it is not this clinic's
    if (saidCities.length && !saidCities.some((t) => p.city.includes(t) || p.names.some((nm) => nm.includes(t)))) best *= 0.7;
    if (best >= PLAUSIBLE) out.push({ id: p.c.id, name: p.c.name, city: p.c.city, score: Math.round(best * 1000) / 1000 });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || (a.city ?? "").localeCompare(b.city ?? "") || a.id.localeCompare(b.id));
  if (!out.length) return [];
  const top = out[0].score;
  if (top >= STRONG && (out.length === 1 || out[1].score < top - 0.12)) return [out[0]];
  return out.filter((m) => m.score >= top - 0.15).slice(0, MAX_OFFERED);
}

/** Clinics with a report the agent can explain, matched against a spoken name. Best first; empty when nothing is close. */
export async function findClinics(said: string): Promise<ClinicMatch[]> {
  if (nameTokens(said).length === 0) return [];
  const rows = await db()<{ id: string; name: string; site_name: string | null; city: string | null }[]>`
    select c.id, c.name, c.site_name, ci.name as city
    from clinics c left join cities ci on ci.id = c.city_id
    where exists (
      select 1 from reports r where r.clinic_id = c.id and not r.superseded
        and r.kind::text in ('teaser', 'monthly', 'retest', 'full') and coalesce(r.data->>'verified', 'true') <> 'false')`;
  return rankClinics(said, rows.map((r) => ({
    id: r.id, name: r.site_name ?? r.name, aliases: r.site_name && r.site_name !== r.name ? [r.name] : [], city: r.city,
  })));
}
