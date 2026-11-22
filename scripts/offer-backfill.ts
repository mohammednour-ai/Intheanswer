/**
 * Bring stored teaser reports and unsent teaser emails in line with the plans
 * in src/lib/offer.ts (see src/lib/reports/offerBackfill.ts for what it does
 * and what it leaves alone).
 *
 *   npx tsx --env-file=<env file> scripts/offer-backfill.ts --dry       counts only, writes nothing
 *   npx tsx --env-file=<env file> scripts/offer-backfill.ts             does it
 *   npx tsx --env-file=<env file> scripts/offer-backfill.ts --limit 5   rebuilds at most 5 emails (to look at them first)
 *   npx tsx --env-file=<env file> scripts/offer-backfill.ts --all       also rebuilds emails whose text changes outside the option lines
 *
 * The database is the one in DATABASE_URL. The whole environment matters, not
 * only the database: APP_URL and APP_SECRET write the report and unsubscribe
 * links, OWNER_* the signature, STRIPE_TAX_RATE_ID the "plus HST" in the PDF,
 * and the Supabase keys decide where the PDFs are stored. Run it with the
 * environment of the application that sends these emails. The first lines it
 * prints say what it is about to use; read them before a run without --dry.
 *
 * Safe to run twice: the second run finds everything current.
 */
import { closeDb } from "../src/lib/db";
import { env, ownerDetails, priceNote } from "../src/lib/env";
import { offerSwitches } from "../src/lib/offerSwitches";
import { emailOfferLines } from "../src/lib/offer";
import { backfillReport, parseBackfillArgs, runOfferBackfill } from "../src/lib/reports/offerBackfill";

async function main() {
  // anything it does not recognise stops it before the database is opened: a mistyped --dry must never become a real run
  const { dry, all, limit } = parseBackfillArgs(process.argv.slice(2));

  const e = env();
  const dbUrl = new URL(e.DATABASE_URL);
  const switches = await offerSwitches();
  console.log(`Offer backfill${dry ? " (dry run: nothing is written)" : ""}`);
  console.log(`Database: ${dbUrl.hostname}${dbUrl.pathname}`);
  console.log(`Links: ${e.APP_URL}   Sender: ${ownerDetails().businessName}   PDFs: ${e.NEXT_PUBLIC_SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY ? "Supabase storage" : "local folder output/"}`);
  console.log(`Price note: "${priceNote()}"   Pillars on: ${switches.pillars.join(", ") || "none"}`);
  console.log(`Option lines every rebuilt email gets:`);
  for (const l of emailOfferLines({ switches })) console.log(`  ${l}`);
  console.log(``);

  const result = await runOfferBackfill({
    dry, all, limit,
    progress: (done, total) => { if (!dry && (done % 10 === 0 || done === total)) console.log(`  emails: ${done} of ${total}`); },
  });
  for (const l of backfillReport(result)) console.log(l);
}

main()
  .then(closeDb)
  .catch(async (e) => {
    console.error((e as Error).message);
    await closeDb();
    process.exit(1);
  });
