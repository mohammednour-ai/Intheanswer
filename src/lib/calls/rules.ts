import { db } from "../db";
import { env, ownerDetailsComplete } from "../env";
import type { AppSettings } from "../settings";
import { voiceConfigured } from "../adapters/voice";
import { addSuppression } from "../sending/suppression";
import { nextWindowStart, startOfNextLocalDay } from "../sending/rules";
import { spendToday } from "../jobs/worker";
import { inSendWindow, localDate } from "../time";

/**
 * Calling rules, enforced in code at the moment a call is about to be placed.
 *
 * The agent's voice is synthesized, and the CRTC's Unsolicited
 * Telecommunications Rules allow a solicitation call that conveys a
 * synthesized voice only with the express consent of the person called;
 * calls to businesses are not exempt from that part of the rules. So the first
 * rule is consent: no call_consents row, no call. There is no cold calling
 * mode, and none should be added without legal advice.
 */

export const MAX_ATTEMPTS = 2;             // the call itself and one retry
export const CONSENT_VALID_DAYS = 14;      // a request to be called goes stale
export const REQUEST_EXPIRY_DAYS = 5;      // a queued call nobody could place is dropped

export interface CallCheck {
  outcome: "call" | "block" | "defer";
  reason: string;
  retryAt?: Date;
}

export interface CallCandidate {
  id: string;
  clinic_id: string | null;
  consent_id: string | null;
  phone: string;
  attempts: number;
  created_at: Date;
}

export async function isPhoneSuppressed(phone: string): Promise<{ suppressed: boolean; reason?: string }> {
  const [r] = await db()<{ reason: string }[]>`select reason from call_suppressions where phone=${phone}`;
  return r ? { suppressed: true, reason: r.reason } : { suppressed: false };
}

/** Never call this number again. Queued calls to it are cancelled and its consents withdrawn. Idempotent. */
export async function suppressPhone(phone: string, reason: string, source: string, clinicId: string | null = null): Promise<void> {
  const sql = db();
  await sql`insert into call_suppressions (phone, reason, source, clinic_id) values (${phone}, ${reason}, ${source}, ${clinicId})
            on conflict (phone) do nothing`;
  await sql`update call_consents set revoked_at=now(), revoked_reason=${reason} where phone=${phone} and revoked_at is null`;
  await sql`update calls set status='cancelled', last_error=${"number suppressed: " + reason}, updated_at=now()
            where phone=${phone} and status='queued'`;
}

/**
 * "Do not contact us at all", said on a call: the number is suppressed, and so
 * is every address we hold for the clinic; unsent mail is cancelled and the
 * clinic is closed to outreach. A paying customer keeps its status (it still
 * gets what it paid for), as with an email unsubscribe.
 */
export async function stopAllContact(phone: string, clinicId: string | null): Promise<void> {
  await suppressPhone(phone, "asked on a call not to be contacted", "call", clinicId);
  if (clinicId) await stopClinic(clinicId, "asked on a call not to be contacted", "call");
}

/**
 * Close a clinic to all outreach: every address we hold for it is suppressed, unsent emails and
 * letters and queued calls are cancelled, its call consents withdrawn. Used for "do not contact us"
 * on a call and on the stop page printed on a letter. Idempotent.
 */
export async function stopClinic(clinicId: string, reason: string, source: string): Promise<void> {
  const sql = db();
  const emails = await sql<{ email: string }[]>`
    select lower(email) as email from contacts where clinic_id=${clinicId}
    union select lower(to_email) from messages where clinic_id=${clinicId} and type in ('first_email', 'follow_up', 'self_serve_teaser')`;
  for (const e of emails) await addSuppression("address", e.email, reason, source);
  await sql`update messages set status='cancelled', updated_at=now()
            where clinic_id=${clinicId} and type in ('first_email', 'follow_up', 'interested_reply', 'question_answer')
              and status in ('draft', 'pending_review', 'held', 'approved', 'scheduled')`;
  await sql`update letters set status='cancelled', reject_reason=${reason}, updated_at=now()
            where clinic_id=${clinicId} and status in ('review', 'held', 'approved')`;
  await sql`update calls set status='cancelled', last_error=${"clinic stopped contact: " + reason}, updated_at=now()
            where clinic_id=${clinicId} and status='queued'`;
  await sql`update call_consents set revoked_at=now(), revoked_reason=${reason} where clinic_id=${clinicId} and revoked_at is null`;
  await sql`update clinics set status='suppressed', status_reason=${reason}, updated_at=now()
            where id=${clinicId} and status not in ('customer', 'do_not_contact', 'suppressed')`;
}

