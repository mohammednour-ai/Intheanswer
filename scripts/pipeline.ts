/**
 * Pipeline CLI (dry run by default: nothing is sent or charged).
 *
 *   npm run pipeline -- seed            insert the two seed clinics and queue step 2 for them
 *   npm run pipeline -- discover        queue step 1 for every active (sector, city)
 *   npm run pipeline -- run             run the worker until the queue is idle
 *   npm run pipeline -- site <url>      read a site and print contact + site-only checks (no Claude)
 *   npm run pipeline -- sitetest <url>  full site test (crawl, speed, mobile, accessibility, ...)
 *   npm run pipeline -- services <domain>  site test + page proposals + full report preview for a clinic
 *   npm run pipeline -- status          funnel counts and job states
 */
import "../src/lib/jobs/register";
import { db, closeDb } from "../src/lib/db";
import { enqueue } from "../src/lib/jobs/queue";
import { runWorkerOnce } from "../src/lib/jobs/worker";
import { readSite } from "../src/lib/site/crawl";
import { runSiteTest, storeSiteTest } from "../src/lib/sitetest/run";
import { proposeForClinic } from "../src/lib/pages/jobs";
import { buildFullReportData, renderFullReport } from "../src/lib/reports/fullReport";
import { htmlToPdf } from "../src/lib/reports/pdf";
import { currentRunLabel } from "../src/lib/pipeline/runs";
import fs from "node:fs/promises";
import { findContacts } from "../src/lib/pipeline/contact";
import { getRobots } from "../src/lib/adapters/http";
import {
  checkAddressOnHome, checkAiCrawlers, checkContactEmail, checkMetaDescription, checkStructuredData,
} from "../src/lib/pipeline/audit/deterministic";

export const SEEDS = [
  { name: "Adental Office", city: "Barrie", sector: "dental", website: "https://adentaloffice.ca/" },
  { name: "Marketplace Medical Centre and MedSpa", city: "Milton", sector: "family", website: "https://www.marketplacemedicalcentre.com/" },
];

async function seed() {
  const sql = db();
  for (const s of SEEDS) {
    const domain = new URL(s.website).hostname.replace(/^www\./, "");
    const [row] = await sql<{ id: string }[]>`
      insert into clinics (name, website, domain, city_id, sector_id, source)
      select ${s.name}, ${s.website}, ${domain}, c.id, se.id, 'seed' from cities c, sectors se
      where c.name=${s.city} and se.slug=${s.sector}
      on conflict do nothing returning id`;
    const id = row?.id ?? (await sql<{ id: string }[]>`select id from clinics where domain=${domain}`)[0].id;
    await enqueue("find_contact", `contact:${id}`, { clinicId: id });
    console.log(`seeded ${s.name} (${id})`);
  }
}

async function discover() {
  const targets = await db()<{ sector_id: number; city_id: number }[]>`select sector_id, city_id from discovery_targets where active`;
  const month = new Date().toISOString().slice(0, 7);
  for (const t of targets) await enqueue("discover", `discover:${t.sector_id}:${t.city_id}:${month}`, { sectorId: t.sector_id, cityId: t.city_id });
  console.log(`queued ${targets.length} discovery jobs`);
}

