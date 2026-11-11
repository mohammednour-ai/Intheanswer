import { db } from "../db";
import { localDate } from "../time";
import { runJobs, type Handler, type RunResult } from "./queue";
import { handlers } from "./handlers";

/** Jobs that call paid APIs and so stop when the daily spend cap is reached. */
export const CLAUDE_JOBS = new Set([
  "test_city",
  "audit_clinic",
  "build_teaser",
  "verify_teaser",
  "classify_reply",
  "build_full_report",
  "monthly_retest",
  "regenerate_message",
  "review_lookup",
  "review_analysis",
  "site_test",
  "propose_pages",
]);

/** Jobs that are part of the outreach pipeline and stop on the kill switch. */
const PIPELINE_JOBS = new Set(["discover", "find_contact", ...CLAUDE_JOBS]);

/** Today's spend across all paid APIs (Claude, Places, ...). */
export const spendToday = () => claudeSpendToday();

export async function claudeSpendToday(): Promise<number> {
  const [r] = await db()<{ usd: number | null }[]>`
    select sum(cost_usd)::float as usd from cost_records
    where (at at time zone 'America/Toronto')::date = ${localDate(new Date())}::date`;
  return r.usd ?? 0;
}

/**
 * Returns a reason to stop a job, or null to run it.
 * - spend cap: Claude jobs pause for the rest of the Toronto day
 * - kill switch: stops sending (enforced in send rules) and new pipeline work
 */
export async function gate(kind: string): Promise<string | null> {
  const sql = db();
  const [s] = await sql<{ kill_switch: boolean; claude_daily_spend_cap_usd: number; pipeline_paused_for_spend: boolean }[]>`
    select kill_switch, claude_daily_spend_cap_usd, pipeline_paused_for_spend from app_settings where id`;
  if (s.kill_switch && PIPELINE_JOBS.has(kind)) return "kill switch";
  if (CLAUDE_JOBS.has(kind)) {
    const spent = await claudeSpendToday();
    const over = spent >= s.claude_daily_spend_cap_usd;
    if (over !== s.pipeline_paused_for_spend) {
      await sql`update app_settings set pipeline_paused_for_spend=${over} where id`;
    }
    if (over) return `daily API spend cap ${s.claude_daily_spend_cap_usd} USD reached (${spent.toFixed(2)})`;
  }
  return null;
}

export async function runWorkerOnce(opts: { limit?: number; kinds?: string[]; extraHandlers?: Record<string, Handler> } = {}): Promise<RunResult> {
  return runJobs({ ...handlers, ...(opts.extraHandlers ?? {}) }, { limit: opts.limit ?? 10, kinds: opts.kinds, gate });
}

/** Jobs that can take minutes (a browser, a 40-page crawl). */
export const HEAVY_JOBS = new Set(["site_test", "test_city", "audit_clinic"]);

/**
 * Run jobs one at a time until the time budget is used. A heavy job is only
 * started while enough of the budget is left for it, so a serverless
 * invocation never leaves several long jobs half-run.
 */
export async function runWorkerBudget(budgetMs: number, heavyNeedsMs = 200_000): Promise<RunResult> {
  const start = Date.now();
  const total: RunResult = { claimed: 0, done: 0, failed: 0, deferred: 0 };
  await expirePending();
  for (;;) {
    const left = budgetMs - (Date.now() - start);
    if (left < 15_000) break;
    const kinds = Object.keys(handlers).filter((k) => left >= heavyNeedsMs || !HEAVY_JOBS.has(k));
    const r = await runJobs(handlers, { limit: 1, kinds, gate });
    if (r.claimed === 0) break;
    total.claimed += r.claimed; total.done += r.done; total.failed += r.failed; total.deferred += r.deferred;
    if (r.deferred && !r.done && !r.failed) break; // only gated or waiting work is left
  }
  return total;
}

/**
 * REVIEW-mode items expire after pending_expiry_days. The clinic's audit is
 * rerun before anything is queued again, so stale findings are never sent.
 */
export async function expirePending(): Promise<number> {
  const sql = db();
  const rows = await sql<{ id: string; clinic_id: string | null }[]>`
    update messages set status='expired', updated_at=now()
    where status='pending_review' and expires_at is not null and expires_at < now()
    returning id, clinic_id`;
  for (const m of rows) {
    await sql`insert into approval_log (message_id, action, actor_email) values (${m.id}, 'expire', 'system')`;
    if (!m.clinic_id) continue;
    await sql`update reports set superseded=true where clinic_id=${m.clinic_id} and kind='teaser'`;
    await sql`update clinics set status='contact_found', status_reason='queued item expired; audit rerun', updated_at=now() where id=${m.clinic_id}`;
    const label = `${localDate(new Date()).slice(0, 7)}-r${m.id.slice(0, 8)}`;
    const [c] = await sql<{ sector_id: number; city_id: number }[]>`select sector_id, city_id from clinics where id=${m.clinic_id}`;
    const month = localDate(new Date()).slice(0, 7);
    const { enqueue } = await import("./queue");
    await enqueue("test_city", `test:${c.sector_id}:${c.city_id}:${month}`, { sectorId: c.sector_id, cityId: c.city_id, runLabel: month });
    await enqueue("audit_clinic", `audit:${m.clinic_id}:${label}`, { clinicId: m.clinic_id, runLabel: month });
  }
  return rows.length;
}
