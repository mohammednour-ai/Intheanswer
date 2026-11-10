import { db } from "../db";
import { env, ownerDetails } from "../env";
import { formatLongDate } from "../time";
import { CHECK_LABELS } from "../pipeline/audit/types";
import type { Evidence } from "../pipeline/audit/types";
import type { NamedClinic } from "../pipeline/match";
import { namesMatch } from "../pipeline/match";
import type { Claim, ReportFinding, ReportRow, TeaserData } from "./types";

/**
 * Builds the teaser's structured content from stored evidence only. Every
 * sentence is assembled from data, and each carries a claim record that the
 * verification gate re-checks.
 */

export const LIMITS_LINE = (assistant: string, model: string, date: string, city: string, questions: number) =>
  `This report reflects one assistant (${assistant}, model ${model}, web search on), ${questions} questions, on one day (${date}), asked through its API from ${city}, Ontario, and what we could read on the clinic's public website that day. Assistants change what they recommend, and results can differ between assistants and apps. No one can guarantee that a clinic will be named.`;

export function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Pick the three most concrete confirmed findings, one per check family. */
export function pickFindings(
  checks: { check_key: string; result: string; is_gap: boolean; severity: number; finding_text: string | null; evidence: Evidence[] }[],
  n = 3,
): ReportFinding[] {
  const family = (k: string) => (k.startsWith("hours") ? "hours" : k);
  const eligible = checks
    .filter((c) => c.is_gap && c.result !== "could_not_verify" && c.finding_text)
    .sort((a, b) => b.severity - a.severity);
  const out: ReportFinding[] = [];
  const used = new Set<string>();
  for (const c of eligible) {
    if (used.has(family(c.check_key))) continue;
    used.add(family(c.check_key));
    out.push({ checkKey: c.check_key, title: CHECK_LABELS[c.check_key] ?? c.check_key, text: c.finding_text!, evidence: c.evidence });
    if (out.length === n) break;
  }
  return out;
}

