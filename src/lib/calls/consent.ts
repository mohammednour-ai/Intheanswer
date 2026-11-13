import { db } from "../db";
import { localParts, TZ } from "../time";
import { channelOpen } from "../channels/settings";
import { isOptedOut } from "../channels/optout";

/**
 * Call-me requests and consent. The exact wording shown beside the unticked
 * box is stored with the number, time, IP and page. Consent lasts 30 days and
 * can be revoked. dial() is the only way a call may start, and it refuses
 * without valid consent, outside calling hours, or when the channel is closed.
 */
export const CALL_CONSENT_TEXT = "I agree to receive an automated call from In The Answer at this number about my report.";
export const emailConsentText = (ownerName: string, business: string) =>
  `I agree to receive emails from ${ownerName} at In The Answer (${business}) with my clinic's full results. I can unsubscribe at any time with the link in every email.`;

/** Calls happen Monday to Friday, 9:30 am to 5:00 pm, clinic local time (Ontario). */
export const CALL_START = "09:30";
export const CALL_END = "17:00";

const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function validWindow(dateYmd: string, start: string, end: string, today = new Date()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateYmd) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return "Please choose a day and a time window.";
  const [y, m, d] = dateYmd.split("-").map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 0 || wd === 6) return "Calls are made Monday to Friday only.";
  if (mins(start) < mins(CALL_START) || mins(end) > mins(CALL_END) || mins(start) >= mins(end)) return "Calls are made between 9:30 am and 5:00 pm only.";
  const p = localParts(today, TZ);
  const todayYmd = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  if (dateYmd < todayYmd) return "Please choose a day that has not passed.";
  if (dateYmd > new Date(today.getTime() + 30 * 86400e3).toISOString().slice(0, 10)) return "Please choose a day within the next 30 days.";
  return null;
}

export function normalizePhone(raw: string): string | null {
  const d = raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? `+1${d}` : null;
}

export interface CallRequestInput {
  clinicId: string;
  name: string;
  role: string;
  phone: string;
  date: string;
  start: string;
  end: string;
  consent: boolean;
  ip: string;
  pageUrl: string;
  sourceChannel: string;
}

export async function createCallRequest(i: CallRequestInput): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  if (!i.consent) return { ok: false, message: "Please tick the box to agree to the call." };
  const name = i.name.trim().slice(0, 100);
  if (name.length < 2) return { ok: false, message: "Please enter your name." };
  const phone = normalizePhone(i.phone);
  if (!phone) return { ok: false, message: "Please enter a 10-digit phone number." };
  const bad = validWindow(i.date, i.start, i.end);
  if (bad) return { ok: false, message: bad };
  if (await isOptedOut(i.clinicId)) return { ok: false, message: "This clinic has asked not to be contacted." };
  const sql = db();
  return sql.begin(async (tx) => {
    const [c] = await tx<{ id: string }[]>`
      insert into call_consents (clinic_id, phone, contact_name, contact_role, consent_text, ip, page_url)
      values (${i.clinicId}, ${phone}, ${name}, ${i.role.trim().slice(0, 80) || null}, ${CALL_CONSENT_TEXT}, ${i.ip}, ${i.pageUrl}) returning id`;
    const [r] = await tx<{ id: string }[]>`
      insert into call_requests (clinic_id, consent_id, preferred_date, window_start, window_end, source_channel)
      values (${i.clinicId}, ${c.id}, ${i.date}, ${i.start}, ${i.end}, ${i.sourceChannel}) returning id`;
    await tx`update clinics set replied=true, updated_at=now() where id=${i.clinicId}`; // they engaged: cold sequence stops
    return { ok: true as const, id: r.id };
  });
}

export class DialRefused extends Error {}

/**
 * The dial function: consent is enforced here, not in the caller. Returns the
 * number to call only when every condition holds; otherwise throws DialRefused.
 * (The voice agent is not connected yet; the portal queue is worked by hand.)
 */
export async function dial(requestId: string, now = new Date()): Promise<{ phone: string; name: string; clinicId: string }> {
  const sql = db();
  const [r] = await sql<{ status: string; clinic_id: string; phone: string; contact_name: string; expires_at: Date; revoked_at: Date | null; consent_text: string }[]>`
    select q.status, q.clinic_id, c.phone, c.contact_name, c.expires_at, c.revoked_at, c.consent_text
    from call_requests q join call_consents c on c.id=q.consent_id where q.id=${requestId}`;
  if (!r) throw new DialRefused("no such call request");
  if (r.status !== "waiting") throw new DialRefused(`request is ${r.status}`);
  if (r.revoked_at) throw new DialRefused("consent was revoked");
  if (r.expires_at.getTime() <= now.getTime()) throw new DialRefused("consent has expired (30 days)");
  if (r.consent_text !== CALL_CONSENT_TEXT) throw new DialRefused("stored consent wording does not cover this call");
  if (await isOptedOut(r.clinic_id)) throw new DialRefused("clinic opted out");
  const p = localParts(now, TZ);
  const t = p.hour * 60 + p.minute;
  if (p.weekday === 0 || p.weekday === 6 || t < mins(CALL_START) || t >= mins(CALL_END)) throw new DialRefused("outside calling hours (Mon to Fri, 9:30 am to 5:00 pm)");
  const gate = await channelOpen("call_me");
  if (!gate.open) throw new DialRefused(gate.reason);
  return { phone: r.phone, name: r.contact_name, clinicId: r.clinic_id };
}

export async function revokeCallConsent(clinicId: string) {
  const sql = db();
  await sql`update call_consents set revoked_at=now() where clinic_id=${clinicId} and revoked_at is null`;
  await sql`update call_requests set status='cancelled', handled_at=now() where clinic_id=${clinicId} and status='waiting'`;
}

export interface EmailConsentInput {
  clinicId: string;
  email: string;
  consent: boolean;
  consentText: string;
  ip: string;
  pageUrl: string;
  sourceChannel: string;
}

export async function createEmailConsent(i: EmailConsentInput): Promise<{ ok: boolean; message: string }> {
  if (!i.consent) return { ok: false, message: "Please tick the box to agree to receive the email." };
  const email = i.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(email)) return { ok: false, message: "Please enter a valid email address." };
  if (await isOptedOut(i.clinicId)) return { ok: false, message: "This clinic has asked not to be contacted." };
  const sql = db();
  await sql`insert into email_consents (clinic_id, email, consent_text, ip, page_url, source_channel)
            values (${i.clinicId}, ${email}, ${i.consentText}, ${i.ip}, ${i.pageUrl}, ${i.sourceChannel})`;
  await sql`update clinics set replied=true, updated_at=now() where id=${i.clinicId}`;
  return { ok: true, message: "Thank you. Your full results will be emailed to you." };
}

/** Express consent on file for this address (the only basis for emailing someone who came by letter). */
export async function hasEmailConsent(clinicId: string, email: string): Promise<boolean> {
  const [r] = await db()`select 1 from email_consents where clinic_id=${clinicId} and email=${email.trim().toLowerCase()} and revoked_at is null limit 1`;
  return !!r;
}