/** What is still missing before a real call can be placed or answered. */
export function callsReady(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!voiceConfigured()) missing.push("TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER");
  if (!env().ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
  const owner = ownerDetailsComplete();
  if (!owner.ok) missing.push(`owner details (${owner.missing.join(", ")})`);
  return { ok: missing.length === 0, missing };
}

/** Outbound calls started today (Toronto), for the daily cap. */
export async function callsStartedToday(now: Date): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    select count(*)::int as n from calls
    where direction='outbound' and dry_run = false and started_at is not null
      and (started_at at time zone 'America/Toronto')::date = ${localDate(now)}::date`;
  return r.n;
}

/**
 * Every check before dialling. Absolute refusals first, then timing and caps
 * (which only delay). Run under the caller's lock so two workers cannot both
 * pass the daily cap.
 */
export async function checkCall(c: CallCandidate, s: AppSettings, now = new Date(), opts: { dryRun?: boolean } = {}): Promise<CallCheck> {
  const sql = db();
  const later = (minutes: number) => new Date(now.getTime() + minutes * 60e3);

  const sup = await isPhoneSuppressed(c.phone);
  if (sup.suppressed) return { outcome: "block", reason: `the number is on the do-not-call list (${sup.reason})` };
  if (c.clinic_id) {
    const [cl] = await sql<{ status: string }[]>`select status::text from clinics where id=${c.clinic_id}`;
    if (cl && (cl.status === "do_not_contact" || cl.status === "suppressed")) return { outcome: "block", reason: `clinic is ${cl.status}` };
  }
  const [consent] = c.consent_id
    ? await sql<{ phone: string; revoked_at: Date | null; granted_at: Date }[]>`select phone, revoked_at, granted_at from call_consents where id=${c.consent_id}`
    : [];
  if (!consent) return { outcome: "block", reason: "no recorded request to be called: the agent only calls numbers a clinic asked us to call" };
  if (consent.revoked_at) return { outcome: "block", reason: "the request to be called was withdrawn" };
  if (consent.phone !== c.phone) return { outcome: "block", reason: "the request to be called was for a different number" };
  if (now.getTime() - consent.granted_at.getTime() > CONSENT_VALID_DAYS * 86400e3) {
    return { outcome: "block", reason: `the request to be called is more than ${CONSENT_VALID_DAYS} days old` };
  }
  if (c.attempts >= MAX_ATTEMPTS) return { outcome: "block", reason: `already tried ${MAX_ATTEMPTS} times` };
  if (now.getTime() - c.created_at.getTime() > REQUEST_EXPIRY_DAYS * 86400e3) {
    return { outcome: "block", reason: `not placed within ${REQUEST_EXPIRY_DAYS} days of the request` };
  }

  if (s.kill_switch) return { outcome: "defer", reason: "kill switch on", retryAt: later(60) };
  if (!s.calls_enabled) return { outcome: "defer", reason: "phone calls are switched off in Settings", retryAt: later(60) };
  if (!opts.dryRun) {
    const ready = callsReady();
    if (!ready.ok) return { outcome: "defer", reason: `not set up: ${ready.missing.join("; ")}`, retryAt: later(60) };
  }
  // Clinics are called in their working day: the same business hours as cold email.
  if (!inSendWindow(now, s.send_window_start, s.send_window_end)) {
    return { outcome: "defer", reason: "outside calling hours", retryAt: nextWindowStart(now, s) };
  }
  if (!opts.dryRun) {
    if ((await callsStartedToday(now)) >= s.calls_daily_cap) {
      return { outcome: "defer", reason: `daily call cap ${s.calls_daily_cap} reached`, retryAt: nextWindowStart(startOfNextLocalDay(now), s) };
    }
    if ((await spendToday()) >= s.claude_daily_spend_cap_usd) return { outcome: "defer", reason: "daily API spend cap reached", retryAt: later(60) };
  }
  const [busy] = await sql`select 1 from calls where phone=${c.phone} and id <> ${c.id} and status in ('dialing', 'in_progress') limit 1`;
  if (busy) return { outcome: "defer", reason: "another call to this number is in progress", retryAt: later(5) };
  return { outcome: "call", reason: "all checks passed" };
}
