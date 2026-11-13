import type postgres from "postgres";
import { db } from "./db";
import { enqueue } from "./jobs/queue";
import { assertPublicUrl, siteDomain } from "./adapters/http";
import { isSuppressed } from "./sending/suppression";
import { sha256 } from "./tokens";
import { appSecret, env } from "./env";
import { ontarioMunicipality } from "./site/ontarioCities";

/**
 * Self-serve box: a clinic enters its website and email and gets its own
 * teaser through the same pipeline. Guards:
 * - public https site only, known sector;
 * - the city must already be in `cities` or be on the built-in list of
 *   Ontario municipalities (free text would create a paid city test per typo);
 * - limits per visitor and per site, checked and recorded in one transaction
 *   so parallel requests cannot slip past them;
 * - a global daily cap: beyond it requests are held for the owner, not run,
 *   so the form cannot burn the API budget;
 * - a clinic we already know is only reused when it is not in contact with us
 *   (see REUSABLE_STATUSES); otherwise nothing changes;
 * - the email must later match the site (checked in the contact step).
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
const DEFAULT_DAILY_CAP = 20;
const CAP_TASK_TITLE = "Self-serve requests are held: daily limit reached";

/**
 * A known clinic is taken over by a self-serve request only from these
 * statuses. Anything else (contact found, audited, queued, contacted, replied,
 * held, customer, suppressed, do-not-contact, ...) is left untouched: the form
 * must not reset or relabel a clinic that is already in the pipeline.
 */
export const REUSABLE_STATUSES = ["discovered", "no_contact", "parked", "skipped", "closed", "excluded"];

const GENERIC = "Thank you. If the details check out, your report will be emailed to you, usually within one business day.";

/** Visitors are counted by a keyed hash of their address; the address itself is never stored. */
export function hashIp(ip: string): string {
  return sha256(appSecret() + ":" + ip).slice(0, 32);
}

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

/** The city as stored: an existing `cities` row (any case), else a listed Ontario municipality, else null. */
export async function resolveCity(input: string): Promise<{ id: number | null; name: string } | null> {
  const typed = input.trim().replace(/\s+/g, " ");
  const [row] = await db()<{ id: number; name: string }[]>`
    select id, name from cities where lower(name)=lower(${typed}) order by (province='ON') desc, id limit 1`;
  if (row) return row;
  const listed = ontarioMunicipality(typed);
  if (!listed) return null;
  const [byListed] = await db()<{ id: number; name: string }[]>`
    select id, name from cities where lower(name)=lower(${listed}) order by (province='ON') desc, id limit 1`;
  return byListed ?? { id: null, name: listed };
}

type Decision =
  | { kind: "reply"; result: SelfServeResult }
  | { kind: "run"; requestId: string; clinicId: string };

