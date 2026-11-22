import crypto from "node:crypto";
import { db } from "../db";
import { env } from "../env";
import { enqueue } from "../jobs/queue";
import { getSettings, type AppSettings } from "../settings";
import { hashIp } from "../selfServe";
import { randomToken } from "../tokens";
import { nextWindowStart } from "../sending/rules";
import { inSendWindow } from "../time";
import { COPILOT_NAME } from "../brand";
import { displayPhone, normalizeCanadianPhone } from "./phone";
import { isPhoneSuppressed } from "./rules";

/**
 * How a call comes to be queued. There are exactly two ways, and both record
 * who asked for it:
 *   1. the clinic asks, on the page its report links to (`requestCall`);
 *   2. the owner records that a clinic asked some other way: in an email
 *      reply, on the phone, in person (`scheduleOwnerCall`).
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PER_IP_PER_DAY = 5;

/** The words a clinic agrees to on the request page. Stored with each consent, so the evidence is the text they saw. */
export function consentWording(): string {
  return `I am asking In The Answer to phone me at this number about this report. I understand that the call is made by ${COPILOT_NAME}, an AI assistant and not a person, and that the call is transcribed so the In The Answer team can review it.`;
}

export interface CallPage {
  reportId: string;
  clinicId: string;
  clinicName: string;
  code: string;
  /** Our number, for a clinic that would rather phone us. Null when telephony is not set up. */
  ourNumber: string | null;
  /** Whether a call can be requested right now, and if not, why (in plain words for the page). */
  open: boolean;
  closedReason: string | null;
  hours: string;
}