async function run() {
  for (let i = 0; i < 500; i++) {
    const r = await runWorkerOnce({ limit: 5 });
    if (r.claimed) console.log(new Date().toISOString(), JSON.stringify(r));
    if (r.claimed === 0) {
      const [w] = await db()<{ n: number; next: Date | null }[]>`
        select count(*)::int as n, min(run_after) as next from jobs where status='queued'`;
      if (w.n === 0) break;
      const waitMs = Math.max(1000, Math.min(30000, (w.next?.getTime() ?? Date.now()) - Date.now()));
      if (waitMs > 25000) {
        console.log(`${w.n} job(s) waiting until ${w.next?.toISOString()}; stopping`);
        break;
      }
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  await status();
}

async function site(url: string) {
  const s = await readSite(url);
  console.log(`pages read (${s.pages.length}):`);
  s.pages.forEach((p) => console.log("  ", p.url, `(${p.text.length} chars, ${p.jsonLd.length} JSON-LD)`));
  if (s.failures.length) console.log("failures:", s.failures);
  if (!s.home) return;
  const c = findContacts(s);
  console.log("\ncontact:", c.doNotContact ? { doNotContact: c.doNotContact } : c.primary, `(${c.candidates.length} candidate(s))`);
  const robots = await getRobots(new URL(s.website).origin);
  const checks = [
    checkMetaDescription(s),
    checkStructuredData(s),
    checkAddressOnHome(s),
    checkContactEmail(s, c.primary),
    checkAiCrawlers(s, robots.txt),
  ];
  console.log("\nsite-only checks:");
  for (const ch of checks) {
    console.log(`  [${ch.result}${ch.isGap ? ", gap" : ""}] ${ch.key}: ${ch.summary}`);
    for (const e of ch.evidence.slice(0, 2)) console.log(`      evidence: ${e.url ?? ""} ${e.quote ? `"${e.quote.slice(0, 160)}"` : e.label ?? ""}`);
  }
}

async function sitetest(url: string) {
  const out = await runSiteTest(url, { cap: Number(process.env.CAP ?? 40), cacheDays: 7 });
  console.log(`pages crawled: ${out.crawl.pages.length} (cap ${out.crawl.cap}); speed source: ${out.perfSource ?? "none"}`);
  if (out.notes.length) console.log("notes:", out.notes);
  for (const c of out.checks) {
    console.log(`  [${c.result}] ${c.key} (impact ${c.impact}): ${c.line}`);
    for (const e of c.evidence.slice(0, 2)) console.log(`      evidence: ${e.url ?? ""} ${e.quote ? `"${e.quote.slice(0, 120)}"` : e.label?.slice(0, 160) ?? ""}`);
  }
}

/** Dry run of the added services for one clinic (by domain): site test, page proposals, full report preview. */
async function services(domain: string) {
  const sql = db();
  const [c] = await sql<{ id: string; website: string; name: string }[]>`select id, website, coalesce(site_name, name) as name from clinics where domain=${domain}`;
  if (!c) throw new Error(`no clinic with domain ${domain}; run seed first`);
  const label = currentRunLabel();
  const t0 = Date.now();
  const out = await runSiteTest(c.website, { cap: 40, cacheDays: 7 });
  await storeSiteTest(c.id, label, out, 40);
  console.log(`\n== ${c.name}: site test (${out.crawl.pages.length} pages, ${Math.round((Date.now() - t0) / 1000)} s, speed: ${out.perfSource ?? "none"})`);
  if (out.notes.length) console.log("   notes:", out.notes.join(" | "));
  for (const k of out.checks) console.log(`   [${k.result}] ${k.key}: ${k.line}`);
  const [run] = await sql<{ id: string }[]>`select test_run_id as id from scores where clinic_id=${c.id} order by created_at desc limit 1`;
  const p = await proposeForClinic(c.id, run?.id ?? null);
  console.log(`\n== ${c.name}: proposed pages (${p.proposals.length})`);
  p.proposals.forEach((x, i) => console.log(`   ${i + 1}. [${x.kind}] ${x.title}  (priority ${x.priority})\n      ${x.reason}`));
  if (p.firstDraft) {
    console.log(`\n== first draft: ${p.firstDraft.title}`);
    console.log("   " + p.firstDraft.directAnswer.join(" "));
    p.firstDraft.details.forEach((d) => console.log("   - " + d));
    console.log(`   ${p.firstDraft.contact.address} | ${p.firstDraft.contact.phone} | ${p.firstDraft.contact.hours}`);
    console.log(`   placeholders: ${p.firstDraft.placeholders.length}; JSON-LD: ${p.firstDraft.jsonLd["@type"]}`);
  }
  const data = await buildFullReportData(c.id);
  const html = renderFullReport(data, { web: false });
  await fs.mkdir("output", { recursive: true });
  const file = `output/full-${domain}`;
  await fs.writeFile(`${file}.html`, html);
  await fs.writeFile(`${file}.pdf`, await htmlToPdf(html));
  console.log(`\nwrote ${file}.html and ${file}.pdf`);
}

async function status() {
  const sql = db();
  console.table(await sql`select status::text, count(*)::int from clinics group by 1 order by 1`);
  console.table(await sql`select kind, status::text, count(*)::int, max(last_error) as last_error from jobs group by 1,2 order by 1,2`);
}

const [cmd, arg] = process.argv.slice(2);
const main = { seed, discover, run, status, site: () => site(arg), sitetest: () => sitetest(arg), services: () => services(arg) }[cmd as "seed"];
if (!main) {
  console.log("usage: npm run pipeline -- seed|discover|run|status|site <url>");
  process.exit(1);
}
main()
  .then(closeDb)
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
