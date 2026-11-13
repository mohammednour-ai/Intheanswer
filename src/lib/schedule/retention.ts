import { db } from "../db";

/**
 * Daily retention. Every window is here. Each step removes at most `limit`
 * rows per run so the job stays short; a backlog is cleared over a few days.
 * Evidence a report relies on (answers, audits, checks, reports) is kept.
 */
export const RETENTION = {
  pageCacheDays: 30,          // fetched pages
  jobLogDays: 60,             // job_logs
  finishedJobDays: 60,        // jobs that are done or cancelled (dead jobs stay until retried or handled)
  reportViewDays: 180,        // report_views rows (the counters on the report stay)
  rawPayloadDays: 90,         // test_answers.raw and inbound_messages.raw are set to null
  selfServeRequestDays: 180,  // self_serve_requests
  // api_cache rows go when their own expires_at has passed
  batchLimit: 2000,           // rows per step per run
} as const;

export type RetentionResult = Record<
  "page_cache" | "job_logs" | "jobs" | "report_views" | "api_cache" | "test_answers_raw" | "inbound_messages_raw" | "self_serve_requests",
  number
>;

const before = (now: Date, days: number) => new Date(now.getTime() - days * 86400e3);

export async function runRetention(now: Date = new Date(), limit: number = RETENTION.batchLimit): Promise<RetentionResult> {
  const sql = db();
  const n = async (q: Promise<readonly unknown[]>) => (await q).length;
  return {
    page_cache: await n(sql`
      delete from page_cache where id in (
        select id from page_cache where fetched_at < ${before(now, RETENTION.pageCacheDays)} order by fetched_at limit ${limit})
      returning 1`),
    job_logs: await n(sql`
      delete from job_logs where id in (
        select id from job_logs where at < ${before(now, RETENTION.jobLogDays)} order by at limit ${limit})
      returning 1`),
    jobs: await n(sql`
      delete from jobs where id in (
        select id from jobs where status in ('done', 'cancelled')
          and coalesce(finished_at, created_at) < ${before(now, RETENTION.finishedJobDays)} limit ${limit})
      returning 1`),
    report_views: await n(sql`
      delete from report_views where id in (
        select id from report_views where viewed_at < ${before(now, RETENTION.reportViewDays)} order by viewed_at limit ${limit})
      returning 1`),
    api_cache: await n(sql`
      delete from api_cache where key in (select key from api_cache where expires_at < ${now} limit ${limit}) returning 1`),
    test_answers_raw: await n(sql`
      update test_answers set raw = null where id in (
        select id from test_answers where raw is not null and asked_at < ${before(now, RETENTION.rawPayloadDays)} limit ${limit})
      returning 1`),
    inbound_messages_raw: await n(sql`
      update inbound_messages set raw = null where id in (
        select id from inbound_messages where raw is not null and received_at < ${before(now, RETENTION.rawPayloadDays)} limit ${limit})
      returning 1`),
    self_serve_requests: await n(sql`
      delete from self_serve_requests where id in (
        select id from self_serve_requests where created_at < ${before(now, RETENTION.selfServeRequestDays)} limit ${limit})
      returning 1`),
  };
}