const to12h = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "a.m." : "p.m."}`;
};

export function callingHours(s: Pick<AppSettings, "send_window_start" | "send_window_end">): string {
  return `Monday to Friday, ${to12h(s.send_window_start)} to ${to12h(s.send_window_end)}, Toronto time`;
}

/** A six-digit code for a report, made once and kept (shown on the request page, said to the agent on an inbound call). */
export async function ensureCallCode(reportId: string): Promise<string> {
  const sql = db();
  const [r] = await sql<{ call_code: string | null }[]>`select call_code from reports where id=${reportId}`;
  if (r?.call_code) return r.call_code;
  for (let i = 0; i < 8; i++) {
    const code = String(crypto.randomInt(100000, 1000000));
    try {
      const set = await sql<{ call_code: string }[]>`update reports set call_code=${code} where id=${reportId} and call_code is null returning call_code`;
      if (set.length) return code;
      const [again] = await sql<{ call_code: string | null }[]>`select call_code from reports where id=${reportId}`;
      if (again?.call_code) return again.call_code;
    } catch (e) {
      if ((e as { code?: string }).code !== "23505") throw e; // the code is taken: try another
    }
  }
  throw new Error("could not assign a report code");
}

type ReportRow = { id: string; clinic_id: string; name: string; status: string };

/** The clinic behind a report link. A sample, an unverified draft or a report with no clinic does not count. */
async function reportByToken(token: string): Promise<ReportRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [r] = await db()<ReportRow[]>`
    select r.id, r.clinic_id, coalesce(c.site_name, c.name) as name, c.status::text
    from reports r join clinics c on c.id = r.clinic_id
    where r.token=${token} and r.kind in ('teaser', 'monthly', 'retest', 'full') and coalesce(r.data->>'verified', 'true') <> 'false'`;
  return r ?? null;
}

/** Whether the report page should offer a call at all (cheap: one settings row). */
export async function callsOffered(): Promise<boolean> {
  const s = await getSettings();
  return s.calls_enabled && !s.kill_switch;
}

export interface CallOffer {
  /** Our number for a clinic that would rather phone us ("+1647..."), and its report code. Null when telephony is not set up. */
  phone: { e164: string; display: string; code: string } | null;
}

/** What a report page shows about calls: null while they are not offered. Gives the report its code if it has none yet. */
export async function callOffer(reportId: string): Promise<CallOffer | null> {
  if (!(await callsOffered())) return null;
  const ours = env().TWILIO_PHONE_NUMBER;
  if (!ours) return { phone: null };
  const code = await ensureCallCode(reportId).catch(() => null);
  return { phone: code ? { e164: ours, display: displayPhone(ours), code } : null };
}

export async function loadCallPage(token: string): Promise<CallPage | null> {
  const r = await reportByToken(token);
  if (!r) return null;
  const s = await getSettings();
  const closedReason =
    !s.calls_enabled || s.kill_switch ? "Calls from our assistant are not available at the moment."
    : r.status === "do_not_contact" || r.status === "suppressed" ? "This clinic asked us not to make contact, so we do not place calls to it."
    : null;
  return {
    reportId: r.id, clinicId: r.clinic_id, clinicName: r.name, code: await ensureCallCode(r.id),
    ourNumber: env().TWILIO_PHONE_NUMBER ? displayPhone(env().TWILIO_PHONE_NUMBER!) : null,
    open: closedReason === null, closedReason, hours: callingHours(s),
  };
}

export type RequestResult = { ok: true; message: string } | { ok: false; message: string };

export interface CallRequest {
  token: string;
  phone: string;
  name?: string;
  agreed: boolean;
  ip: string;
  honeypot?: string;
}

/** When the call will be tried: now, inside calling hours; otherwise when they next open. */
function firstSlot(now: Date, s: AppSettings): Date {
  return inSendWindow(now, s.send_window_start, s.send_window_end) ? now : nextWindowStart(now, s);
}

const whenText = (at: Date, now: Date) =>
  at.getTime() - now.getTime() < 60e3
    ? "within the next few minutes"
    : `on ${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", weekday: "long", hour: "numeric", minute: "2-digit" }).format(at)} (Toronto time) or soon after`;

async function queueCall(tx: ReturnType<typeof db>, c: { clinicId: string; reportId: string | null; consentId: string; phone: string; name: string | null; at: Date }): Promise<string> {
  const [call] = await tx<{ id: string }[]>`
    insert into calls (token, direction, status, clinic_id, report_id, consent_id, phone, contact_name, scheduled_for, idempotency_key)
    values (${randomToken(24)}, 'outbound', 'queued', ${c.clinicId}, ${c.reportId}, ${c.consentId}, ${c.phone}, ${c.name}, ${c.at}, ${"consent:" + c.consentId})
    returning id`;
  return call.id;
}

/** A clinic asks, on the page its report links to, for the assistant to phone it. */
export async function requestCall(input: CallRequest, now = new Date()): Promise<RequestResult> {
  const sql = db();
  const generic: RequestResult = { ok: true, message: "Thank you. Our assistant will call you." };
  if (input.honeypot) return generic; // bots get the same answer and nothing happens
  const r = await reportByToken(input.token);
  if (!r) return { ok: false, message: "This link is not valid any more. Please use the link in your latest report." };
  if (!input.agreed) return { ok: false, message: "Please tick the box to confirm that you are asking for this call." };
  const phone = normalizeCanadianPhone(input.phone);
  if (!phone) return { ok: false, message: "Please enter a Canadian phone number with its area code, for example 705-555-0100." };
  const name = (input.name ?? "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80) || null;

  const s = await getSettings();
  const ours = env().TWILIO_PHONE_NUMBER;
  const phoneUs = ours ? ` You can also phone us at ${displayPhone(ours)}.` : "";
  if (!s.calls_enabled || s.kill_switch) return { ok: false, message: "Calls from our assistant are not available at the moment." };
  if (r.status === "do_not_contact" || r.status === "suppressed") {
    return { ok: false, message: "This clinic asked us not to make contact, so we do not place calls to it." + phoneUs };
  }
  if ((await isPhoneSuppressed(phone)).suppressed) {
    return { ok: false, message: "We were asked not to call that number, so we will not." + phoneUs };
  }

  const ipHash = hashIp(input.ip);
  const at = firstSlot(now, s);
  // Every limit is checked and the request recorded in one transaction under one lock,
  // so two requests arriving together cannot both pass a count.
  const out = await sql.begin(async (tx): Promise<RequestResult & { callId?: string }> => {
    await tx`select pg_advisory_xact_lock(hashtext('call_requests'))`;
    const [live] = await tx`select 1 from calls where report_id=${r.id} and status in ('queued', 'dialing', 'in_progress') limit 1`;
    if (live) return { ok: true, message: "A call for this report is already on its way." };
    const [n] = await tx<{ report: number; ip: number; all: number }[]>`
      select count(*) filter (where report_id=${r.id})::int as report,
             count(*) filter (where ip_hash=${ipHash})::int as ip,
             count(*)::int as all
      from call_consents where source='web_form' and granted_at > ${new Date(now.getTime() - 86400e3)}`;
    if (n.report >= s.call_requests_per_report_per_day || n.ip >= PER_IP_PER_DAY) {
      return { ok: false, message: "A call was already requested for this report today." + phoneUs };
    }
    if (n.all >= s.calls_daily_cap) return { ok: false, message: "Our assistant is fully booked today. Please try again tomorrow." + phoneUs };
    const [consent] = await tx<{ id: string }[]>`
      insert into call_consents (clinic_id, report_id, phone, source, wording, contact_name, ip_hash, recorded_by, granted_at)
      values (${r.clinic_id}, ${r.id}, ${phone}, 'web_form', ${consentWording()}, ${name}, ${ipHash}, 'clinic', ${now})
      returning id`;
    const callId = await queueCall(tx as never, { clinicId: r.clinic_id, reportId: r.id, consentId: consent.id, phone, name, at });
    return { ok: true, message: `Thank you. Our assistant will call ${displayPhone(phone)} ${whenText(at, now)}.`, callId };
  });
  if (out.callId) await enqueue("place_call", `call:${out.callId}:1`, { callId: out.callId }, { runAfter: at, priority: 20, maxAttempts: 4 });
  return { ok: out.ok, message: out.message };
}

export const OWNER_SOURCES = {
  email_reply: "asked in an email reply",
  phone_request: "asked on the phone",
  in_person: "asked in person",
} as const;
export type OwnerSource = keyof typeof OWNER_SOURCES;

/**
 * The owner records that a clinic asked to be called (the reply to an
 * interested clinic offers exactly this) and queues the call. The owner is
 * vouching for the request, so this is only reachable from the portal, and
 * the note saying how the clinic asked is required.
 */
export async function scheduleOwnerCall(input: { clinicId: string; phone: string; name?: string; source: string; note: string; actorEmail: string }, now = new Date()): Promise<RequestResult> {
  const sql = db();
  if (!(input.source in OWNER_SOURCES)) return { ok: false, message: "Choose how the clinic asked for the call." };
  const note = input.note.replace(/\s+/g, " ").trim().slice(0, 500);
  if (note.length < 5) return { ok: false, message: "Say how the clinic asked for the call (for example: reply of 12 November, asked to be called after 2 pm)." };
  const phone = normalizeCanadianPhone(input.phone);
  if (!phone) return { ok: false, message: "Enter a Canadian phone number with its area code." };
  const [c] = await sql<{ id: string; status: string }[]>`select id, status::text from clinics where id=${input.clinicId}`;
  if (!c) return { ok: false, message: "Clinic not found." };
  if (c.status === "do_not_contact" || c.status === "suppressed") return { ok: false, message: `This clinic is ${c.status.replace(/_/g, " ")}: it is not called.` };
  const sup = await isPhoneSuppressed(phone);
  if (sup.suppressed) return { ok: false, message: `That number is on the do-not-call list (${sup.reason}).` };
  const [live] = await sql`select 1 from calls where clinic_id=${c.id} and status in ('queued', 'dialing', 'in_progress') limit 1`;
  if (live) return { ok: false, message: "A call to this clinic is already queued or in progress." };
  const s = await getSettings();
  const at = firstSlot(now, s);
  const name = (input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || null;
  const source = input.source as OwnerSource;
  const callId = await sql.begin(async (tx) => {
    const [consent] = await tx<{ id: string }[]>`
      insert into call_consents (clinic_id, phone, source, wording, contact_name, note, recorded_by, granted_at)
      values (${c.id}, ${phone}, ${source}, ${`The clinic ${OWNER_SOURCES[source]} to be called at this number. Recorded by the owner.`}, ${name}, ${note}, ${input.actorEmail}, ${now})
      returning id`;
    return queueCall(tx as never, { clinicId: c.id, reportId: null, consentId: consent.id, phone, name, at });
  });
  await enqueue("place_call", `call:${callId}:1`, { callId }, { runAfter: at, priority: 20, maxAttempts: 4 });
  return { ok: true, message: `Call to ${displayPhone(phone)} queued: ${whenText(at, now)}.${s.calls_enabled ? "" : " Calls are switched off in Settings, so it waits until they are on."}` };
}

/** The owner cancels a call that has not been placed yet. */
export async function cancelCall(callId: string): Promise<boolean> {
  const rows = await db()`update calls set status='cancelled', last_error='cancelled by the owner', updated_at=now() where id=${callId} and status='queued' returning id`;
  return rows.length > 0;
}
