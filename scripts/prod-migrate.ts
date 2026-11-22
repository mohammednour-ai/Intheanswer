/**
 * Apply one migration file to the PRODUCTION database, from the owner's machine:
 *
 *   npx tsx scripts/prod-migrate.ts supabase/migrations/<file>.sql
 *
 * For when the Supabase connector cannot be used. Reads DATABASE_URL from
 * .env.production.local (git-ignored) and prints no secret. The file runs in
 * one transaction, so it applies completely or not at all, and it is recorded
 * in supabase_migrations.schema_migrations under the name after the timestamp
 * (as the connector records it), so the list of applied migrations stays true.
 * A name that is already recorded is not applied again.
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

function prodDatabaseUrl(): string {
  const file = path.join(process.cwd(), ".env.production.local");
  if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  const m = fs.readFileSync(file, "utf8").match(/^DATABASE_URL=(.*)$/m);
  const url = (m?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  if (!url) throw new Error("DATABASE_URL is missing from .env.production.local");
  const host = new URL(url).hostname;
  if (!/supabase\.(com|co)$/.test(host)) throw new Error(`DATABASE_URL points at ${host}, not a Supabase host`);
  return url;
}

async function main() {
  const file = process.argv[2];
  if (!file || !file.endsWith(".sql") || !fs.existsSync(file)) throw new Error("usage: npx tsx scripts/prod-migrate.ts supabase/migrations/<file>.sql");
  const name = path.basename(file, ".sql").replace(/^\d+_/, "");
  const body = fs.readFileSync(file, "utf8");
  const sql = postgres(prodDatabaseUrl(), { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [already] = await sql<{ version: string }[]>`select version from supabase_migrations.schema_migrations where name = ${name} limit 1`;
    if (already) {
      console.log(`"${name}" is already recorded as applied (version ${already.version}); nothing done`);
      return;
    }
    const version = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into supabase_migrations.schema_migrations (version, name, statements) values (${version}, ${name}, ${[body]})`;
    });
    console.log(`applied "${name}" to production as version ${version}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
