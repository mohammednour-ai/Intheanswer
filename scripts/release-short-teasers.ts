/**
 * Release the first emails held only because two findings (not three) survived verification
 * (see src/lib/pipeline/releaseShortTeasers.ts). In production, start the job instead
 * (`insert into jobs (kind, idempotency_key, payload) values ('release_short_teasers',
 * 'release_short_teasers:1', '{"round":1}')`): it runs with production's addresses and PDF
 * storage. This script is for --dry counts, or for an environment whose APP_URL and storage
 * are the ones the emails were written with.
 *
 *   npx tsx --env-file=<env file> scripts/release-short-teasers.ts --dry        counts only, writes nothing
 *   npx tsx --env-file=<env file> scripts/release-short-teasers.ts --limit 3    releases at most 3
 *   npx tsx --env-file=<env file> scripts/release-short-teasers.ts              releases all of them
 *
 * Safe to run twice: a released email is no longer held, so the second run finds nothing.
 */
import { closeDb } from "../src/lib/db";
import { env } from "../src/lib/env";
import { releaseReport, releaseShortTeasers } from "../src/lib/pipeline/releaseShortTeasers";

const USAGE = "usage: npx tsx --env-file=<env file> scripts/release-short-teasers.ts [--dry] [--limit <n>]";

function args(argv: string[]): { dry: boolean; limit?: number } {
  const out: { dry: boolean; limit?: number } = { dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry" || a === "--dry-run") out.dry = true;
    else if (a === "--limit") {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v)) throw new Error(USAGE);
      out.limit = Number(v);
    } else throw new Error(`unknown argument "${a}"\n${USAGE}`);
  }
  return out;
}

async function main() {
  const o = args(process.argv.slice(2));
  const e = env();
  console.log(`Two-finding release${o.dry ? " (dry run: nothing is written)" : ""}`);
  console.log(`Database: ${new URL(e.DATABASE_URL).hostname}   Links: ${e.APP_URL}   PDFs: ${e.NEXT_PUBLIC_SUPABASE_URL && e.SUPABASE_SERVICE_ROLE_KEY ? "Supabase storage" : "local folder output/"}`);
  const r = await releaseShortTeasers(o);
  for (const l of releaseReport(r)) console.log(l);
}

main()
  .then(closeDb)
  .catch(async (err) => {
    console.error((err as Error).message);
    await closeDb();
    process.exit(1);
  });