export async function buildTeaserData(clinicId: string, scoreId: string, reportToken: string): Promise<TeaserData> {
  const sql = db();
  const [s] = await sql<{
    recommended: number; listed_only: number; total: number; audit_id: string; test_run_id: string;
  }[]>`select recommended, listed_only, total, audit_id, test_run_id from scores where id=${scoreId}`;
  const [c] = await sql<{ name: string; site_name: string | null; website: string; domain: string; city: string; sector: string; noun: string; reg: string }[]>`
    select c.name, c.site_name, c.website, c.domain, ci.name as city, se.name as sector, se.patient_noun as noun, se.regulator_note as reg
    from clinics c join cities ci on ci.id=c.city_id join sectors se on se.id=c.sector_id where c.id=${clinicId}`;
  const [run] = await sql<{ assistant: string; model: string; finished_at: Date }[]>`
    select assistant, model, finished_at from test_runs where id=${s.test_run_id}`;
  const answers = await sql<{ id: string; question_index: number; question: string; answer_text: string; clinics_named: NamedClinic[]; served_model: string | null; status: string; matched_as: string | null; evidence: string | null }[]>`
    select a.id, a.question_index, a.question, a.answer_text, a.clinics_named, a.served_model, r.status::text, r.matched_as, r.evidence
    from test_answers a join clinic_test_results r on r.test_answer_id=a.id and r.clinic_id=${clinicId}
    where a.test_run_id=${s.test_run_id} order by a.question_index`;
  const checks = await sql<{ check_key: string; result: string; is_gap: boolean; severity: number; finding_text: string | null; evidence: Evidence[] }[]>`
    select check_key, result::text, is_gap, severity, finding_text, evidence from audit_checks where audit_id=${s.audit_id}`;
  const [audit] = await sql<{ pages_read: string[] }[]>`select pages_read from audits where id=${s.audit_id}`;

  const name = c.site_name ?? c.name;
  const date = formatLongDate(run.finished_at);
  const claims: Claim[] = [];

  const rows: ReportRow[] = answers.map((a) => {
    const namedInstead = a.clinics_named
      .filter((n) => n.status === "recommended")
      .filter((n) => !(namesMatch(n.name, c.name, c.city) || (c.site_name && namesMatch(n.name, c.site_name, c.city))))
      .map((n) => n.name);
    claims.push({
      id: `row-${a.question_index}`,
      where: "row",
      claim: `Question ${a.question_index + 1}: status ${a.status}; named instead: ${namedInstead.join(", ") || "none"}`,
      evidence: [
        { kind: "answer_quote", ref: a.id, label: `Question: ${a.question}` },
        ...(a.evidence ? [{ kind: "answer_quote" as const, ref: a.id, quote: a.evidence, label: `How ${c.site_name ?? c.name} appeared` }] : []),
        ...a.clinics_named
          .filter((n) => n.status === "recommended" && namedInstead.includes(n.name))
          .map((n) => ({ kind: "answer_quote" as const, ref: a.id, quote: n.quote, label: `Recommended: ${n.name}` })),
        ...(!a.evidence ? [{ kind: "answer_quote" as const, ref: a.id, label: `${c.site_name ?? c.name} does not appear in the answer text` }] : []),
      ],
    });
    return {
      questionIndex: a.question_index,
      question: a.question,
      status: a.status as ReportRow["status"],
      matchedAs: a.matched_as,
      namedInstead,
      answerId: a.id,
    };
  });

  const findings = pickFindings(checks);
  findings.forEach((f, i) => claims.push({ id: `finding-${i}`, where: "finding", claim: f.text, evidence: f.evidence }));

  const gaps = checks.filter((x) => x.is_gap && x.result !== "could_not_verify").length;
  const listedPart = s.listed_only ? `, and mentioned it without recommending it in ${s.listed_only}` : "";
  const summary: [string, string] = [
    `We asked ${run.assistant} ${plural(s.total, "question", "questions")} a patient in ${c.city} might ask when looking for a ${c.noun}. It recommended ${name} in ${s.recommended} of them${listedPart}.`,
    `On the ${plural(audit.pages_read.length, "page", "pages")} we read on ${c.domain}, we found ${plural(gaps, "gap", "gaps")} in what the site states for patients and for the tools assistants use to read it. The three most concrete are below.`,
  ];
  claims.push({ id: "summary-0", where: "summary", claim: summary[0], evidence: [{ kind: "answer_quote", label: `score ${s.recommended}/${s.total}, listed ${s.listed_only}` }] });
  claims.push({ id: "summary-1", where: "summary", claim: summary[1], evidence: [{ kind: "pages_read", label: `${audit.pages_read.length} pages; ${gaps} confirmed gaps` }] });

  const servedModels = [...new Set(answers.map((a) => a.served_model ?? run.model))];
  const owner = ownerDetails();
  const base = env().APP_URL;
  return {
    kind: "teaser",
    clinic: { id: clinicId, name, city: c.city, website: c.website, domain: c.domain },
    sector: { name: c.sector, patientNoun: c.noun, regulatorNote: c.reg },
    test: { assistant: run.assistant, model: run.model, servedModels, date, dateIso: run.finished_at.toISOString(), questionCount: s.total },
    score: { recommended: s.recommended, listedOnly: s.listed_only, total: s.total },
    summary,
    rows,
    findings,
    pagesRead: audit.pages_read.length,
    offers: { oneTimeUrl: `${base}/buy/${reportToken}/report`, monthlyUrl: `${base}/buy/${reportToken}/monthly`, minTerm: owner.minTerm },
    limits: LIMITS_LINE(run.assistant, servedModels.join(", "), date, c.city, s.total),
    findingsTotal: gaps,
    owner: { name: owner.name, businessName: owner.businessName, mailingAddress: owner.mailingAddress, phone: owner.phone, email: owner.email },
    claims,
  };
}
