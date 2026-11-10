import { z } from "zod";
import { structured, type UsageLike } from "../../adapters/claude";
import type { SiteRead } from "../../site/crawl";
import { textContains } from "../../site/parse";
import { formatLongDate } from "../../time";
import type { CheckOutcome, Evidence } from "./types";

/**
 * Checks that need reading comprehension. Claude reads the text of the pages
 * we fetched and must quote them exactly. Every quote is then checked against
 * the stored page text; an unverifiable "found" becomes could_not_verify, and
 * "not found" is only stated when the site was readable.
 */

const Q = z.object({ quote: z.string(), url: z.string() });

export const SemanticSchema = z.object({
  site_name: z.object({ value: z.string(), quote: z.string(), url: z.string() }).nullable(),
  address: z.object({ value: z.string(), quote: z.string(), url: z.string() }).nullable(),
  phone: z.object({ value: z.string(), quote: z.string(), url: z.string() }).nullable(),
  questions: z.array(z.object({ index: z.number().int(), answered: z.boolean(), quote: z.string(), url: z.string() })),
  new_patients: z.object({
    status: z.enum(["accepting", "not_accepting", "waitlist", "other", "not_stated"]),
    quote: z.string(),
    url: z.string(),
  }),
  hours: z.object({
    blocks: z.array(z.object({ text: z.string(), url: z.string() })),
    conflict: z.object({
      exists: z.boolean(),
      a: Q.nullable(),
      b: Q.nullable(),
      explanation: z.string(),
    }),
  }),
  fees: z.object({ published: z.boolean(), quotes: z.array(Q) }),
  insurance: z.object({
    stated: z.boolean(),
    direct_billing: z.enum(["yes", "no", "not_stated"]),
    quotes: z.array(Q),
  }),
  practitioners: z.object({ named: z.boolean(), with_credentials: z.boolean(), quotes: z.array(Q) }),
  languages: z.object({ stated: z.boolean(), quotes: z.array(Q) }),
  areas_served: z.object({ stated: z.boolean(), quotes: z.array(Q) }),
  outdated: z.array(z.object({ quote: z.string(), url: z.string(), reason: z.string() })),
});
export type SemanticRead = z.infer<typeof SemanticSchema>;

const SYSTEM = `You audit a clinic's website text for a factual report. You only report what the text says.
Hard rules:
- Every quote must be copied character for character from the page text given, 3 to 40 words, from the page whose URL you give. If you cannot quote it, treat it as not stated.
- Never infer, never assume, never use outside knowledge about the clinic.
- "answered" for a patient question means the site text directly states the information a patient needs for that question (not merely a related page title or a "contact us").
- Hours: list each distinct block of opening hours you see. A conflict exists only when two blocks give different hours for the same day and service, and you can quote both.
- Fees: published means at least one specific price in dollars for a service.
- Outdated notices: only notices that are clearly out of date given today's date (a date that has passed, a past year's holiday schedule, pandemic-era rules such as mandatory masks or screening). Give the reason.`;

export function buildCorpus(site: SiteRead, maxPerPage = 12000, maxTotal = 90000): string {
  let total = 0;
  const parts: string[] = [];
  for (const p of site.pages) {
    const t = p.text.slice(0, maxPerPage);
    if (total + t.length > maxTotal) break;
    total += t.length;
    parts.push(`<page url="${p.url}">\n${t}\n</page>`);
  }
  return parts.join("\n\n");
}

export async function readSemantics(site: SiteRead, clinicName: string, questions: string[], now = new Date()) {
  const user = `Today's date: ${formatLongDate(now)}.
Clinic: ${clinicName}

Patient questions (index: question):
${questions.map((q, i) => `${i}: ${q}`).join("\n")}

Website pages:
${buildCorpus(site)}`;
  return structured({ purpose: "audit", system: SYSTEM, user, schema: SemanticSchema, effort: "medium" });
}

// ---------------------------------------------------------------------------
// Turning Claude's reading into verified check outcomes
// ---------------------------------------------------------------------------

/** Find the page that really contains the quote (Claude may cite the wrong URL). */
export function locate(site: SiteRead, quote: string, url?: string): string | null {
  if (!quote || quote.trim().length < 3) return null;
  const preferred = site.pages.find((p) => p.url === url);
  if (preferred && textContains(preferred.text, quote)) return preferred.url;
  const any = site.pages.find((p) => textContains(p.text, quote));
  return any ? any.url : null;
}

function verifiedQuotes(site: SiteRead, qs: { quote: string; url: string }[]): Evidence[] {
  const out: Evidence[] = [];
  for (const q of qs) {
    const u = locate(site, q.quote, q.url);
    if (u) out.push({ kind: "page_quote", url: u, quote: q.quote });
  }
  return out;
}

