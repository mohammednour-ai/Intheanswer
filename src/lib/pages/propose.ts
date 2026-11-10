import { db } from "../db";
import { SERVICE_WORDS } from "../reviews/serviceWords";
import { INTENTS, intentFor, fill, slugify, PRESCRIPTION_RE } from "./intents";

/**
 * Propose the answer pages a clinic is missing: one per common patient
 * question and one per service the clinic offers, where the site has no page
 * that covers it. Inputs: the question set (and test results when present),
 * the pages read in the site test, and the services named in the test answers.
 */

export interface PageSiteFacts {
  pages: { url: string; title: string; h1: string[]; text: string }[];
}

export interface ProposalInput {
  clinic: string;
  city: string;
  sector: string;
  questions: { index: number; text: string; status: "recommended" | "listed_only" | "not_named" | null }[];
  site: PageSiteFacts;
  /** service words the assistant used about other clinics, with counts */
  competitorWords: { word: string; count: number }[];
}

export interface Proposal {
  kind: "question" | "service";
  intent: string;
  targetQuestion: string;
  questionIndex: number | null;
  service: string | null;
  title: string;
  slug: string;
  priority: number;
  reason: string;
  evidence: { kind: string; url?: string; label: string }[];
}

function coveredBy(site: PageSiteFacts, re: RegExp): string | null {
  const hit = site.pages.find((p) => re.test(new URL(p.url).pathname) || re.test(p.title) || p.h1.some((h) => re.test(h)));
  return hit ? hit.url : null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Page names for service words that are not nouns on their own. */
const SERVICE_NAMES: Record<string, string> = {
  pediatric: "Care for children",
  children: "Care for children",
  kids: "Care for children",
  "women's health": "Women's health care",
  "laser hair removal": "Laser hair removal",
  ecg: "ECG testing",
  "blood work": "Blood work",
  ipl: "IPL treatment",
  prp: "PRP treatment",
};

export function proposePages(input: ProposalInput, max = 10): Proposal[] {
  const out: Proposal[] = [];
  const v = { clinic: input.clinic, city: input.city };
  for (const q of input.questions) {
    const t = intentFor(q.text);
    if (!t || out.some((p) => p.intent === t.intent)) continue;
    const covered = coveredBy(input.site, t.covered);
    const notRecommended = q.status !== null && q.status !== "recommended";
    if (covered && !notRecommended) continue;
    let priority = 50;
    const why: string[] = [];
    const evidence: Proposal["evidence"] = [];
    if (notRecommended) {
      priority += 30;
      why.push(`the clinic was ${q.status === "listed_only" ? "listed but not recommended" : "not named"} for this question`);
      evidence.push({ kind: "test", label: `question ${q.index + 1}: ${q.status}` });
    }
    if (!covered) {
      priority += 20;
      why.push(`none of the ${input.site.pages.length} pages read has a page on this topic`);
      evidence.push({ kind: "pages_read", label: `${input.site.pages.length} pages checked for: ${t.covered.source}` });
    } else {
      evidence.push({ kind: "page", url: covered, label: "existing page on this topic (the new page would answer the question directly)" });
    }
    const title = fill(t.title, v);
    out.push({ kind: "question", intent: t.intent, targetQuestion: q.text, questionIndex: q.index, service: null, title, slug: slugify(title), priority, reason: cap(why.join("; ")) + ".", evidence });
  }

  // services the clinic mentions on its own site but has no page for
  const allText = input.site.pages.map((p) => p.text.toLowerCase()).join("\n");
  const generic = new Set(["new patients", "family", "evening", "saturday", "weekend", "prices", "fees", "insurance", "direct billing", "accepting", "children", "kids", "emergency", "same-day", "walk-in", "virtual", "forms", "physical", "pricing", "consultation", "nurse", "physician", "doctor", "registered", "packages", "membership", "ohip", "no appointment", "booking online", "wait time", "cdcp", "payment plan", "lab", "family doctor", "sick note"]);
  const weights = new Map(input.competitorWords.map((w) => [w.word, w.count]));
  for (const s of SERVICE_WORDS[input.sector] ?? []) {
    if (generic.has(s) || !allText.includes(s)) continue;
    if (coveredBy(input.site, new RegExp(s.replace(/[-\s]+/g, "[- ]?"), "i"))) continue;
    const comp = weights.get(s) ?? 0;
    const service = SERVICE_NAMES[s] ?? cap(s);
    const title = fill("{service} at {clinic} in {city}: what to expect", { ...v, service });
    out.push({
      kind: "service", intent: "service", targetQuestion: `Where can I get ${s} in ${input.city}?`, questionIndex: null, service,
      title, slug: slugify(title), priority: 30 + Math.min(20, comp * 5) + (PRESCRIPTION_RE.test(s) ? -10 : 0),
      reason: `The site mentions ${s === service.toLowerCase() ? s : `${s} (${service.toLowerCase()})`} but has no page about it${comp ? `; the assistant mentioned ${s} ${comp} time(s) when naming other clinics` : ""}.`,
      evidence: [{ kind: "pages_read", label: `"${s}" appears in the site text; no page URL, title or heading is about it` }],
    });
  }
  return out.sort((a, b) => b.priority - a.priority).slice(0, max);
}

/** Assign planned months: pagesPerMonth per month, starting next month. */
export function planMonths(n: number, pagesPerMonth: number, from = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1 + Math.floor(i / Math.max(1, pagesPerMonth)), 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export async function saveProposals(clinicId: string, proposals: Proposal[], pagesPerMonth: number) {
  const sql = db();
  const months = planMonths(proposals.length, pagesPerMonth);
  const ids: string[] = [];
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const [row] = await sql<{ id: string }[]>`
      insert into answer_pages (clinic_id, kind, intent, target_question, question_index, service, title, slug, priority, reason, evidence, planned_month)
      values (${clinicId}, ${p.kind}, ${p.intent}, ${p.targetQuestion}, ${p.questionIndex}, ${p.service}, ${p.title}, ${p.slug},
              ${p.priority}, ${p.reason}, ${sql.json(p.evidence as never)}, ${months[i]})
      on conflict (clinic_id, slug) do update set priority=excluded.priority, reason=excluded.reason, evidence=excluded.evidence, updated_at=now()
      returning id`;
    ids.push(row.id);
    await sql`insert into answer_page_events (page_id, from_status, to_status, actor, note)
              select ${row.id}, null, 'proposed', 'system', ${p.reason}
              where not exists (select 1 from answer_page_events where page_id=${row.id})`;
  }
  return ids;
}

export { INTENTS };
