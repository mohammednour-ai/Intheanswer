import { db } from "./db";
import { enqueue } from "./jobs/queue";
import { assertPublicUrl, siteDomain } from "./adapters/http";
import { isSuppressed } from "./sending/suppression";
import { sha256 } from "./tokens";
import { env } from "./env";

/**
 * Self-serve box: a clinic enters its website and email and gets its own
 * teaser through the same pipeline. Guards: public https site only, known
 * sector, Ontario city name, rate limits per visitor and per site, and the
 * email must later match the site (checked in the contact step).
 */
export interface SelfServeInput {
  website: string;
  email: string;
  sector: string;
  city: string;
  ip: string;
  honeypot?: string;
}

export type SelfServeResult = { ok: true; message: string } | { ok: false; message: string };

const PER_IP_PER_DAY = 3;
const PER_SITE_DAYS = 14;

export function normalizeWebsite(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!u.hostname.includes(".")) return null;
    return `https://${u.hostname.toLowerCase()}/`;
  } catch {
    return null;
  }
}

export async function submitSelfServe(input: SelfServeInput): Promise<SelfServeResult> {
  const sql = db();
  const generic: SelfServeResult = { ok: true, message: "Thank you. If the details check out, your report will be emailed to you, usually within one business day." };
  if (input.honeypot) return generic; // bots get the same answer and nothing happens

  const website = normalizeWebsite(input.website);
  const email = input.email.trim().toLowerCase();
  const city = input.city.trim().replace(/\s+/g, " ");
  if (!website) return { ok: false, message: "Please enter your clinic's website address." };
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(email)) return { ok: false, message: "Please enter a valid email address." };
  if (!/^[A-Za-zÀ-ÿ' .-]{2,40}$/.test(city)) return { ok: false, message: "Please enter your city or town in Ontario." };
  const domain = siteDomain(website);
  if (domain === siteDomain(env().APP_URL) || domain === "intheanswer.ca") return { ok: false, message: "Please enter your clinic's own website." };
  try {
    await assertPublicUrl(website);
  } catch {
    return { ok: false, message: "That website address cannot be reached from the public internet." };
  }
  const [sector] = await sql<{ id: number }[]>`select id from sectors where slug=${input.sector} and active`;
  if (!sector) return { ok: false, message: "Please choose the type of clinic." };
  if ((await isSuppressed(email)).suppressed) return generic; // never email a suppressed address; do not reveal it

  const ipHash = sha256(env().APP_SECRET + ":" + input.ip).slice(0, 32);
  const [byIp] = await sql<{ n: number }[]>`select count(*)::int as n from self_serve_requests where ip_hash=${ipHash} and created_at > now() - interval '1 day'`;
  if (byIp.n >= PER_IP_PER_DAY) return { ok: false, message: "You have reached today's limit for report requests. Please try again tomorrow." };
  const [bySite] = await sql<{ n: number }[]>`
    select count(*)::int as n from self_serve_requests where website=${website} and status <> 'rejected'
      and created_at > now() - make_interval(days => ${PER_SITE_DAYS})`;
  if (bySite.n > 0) return { ok: true, message: "A report for this website was requested recently. It will be emailed to the address given then." };

  const [c] = await sql<{ id: number }[]>`
    insert into cities (name, active) values (${city.replace(/\b\w/g, (m) => m.toUpperCase())}, false)
    on conflict (name, province) do update set name = excluded.name returning id`;
  // reuse a clinic we already know by its site, else create one for this request
  const [existing] = await sql<{ id: string; status: string }[]>`select id, status::text from clinics where domain=${domain} limit 1`;
  if (existing && ["do_not_contact", "suppressed"].includes(existing.status)) return generic;
  const clinicId =
    existing?.id ??
    (await sql<{ id: string }[]>`
      insert into clinics (name, website, domain, city_id, sector_id, source)
      values (${domain}, ${website}, ${domain}, ${c.id}, ${sector.id}, 'self_serve') returning id`)[0].id;
  if (existing) await sql`update clinics set source='self_serve', updated_at=now() where id=${existing.id}`;
  const [req] = await sql<{ id: string }[]>`
    insert into self_serve_requests (website, email, ip_hash, status, clinic_id) values (${website}, ${email}, ${ipHash}, 'received', ${clinicId}) returning id`;
  await enqueue("find_contact", `selfserve:${req.id}`, { clinicId }, { priority: 30 });
  return generic;
}
