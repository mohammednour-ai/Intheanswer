import { db } from "../db";
import { env } from "../env";
import type { JobContext } from "../jobs/queue";
import { DeferJob, PermanentJobError } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { gate } from "../jobs/worker";
import { purchaseRetestEligibleSql } from "../schedule/plan";
import { RETEST_STATUSES } from "./due";
import { finishedTestRun, runRetestAudit } from "./audit";
import { buildAndDeliverComparison, type ComparisonDeps } from "./report";
import type { RetestContext } from "./handover";

/**
 * Retest jobs.
 *
 *   monthly_retest  (subscriber, once a cycle)        purchase_retest (once per one-time order)
 *        \                                                  /
 *         test_city (shared per city and run label), site_test, review_analysis (connected profile only)
 *         audit of the clinic's site (src/lib/retests/audit.ts)
 *         score_clinic  --payload.retest-->  monthly_report   or   retest_upgrade
 *
 * Every step is keyed, so a retry or a second scheduler tick repeats nothing.
 */

const REVIEW_WAIT_MS = 30 * 60e3;

async function startRetest(ctx: JobContext, o: { clinicId: string; runLabel: string; retest: RetestContext; reviews: boolean }) {
  const sql = db();
  const [c] = await sql<{ sector_id: number | null; city_id: number | null }[]>`select sector_id, city_id from clinics where id = ${o.clinicId}`;
  if (!c) throw new PermanentJobError("clinic not found");
  if (!c.sector_id || !c.city_id) throw new PermanentJobError("clinic has no sector or city");

  await ctx.enqueue("test_city", `test:${c.sector_id}:${c.city_id}:${o.runLabel}`, { sectorId: c.sector_id, cityId: c.city_id, runLabel: o.runLabel });
  await ctx.enqueue("site_test", `sitetest:${o.clinicId}:${o.runLabel}`, { clinicId: o.clinicId, runLabel: o.runLabel }, { maxAttempts: 2 });
  if (o.reviews) {
    const [g] = await sql`select 1 from gbp_connections where clinic_id = ${o.clinicId} and status = 'connected'`;
    if (g) await ctx.enqueue("review_analysis", `reviews:${o.clinicId}:${o.runLabel}`, { clinicId: o.clinicId, runLabel: o.runLabel }, { maxAttempts: 2 });
  }
  const run = await finishedTestRun(c.sector_id, c.city_id, o.runLabel); // defers while the city test runs

  // an earlier attempt of this job may already have stored the audit and queued the score
  const [queued] = await sql<{ id: string }[]>`
    select id from jobs where kind = 'score_clinic' and payload->>'retestJob' = ${ctx.job.idempotency_key} limit 1`;
  if (queued) return { already: true, scoreJob: queued.id };

  const audit = await runRetestAudit(ctx, o.clinicId, run.id);
  await ctx.enqueue("score_clinic", `score:${o.clinicId}:${audit.auditId}`, {
    clinicId: o.clinicId, auditId: audit.auditId, testRunId: run.id, runLabel: o.runLabel, retest: o.retest, retestJob: ctx.job.idempotency_key,
  });
  return { auditId: audit.auditId, testRunId: run.id, pages: audit.pages, next: "score_clinic" };
}

async function handleMonthlyRetest(ctx: JobContext) {
  const { clinicId, subscriptionId, cycle, runLabel, grace } = ctx.job.payload as {
    clinicId: string; subscriptionId?: string; cycle: string; runLabel?: string; grace?: boolean;
  };
  const [sub] = await db()`select 1 from subscriptions where clinic_id = ${clinicId} and status = any(${RETEST_STATUSES}) limit 1`;
  if (!sub) return { skipped: "the subscription is no longer active" };
  return startRetest(ctx, {
    clinicId, runLabel: runLabel ?? cycle, reviews: true,
    retest: { kind: "monthly", cycle, subscriptionId: subscriptionId ?? null, grace: !!grace },
  });
}

/** Why an order gets no retest message, or null when it does. Marks the order so it is not looked at again. */
async function purchaseRetestBlocked(orderId: string): Promise<string | null> {
  const sql = db();
  const [o] = await sql<{ status: string; refunded_at: Date | null; retest_done_at: Date | null; eligible: boolean }[]>`
    select o.status, o.refunded_at, o.retest_done_at, (${purchaseRetestEligibleSql(sql)}) as eligible from orders o where o.id = ${orderId}`;
  if (!o) return "order not found";
  if (o.retest_done_at) return "already handled";
  if (o.eligible) return null;
  const why = o.status !== "paid" || o.refunded_at ? `order is ${o.refunded_at ? "refunded" : o.status}` : "the clinic subscribed, unsubscribed or was closed";
  await sql`update orders set retest_done_at = now(), retest_note = ${"skipped: " + why} where id = ${orderId} and retest_done_at is null`;
  return why;
}

