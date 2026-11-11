import { db } from "../db";
import type { JobContext } from "../jobs/queue";
import { PermanentJobError } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { readSite, type SiteRead } from "../site/crawl";
import { addSuppression } from "../sending/suppression";
import { currentRunLabel } from "./runs";

/**
 * Step 2: find a contact address. Rules:
 * - only an address the clinic publishes on its own site, with the exact URL
 * - never guessed, never from a directory or a purchased list
 * - a "no solicitation" notice marks the clinic do-not-contact
 */

const NO_SOLICIT_RE =
  /\b(no (soliciting|solicitations?|solicitors|sales calls|marketing (emails?|calls))|do not (solicit|send (us )?(unsolicited|marketing|sales))|not (accept|respond to) (unsolicited|solicitations?)|unsolicited (emails?|messages|offers|solicitations?) (are|will) not|solicitations? (are|is) not (welcome|accepted)|vendors?,? please do not)\b/i;

const GENERIC_LOCAL = /^(info|hello|contact|reception|office|frontdesk|front\.desk|admin|appointments?|booking|bookings|clinic|team|enquiries|inquiries|care|mail)$/;

export interface ContactCandidate {
  email: string;
  sourceUrl: string;
  snippet: string;
  onOwnDomain: boolean;
  viaMailto: boolean;
}

export interface ContactResult {
  doNotContact: { url: string; quote: string } | null;
  candidates: ContactCandidate[];
  primary: ContactCandidate | null;
}

export function emailOnDomain(email: string, domain: string): boolean {
  const d = email.split("@")[1]?.toLowerCase() ?? "";
  return d === domain || d.endsWith("." + domain);
}

export function findContacts(site: SiteRead): ContactResult {
  let doNotContact: ContactResult["doNotContact"] = null;
  const byEmail = new Map<string, ContactCandidate>();
  for (const p of site.pages) {
    const m = p.text.match(NO_SOLICIT_RE);
    if (m && !doNotContact) {
      const i = m.index ?? 0;
      doNotContact = { url: p.url, quote: p.text.slice(Math.max(0, i - 60), i + m[0].length + 60).replace(/\n/g, " ").trim() };
    }
    for (const e of p.emails) {
      if (byEmail.has(e.email)) {
        const prev = byEmail.get(e.email)!;
        if (!prev.viaMailto && e.viaMailto) byEmail.set(e.email, { ...prev, viaMailto: true });
        continue;
      }
      byEmail.set(e.email, {
        email: e.email,
        sourceUrl: p.url,
        snippet: e.context,
        onOwnDomain: emailOnDomain(e.email, site.domain),
        viaMailto: e.viaMailto,
      });
    }
  }
  const candidates = [...byEmail.values()];
  const rank = (c: ContactCandidate) =>
    (c.onOwnDomain ? 100 : 0) + (GENERIC_LOCAL.test(c.email.split("@")[0]) ? 20 : 0) + (c.viaMailto ? 5 : 0);
  candidates.sort((a, b) => rank(b) - rank(a));
  return { doNotContact, candidates, primary: candidates[0] ?? null };
}

/** Name as the clinic writes it: the page title before any separator, else the main heading. */
export function ownSiteName(title: string, h1: string[]): string | null {
  const parts = title.split(/\s+[|\u2013\u2014:-]\s+/).map((x) => x.trim()).filter(Boolean);
  const pick = parts.find((x) => !/^(home|welcome|homepage)$/i.test(x)) ?? h1[0] ?? "";
  const name = pick.replace(/\s+/g, " ").trim();
  return name.length >= 3 && name.length <= 80 ? name : null;
}

/**
 * Self-serve: the clinic asked for its own report. The address it typed is
 * used only when it is on the site's own domain or published on the site;
 * otherwise the request is held for the owner (so the form cannot be used to
 * send a report about one business to someone else).
 */
