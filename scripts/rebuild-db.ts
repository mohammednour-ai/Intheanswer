import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

/**
 * Drop and recreate a LOCAL database from the Supabase shim, the migrations
 * and the seed. Plain Node: works on Windows, macOS and Linux without psql.
 * Never point this at Supabase (the shim must not be applied there, and the
 * database is dropped first).
 *
 *   npm run db:local            -> intheanswer on localhost
 *   npm run db:local -- <url>   -> the database named in the URL
 */
export async function rebuildDatabase(databaseUrl: string): Promise<string> {
  const url = new URL(databaseUrl);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unexpected database name "${name}"`);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`refusing to rebuild a database on ${url.hostname}: local databases only`);
  }
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`);
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const root = path.resolve(__dirname, "..");
  const migrations = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  const files = ["supabase/local/00_supabase_shim.sql", ...migrations.map((f) => `supabase/migrations/${f}`), "supabase/seed.sql"];
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    for (const f of files) {
      try {
        await sql.unsafe(fs.readFileSync(path.join(root, f), "utf8"));
      } catch (e) {
        throw new Error(`${f}: ${(e as Error).message}`);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return name;
}

if (require.main === module) {
  const target = process.argv[2] ?? process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/intheanswer";
  rebuildDatabase(target).then(
    (name) => console.log(`local database ${name} ready`),
    (e) => {
      console.error((e as Error).message);
      process.exit(1);
    },
  );
}
