/**
 * DEMO ONLY: fills the local database with one INVENTED clinic so the portal
 * can be seen with a realistic queue item. The model verification pass is
 * stubbed and the item says so. Never run against production.
 */
import { db, closeDb } from "../src/lib/db";
import { buildTeaserData } from "../src/lib/reports/teaser";
import { renderTeaser } from "../src/lib/reports/renderTeaser";
import { buildFirstEmail } from "../src/lib/emails/firstEmail";
import { verifyTeaser } from "../src/lib/pipeline/verify";
import { computeClinicResults } from "../src/lib/pipeline/score";
import { htmlToPdf } from "../src/lib/reports/pdf";
import { putFile } from "../src/lib/storage";
import { randomToken, sha256 } from "../src/lib/tokens";

const SITE = "https://birchwood-dental.example/";
const PAGES: Record<string, string> = {
  [SITE]: `<html><head><title>Birchwood Dental</title></head><body><h1>Birchwood Dental Clinic</h1>
<p>Family dentistry in Orillia. Saturday 9:00 am to 2:00 pm.</p><p>Notice: masks are required in the clinic during the COVID-19 pandemic.</p>
<a href="mailto:info@birchwood-dental.example">info@birchwood-dental.example</a></body></html>`,
  [SITE + "contact"]: `<html><body><h1>Contact</h1><p>Hours: Monday to Friday 8:00 am to 5:00 pm. Saturday closed.</p></body></html>`,
};

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "postgres://localhost")) throw new Error("demo is local only");
  const sql = db();
  await sql`insert into cities (name, lat, lng) values ('Orillia', 44.6082, -79.4197) on conflict do nothing`;
  const [city] = await sql<{ id: number }[]>`select id from cities where name='Orillia'`;
  const [sec] = await sql<{ id: number }[]>`select id from sectors where slug='dental'`;
  const [qs] = await sql<{ id: number; questions: string[] }[]>`select id, questions from question_sets where sector_id=${sec.id} and active`;
  await sql`delete from clinics where domain='birchwood-dental.example'`;
  const [clinic] = await sql<{ id: string }[]>`
    insert into clinics (name, website, domain, city_id, sector_id, source, status)
    values ('Birchwood Dental Clinic (DEMO, invented)', ${SITE}, 'birchwood-dental.example', ${city.id}, ${sec.id}, 'seed', 'audited') returning id`;
  await sql`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${clinic.id}, 'info@birchwood-dental.example', ${SITE}, true, true)`;
  for (const [u, h] of Object.entries(PAGES)) {
    await sql`insert into page_cache (url, domain, http_status, content_type, body) values (${u}, 'birchwood-dental.example', 200, 'text/html', ${h})
              on conflict (url) do update set body=excluded.body, fetched_at=now()`;
  }
  const [run] = await sql<{ id: string }[]>`
    insert into test_runs (sector_id, city_id, question_set_id, assistant, model, run_label, finished_at)
    values (${sec.id}, ${city.id}, ${qs.id}, 'Claude', 'claude-opus-5-5', ${"demo-" + Date.now()}, now()) returning id`;
  const others = ["Lakeside Smiles (invented)", "Northgate Family Dental (invented)", "Couchiching Dental Care (invented)"];
  for (let i = 0; i < qs.questions.length; i++) {
    const rec = i === 3;
    const pick = [others[i % 3], others[(i + 1) % 3]];
    const named = pick.map((n) => ({ name: n, url: null, status: "recommended", quote: `${n} is a good option` }));
    if (rec) named.push({ name: "Birchwood Dental Clinic", url: null, status: "recommended", quote: "Birchwood Dental Clinic is a good option" });
    const text = named.map((n) => `${n.name} is a good option.`).join(" ");
    await sql`insert into test_answers (test_run_id, question_index, question, answer_text, clinics_named, served_model)
              values (${run.id}, ${i}, ${qs.questions[i].replaceAll("{city}", "Orillia")}, ${text}, ${sql.json(named)}, 'claude-opus-5-5')`;
  }
  const [audit] = await sql<{ id: string }[]>`insert into audits (clinic_id, pages_read) values (${clinic.id}, ${Object.keys(PAGES)}) returning id`;
  const checks = [
    ["hours_conflict", "found", 90, `Two different sets of hours appear on your site: "Saturday 9:00 am to 2:00 pm" (${SITE}) and "Saturday closed" (${SITE}contact).`,
      [{ kind: "page_quote", url: SITE, quote: "Saturday 9:00 am to 2:00 pm" }, { kind: "page_quote", url: SITE + "contact", quote: "Saturday closed" }]],
    ["new_patients", "not_found", 80, "We did not find a statement on the 2 pages we read on birchwood-dental.example saying whether you are accepting new patients.",
      [{ kind: "pages_read", label: Object.keys(PAGES).join(" ") }]],
    ["outdated_notices", "found", 70, `Your site still shows a notice that appears out of date: "masks are required in the clinic during the COVID-19 pandemic" (${SITE}).`,
      [{ kind: "page_quote", url: SITE, quote: "masks are required in the clinic during the COVID-19 pandemic" }]],
    ["meta_description", "not_found", 40, "Your home page source has no page description (the short summary search tools and assistants show for a page).",
      [{ kind: "raw_source", url: SITE, label: "no meta description tag in the HTML" }]],
  ] as const;
  for (const [k, r, sev, text, ev] of checks) {
    await sql`insert into audit_checks (audit_id, check_key, result, summary, evidence, is_gap, severity, finding_text)
              values (${audit.id}, ${k}, ${r}, ${text}, ${sql.json(ev as never)}, true, ${sev}, ${text})`;
  }
  // DEMO site test results (invented)
  const [srun] = await sql<{ id: string }[]>`
    insert into site_test_runs (clinic_id, run_label, status, page_cap, pages_crawled, perf_source, finished_at)
    values (${clinic.id}, ${"demo-" + Date.now()}, 'done', 40, 18, 'lighthouse_local', now()) returning id`;
  const siteChecks = [
    ["booking_path", "booking", "needs_work", 100, "No booking link or phone number was found on the home page or the pages it links to.",
      "From your home page and the 6 pages it links to, we did not find a booking link or a phone number a patient can tap."],
    ["speed_mobile", "speed", "needs_work", 88, "On mobile, in the lab test the main content took 4.6 s to appear (good is 2.5 s or less) (a Lighthouse lab test run from our server).",
      "On a simulated phone, in the lab test the main content took 4.6 s to appear (good is 2.5 s or less) (a Lighthouse lab test run from our server of your home page)."],
    ["accessibility", "accessibility", "could_not_test", 76, "Accessibility could not be tested in a browser (automated checks, not a full accessibility audit).", null],
    ["https", "security", "pass", 86, "The site is served over HTTPS.", null],
  ] as const;
  for (const [k, cat, r, imp, line, ft] of siteChecks) {
    await sql`insert into site_test_checks (run_id, check_key, category, result, impact, line, finding_text, evidence)
              values (${srun.id}, ${k}, ${cat}, ${r}, ${imp}, ${line}, ${ft}, ${sql.json([{ kind: "pages_read", label: "DEMO evidence" }])})`;
  }
  await computeClinicResults(clinic.id, run.id);
  const [score] = await sql<{ id: string }[]>`
    insert into scores (clinic_id, test_run_id, audit_id, recommended, listed_only, not_named, total, confirmed_findings, qualifies, reason)
    values (${clinic.id}, ${run.id}, ${audit.id}, 1, 0, 5, 6, 4, true, 'demo') returning id`;

  const token = randomToken();
  const data = await buildTeaserData(clinic.id, score.id, token);
  const draft = buildFirstEmail(data, { toEmail: "info@birchwood-dental.example", sourceUrl: SITE, reportUrl: `http://localhost:3100/r/${token}` });
  const v = await verifyTeaser({
    data, draft, scoreId: score.id, live: false, withModel: true,
    verifier: async (items) => ({ verdicts: items.map((i) => ({ id: i.id, supported: true, issue: "none" as const, explanation: "" })), usage: null, costUsd: 0 }),
  });
  const final = buildFirstEmail(v.data, { toEmail: "info@birchwood-dental.example", sourceUrl: SITE, reportUrl: `http://localhost:3100/r/${token}` });
  const html = renderTeaser(v.data);
  const pdf = await htmlToPdf(html);
  const pdfRef = await putFile(`reports/${token}.pdf`, pdf, "application/pdf");
  const [rep] = await sql<{ id: string }[]>`
    insert into reports (clinic_id, kind, token, score_id, data, html, pdf_path, pdf_bytes)
    values (${clinic.id}, 'teaser', ${token}, ${score.id}, ${sql.json({ ...v.data, verified: true } as never)}, ${html}, ${pdfRef}, ${pdf.length}) returning id`;
  const flags = [...v.flags, { code: "demo_model_check_stubbed", message: "DEMO: invented clinic; the model verification pass was stubbed for this demo", severity: "warn" }];
  await sql`insert into messages (clinic_id, type, status, to_email, contact_source_url, subject, body_text, report_id, attach_pdf,
                                  claims, flags, gate_passed, requires_review, review_reason, mode_at_creation, expires_at, content_hash, dry_run)
            values (${clinic.id}, 'first_email', 'pending_review', 'info@birchwood-dental.example', ${SITE}, ${final.subject}, ${final.bodyText},
                    ${rep.id}, true, ${sql.json([...v.data.claims, ...final.claims] as never)}, ${sql.json(flags as never)}, true, true,
                    'REVIEW mode (DEMO item)', 'REVIEW', now() + interval '7 days', ${sha256(final.subject + final.bodyText)}, true)`;
  await sql`update clinics set status='queued' where id=${clinic.id}`;
  console.log("demo item queued; report token", token);
  await closeDb();
}
main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
