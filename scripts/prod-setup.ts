/**
 * One-time production setup, run from the owner's machine:
 *
 *   npx tsx scripts/prod-setup.ts
 *
 * Reads .env.production.local (git-ignored), which must hold:
 *   DATABASE_URL               Supabase > Connect > Transaction pooler (port 6543), with the password
 *   SUPABASE_SERVICE_ROLE_KEY  Supabase > Project Settings > API keys > service_role (secret)
 *   CRON_SECRET                already there (generated when the Vercel settings were made)
 * and optionally WORKER_URL (default https://intheanswer.vercel.app/api/cron/worker).
 *
 * It then
 *   1. checks that the database answers and holds the migrated schema,
 *   2. stores CRON_SECRET in Supabase Vault and schedules pg_cron to call the
 *      worker every minute with it (Vercel Hobby allows a cron only once a day),
 *   3. copies DATABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the Vercel project.
 *
 * No secret is printed. Safe to re-run: every step replaces what it made before.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import postgres from "postgres";

const FILE = path.join(process.cwd(), ".env.production.local");
const JOB = "intheanswer-worker";
const VAULT_NAME = "intheanswer_cron_secret";

function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function need(env: Record<string, string>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is missing from .env.production.local`);
  return v;
}

function vercelEnv(name: string, value: string) {
  const bin = process.platform === "win32" ? "vercel.cmd" : "vercel";
  const r = spawnSync(bin, ["env", "add", name, "production", "--force"], { input: value, encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`vercel env add ${name} failed (exit ${r.status})`);
  console.log(`vercel: ${name} set`);
}

async function main() {
  const env = readEnvFile(FILE);
  const dbUrl = need(env, "DATABASE_URL");
  const serviceKey = need(env, "SUPABASE_SERVICE_ROLE_KEY");
  const cronSecret = need(env, "CRON_SECRET");
  const workerUrl = env.WORKER_URL || "https://intheanswer.vercel.app/api/cron/worker";

  const host = new URL(dbUrl).hostname;
  if (!/supabase\.(com|co)$/.test(host)) throw new Error(`DATABASE_URL points at ${host}, not a Supabase host`);
  if (!/^https:\/\//.test(workerUrl)) throw new Error("WORKER_URL must be https");

  const sql = postgres(dbUrl, { prepare: false, max: 1, ssl: "require", connect_timeout: 20 });
  try {
    // 1. the database answers and is the migrated one
    const [check] = await sql<{ tables: number; settings: number }[]>`
      select (select count(*) from pg_tables where schemaname = 'public')::int as tables,
             (select count(*) from public.app_settings)::int as settings`;
    if (check.tables < 40 || check.settings !== 1) throw new Error(`unexpected schema: ${check.tables} tables, ${check.settings} settings rows`);
    console.log(`database: ok (${check.tables} tables)`);

    // 2. the secret in Vault, and the every-minute call
    const [existing] = await sql<{ id: string }[]>`select id from vault.secrets where name = ${VAULT_NAME}`;
    if (existing) await sql`select vault.update_secret(${existing.id}::uuid, ${cronSecret})`;
    else await sql`select vault.create_secret(${cronSecret}, ${VAULT_NAME}, 'Bearer token for the In The Answer worker route')`;
    console.log("vault: worker secret stored");

    const command = `select net.http_get(
      url := '${workerUrl.replace(/'/g, "''")}',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = '${VAULT_NAME}')),
      timeout_milliseconds := 300000
    );`;
    await sql`select cron.unschedule(jobid) from cron.job where jobname = ${JOB}`;
    await sql`select cron.schedule(${JOB}, '* * * * *', ${command})`;
    console.log(`pg_cron: ${JOB} calls ${workerUrl} every minute`);
  } finally {
    await sql.end({ timeout: 5 });
  }

  // 3. the two secrets the deployed app still needs
  vercelEnv("DATABASE_URL", dbUrl);
  vercelEnv("SUPABASE_SERVICE_ROLE_KEY", serviceKey);
  console.log("done: redeploy so the new settings take effect (vercel deploy --prod)");
}

main().catch((e) => {
  // the message never contains a secret: only names and hosts are put in errors above
  console.error(`prod-setup failed: ${(e as Error).message}`);
  process.exit(1);
});
