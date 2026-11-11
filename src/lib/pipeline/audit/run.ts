import { db } from "../../db";
import type { JobContext } from "../../jobs/queue";
import { DeferJob, PermanentJobError } from "../../jobs/queue";
import { register } from "../../jobs/handlers";
import { readSite } from "../../site/crawl";
import { getRobots } from "../../adapters/http";
import { checkAddressOnHome, checkAiCrawlers, checkContactEmail, checkMetaDescription, checkStructuredData } from "./deterministic";
import { readSemantics, semanticChecks, locate } from "./semantic";
import { checkDirectories, isDirectory } from "./directories";
import type { CheckOutcome } from "./types";
import { env } from "../../env";

/**
 * Step 4: audit the clinic's site and store every check with evidence.
 * Waits until the city's test run (step 3) has finished, because the
 * directory check uses the sources the assistant cited.
 */

export async function findTestRun(sectorId: number, cityId: number, runLabel: string) {
  const [r] = await db()<{ id: string; finished_at: Date | null }[]>`
    select t.id, t.finished_at from test_runs t
    where t.sector_id=${sectorId} and t.city_id=${cityId} and t.run_label=${runLabel}
    order by t.started_at desc limit 1`;
  return r ?? null;
}

async function handleAudit(ctx: JobContext) {
  const { clinicId, runLabel } = ctx.job.payload as { clinicId: string; runLabel: string };
  const sql = db();
  const [c] = await sql<{ id: string; name: string; website: string; sector_id: number; city_id: number; city: string; sector_slug: string }[]>`
    select c.id, c.name, c.website, c.sector_id, c.city_id, ci.name as city, s.slug as sector_slug
    from clinics c join cities ci on ci.id=c.city_id join sectors s on s.id=c.sector_id where c.id=${clinicId}`;
  if (!c) throw new PermanentJobError("clinic not found");
  const run = await findTestRun(c.sector_id, c.city_id, runLabel);
  if (!run || !run.finished_at) throw new DeferJob(120, "waiting for the city test run");

  const site = await readSite(c.website);
  if (!site.home) {
    await sql`update clinics set status='parked', status_reason='site could not be read for the audit', updated_at=now() where id=${clinicId}`;
    return { parked: "site unreadable" };
  }
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

  // semantic checks over the question set (generic form of each question for this city)
  const answers = await sql<{ question: string; sources: { url: string; cited: boolean }[] }[]>`
    select question, sources from test_answers where test_run_id=${run.id} order by question_index`;
  const questions = answers.map((a) => a.question);
  const sem = await readSemantics(site, c.name, questions);
  await ctx.cost({ provider: "anthropic", operation: "audit_read", units: sem.usage as never, costUsd: sem.costUsd, clinicId });
  checks.push(...semanticChecks(site, sem.data, { sector: c.sector_slug, questions, domain: site.domain }));

  // facts confirmed on the clinic's own site (with exact quotes)
  const siteName = sem.data.site_name && locate(site, sem.data.site_name.quote, sem.data.site_name.url) ? sem.data.site_name.value : null;
  const sitePhone = sem.data.phone && locate(site, sem.data.phone.quote, sem.data.phone.url) ? sem.data.phone.value : null;
  const siteAddress = sem.data.address && locate(site, sem.data.address.quote, sem.data.address.url) ? sem.data.address.value : null;

  // directory consistency, using directories the assistant itself cited
  const dirUrls = answers.flatMap((a) => a.sources.filter((s) => s.cited && isDirectory(s.url)).map((s) => s.url));
  const dir = await checkDirectories({ clinicName: c.name, siteName, sitePhone, siteAddress, domain: site.domain, city: c.city, directoryUrls: dirUrls });
  if (dir.usage) await ctx.cost({ provider: "anthropic", operation: "directory_read", units: dir.usage as never, costUsd: dir.costUsd, clinicId });
  checks.push(dir.outcome);

  const audit = await sql.begin(async (tx) => {
    await tx`update audits set superseded = true where clinic_id=${clinicId}`;
    const [a] = await tx<{ id: string }[]>`
      insert into audits (clinic_id, pages_read) values (${clinicId}, ${site.pages.map((p) => p.url)}) returning id`;
    for (const ch of checks) {
      await tx`insert into audit_checks (audit_id, check_key, result, summary, evidence, is_gap, severity, finding_text)
               values (${a.id}, ${ch.key}, ${ch.result}, ${ch.summary}, ${tx.json(ch.evidence as never)}, ${ch.isGap},
                       ${ch.severity}, ${ch.findingText ?? null})`;
    }
    await tx`update clinics set site_name=coalesce(${siteName}, site_name),
               name=case when source='places' then coalesce(${siteName}, name) else name end,
               phone=coalesce(${sitePhone}, phone), phone_confirmed_on_site=${!!sitePhone},
               address=coalesce(${siteAddress}, address), address_confirmed_on_site=${!!siteAddress},
               status='audited', updated_at=now() where id=${clinicId}`;
    return a;
  });
  await ctx.enqueue("score_clinic", `score:${clinicId}:${audit.id}`, { clinicId, auditId: audit.id, testRunId: run.id, runLabel });
  if (env().GOOGLE_PLACES_API_KEY) {
    await ctx.enqueue("review_lookup", `reviewlookup:${clinicId}:${run.id}`, { clinicId, testRunId: run.id }, { maxAttempts: 2 });
  }
  return {
    auditId: audit.id,
    pages: site.pages.length,
    gaps: checks.filter((x) => x.isGap && x.result !== "could_not_verify").map((x) => x.key),
    couldNotVerify: checks.filter((x) => x.result === "could_not_verify").map((x) => x.key),
  };
}

register("audit_clinic", handleAudit);
