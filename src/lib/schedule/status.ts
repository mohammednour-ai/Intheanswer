import { db } from "../db";
import { getSettings } from "../settings";
import { localDate } from "../time";
import { upcomingRetests } from "../retests/due";

/** What the portal's System page shows. Read-only. */
export async function systemStatus(now: Date = new Date()) {
  const sql = db();
  const day = localDate(now);
  const month = day.slice(0, 7);
  const s = await getSettings();
  const [spend] = await sql<{ usd: number | null }[]>`
    select sum(cost_usd)::float as usd from cost_records where (at at time zone 'America/Toronto')::date = ${day}::date`;

  const targets = await sql<{ id: number; city: string; sector: string; active: boolean; last_run_at: Date | null; job_status: string | null; job_error: string | null }[]>`
    select t.id, c.name as city, s.name as sector, (t.active and s.active and c.active) as active, t.last_run_at,
           j.status::text as job_status, j.last_error as job_error
    from discovery_targets t join sectors s on s.id = t.sector_id join cities c on c.id = t.city_id
    left join jobs j on j.idempotency_key = 'discover:' || t.id || ':' || ${month}
    order by t.last_run_at asc nulls first, t.id`;

  const upcoming = await upcomingRetests(now);
  const keys = upcoming.map((r) => `monthly_retest:${r.clinicId}:${r.cycle}`);
  const retestJobs = keys.length
    ? await sql<{ idempotency_key: string; status: string }[]>`select idempotency_key, status::text from jobs where idempotency_key = any(${keys})`
    : [];
  const retests = upcoming.map((r, i) => ({ ...r, jobStatus: retestJobs.find((j) => j.idempotency_key === keys[i])?.status ?? null }));

  const purchaseRetests = await sql<{ id: string; clinic_id: string | null; name: string | null; paid_at: Date; due: Date; job_status: string | null }[]>`
    select o.id, o.clinic_id, coalesce(c.site_name, c.name) as name, o.paid_at,
           o.paid_at + make_interval(days => ${s.retest_after_purchase_days}) as due, j.status::text as job_status
    from orders o left join clinics c on c.id = o.clinic_id
    left join jobs j on j.idempotency_key = 'purchase_retest:' || o.id
    where o.kind = 'one_time' and o.status = 'paid' and o.retest_done_at is null and o.paid_at is not null
      and o.paid_at > ${new Date(now.getTime() - 90 * 86400e3)}
    order by o.paid_at limit 50`;

  const tasks = await sql<{ name: string; period: string; status: string; finished_at: Date | null; last_error: string | null }[]>`
    select distinct on (payload->>'name') payload->>'name' as name, payload->>'period' as period, status::text, finished_at, last_error
    from jobs where kind = 'scheduled_task' order by payload->>'name', created_at desc`;

  const dead = await sql<{ id: string; kind: string; idempotency_key: string; attempts: number; last_error: string | null; created_at: Date }[]>`
    select id, kind, idempotency_key, attempts, last_error, created_at from jobs where status = 'dead' order by created_at desc limit 100`;
  const failing = await sql<{ id: string; kind: string; idempotency_key: string; attempts: number; max_attempts: number; last_error: string | null; run_after: Date }[]>`
    select id, kind, idempotency_key, attempts, max_attempts, last_error, run_after from jobs
    where status = 'queued' and attempts > 0 and last_error is not null
    order by run_after limit 100`;

  const alerts = await sql<{ id: string; title: string; body: string | null; created_at: Date; clinic_id: string | null }[]>`
    select id, title, body, created_at, clinic_id from owner_tasks where kind = 'alert' and status = 'open' order by created_at desc limit 100`;

  return {
    day,
    month,
    spendToday: spend.usd ?? 0,
    spendCap: Number(s.claude_daily_spend_cap_usd),
    killSwitch: s.kill_switch,
    perDay: s.discovery_targets_per_day,
    digestHour: s.digest_hour_local,
    targets, retests, purchaseRetests, tasks, dead, failing, alerts,
  };
}

/** Put a dead job back in the queue with a clean attempt count. */
export async function retryDeadJob(id: string): Promise<boolean> {
  const r = await db()`
    update jobs set status = 'queued', attempts = 0, run_after = now(), locked_at = null, locked_by = null, finished_at = null
    where id = ${id} and status = 'dead' returning id`;
  return r.length > 0;
}

export async function dismissAlertTask(id: string): Promise<boolean> {
  const r = await db()`
    update owner_tasks set status = 'dismissed', done_at = now() where id = ${id} and kind = 'alert' and status = 'open' returning id`;
  return r.length > 0;
}
