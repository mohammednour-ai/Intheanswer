/**
 * Pipeline CLI (dry run by default: nothing is sent or charged).
 *
 *   npm run pipeline -- seed            insert the two seed clinics and queue step 2 for them
 *   npm run pipeline -- discover        queue step 1 for every active (sector, city)
 *   npm run pipeline -- run             run the worker until the queue is idle
 *   npm run pipeline -- site <url>      read a site and print contact + site-only checks (no Claude)
 *   npm run pipeline -- status          funnel counts and job states
 */
import "../src/lib/jobs/register";
import { db, closeDb } from "../src/lib/db";
import { enqueue } from "../src/lib/jobs/queue";
import { runWorkerOnce } from "../src/lib/jobs/worker";
import { readSite } from "../src/lib/site/crawl";
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

async function status() {
  const sql = db();
  console.table(await sql`select status::text, count(*)::int from clinics group by 1 order by 1`);
  console.table(await sql`select kind, status::text, count(*)::int, max(last_error) as last_error from jobs group by 1,2 order by 1,2`);
}

const [cmd, arg] = process.argv.slice(2);
const main = { seed, discover, run, status, site: () => site(arg) }[cmd as "seed"];
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
