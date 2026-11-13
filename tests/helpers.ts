import { db } from "@/lib/db";

/** Truncate mutable tables between tests (config tables are kept). */
export async function resetData() {
  const sql = db();
  await sql`truncate jobs, job_logs, cost_records, messages, message_events, send_audit_log, approval_log,
            suppressions, inbound_messages, clinics, contacts, page_cache, test_runs, test_answers,
            clinic_test_results, audits, audit_checks, scores, reports, report_views, stripe_events, orders,
            subscriptions, intake_forms, owner_tasks, self_serve_requests, owner_notifications, unsubscribe_attempts, api_cache cascade`;
  await sql`update app_settings set owner_user_id=null, kill_switch=false, auto_paused=false, auto_pause_reason=null,
            auto_pause_cleared_at=null, dry_run=true, live_enabled=false, warmup_start_date=null, daily_cap_override=null,
            send_window_start='09:30', send_window_end='16:30', claude_daily_spend_cap_usd=25,
            pipeline_paused_for_spend=false, dns_verified=false where id`;
  await sql`update message_type_modes set mode='REVIEW', review_first_n=10, auto_since=null, auto_created_count=0`;
}

export async function makeClinic(over: Record<string, unknown> = {}) {
  const sql = db();
  const [city] = await sql<{ id: number }[]>`select id from cities where name='Barrie'`;
  const [sector] = await sql<{ id: number }[]>`select id from sectors where slug='dental'`;
  const row = {
    name: "Test Dental",
    website: "https://testdental.example",
    domain: "testdental.example",
    city_id: city.id,
    sector_id: sector.id,
    source: "seed",
    status: "teaser_built",
    ...over,
  };
  const [c] = await sql<{ id: string }[]>`insert into clinics ${sql(row as never)} returning id`;
  return c.id;
}

export async function makeMessage(over: Record<string, unknown> = {}) {
  const sql = db();
  const row = {
    type: "first_email",
    status: "pending_review",
    to_email: "info@testdental.example",
    subject: "Test subject",
    body_text: "Test body",
    flags: sql.json([]),
    ...over,
  };
  const [m] = await sql<{ id: string }[]>`insert into messages ${sql(row as never)} returning id`;
  return m.id;
}