async function selfServeContact(ctx: JobContext, clinic: { id: string; sector_id: number; city_id: number }, site: Awaited<ReturnType<typeof readSite>>, r: ContactResult) {
  const sql = db();
  const [req] = await sql<{ email: string }[]>`select email from self_serve_requests where clinic_id=${clinic.id} order by created_at desc limit 1`;
  if (!req) throw new PermanentJobError("self-serve request not found");
  const email = req.email.toLowerCase();
  const verified = emailOnDomain(email, site.domain) || r.candidates.some((c) => c.email === email);
  if (!verified) {
    const reason = `self-serve: ${email} is not on ${site.domain} and is not published on the site`;
    await sql`update clinics set status='held', status_reason=${reason}, updated_at=now() where id=${clinic.id}`;
    await sql`update self_serve_requests set status='held', reason=${reason} where clinic_id=${clinic.id}`;
    return { held: reason };
  }
  await sql`insert into contacts (clinic_id, email, source_url, source_snippet, on_own_domain, is_primary)
            values (${clinic.id}, ${email}, ${"requested by the clinic on intheanswer.ca"}, 'self-serve request', ${emailOnDomain(email, site.domain)}, true)
            on conflict (clinic_id, email) do update set is_primary=true`;
  await sql`update clinics set status='contact_found', status_reason=null, updated_at=now() where id=${clinic.id}`;
  await sql`update self_serve_requests set status='running' where clinic_id=${clinic.id}`;
  const label = currentRunLabel();
  await ctx.enqueue("test_city", `test:${clinic.sector_id}:${clinic.city_id}:${label}`, { sectorId: clinic.sector_id, cityId: clinic.city_id, runLabel: label });
  await ctx.enqueue("audit_clinic", `audit:${clinic.id}:${label}`, { clinicId: clinic.id, runLabel: label });
  await ctx.enqueue("site_test", `sitetest:${clinic.id}:${label}`, { clinicId: clinic.id, runLabel: label }, { maxAttempts: 2 });
  return { contact: email, selfServe: true };
}

async function handleFindContact(ctx: JobContext) {
  const { clinicId } = ctx.job.payload as { clinicId: string };
  const sql = db();
  const [clinic] = await sql<{ id: string; website: string | null; sector_id: number; city_id: number; status: string; source: string }[]>`
    select id, website, sector_id, city_id, status::text, source from clinics where id = ${clinicId}`;
  if (!clinic) throw new PermanentJobError("clinic not found");
  if (!clinic.website) {
    await sql`update clinics set status='excluded', status_reason='no website of its own', updated_at=now() where id=${clinicId}`;
    return { skipped: "no website" };
  }
  const site = await readSite(clinic.website);
  await ctx.log("site read", { pages: site.pages.map((p) => p.url), failures: site.failures });
  if (!site.home) {
    await sql`update clinics set status='no_contact', status_reason=${"site could not be read: " + (site.failures[0]?.reason ?? "unknown")},
              updated_at=now() where id=${clinicId}`;
    return { skipped: "site unreadable" };
  }
  // The clinic's name comes from its own site (never from Places).
  if (clinic.source === "places") {
    const own = ownSiteName(site.home.title, site.home.h1);
    if (own) await sql`update clinics set name=${own}, updated_at=now() where id=${clinicId}`;
  }
  const r = findContacts(site);
  if (clinic.source === "self_serve") return selfServeContact(ctx, clinic, site, r);
  if (r.doNotContact) {
    await sql`update clinics set status='do_not_contact', status_reason=${`no-solicitation notice at ${r.doNotContact.url}: "${r.doNotContact.quote}"`},
              updated_at=now() where id=${clinicId}`;
    await addSuppression("domain", site.domain, `no-solicitation notice at ${r.doNotContact.url}`, "do_not_contact_notice");
    return { doNotContact: r.doNotContact };
  }
  for (const c of r.candidates) {
    await sql`insert into contacts (clinic_id, email, source_url, source_snippet, on_own_domain, is_primary)
              values (${clinicId}, ${c.email}, ${c.sourceUrl}, ${c.snippet}, ${c.onOwnDomain}, ${c === r.primary})
              on conflict (clinic_id, email) do update set source_url=excluded.source_url, source_snippet=excluded.source_snippet,
                is_primary=excluded.is_primary`;
  }
  if (!r.primary) {
    await sql`update clinics set status='no_contact', status_reason='no email address published on its own site', updated_at=now() where id=${clinicId}`;
    return { contact: null };
  }
  await sql`update clinics set status='contact_found', status_reason=null, updated_at=now() where id=${clinicId}`;
  // next: make sure the city test exists, then audit this clinic
  const label = currentRunLabel();
  await ctx.enqueue("test_city", `test:${clinic.sector_id}:${clinic.city_id}:${label}`, {
    sectorId: clinic.sector_id,
    cityId: clinic.city_id,
    runLabel: label,
  });
  await ctx.enqueue("audit_clinic", `audit:${clinicId}:${label}`, { clinicId, runLabel: label });
  await ctx.enqueue("site_test", `sitetest:${clinicId}:${label}`, { clinicId, runLabel: label }, { maxAttempts: 2 });
  return { contact: r.primary.email, source: r.primary.sourceUrl };
}

register("find_contact", handleFindContact);
