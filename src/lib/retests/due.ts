import { db } from "../db";
import { daysBetween, localDate } from "../time";

/**
 * When a subscriber's monthly retest is due. Pure calendar logic on Toronto
 * dates (YYYY-MM-DD) and month labels (YYYY-MM), so it is easy to test.
 *
 * - The retest runs on the anniversary day of the subscription (the day of the
 *   month it started), or the first business day after when that day is a
 *   weekend. A subscription that started on the 31st uses the last day of a
 *   shorter month.
 * - The first cycle is the month after the subscription started.
 * - A cycle is named after its anniversary month even when the business-day
 *   roll moves the run to the 1st or 2nd of the next month.
 * - A due cycle that was missed (kill switch, outage) is still started for
 *   CATCH_UP_DAYS; after that it is skipped and the next cycle runs as usual.
 */

export const CATCH_UP_DAYS = 20;

/** Subscription states that get a monthly retest. past_due gets one cycle of grace. */
export const RETEST_STATUSES = ["active", "trialing", "past_due"];

export function addMonths(label: string, n: number): string {
  const [y, m] = label.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function weekday(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isBusinessYmd(ymd: string): boolean {
  const wd = weekday(ymd);
  return wd >= 1 && wd <= 5;
}

/** The due date of a cycle for a subscription that started on `anchorYmd`. */
export function retestDueDate(anchorYmd: string, cycle: string): string {
  const [y, m] = cycle.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Math.min(Number(anchorYmd.slice(8, 10)), last);
  let due = `${cycle}-${String(day).padStart(2, "0")}`;
  while (!isBusinessYmd(due)) due = addDays(due, 1);
  return due;
}

/** Cycles whose due date has arrived (and is still inside the catch-up window) on `todayYmd`. */
export function cyclesDue(anchorYmd: string, todayYmd: string): { cycle: string; due: string }[] {
  const thisMonth = todayYmd.slice(0, 7);
  const out: { cycle: string; due: string }[] = [];
  for (const cycle of [addMonths(thisMonth, -1), thisMonth]) {
    if (cycle <= anchorYmd.slice(0, 7)) continue; // the first retest is a month after the start
    const due = retestDueDate(anchorYmd, cycle);
    if (due <= todayYmd && daysBetween(due, todayYmd) <= CATCH_UP_DAYS) out.push({ cycle, due });
  }
  return out;
}

/** The next cycle that is due today or later. */
export function nextRetest(anchorYmd: string, todayYmd: string): { cycle: string; due: string } {
  let cycle = addMonths(todayYmd.slice(0, 7), -1);
  for (let i = 0; i < 4; i++, cycle = addMonths(cycle, 1)) {
    if (cycle <= anchorYmd.slice(0, 7)) continue;
    const due = retestDueDate(anchorYmd, cycle);
    if (due >= todayYmd) return { cycle, due };
  }
  return { cycle, due: retestDueDate(anchorYmd, cycle) };
}

export interface RetestSubscription {
  subscription_id: string;
  clinic_id: string;
  clinic_name: string;
  status: string;
  anchor: string;              // YYYY-MM-DD the subscription started (Toronto)
  last_report_grace: boolean;  // the latest monthly report was the past_due grace cycle
}

/** One row per clinic with a subscription that still gets retests. */
export async function retestSubscriptions(): Promise<RetestSubscription[]> {
  return db()<RetestSubscription[]>`
    select distinct on (s.clinic_id)
           s.id as subscription_id, s.clinic_id, coalesce(c.site_name, c.name) as clinic_name, s.status,
           to_char(s.created_at at time zone 'America/Toronto', 'YYYY-MM-DD') as anchor,
           coalesce((select (r.data->>'grace')::boolean from reports r
                     where r.clinic_id = s.clinic_id and r.kind = 'monthly' and not r.superseded
                     order by r.created_at desc limit 1), false) as last_report_grace
    from subscriptions s join clinics c on c.id = s.clinic_id
    where s.status = any(${RETEST_STATUSES})
    order by s.clinic_id, (s.status = 'past_due'), s.created_at`;
}

/**
 * past_due counts as active for one cycle: the retest still runs, and its
 * report is marked as the grace cycle. While the latest report is that grace
 * report and the subscription is still past_due, no further cycle starts.
 */
export function eligibleForCycle(s: Pick<RetestSubscription, "status" | "last_report_grace">): boolean {
  if (s.status === "past_due") return !s.last_report_grace;
  return RETEST_STATUSES.includes(s.status);
}

export interface ScheduledRetest {
  clinicId: string;
  clinicName: string;
  subscriptionId: string;
  status: string;
  cycle: string;
  due: string;
  grace: boolean;
}

/** Retests that should be running today (before the "already queued" check). */
export async function retestsDue(now: Date): Promise<ScheduledRetest[]> {
  const today = localDate(now);
  const out: ScheduledRetest[] = [];
  for (const s of await retestSubscriptions()) {
    if (!eligibleForCycle(s)) continue;
    for (const c of cyclesDue(s.anchor, today)) {
      out.push({ clinicId: s.clinic_id, clinicName: s.clinic_name, subscriptionId: s.subscription_id, status: s.status,
                 cycle: c.cycle, due: c.due, grace: s.status === "past_due" });
    }
  }
  return out;
}

/** The next retest of every subscriber, soonest first (portal and digest). */
export async function upcomingRetests(now: Date): Promise<ScheduledRetest[]> {
  const today = localDate(now);
  const subs = await retestSubscriptions();
  return subs
    .filter(eligibleForCycle)
    .map((s) => {
      const n = nextRetest(s.anchor, today);
      return { clinicId: s.clinic_id, clinicName: s.clinic_name, subscriptionId: s.subscription_id, status: s.status,
               cycle: n.cycle, due: n.due, grace: s.status === "past_due" };
    })
    .sort((a, b) => a.due.localeCompare(b.due));
}
