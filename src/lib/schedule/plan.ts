import { db } from "../db";
import { enqueue } from "../jobs/queue";
import { env } from "../env";
import type { AppSettings } from "../settings";
import { isBusinessDay, localDate, torontoToUtc } from "../time";
import { retestsDue } from "../retests/due";

/**
 * What the tick starts each minute. Each function runs one or two indexed
 * queries, returns the idempotency keys it created, and only ever enqueues.
 */

/** How long after its due day a retest after a purchase is still started. */
export const PURCHASE_RETEST_WINDOW_DAYS = 30;

/**
 * Discovery: every active target once a calendar month, at most
 * `discovery_targets_per_day` a day, the target discovered longest ago first,
 * business days only. Key `discover:<targetId>:<month>`.
 */
export async function planDiscovery(now: Date, settings: Pick<AppSettings, "discovery_targets_per_day">): Promise<string[]> {
  if (!isBusinessDay(now)) return [];
  // Without a Places key discovery cannot run: start nothing instead of failing jobs.
  if (!env().GOOGLE_PLACES_API_KEY && env().EXTERNAL_MODE !== "replay") return [];
  const perDay = Math.max(0, settings.discovery_targets_per_day ?? 2);
  if (perDay === 0) return [];
  const sql = db();
  const day = localDate(now);
  const month = day.slice(0, 7);
  const monthStart = torontoToUtc(`${month}-01`, "00:00");
  const [today] = await sql<{ n: number }[]>`
    select count(*)::int as n from jobs where kind = 'discover' and payload->>'day' = ${day}`;
  const room = perDay - today.n;
  if (room <= 0) return [];
  const targets = await sql<{ id: number; sector_id: number; city_id: number }[]>`
    select t.id, t.sector_id, t.city_id
    from discovery_targets t join sectors s on s.id = t.sector_id join cities c on c.id = t.city_id
    where t.active and s.active and c.active
      and (t.last_run_at is null or t.last_run_at < ${monthStart})
      and not exists (select 1 from jobs j where j.idempotency_key = 'discover:' || t.id || ':' || ${month})
    order by t.last_run_at asc nulls first, t.id
    limit ${room}`;
  const started: string[] = [];
  for (const t of targets) {
    const key = `discover:${t.id}:${month}`;
    const r = await enqueue("discover", key, { sectorId: t.sector_id, cityId: t.city_id, targetId: t.id, day });
    if (r.created) started.push(key);
  }
  return started;
}

/**
 * Monthly retest of each subscriber on its anniversary day (see
 * src/lib/retests/due.ts). Key `monthly_retest:<clinicId>:<cycle>`.
 */
export async function planMonthlyRetests(now: Date): Promise<string[]> {
  const due = await retestsDue(now);
  if (!due.length) return [];
  const keys = due.map((d) => `monthly_retest:${d.clinicId}:${d.cycle}`);
  const have = new Set(
    (await db()<{ idempotency_key: string }[]>`select idempotency_key from jobs where idempotency_key = any(${keys})`).map((r) => r.idempotency_key),
  );
  const started: string[] = [];
  for (const [i, d] of due.entries()) {
    if (have.has(keys[i])) continue;
    const r = await enqueue("monthly_retest", keys[i], {
      clinicId: d.clinicId, subscriptionId: d.subscriptionId, cycle: d.cycle, runLabel: d.cycle, due: d.due, grace: d.grace,
    }, { maxAttempts: 6 });
    if (r.created) started.push(keys[i]);
  }
  return started;
}

/** Orders that may get the retest and the upgrade message. Shared by the tick and the jobs. */
export const purchaseRetestEligibleSql = (sql: ReturnType<typeof db>) => sql`
  o.kind = 'one_time' and o.status = 'paid' and o.refunded_at is null and o.clinic_id is not null
  and not exists (select 1 from subscriptions s where s.clinic_id = o.clinic_id)
  and not exists (select 1 from clinics c where c.id = o.clinic_id and c.status in ('suppressed', 'do_not_contact', 'closed', 'excluded'))
  and not exists (
    select 1 from suppressions x
    where (x.kind = 'address' and x.value = lower(o.customer_email))
       or (x.kind = 'domain' and x.value = (select c.domain from clinics c where c.id = o.clinic_id)))`;

/**
 * Retest `retest_after_purchase_days` after a paid one-time order, once per
 * order. Not for clinics that subscribed, unsubscribed or were refunded.
 * Key `purchase_retest:<orderId>`.
 */
export async function planPurchaseRetests(now: Date, settings: Pick<AppSettings, "retest_after_purchase_days">): Promise<string[]> {
  const sql = db();
  const days = settings.retest_after_purchase_days;
  const dueBefore = new Date(now.getTime() - days * 86400e3);
  const notBefore = new Date(now.getTime() - (days + PURCHASE_RETEST_WINDOW_DAYS) * 86400e3);
  const orders = await sql<{ id: string; clinic_id: string }[]>`
    select o.id, o.clinic_id from orders o
    where o.retest_done_at is null and o.paid_at <= ${dueBefore} and o.paid_at > ${notBefore}
      and ${purchaseRetestEligibleSql(sql)}
      and not exists (select 1 from jobs j where j.idempotency_key = 'purchase_retest:' || o.id)
    order by o.paid_at limit 20`;
  const started: string[] = [];
  for (const o of orders) {
    const key = `purchase_retest:${o.id}`;
    // Its own run label: the month's shared city test may be older than the purchase,
    // or the very run the first report used. Retests due the same day share one city test.
    const r = await enqueue("purchase_retest", key, { orderId: o.id, clinicId: o.clinic_id, runLabel: `retest-${localDate(now)}` }, { maxAttempts: 6 });
    if (r.created) started.push(key);
  }
  return started;
}
