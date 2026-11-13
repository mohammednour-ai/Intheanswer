/**
 * DEMO ONLY (local database): builds a test-mode letter batch and a postcard for
 * the invented demo clinic so the letter, the results page and the batch screen
 * can be looked at. The model verification pass is stubbed here; real batches
 * built in the portal use the Claude verifier. Run scripts/demo-portal.ts first.
 */
import fs from "node:fs/promises";
import { db, closeDb } from "../src/lib/db";
import { buildLetterBatch } from "../src/lib/mail/batches";
import { buildLetterData, renderLetter } from "../src/lib/mail/letter";
import { htmlToPdf } from "../src/lib/reports/pdf";
import { ensureCode } from "../src/lib/qr";
import type { ModelVerifier } from "../src/lib/pipeline/verify";

const stub: ModelVerifier = async (items) => ({ verdicts: items.map((i) => ({ id: i.id, supported: true, issue: "none" as const, explanation: "" })), usage: null, costUsd: 0 });

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "postgres://localhost")) throw new Error("demo is local only");
  const sql = db();
  const [c] = await sql<{ id: string; city_id: number }[]>`
    update clinics set address='45 Birchwood Avenue, Orillia, ON L3V 2K4', address_confirmed_on_site=true, priority_score=6, status='queued', replied=false
    where domain='birchwood-dental.example' returning id, city_id`;
  if (!c) throw new Error("run scripts/demo-portal.ts first");
  await sql`update channel_settings set values = values || '{"on": true}'::jsonb where channel='letter'`;
  await sql`delete from mail_batches`;
  const b = await buildLetterBatch({ cityId: c.city_id, testMode: true, verifier: stub, label: "DEMO letters (invented clinic)" });
  const code = await ensureCode(c.id);
  await fs.mkdir("output", { recursive: true });
  await fs.writeFile("output/demo-letter.pdf", await htmlToPdf(await renderLetter(await buildLetterData(c.id, "letter", "A"))));
  await fs.writeFile("output/demo-postcard.pdf", await htmlToPdf(await renderLetter(await buildLetterData(c.id, "postcard", "A"))));
  console.log(JSON.stringify({ batch: b.batchId, pieces: b.pieces, code }));
  await closeDb();
}
main().catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
