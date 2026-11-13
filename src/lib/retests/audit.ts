import { db } from "../db";
import type { JobContext } from "../jobs/queue";
import { DeferJob, PermanentJobError } from "../jobs/queue";
import { readSite } from "../site/crawl";
import { getRobots } from "../adapters/http";
import { checkAddressOnHome, checkAiCrawlers, checkContactEmail, checkMetaDescription, checkStructuredData } from "../pipeline/audit/deterministic";
import { readSemantics, semanticChecks, locate } from "../pipeline/audit/semantic";
import { checkDirectories, isDirectory } from "../pipeline/audit/directories";
import { findTestRun, testJobState } from "../pipeline/audit/run";
import type { CheckOutcome } from "../pipeline/audit/types";

/**
 * The site audit for a clinic that is already a customer (monthly retest and
 * the retest after a one-time purchase).
 *
 * The prospect audit job (`audit_clinic`) deliberately leaves customers alone,
 * and it moves a clinic through the outreach statuses. A retest needs the same
 * checks with neither: the checks below are the ones `audit_clinic` runs, the
 * result is stored the same way (audits + audit_checks, older audits marked
 * superseded), and the clinic's status and name are not touched.
 *
 * Keep the list of checks in step with src/lib/pipeline/audit/run.ts.
 */
export interface RetestAudit {
  auditId: string;
  testRunId: string;
  pages: number;
}

/** The finished city test for this run label; defers while it runs, fails for good if its job is dead. */
export async function finishedTestRun(sectorId: number, cityId: number, runLabel: string): Promise<{ id: string }> {
  const run = await findTestRun(sectorId, cityId, runLabel);
  if (run?.finished_at) return { id: run.id };
  const job = await testJobState(sectorId, cityId, runLabel);
  if (job?.status === "dead" || job?.status === "cancelled") {
    throw new PermanentJobError(`the city test for this run did not complete (${(job.last_error ?? "test job " + job.status).slice(0, 300)})`);
  }
  throw new DeferJob(120, "waiting for the city test run");
}

export async function runRetestAudit(ctx: JobContext, clinicId: string, testRunId: string): Promise<RetestAudit> {
  const sql = db();
  const [c] = await sql<{ name: string; website: string | null; city: string; sector_slug: string }[]>`
    select c.name, c.website, ci.name as city, s.slug as sector_slug
    from clinics c join cities ci on ci.id=c.city_id join sectors s on s.id=c.sector_id where c.id=${clinicId}`;
  if (!c) throw new PermanentJobError("clinic not found");
  if (!c.website) throw new PermanentJobError("clinic has no website");

  const site = await readSite(c.website);
  // A site that is down today is retried with the job's backoff; it is never reported as a finding.
  if (!site.home) throw new Error("the clinic's site could not be read for the retest audit");
  const [primary] = await sql<{ email: string; source_url: string; on_own_domain: boolean }[]>`
    select email, source_url, on_own_domain from contacts where clinic_id=${clinicId} and is_primary limit 1`;
  const robots = await getRobots(new URL(site.website).origin);

  const checks: CheckOutcome[] = [
    checkMetaDescription(site),
    checkStructuredData(site),
    checkAddressOnHome(site),
    checkContactEmail(site, primary ? { email: primary.email, sourceUrl: primary.source_url, onOwnDomain: primary.on_own_domain } : null),
    checkAiCrawlers(site, robots.txt),
  ];
  const answers = await sql<{ question: string; sources: { url: string; cited: boolean }[] }[]>`
    select question, sources from test_answers where test_run_id=${testRunId} order by question_index`;
  const questions = answers.map((a) => a.question);
  const sem = await readSemantics(site, c.name, questions);
  await ctx.cost({ provider: "anthropic", operation: "audit_read", units: sem.usage as never, costUsd: sem.costUsd, clinicId });
  checks.push(...semanticChecks(site, sem.data, { sector: c.sector_slug, questions, domain: site.domain }));

  const siteName = sem.data.site_name && locate(site, sem.data.site_name.quote, sem.data.site_name.url) ? sem.data.site_name.value : null;
  const sitePhone = sem.data.phone && locate(site, sem.data.phone.quote, sem.data.phone.url) ? sem.data.phone.value : null;
  const siteAddress = sem.data.address && locate(site, sem.data.address.quote, sem.data.address.url) ? sem.data.address.value : null;
  const dirUrls = answers.flatMap((a) => a.sources.filter((s) => s.cited && isDirectory(s.url)).map((s) => s.url));
  const dir = await checkDirectories({ clinicName: c.name, siteName, sitePhone, siteAddress, domain: site.domain, city: c.city, directoryUrls: dirUrls });
  if (dir.usage) await ctx.cost({ provider: "anthropic", operation: "directory_read", units: dir.usage as never, costUsd: dir.costUsd, clinicId });
  checks.push(dir.outcome);

  const auditId = await sql.begin(async (tx) => {
    await tx`update audits set superseded = true where clinic_id=${clinicId}`;
    const [a] = await tx<{ id: string }[]>`
      insert into audits (clinic_id, pages_read) values (${clinicId}, ${site.pages.map((p) => p.url)}) returning id`;
    for (const ch of checks) {
      await tx`insert into audit_checks (audit_id, check_key, result, summary, evidence, is_gap, severity, finding_text)
               values (${a.id}, ${ch.key}, ${ch.result}, ${ch.summary}, ${tx.json(ch.evidence as never)}, ${ch.isGap},
                       ${ch.severity}, ${ch.findingText ?? null})`;
    }
    return a.id;
  });
  return { auditId, testRunId, pages: site.pages.length };
}
