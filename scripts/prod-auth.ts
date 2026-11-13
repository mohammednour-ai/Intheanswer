/**
 * Portal sign-in setup for the production Supabase project, run from the owner's machine:
 *
 *   npx tsx scripts/prod-auth.ts
 *
 * Needs SUPABASE_ACCESS_TOKEN in .env.production.local (Supabase > Account >
 * Access Tokens) and RESEND_API_KEY in .env.local. It sets, and only sets:
 *   - Site URL and the allowed redirect URL, so sign-in links open the live site
 *   - custom SMTP through Resend, so the sign-in email can reach the owner
 *   - sign-ups off (the owner account already exists)
 * Then it asks Supabase for a sign-in link for the owner address, as a test.
 * No secret is printed.
 */
import fs from "node:fs";
import path from "node:path";

const REF = "ckpwzvoqunpqbczdywcd";
const SITE = "https://intheanswer.ca";
const OWNER = "hello@intheanswer.ca";

function read(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^["']/.test(v)) v = v.slice(1, v.indexOf(v[0], 1) > 0 ? v.indexOf(v[0], 1) : undefined);
    else v = v.replace(/\s+#.*$/, "").trim();
    out[m[1]] = v;
  }
  return out;
}

async function main() {
  const prod = read(path.join(process.cwd(), ".env.production.local"));
  const local = read(path.join(process.cwd(), ".env.local"));
  const token = prod.SUPABASE_ACCESS_TOKEN;
  const resendKey = local.RESEND_API_KEY;
  const sending = local.SENDING_DOMAIN || "mail.intheanswer.ca";
  if (!token) throw new Error("SUPABASE_ACCESS_TOKEN is missing from .env.production.local");
  if (!resendKey) throw new Error("RESEND_API_KEY is missing from .env.local");

  const api = `https://api.supabase.com/v1/projects/${REF}/config/auth`;
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const body = {
    site_url: SITE,
    uri_allow_list: `${SITE}/auth/callback,${SITE}/**`,
    disable_signup: true,
    external_email_enabled: true,
    smtp_admin_email: `hello@${sending}`,
    smtp_sender_name: "In The Answer",
    smtp_host: "smtp.resend.com",
    smtp_port: "465",
    smtp_user: "resend",
    smtp_pass: resendKey,
    smtp_max_frequency: 60,
    // auth emails per hour across the project (Supabase's default is 2)
    rate_limit_email_sent: 30,
  };
  const r = await fetch(api, { method: "PATCH", headers: H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`auth config update failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  const c = (await (await fetch(api, { headers: H })).json()) as Record<string, unknown>;
  console.log(`site_url: ${c.site_url}`);
  console.log(`redirects: ${c.uri_allow_list}`);
  console.log(`sign-ups disabled: ${c.disable_signup}`);
  console.log(`smtp: ${c.smtp_host}:${c.smtp_port} as ${c.smtp_admin_email}`);
  console.log(`auth emails per hour: ${c.rate_limit_email_sent}`);
  // Supabase applies new settings a few seconds after the update returns
  await new Promise((r) => setTimeout(r, 15_000));

  // a test sign-in link to the owner, the same request the portal login page makes
  const keys = (await (await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys`, { headers: H })).json()) as { name: string; api_key: string; type?: string }[];
  const anon = keys.find((k) => k.type === "publishable")?.api_key ?? keys.find((k) => k.name === "anon")?.api_key;
  if (!anon) return console.log("test link: skipped (no publishable key found)");
  const otp = await fetch(`https://${REF}.supabase.co/auth/v1/otp?redirect_to=${encodeURIComponent(`${SITE}/auth/callback`)}`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email: OWNER, create_user: false }),
  });
  console.log(`test link to ${OWNER}: HTTP ${otp.status}${otp.ok ? "" : " " + (await otp.text()).slice(0, 200)}`);
}

main().catch((e) => {
  console.error(`prod-auth failed: ${(e as Error).message}`);
  process.exit(1);
});