async function handlePurchaseRetest(ctx: JobContext) {
  const { orderId, clinicId, runLabel } = ctx.job.payload as { orderId: string; clinicId: string; runLabel: string };
  // this job reads the site with a paid model: same stops as the monthly retest
  const stop = await gate("monthly_retest");
  if (stop) throw new DeferJob(600, `paused: ${stop}`);
  const blocked = await purchaseRetestBlocked(orderId);
  if (blocked) return { skipped: blocked };
  return startRetest(ctx, { clinicId, runLabel, reviews: false, retest: { kind: "purchase", orderId } });
}

async function customerEmail(clinicId: string, preferred?: string | null): Promise<string | null> {
  if (preferred) return preferred;
  const [r] = await db()<{ email: string | null }[]>`
    select coalesce(
      (select customer_email from orders where clinic_id = ${clinicId} and customer_email is not null and status in ('paid', 'partially_refunded')
       order by paid_at desc nulls last limit 1),
      (select email from contacts where clinic_id = ${clinicId} and is_primary limit 1)) as email`;
  return r?.email ?? null;
}

export async function deliverMonthlyReport(
  p: { clinicId: string; scoreId: string; cycle: string; runLabel?: string; grace?: boolean },
  deps: ComparisonDeps = {},
) {
  const sql = db();
  const runLabel = p.runLabel ?? p.cycle;
  // this month's review numbers, when the clinic connected its Business Profile
  const [rv] = await sql<{ status: string; created_at: Date }[]>`
    select status::text, created_at from jobs where idempotency_key = ${`reviews:${p.clinicId}:${runLabel}`}`;
  if (rv && ["queued", "running"].includes(rv.status) && Date.now() - rv.created_at.getTime() < REVIEW_WAIT_MS) {
    throw new DeferJob(60, "waiting for the review numbers");
  }
  const [previousReport] = await sql<{ id: string; kind: string; score_id: string | null; created_at: Date }[]>`
    select id, kind::text, score_id, created_at from reports
    where clinic_id = ${p.clinicId} and kind in ('monthly', 'full') and not superseded
      and coalesce(data->>'cycle', '') <> ${p.cycle}
    order by created_at desc limit 1`;
  const toEmail = await customerEmail(p.clinicId);
  if (!toEmail) throw new PermanentJobError("no email address for this customer");
  const r = await buildAndDeliverComparison({
    kind: "monthly", clinicId: p.clinicId, scoreId: p.scoreId, cycle: p.cycle, grace: p.grace, previousReport: previousReport ?? null,
    toEmail, messageKey: `monthly_report:${p.clinicId}:${p.cycle}`,
  }, deps);
  return { reportId: r.reportId, built: r.built, message: r.message.id, status: r.message.status, flags: r.flags.map((f) => f.code), removed: r.removed };
}

export async function deliverRetestUpgrade(p: { clinicId: string; scoreId: string; orderId: string }, deps: ComparisonDeps = {}) {
  const sql = db();
  const blocked = await purchaseRetestBlocked(p.orderId);
  if (blocked) return { skipped: blocked };
  const [order] = await sql<{ customer_email: string | null; paid_at: Date | null; report_id: string | null }[]>`
    select customer_email, paid_at, report_id from orders where id = ${p.orderId}`;
  const toEmail = await customerEmail(p.clinicId, order.customer_email);
  if (!toEmail) {
    await sql`update orders set retest_done_at = now(), retest_note = 'skipped: no email address' where id = ${p.orderId}`;
    return { skipped: "no email address" };
  }
  const [previousReport] = order.report_id
    ? await sql<{ id: string; kind: string; score_id: string | null; created_at: Date }[]>`
        select id, kind::text, score_id, created_at from reports where id = ${order.report_id}`
    : [];
  const [teaser] = await sql<{ token: string }[]>`
    select token from reports where clinic_id = ${p.clinicId} and kind = 'teaser' and data->>'verified' = 'true'
    order by superseded, created_at desc limit 1`;
  const r = await buildAndDeliverComparison({
    kind: "retest", clinicId: p.clinicId, scoreId: p.scoreId, cycle: p.orderId, orderId: p.orderId,
    previousReport: previousReport ?? null, baselineBefore: order.paid_at,
    monthlyUrl: teaser ? `${env().APP_URL}/buy/${teaser.token}/monthly` : null,
    toEmail, messageKey: `retest_upgrade:${p.orderId}`,
    forceReview: teaser ? undefined : "no teaser report to build the full service plan link from; the pricing page is linked instead",
  }, deps);
  await sql`update orders set retest_done_at = now(), retest_note = ${"message " + r.message.status} where id = ${p.orderId} and retest_done_at is null`;
  return { reportId: r.reportId, built: r.built, message: r.message.id, status: r.message.status, flags: r.flags.map((f) => f.code) };
}

register("monthly_retest", handleMonthlyRetest);
register("purchase_retest", handlePurchaseRetest);
register("monthly_report", (ctx) => deliverMonthlyReport(ctx.job.payload as never));
register("retest_upgrade", (ctx) => deliverRetestUpgrade(ctx.job.payload as never));
