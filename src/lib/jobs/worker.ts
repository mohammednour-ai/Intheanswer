import { db } from "../db";
import { localDate } from "../time";
import { runJobs, type Handler, type RunResult } from "./queue";
import { handlers } from "./handlers";

/** Jobs that call the Claude API and so stop when the daily spend cap is reached. */
export const CLAUDE_JOBS = new Set([
  "test_city",
  "audit_clinic",
  "build_teaser",
  "verify_teaser",
  "classify_reply",
  "build_full_report",
  "monthly_retest",
  "regenerate_message",
]);

/** Jobs that are part of the outreach pipeline and stop on the kill switch. */
const PIPELINE_JOBS = new Set(["discover", "find_contact", ...CLAUDE_JOBS]);

export async function claudeSpendToday(): Promise<number> {
  const [r] = await db()<{ usd: number | null }[]>`
    select sum(cost_usd)::float as usd from cost_records
    where provider='anthropic' and (at at time zone 'America/Toronto')::date = ${localDate(new Date())}::date`;
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
    if (over) return `Claude spend cap ${s.claude_daily_spend_cap_usd} USD reached (${spent.toFixed(2)})`;
  }
  return null;
}

export async function runWorkerOnce(opts: { limit?: number; kinds?: string[]; extraHandlers?: Record<string, Handler> } = {}): Promise<RunResult> {
  return runJobs({ ...handlers, ...(opts.extraHandlers ?? {}) }, { limit: opts.limit ?? 10, kinds: opts.kinds, gate });
}
