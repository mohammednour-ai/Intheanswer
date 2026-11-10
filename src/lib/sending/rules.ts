import { db } from "../db";
import type { AppSettings } from "../settings";
import { daysBetween, inSendWindow, localDate, torontoToUtc, isBusinessDay } from "../time";
import { isSuppressed } from "./suppression";

/**
 * Sending rules, enforced in code for every outbound message in both modes.
 * Pure helpers are exported separately so they can be unit tested.
 */

type WarmupSettings = Pick<
  AppSettings,
  "warmup_start_date" | "warmup_start_per_day" | "warmup_step_per_week" | "warmup_ceiling" | "daily_cap_override"
>;

/** Daily cap: 10 to start, +5 each week, ceiling 40; a manual override can only lower it. */
export function warmupCapForDate(s: WarmupSettings, todayYmd: string): number {
  let cap = s.warmup_start_per_day;
  if (s.warmup_start_date) {
    const days = daysBetween(s.warmup_start_date, todayYmd);
    const weeks = Math.max(0, Math.floor(days / 7));
    cap = Math.min(s.warmup_ceiling, s.warmup_start_per_day + s.warmup_step_per_week * weeks);
  }
  if (s.daily_cap_override != null) cap = Math.min(cap, s.daily_cap_override);
  return Math.max(0, cap);
}

/**
 * Spread sends across the window: given how many are allowed today and how many
 * already went, return the earliest time the next one may leave.
 */
export function nextSlot(now: Date, s: Pick<AppSettings, "send_window_start" | "send_window_end">, cap: number, sentToday: number): Date {
  const day = localDate(now);
  const start = torontoToUtc(day, s.send_window_start).getTime();
  const end = torontoToUtc(day, s.send_window_end).getTime();
  const interval = cap > 0 ? (end - start) / cap : end - start;
  const slot = start + interval * sentToday;
  return new Date(Math.max(now.getTime(), slot));
}

/** Message types that count against the cold-outreach cap and the 2-contacts rule. */
export const COLD_TYPES = new Set(["first_email", "follow_up"]);

export interface SendCheck {
  ok: boolean;
  /** "block": never send (cancel). "defer": try again later. */
  outcome: "send" | "block" | "defer";
  reason: string;
  retryAt?: Date;
}

export interface SendCandidate {
  id: string;
  type: string;
  to_email: string;
  clinic_id: string | null;
}

/**
 * All checks before a send. Order matters: absolute blocks first, then
 * timing/caps (defers).
 */