function pagesRead(site: SiteRead): Evidence {
  return { kind: "pages_read", label: site.pages.map((p) => p.url).join(" ") };
}

function cannot(key: string, why: string, site: SiteRead): CheckOutcome {
  return { key, result: "could_not_verify", isGap: false, severity: 0, summary: why, evidence: [pagesRead(site)] };
}

export interface SemanticContext {
  sector: "dental" | "family" | "medspa" | string;
  questions: string[];
  domain: string;
}

export function semanticChecks(site: SiteRead, r: SemanticRead, ctx: SemanticContext): CheckOutcome[] {
  const n = site.pages.length;
  const where = `the ${n} page${n === 1 ? "" : "s"} we read on ${ctx.domain}`;
  if (!site.readable) {
    const why = "The site renders too little text without a browser to check this.";
    return ["questions_answered", "new_patients", "hours", "hours_conflict", "fees", "insurance_billing", "practitioners", "languages", "areas_served", "outdated_notices"].map(
      (k) => cannot(k, why, site),
    );
  }
  const out: CheckOutcome[] = [];

  // questions answered in text
  const answered: { q: string; ev: Evidence }[] = [];
  const unanswered: string[] = [];
  ctx.questions.forEach((q, i) => {
    const a = r.questions.find((x) => x.index === i);
    const u = a?.answered ? locate(site, a.quote, a.url) : null;
    if (u && a) answered.push({ q, ev: { kind: "page_quote", url: u, quote: a.quote, label: q } });
    else unanswered.push(q);
  });
  out.push({
    key: "questions_answered",
    result: answered.length === ctx.questions.length ? "found" : "not_found",
    isGap: unanswered.length >= 2,
    severity: unanswered.length >= 3 ? 72 : 45,
    summary: `${answered.length} of ${ctx.questions.length} patient questions are answered in the text of ${where}.`,
    evidence: [...answered.map((a) => a.ev), { ...pagesRead(site), label: `not answered in text: ${unanswered.join(" | ")}` }],
    findingText:
      unanswered.length > 0
        ? `Of the ${ctx.questions.length} questions patients asked, ${answered.length} ${answered.length === 1 ? "is" : "are"} answered in plain text on ${where}. Not found: ${unanswered
            .map((q) => `"${q}"`)
            .join("; ")}.`
        : undefined,
  });

  // new patients
  {
    const u = r.new_patients.status !== "not_stated" ? locate(site, r.new_patients.quote, r.new_patients.url) : null;
    if (u)
      out.push({
        key: "new_patients", result: "found", isGap: false, severity: 0,
        summary: "The site states whether new patients are accepted.",
        evidence: [{ kind: "page_quote", url: u, quote: r.new_patients.quote }],
      });
    else
      out.push({
        key: "new_patients", result: "not_found", isGap: ctx.sector !== "medspa", severity: 80,
        summary: `No statement about accepting new patients was found on ${where}.`,
        evidence: [pagesRead(site)],
        findingText: `We did not find a statement on ${where} saying whether you are accepting new patients.`,
      });
  }

  // hours + conflict
  {
    const blocks = r.hours.blocks.map((b) => ({ ...b, u: locate(site, b.text, b.url) })).filter((b) => b.u);
    out.push(
      blocks.length
        ? {
            key: "hours", result: "found", isGap: false, severity: 0,
            summary: "Opening hours are stated in the site text.",
            evidence: blocks.slice(0, 3).map((b) => ({ kind: "page_quote" as const, url: b.u!, quote: b.text })),
          }
        : {
            key: "hours", result: "not_found", isGap: true, severity: 70,
            summary: `No opening hours were found in the text of ${where}.`,
            evidence: [pagesRead(site)],
            findingText: `We did not find your opening hours written as text on ${where} (hours shown only in an image or a booking widget are not read as text).`,
          },
    );
    const c = r.hours.conflict;
    const ua = c.exists && c.a ? locate(site, c.a.quote, c.a.url) : null;
    const ub = c.exists && c.b ? locate(site, c.b.quote, c.b.url) : null;
    if (c.exists && c.a && c.b && ua && ub && c.a.quote.trim() !== c.b.quote.trim()) {
      out.push({
        key: "hours_conflict", result: "found", isGap: true, severity: 90,
        summary: `Two different sets of hours appear: ${c.explanation}`,
        evidence: [
          { kind: "page_quote", url: ua, quote: c.a.quote },
          { kind: "page_quote", url: ub, quote: c.b.quote },
        ],
        findingText: `Two different sets of hours appear on your site: "${c.a.quote}" (${ua}) and "${c.b.quote}" (${ub}).`,
      });
    } else if (c.exists) {
      out.push(cannot("hours_conflict", "A possible hours conflict could not be confirmed with exact quotes.", site));
    } else {
      out.push({
        key: "hours_conflict", result: "not_found", isGap: false, severity: 0,
        summary: blocks.length > 1 ? "The hours that appear on different pages agree." : "Only one set of hours appears.",
        evidence: [pagesRead(site)],
      });
    }
  }

  // fees
  {
    const ev = verifiedQuotes(site, r.fees.quotes).filter((e) => /\$\s?\d/.test(e.quote ?? ""));
    const label = ctx.sector === "medspa" ? "prices for treatments" : "fees for services not covered by insurance";
    out.push(
      r.fees.published && ev.length
        ? { key: "fees", result: "found", isGap: false, severity: 0, summary: "At least one price is published.", evidence: ev.slice(0, 3) }
        : {
            key: "fees", result: "not_found", isGap: true, severity: 75,
            summary: `No ${label} were found on ${where}.`,
            evidence: [pagesRead(site)],
            findingText: `We did not find any ${label} on ${where}. Patients asked about cost directly.`,
          },
    );
  }

  // insurance and direct billing (not for medspas)
  if (ctx.sector !== "medspa") {
    const ev = verifiedQuotes(site, r.insurance.quotes);
    out.push(
      r.insurance.stated && ev.length
        ? {
            key: "insurance_billing", result: "found", isGap: false, severity: 0,
            summary: r.insurance.direct_billing === "yes" ? "The site states insurance and direct billing information." : "The site states insurance information.",
            evidence: ev.slice(0, 3),
          }
        : {
            key: "insurance_billing", result: "not_found", isGap: true, severity: 60,
            summary: `No information about insurance or direct billing was found on ${where}.`,
            evidence: [pagesRead(site)],
            findingText: `We did not find whether you bill insurance directly on ${where}.`,
          },
    );
  }

  // practitioners
  {
    const ev = verifiedQuotes(site, r.practitioners.quotes);
    if (r.practitioners.named && ev.length) {
      out.push(
        r.practitioners.with_credentials
          ? { key: "practitioners", result: "found", isGap: false, severity: 0, summary: "Practitioners are named with their credentials.", evidence: ev.slice(0, 4) }
          : {
              key: "practitioners", result: "found", isGap: true, severity: 45,
              summary: "Practitioners are named but their credentials were not found next to their names.",
              evidence: ev.slice(0, 4),
              findingText: `Your practitioners are named on the site, but we did not find their credentials (for example degree or college registration) next to their names.`,
            },
      );
    } else {
      out.push({
        key: "practitioners", result: "not_found", isGap: true, severity: 55,
        summary: `No practitioner names were found on ${where}.`,
        evidence: [pagesRead(site)],
        findingText: `We did not find the names of the practitioners who see patients on ${where}.`,
      });
    }
  }

  // languages, areas served
  for (const [key, val, label, sev] of [
    ["languages", r.languages, "the languages spoken at the clinic", 30],
    ["areas_served", r.areas_served, "the neighbourhoods or towns you serve", 30],
  ] as const) {
    const ev = verifiedQuotes(site, val.quotes);
    out.push(
      val.stated && ev.length
        ? { key, result: "found", isGap: false, severity: 0, summary: `The site states ${label}.`, evidence: ev.slice(0, 3) }
        : {
            key, result: "not_found", isGap: true, severity: sev,
            summary: `No mention of ${label} was found on ${where}.`,
            evidence: [pagesRead(site)],
            findingText: `We did not find ${label} on ${where}.`,
          },
    );
  }

  // outdated notices
  {
    const ok = r.outdated
      .map((o) => ({ ...o, u: locate(site, o.quote, o.url) }))
      .filter((o) => o.u && /(covid|pandemic|mask|screening|20[0-2]\d|holiday|christmas|easter|thanksgiving|closed)/i.test(o.quote));
    out.push(
      ok.length
        ? {
            key: "outdated_notices", result: "found", isGap: true, severity: 70,
            summary: `${ok.length} notice${ok.length > 1 ? "s" : ""} that appear out of date: ${ok.map((o) => o.reason).join("; ")}`,
            evidence: ok.map((o) => ({ kind: "page_quote" as const, url: o.u!, quote: o.quote, label: o.reason })),
            findingText: `Your site still shows a notice that appears out of date: "${ok[0].quote}" (${ok[0].u}).`,
          }
        : { key: "outdated_notices", result: "not_found", isGap: false, severity: 0, summary: "No outdated notices were seen.", evidence: [pagesRead(site)] },
    );
  }
  return out;
}

export type { UsageLike };
