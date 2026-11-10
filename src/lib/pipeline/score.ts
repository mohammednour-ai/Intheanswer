import { db } from "../db";
import type { JobContext } from "../jobs/queue";
import { PermanentJobError } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { matchClinic, type NamedClinic } from "./match";

/**
 * Step 5: score = number of questions where the clinic was recommended.
 * Continue only with a real gap: at least two questions not recommended AND at
 * least three confirmed site findings. Others are parked.
 */

export function qualifies(total: number, recommended: number, confirmedFindings: number): { ok: boolean; reason: string } {
  const notRecommended = total - recommended;
  if (notRecommended < 2) return { ok: false, reason: `recommended in ${recommended} of ${total}: no real gap` };
  if (confirmedFindings < 3) return { ok: false, reason: `only ${confirmedFindings} confirmed site finding(s); need 3` };
  return { ok: true, reason: `not recommended in ${notRecommended} of ${total}; ${confirmedFindings} confirmed findings` };
}

export async function computeClinicResults(clinicId: string, testRunId: string) {
  const sql = db();
  const [c] = await sql<{ name: string; site_name: string | null; domain: string | null; city: string }[]>`
    select c.name, c.site_name, c.domain, ci.name as city from clinics c join cities ci on ci.id=c.city_id where c.id=${clinicId}`;
  const answers = await sql<{ id: string; answer_text: string; clinics_named: NamedClinic[]; sources: { url: string; cited: boolean }[] }[]>`
    select id, answer_text, clinics_named, sources from test_answers where test_run_id=${testRunId} order by question_index`;
  const results = answers.map((a) => ({
    answerId: a.id,
    ...matchClinic(
      { clinicName: c.name, siteName: c.site_name, domain: c.domain, city: c.city },
      { text: a.answer_text, named: a.clinics_named, citedUrls: a.sources.filter((s) => s.cited).map((s) => s.url) },
    ),
  }));
  for (const r of results) {
    await sql`insert into clinic_test_results (clinic_id, test_answer_id, status, matched_as, evidence)
              values (${clinicId}, ${r.answerId}, ${r.status}, ${r.matchedAs}, ${r.evidence})
              on conflict (clinic_id, test_answer_id) do update set status=excluded.status, matched_as=excluded.matched_as, evidence=excluded.evidence`;
  }
  return results;
}

async function handleScore(ctx: JobContext) {
  const { clinicId, auditId, testRunId, force } = ctx.job.payload as { clinicId: string; auditId: string; testRunId: string; force?: boolean };
  const sql = db();
  const results = await computeClinicResults(clinicId, testRunId);
  if (results.length === 0) throw new PermanentJobError("test run has no answers");
  const rec = results.filter((r) => r.status === "recommended").length;
  const listed = results.filter((r) => r.status === "listed_only").length;
  const [f] = await sql<{ n: number }[]>`
    select count(*)::int as n from audit_checks where audit_id=${auditId} and is_gap and result <> 'could_not_verify'`;
  const q = qualifies(results.length, rec, f.n);
  const [score] = await sql<{ id: string }[]>`
    insert into scores (clinic_id, test_run_id, audit_id, recommended, listed_only, not_named, total, confirmed_findings, qualifies, reason)
    values (${clinicId}, ${testRunId}, ${auditId}, ${rec}, ${listed}, ${results.length - rec - listed}, ${results.length}, ${f.n}, ${q.ok}, ${q.reason})
    on conflict (clinic_id, test_run_id, audit_id) do update set recommended=excluded.recommended, listed_only=excluded.listed_only,
      not_named=excluded.not_named, confirmed_findings=excluded.confirmed_findings, qualifies=excluded.qualifies, reason=excluded.reason
    returning id`;
  if (!q.ok && !force) {
    await sql`update clinics set status='parked', status_reason=${q.reason}, updated_at=now() where id=${clinicId}`;
    return { parked: q.reason, score: `${rec} of ${results.length}` };
  }
  await ctx.enqueue("build_teaser", `teaser:${score.id}`, { clinicId, scoreId: score.id });
  return { score: `${rec} of ${results.length}`, findings: f.n, next: "build_teaser" };
}

register("score_clinic", handleScore);