export async function checkSend(m: SendCandidate, s: AppSettings, now = new Date()): Promise<SendCheck> {
  const sql = db();
  const isCold = COLD_TYPES.has(m.type);
  const transactionalAlways = m.type === "payment_receipt" || m.type === "unsubscribe_confirmation";

  if (s.kill_switch && !transactionalAlways) return { ok: false, outcome: "defer", reason: "kill switch on", retryAt: new Date(now.getTime() + 3600e3) };
  if (s.auto_paused && !transactionalAlways) return { ok: false, outcome: "defer", reason: `auto-paused: ${s.auto_pause_reason}`, retryAt: new Date(now.getTime() + 3600e3) };
  if (!s.dns_verified) return { ok: false, outcome: "defer", reason: "SPF/DKIM/DMARC not verified", retryAt: new Date(now.getTime() + 3600e3) };

  // Suppression applies to everything except the unsubscribe confirmation itself.
  if (m.type !== "unsubscribe_confirmation") {
    const sup = await isSuppressed(m.to_email);
    if (sup.suppressed) return { ok: false, outcome: "block", reason: `suppressed (${sup.reason})` };
  }

  if (isCold && m.clinic_id) {
    const [c] = await sql<{ contact_count: number; replied: boolean; status: string }[]>`
      select contact_count, replied, status::text from clinics where id = ${m.clinic_id}`;
    if (c?.status === "do_not_contact" || c?.status === "suppressed") return { ok: false, outcome: "block", reason: `clinic is ${c.status}` };
    if (c && c.replied) return { ok: false, outcome: "block", reason: "clinic replied; cold sequence stops" };
    if (c && c.contact_count >= 2) return { ok: false, outcome: "block", reason: "clinic already contacted twice" };
    if (m.type === "follow_up") {
      const [prior] = await sql<{ n: number }[]>`
        select count(*)::int as n from messages where clinic_id=${m.clinic_id} and type='follow_up' and status='sent'`;
      if (prior.n > 0) return { ok: false, outcome: "block", reason: "follow-up already sent" };
    }
  }

  if (isCold) {
    if (!inSendWindow(now, s.send_window_start, s.send_window_end)) {
      return { ok: false, outcome: "defer", reason: "outside sending hours", retryAt: nextWindowStart(now, s) };
    }
    const today = localDate(now);
    const cap = warmupCapForDate(s, today);
    const [sent] = await sql<{ n: number }[]>`
      select count(*)::int as n from messages
      where type in ('first_email','follow_up') and status='sent'
        and (sent_at at time zone 'America/Toronto')::date = ${today}::date`;
    if (sent.n >= cap) return { ok: false, outcome: "defer", reason: `daily cap ${cap} reached`, retryAt: nextWindowStart(new Date(now.getTime() + 86400e3), s, true) };
    const slot = nextSlot(now, s, cap, sent.n);
    if (slot.getTime() > now.getTime() + 30e3) return { ok: false, outcome: "defer", reason: "spreading sends across the day", retryAt: slot };
  }
  return { ok: true, outcome: "send", reason: "all checks passed" };
}

export function nextWindowStart(from: Date, s: Pick<AppSettings, "send_window_start" | "send_window_end">, forceNextDay = false): Date {
  let d = new Date(from.getTime());
  for (let i = 0; i < 10; i++) {
    const day = localDate(d);
    const start = torontoToUtc(day, s.send_window_start);
    const end = torontoToUtc(day, s.send_window_end);
    if (isBusinessDay(start) && (!forceNextDay || i > 0 || d.getTime() <= start.getTime())) {
      if (d.getTime() < start.getTime()) return start;
      if (d.getTime() < end.getTime() && !forceNextDay) return d;
    }
    d = torontoToUtc(localDate(new Date(start.getTime() + 86400e3)), "00:01");
  }
  return d;
}

/** Bounce/complaint monitor: pause all sending when bounces > 3% or any complaint. */
export async function evaluateAutoPause(windowDays = 14, minSample = 20): Promise<{ paused: boolean; reason?: string }> {
  const sql = db();
  const [r] = await sql<{ sent: number; bounced: number; complained: number }[]>`
    select count(*)::int as sent,
           count(*) filter (where bounced_at is not null)::int as bounced,
           count(*) filter (where complained_at is not null)::int as complained
    from messages where status='sent' and dry_run = false
      and sent_at > greatest(now() - make_interval(days => ${windowDays}),
                             coalesce((select auto_pause_cleared_at from app_settings where id), '-infinity'))`;
  const [s] = await sql<{ bounce_rate_threshold: number; auto_paused: boolean }[]>`select bounce_rate_threshold, auto_paused from app_settings where id`;
  let reason: string | undefined;
  if (r.complained > 0) reason = `${r.complained} spam complaint(s) in the last ${windowDays} days`;
  else if (r.sent >= minSample && r.bounced / r.sent > s.bounce_rate_threshold)
    reason = `bounce rate ${(100 * r.bounced / r.sent).toFixed(1)}% over ${r.sent} sends exceeds ${(s.bounce_rate_threshold * 100).toFixed(0)}%`;
  else if (r.sent > 0 && r.sent < minSample && r.bounced >= 2)
    reason = `${r.bounced} bounces in the first ${r.sent} sends`;
  if (reason && !s.auto_paused) {
    await sql`update app_settings set auto_paused=true, auto_pause_reason=${reason}, auto_paused_at=now() where id`;
    return { paused: true, reason };
  }
  return { paused: s.auto_paused || !!reason, reason };
}
