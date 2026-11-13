import { db } from "./db";
import { addSuppression, normalizeEmail } from "./sending/suppression";
import { hashIp } from "./selfServe";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/;

/**
 * Unsubscribe: works without login, takes effect at once, never expires.
 * The address is suppressed, every unsent message to it is cancelled, and the
 * clinic it belongs to is closed to further contact. A paying customer's
 * clinic is never closed this way.
 *
 * This function trusts its caller: use it for a signed link or a one-click
 * header (proof that the request comes from the mailbox). For an address
 * typed into the public form use unsubscribeByAddress.
 */
export async function unsubscribe(emailRaw: string, source: "unsubscribe_link" | "unsubscribe_form" | "one_click" | "reply" | "complaint"): Promise<void> {
  const email = normalizeEmail(emailRaw);
  if (!EMAIL_RE.test(email)) return;
  const sql = db();
  await addSuppression("address", email, "unsubscribed", source);
  await sql`update messages set status='cancelled', updated_at=now()
            where lower(to_email)=${email} and status in ('draft','pending_review','held','approved','scheduled')`;
  // The clinic this address belongs to: one of its recorded contacts, or the
  // clinic a message to this address was written for. Customers keep their
  // status, and a do-not-contact notice is not replaced by a weaker reason.
  await sql`update clinics set status='suppressed', status_reason='unsubscribed', updated_at=now()
            where id in (
              select clinic_id from contacts where lower(email)=${email}
              union
              select clinic_id from messages where lower(to_email)=${email} and clinic_id is not null
            )
            and status not in ('customer', 'do_not_contact', 'suppressed')`;
}

/** True when we have, or are about to have, a reason to write to this address. */
export async function isKnownRecipient(email: string): Promise<boolean> {
  const [r] = await db()<{ known: boolean }[]>`
    select (exists (select 1 from messages where lower(to_email)=${email})
         or exists (select 1 from contacts where lower(email)=${email})
         or exists (select 1 from self_serve_requests where lower(email)=${email})) as known`;
  return !!r?.known;
}

export const UNSUB_PER_IP_PER_HOUR = 5;
export const UNSUB_PER_IP_PER_DAY = 20;

/**
 * Unsubscribe by typing an address (the public form): no proof that the
 * visitor owns the mailbox, so it is limited to what a real recipient needs.
 * - It only acts on an address we have written to, have queued mail for, or
 *   hold as a contact. Unknown addresses are ignored, so the form cannot be
 *   used to fill the suppression list or close clinics by guessing.
 * - Each visitor (hashed IP) gets a few attempts per hour and per day.
 * The caller shows the same confirmation whatever happened here, so the form
 * does not reveal whether an address is on our list.
 */
export async function unsubscribeByAddress(emailRaw: string, ip: string): Promise<{ acted: boolean; reason?: "invalid" | "rate_limited" | "unknown_address" }> {
  const email = normalizeEmail(emailRaw);
  if (!EMAIL_RE.test(email)) return { acted: false, reason: "invalid" };
  const sql = db();
  const ipHash = hashIp(ip);
  // Record the attempt and count in one statement under a per-visitor lock, so parallel posts cannot all pass.
  const allowed = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${"unsub:" + ipHash}))`;
    const [n] = await tx<{ hour: number; day: number }[]>`
      select count(*) filter (where created_at > now() - interval '1 hour')::int as hour, count(*)::int as day
      from unsubscribe_attempts where ip_hash=${ipHash} and created_at > now() - interval '1 day'`;
    if (n.hour >= UNSUB_PER_IP_PER_HOUR || n.day >= UNSUB_PER_IP_PER_DAY) return false;
    await tx`insert into unsubscribe_attempts (ip_hash) values (${ipHash})`;
    return true;
  });
  // old attempts are of no further use
  await sql`delete from unsubscribe_attempts where created_at < now() - interval '2 days'`;
  if (!allowed) return { acted: false, reason: "rate_limited" };
  if (!(await isKnownRecipient(email))) return { acted: false, reason: "unknown_address" };
  await unsubscribe(email, "unsubscribe_form");
  return { acted: true };
}
