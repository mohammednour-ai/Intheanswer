import { db } from "../db";
import type { JobContext } from "../jobs/queue";
import { PermanentJobError, DeferJob } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { matchClinic, type NamedClinic } from "./match";
import { updateClinicPriority } from "../sending/priority";
import { handOverRetestScore, type RetestContext } from "../retests/handover";

/**
 * Step 5: score = number of questions where the clinic was recommended.
 * Continue only with a real gap: at least two questions not recommended AND at
 * least three confirmed site findings. Others are parked.
 *
 * A customer is different: it is scored, never parked and never sent a teaser.
 * When the score belongs to a retest (payload.retest, set by the monthly retest
 * and the retest after a purchase) it is handed to that retest's report job.
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
  const { clinicId, auditId, testRunId, force, runLabel, retest } = ctx.job.payload as {
    clinicId: string; auditId: string; testRunId: string; force?: boolean; runLabel?: string; retest?: RetestContext;
  };
  const sql = db();
  // The site test feeds the teaser. Wait for it (finished or failed) for up to
  // 30 minutes; after that the clinic continues without that section.
  if (runLabel) {
    const [st] = await sql<{ status: string | null; job_status: string | null; created: Date | null }[]>`
      select (select status from site_test_runs where clinic_id=${clinicId} and run_label=${runLabel}) as status,
             (select status::text from jobs where idempotency_key=${`sitetest:${clinicId}:${runLabel}`}) as job_status,
             (select created_at from jobs where idempotency_key=${`sitetest:${clinicId}:${runLabel}`}) as created`;
    const pending = !st.status && st.job_status && ["queued", "running"].includes(st.job_status);
    if (pending && st.created && Date.now() - st.created.getTime() < 30 * 60e3) throw new DeferJob(60, "waiting for the site test");
  }
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
  const priority = await updateClinicPriority(clinicId, auditId, rec, results.length);
  const [src] = await sql<{ source: string; status: string }[]>`select source, status::text from clinics where id=${clinicId}`;
  if (retest || src?.status === "customer") {
    // Never parked, never a teaser. The clinic's status is left as it is.
    const next = retest ? await handOverRetestScore(ctx.enqueue, { clinicId, scoreId: score.id, testRunId, runLabel: runLabel ?? null, retest }) : null;
    if (runLabel && /^\d{4}-\d{2}$/.test(runLabel)) {
      await ctx.enqueue("propose_pages", `pages:${clinicId}:${runLabel}`, { clinicId, runLabel, testRunId }, { maxAttempts: 2 });
    }
    return { score: `${rec} of ${results.length}`, findings: f.n, customer: true, next };
  }
  const selfServe = src?.source === "self_serve"; // the clinic asked for it: never parked
  if (!q.ok && !force && !selfServe) {
    await sql`update clinics set status='parked', status_reason=${q.reason}, updated_at=now() where id=${clinicId}`;
    return { parked: q.reason, score: `${rec} of ${results.length}` };
  }
  await ctx.enqueue("build_teaser", `teaser:${score.id}`, { clinicId, scoreId: score.id, ...(selfServe ? { messageType: "self_serve_teaser" } : {}) });
  if (runLabel) await ctx.enqueue("propose_pages", `pages:${clinicId}:${runLabel}`, { clinicId, runLabel, testRunId }, { maxAttempts: 2 });
  return { score: `${rec} of ${results.length}`, findings: f.n, priority: priority.score, next: "build_teaser" };
}

register("score_clinic", handleScore);
