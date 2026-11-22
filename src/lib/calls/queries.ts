import { db } from "../db";

/** Read models for the portal's Calls page. */

export interface CallListItem {
  id: string;
  direction: "outbound" | "inbound";
  status: string;
  clinic_id: string | null;
  clinic_name: string | null;
  phone: string;
  contact_name: string | null;
  attempts: number;
  scheduled_for: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  outcome: string | null;
  summary: string | null;
  signals: Record<string, unknown>;
  review_flags: { said: string; issue: string }[];
  dry_run: boolean;
  last_error: string | null;
  created_at: Date;
  consent_source: string | null;
  consent_note: string | null;
  consent_at: Date | null;
}

export interface CallTurn {
  call_id: string;
  seq: number;
  role: "agent" | "caller" | "system";
  text: string;
  action: string | null;
  blocked_text: string | null;
  flags: { code: string; message: string }[];
}

export async function listCalls(limit = 60): Promise<CallListItem[]> {
  return db()<CallListItem[]>`
    select c.id, c.direction, c.status, c.clinic_id, coalesce(cl.site_name, cl.name) as clinic_name, c.phone, c.contact_name, c.attempts,
           c.scheduled_for, c.started_at, c.ended_at, c.duration_seconds, c.outcome, c.summary, c.signals, c.review_flags, c.dry_run,
           c.last_error, c.created_at, k.source as consent_source, k.note as consent_note, k.granted_at as consent_at
    from calls c left join clinics cl on cl.id = c.clinic_id left join call_consents k on k.id = c.consent_id
    order by c.created_at desc limit ${limit}`;
}

export async function turnsFor(callIds: string[]): Promise<Map<string, CallTurn[]>> {
  const out = new Map<string, CallTurn[]>();
  if (!callIds.length) return out;
  const rows = await db()<CallTurn[]>`
    select call_id, seq, role, text, action, blocked_text, flags from call_turns where call_id = any(${callIds}) order by call_id, seq`;
  for (const r of rows) out.set(r.call_id, [...(out.get(r.call_id) ?? []), r]);
  return out;
}

export async function listCallSuppressions(limit = 200) {
  return db()<{ phone: string; reason: string; source: string; created_at: Date }[]>`
    select phone, reason, source, created_at from call_suppressions order by created_at desc limit ${limit}`;
}

/** Calls for one clinic, newest first (the clinic page). */
export async function callsForClinic(clinicId: string, limit = 5) {
  return db()<{ id: string; status: string; created_at: Date; outcome: string | null; phone: string }[]>`
    select id, status, created_at, outcome, phone from calls where clinic_id=${clinicId} order by created_at desc limit ${limit}`;
}