export async function submitSelfServe(input: SelfServeInput): Promise<SelfServeResult> {
  const sql = db();
  const generic: SelfServeResult = { ok: true, message: GENERIC };
  if (input.honeypot) return generic; // bots get the same answer and nothing happens

  const website = normalizeWebsite(input.website);
  const email = input.email.trim().toLowerCase();
  const cityTyped = input.city.trim().replace(/\s+/g, " ");
  if (!website) return { ok: false, message: "Please enter your clinic's website address." };
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(email)) return { ok: false, message: "Please enter a valid email address." };
  if (!/^[A-Za-zÀ-ÿ' .-]{2,40}$/.test(cityTyped)) return { ok: false, message: "Please enter your city or town in Ontario." };
  const domain = siteDomain(website);
  if (domain === siteDomain(env().APP_URL) || domain === "intheanswer.ca") return { ok: false, message: "Please enter your clinic's own website." };
  const [sector] = await sql<{ id: number }[]>`select id from sectors where slug=${input.sector} and active`;
  if (!sector) return { ok: false, message: "Please choose the type of clinic." };
  const city = await resolveCity(cityTyped);
  if (!city) {
    return { ok: false, message: "We could not match that to a city or town in Ontario. Please enter the nearest city or town, for example Barrie or Milton." };
  }
  try {
    await assertPublicUrl(website);
  } catch {
    return { ok: false, message: "That website address cannot be reached from the public internet." };
  }
  if ((await isSuppressed(email)).suppressed) return generic; // never email a suppressed address; do not reveal it

  const ipHash = hashIp(input.ip);
  // Every limit is checked and the request recorded inside one transaction
  // under one lock, so two requests arriving together cannot both pass a count.
  const decision = await sql.begin(async (tx): Promise<Decision> => {
    await tx`select pg_advisory_xact_lock(hashtext('self_serve_requests'))`;
    const [byIp] = await tx<{ n: number }[]>`
      select count(*)::int as n from self_serve_requests where ip_hash=${ipHash} and created_at > now() - interval '1 day'`;
    if (byIp.n >= PER_IP_PER_DAY) {
      return { kind: "reply", result: { ok: false, message: "You have reached today's limit for report requests. Please try again tomorrow." } };
    }
    const [bySite] = await tx<{ n: number }[]>`
      select count(*)::int as n from self_serve_requests where website=${website} and status <> 'rejected'
        and created_at > now() - make_interval(days => ${PER_SITE_DAYS})`;
    if (bySite.n > 0) {
      return { kind: "reply", result: { ok: true, message: "A report for this website was requested recently. It will be emailed to the address given then." } };
    }
    // A clinic we already know is reused only when we are not already dealing with it.
    const [existing] = await tx<{ id: string; status: string }[]>`
      select id, status::text from clinics where domain=${domain} order by created_at limit 1 for update`;
    if (existing && !REUSABLE_STATUSES.includes(existing.status)) return { kind: "reply", result: generic };

    // Global daily cap: over it the request is kept for the owner and nothing runs.
    const [cap] = await tx<{ cap: number | null }[]>`select self_serve_daily_cap as cap from app_settings where id`;
    const [today] = await tx<{ n: number }[]>`
      select count(*)::int as n from self_serve_requests
      where status in ('received', 'running', 'sent') and created_at > now() - interval '1 day'`;
    if (today.n >= (cap?.cap ?? DEFAULT_DAILY_CAP)) {
      await tx`insert into self_serve_requests (website, email, ip_hash, status, reason, sector_id, city)
               values (${website}, ${email}, ${ipHash}, 'held', 'daily self-serve limit reached', ${sector.id}, ${city.name})`;
      await tx`insert into owner_tasks (kind, title, body)
               select 'held_review', ${CAP_TASK_TITLE},
                      'More report requests arrived from the public site than the daily limit allows. They are stored as held and were not run.'
               where not exists (select 1 from owner_tasks where title=${CAP_TASK_TITLE} and status='open')`;
      return { kind: "reply", result: generic };
    }
    const started = await startRequest(tx, { website, email, ipHash, domain, sectorId: sector.id, city, existingClinicId: existing?.id ?? null });
    return { kind: "run", ...started };
  });
  if (decision.kind === "reply") return decision.result;
  await enqueue("find_contact", `selfserve:${decision.requestId}`, { clinicId: decision.clinicId }, { priority: 30 });
  return generic;
}

type Tx = postgres.TransactionSql<{ numeric: number }>;

/** Create (or take over) the clinic and record the request as received. */
async function startRequest(
  tx: Tx,
  r: { website: string; email: string; ipHash: string | null; domain: string; sectorId: number; city: { id: number | null; name: string }; existingClinicId: string | null; requestId?: string },
): Promise<{ requestId: string; clinicId: string }> {
  let clinicId = r.existingClinicId;
  if (clinicId) {
    await tx`update clinics set source='self_serve', status='discovered', status_reason=null,
               website=coalesce(website, ${r.website}), updated_at=now() where id=${clinicId}`;
  } else {
    const cityId =
      r.city.id ??
      (await tx<{ id: number }[]>`
        insert into cities (name, active) values (${r.city.name}, false)
        on conflict (name, province) do update set name = excluded.name returning id`)[0].id;
    [{ id: clinicId }] = await tx<{ id: string }[]>`
      insert into clinics (name, website, domain, city_id, sector_id, source)
      values (${r.domain}, ${r.website}, ${r.domain}, ${cityId}, ${r.sectorId}, 'self_serve') returning id`;
  }
  if (r.requestId) {
    await tx`update self_serve_requests set status='received', reason=null, clinic_id=${clinicId} where id=${r.requestId}`;
    return { requestId: r.requestId, clinicId: clinicId! };
  }
  const [req] = await tx<{ id: string }[]>`
    insert into self_serve_requests (website, email, ip_hash, status, clinic_id, sector_id, city)
    values (${r.website}, ${r.email}, ${r.ipHash}, 'received', ${clinicId}, ${r.sectorId}, ${r.city.name}) returning id`;
  return { requestId: req.id, clinicId: clinicId! };
}

/**
 * Owner action: run a request that was held because the daily limit was
 * reached. The same clinic rules apply as for a new request.
 */
export async function runHeldSelfServe(requestId: string): Promise<{ ok: boolean; reason?: string }> {
  const sql = db();
  const out = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('self_serve_requests'))`;
    const [q] = await tx<{ website: string; email: string; sector_id: number | null; city: string | null; clinic_id: string | null; status: string }[]>`
      select website, email, sector_id, city, clinic_id, status from self_serve_requests where id=${requestId} for update`;
    if (!q || q.status !== "held" || q.clinic_id || !q.sector_id || !q.city) return { ok: false as const, reason: "not a request held by the daily limit" };
    const city = await resolveCity(q.city);
    if (!city) return { ok: false as const, reason: "city is not recognised" };
    if ((await isSuppressed(q.email)).suppressed) return { ok: false as const, reason: "the address is suppressed" };
    const domain = siteDomain(q.website);
    const [existing] = await tx<{ id: string; status: string }[]>`
      select id, status::text from clinics where domain=${domain} order by created_at limit 1 for update`;
    if (existing && !REUSABLE_STATUSES.includes(existing.status)) return { ok: false as const, reason: `the clinic is already ${existing.status}` };
    const started = await startRequest(tx, {
      website: q.website, email: q.email, ipHash: null, domain, sectorId: q.sector_id, city, existingClinicId: existing?.id ?? null, requestId,
    });
    return { ok: true as const, ...started };
  });
  if (!out.ok) return { ok: false, reason: out.reason };
  await enqueue("find_contact", `selfserve:${out.requestId}`, { clinicId: out.clinicId }, { priority: 30 });
  return { ok: true };
}
