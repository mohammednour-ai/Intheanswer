// SYNTHETIC fixture: an invented clinic with a verified teaser stored, ready for outreach.
import { db } from "@/lib/db";
import { buildTeaserData } from "@/lib/reports/teaser";
import { renderTeaser } from "@/lib/reports/renderTeaser";
import { computeClinicResults } from "@/lib/pipeline/score";
import type { ModelVerifier } from "@/lib/pipeline/verify";
import { makeClinic } from "../helpers";

export const allSupported: ModelVerifier = async (items) => ({
  verdicts: items.map((i) => ({ id: i.id, supported: true, issue: "none" as const, explanation: "" })), usage: null, costUsd: 0,
});

let n = 0;
export async function clinicWithTeaser(over: { name?: string; score?: number; address?: string | null; email?: string | null; city?: string } = {}) {
  const sql = db();
  n++;
  const domain = `clinic${n}-${Date.now()}.example`;
  const site = `https://${domain}/`;
  const name = over.name ?? `Maple Grove Dental ${n}`;
  const address = over.address === undefined ? "12 Maple Street, Barrie, ON L4M 1A1" : over.address;
  const clinicId = await makeClinic({
    name, website: site, domain, status: "queued", priority_score: over.score ?? 3,
    address, address_confirmed_on_site: !!address,
  });
  if (over.email !== null) {
    await sql`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${clinicId}, ${over.email ?? `info@${domain}`}, ${site}, true, true)`;
  }
  await sql`insert into page_cache (url, domain, http_status, content_type, body) values
    (${site}, ${domain}, 200, 'text/html', '<html><body><p>Hours: Monday to Friday 9:00 am to 5:00 pm</p></body></html>'),
    (${site + "contact"}, ${domain}, 200, 'text/html', '<html><body><p>Hours: Monday to Friday 8:00 am to 4:00 pm</p></body></html>')`;
  const [qs] = await sql<{ id: number; sector_id: number }[]>`select q.id, q.sector_id from question_sets q join sectors s on s.id=q.sector_id where s.slug='dental'`;
  const [city] = await sql<{ id: number }[]>`select id from cities where name='Barrie'`;
  const [run] = await sql<{ id: string }[]>`
    insert into test_runs (sector_id, city_id, question_set_id, assistant, model, run_label, finished_at)
    values (${qs.sector_id}, ${city.id}, ${qs.id}, 'Claude', 'claude-opus-5-5', ${"t" + n + "-" + Date.now()}, '2026-11-10T15:00:00Z') returning id`;
  for (let i = 0; i < 6; i++) {
    await sql`insert into test_answers (test_run_id, question_index, question, answer_text, clinics_named, served_model)
              values (${run.id}, ${i}, ${"Question " + (i + 1) + " in Barrie?"}, 'Lakeshore Dental Studio is accepting new patients.',
                      ${sql.json([{ name: "Lakeshore Dental Studio", url: null, status: "recommended", quote: "Lakeshore Dental Studio is accepting new patients" }])}, 'claude-opus-5-5')`;
  }
  const [audit] = await sql<{ id: string }[]>`insert into audits (clinic_id, pages_read) values (${clinicId}, ${[site, site + "contact"]}) returning id`;
  const checks: [string, string, number, string, unknown[]][] = [
    ["hours_conflict", "found", 90, `Two different sets of hours appear on your site: "Monday to Friday 9:00 am to 5:00 pm" (${site}) and "Monday to Friday 8:00 am to 4:00 pm" (${site}contact).`,
      [{ kind: "page_quote", url: site, quote: "Monday to Friday 9:00 am to 5:00 pm" }, { kind: "page_quote", url: site + "contact", quote: "Monday to Friday 8:00 am to 4:00 pm" }]],
    ["new_patients", "not_found", 80, `We did not find a statement on the 2 pages we read on ${domain} saying whether you are accepting new patients.`, [{ kind: "pages_read", label: "2 pages" }]],
    ["practitioners", "not_found", 55, `We did not find the names of the practitioners who see patients on the 2 pages we read on ${domain}.`, [{ kind: "pages_read", label: "2 pages" }]],
  ];
  for (const [k, r, sev, text, ev] of checks) {
    await sql`insert into audit_checks (audit_id, check_key, result, summary, evidence, is_gap, severity, finding_text)
              values (${audit.id}, ${k}, ${r}, 's', ${sql.json(ev as never)}, true, ${sev}, ${text})`;
  }
  await computeClinicResults(clinicId, run.id);
  const [score] = await sql<{ id: string }[]>`
    insert into scores (clinic_id, test_run_id, audit_id, recommended, listed_only, not_named, total, confirmed_findings, qualifies, reason)
    values (${clinicId}, ${run.id}, ${audit.id}, 0, 0, 6, 6, 3, true, 'ok') returning id`;
  const token = `tok_fixture_${n}_${Date.now()}`;
  const data = await buildTeaserData(clinicId, score.id, token);
  const [rep] = await sql<{ id: string }[]>`
    insert into reports (clinic_id, kind, token, score_id, data, html) values (${clinicId}, 'teaser', ${token}, ${score.id}, ${sql.json({ ...data, verified: true } as never)}, ${renderTeaser(data)}) returning id`;
  return { clinicId, scoreId: score.id, reportId: rep.id, domain, name };
}
