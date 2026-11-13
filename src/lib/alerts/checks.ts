import { db } from "../db";
import { localDate } from "../time";
import { getSettings } from "../settings";
import { currentRunLabel } from "../pipeline/runs";
import { raiseAlert, unseenIds, portalUrl } from "./raise";

/**
 * Owner alerts. Run every hour by the scheduler (and safe to run more often):
 * each alert is deduped per kind per day, and the checks that list things
 * (jobs, messages) only report the ones no earlier alert has reported.
 * A Stripe payment failure is mailed by the payments code itself.
 */

export const ALERT_LIMITS = {
  heldHours: 48,        // an item held by the verification gate this long
  approvalDays: 3,      // an item waiting for approval this long
  cityMinSiteTests: 3,  // site tests in one city this month before "all failed" counts
  stuckRetestHours: 24, // a monthly retest with no report after this long
} as const;

const short = (s: string | null, n = 200) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One alert a day listing the jobs that went dead since the last alert. */
export async function checkDeadJobs(now: Date) {
  const sql = db();
  const dead = await sql<{ id: string; kind: string; last_error: string | null; attempts: number }[]>`
    select id, kind, last_error, attempts from jobs where status = 'dead' order by created_at desc limit 200`;
  const fresh = new Set(await unseenIds("alert:dead_jobs", dead.map((d) => d.id)));
  const list = dead.filter((d) => fresh.has(d.id));
  if (!list.length) return { raised: false };
  const lines = list.slice(0, 20).map((d) => `- ${d.kind}: ${short(d.last_error) || "no error text"}`);
  const title = `${plural(list.length, "job", "jobs")} failed and will not be retried`;
  return raiseAlert({
    kind: "alert:dead_jobs",
    day: localDate(now),
    ids: list.map((d) => d.id),
    subject: `In The Answer: ${title}`,
    body: [`${title}.`, "", ...lines, list.length > 20 ? `... and ${list.length - 20} more` : "", "",
           `See them and retry: ${portalUrl("/system")}`].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n"),
    task: { title, body: lines.join("\n") },
  });
}

export async function checkAutoPause(now: Date) {
  const [s] = await db()<{ auto_paused: boolean; auto_pause_reason: string | null; auto_paused_at: Date | null }[]>`
    select auto_paused, auto_pause_reason, auto_paused_at from app_settings where id`;
  if (!s.auto_paused) return { raised: false };
  const reason = s.auto_pause_reason ?? "no reason recorded";
  return raiseAlert({
    kind: "alert:auto_paused",
    day: localDate(s.auto_paused_at ?? now),
    subject: "In The Answer: sending paused itself",
    body: [`Sending is paused: ${reason}.`, "", "Nothing more is sent until you clear the pause.", `Settings: ${portalUrl("/settings")}`].join("\n"),
    task: { title: "Sending paused itself", body: `${reason}. Clear the pause in Settings once the cause is fixed.` },
  });
}

export async function checkSpendCap(now: Date) {
  const s = await getSettings();
  const day = localDate(now);
  const [r] = await db()<{ usd: number | null }[]>`
    select sum(cost_usd)::float as usd from cost_records where (at at time zone 'America/Toronto')::date = ${day}::date`;
  const spent = r.usd ?? 0;
  if (spent < s.claude_daily_spend_cap_usd) return { raised: false };
  return raiseAlert({
    kind: "alert:spend_cap",
    day,
    detail: { spent, cap: s.claude_daily_spend_cap_usd },
    subject: "In The Answer: daily API spend cap reached",
    body: [`Spend today is ${spent.toFixed(2)} USD; the cap is ${Number(s.claude_daily_spend_cap_usd).toFixed(2)} USD.`,
           "Jobs that call paid APIs wait until tomorrow (Toronto time), or until you raise the cap.", "",
           `Settings: ${portalUrl("/settings")}`].join("\n"),
  });
}

/** A city whose question test is dead, or where every site test this month failed. */
export async function checkCityFailures(now: Date) {
  const sql = db();
  const label = currentRunLabel(now);
  const tests = await sql<{ id: string; city: string | null; sector: string | null; last_error: string | null }[]>`
    select j.id, c.name as city, s.name as sector, j.last_error
    from jobs j
    left join cities c on c.id = (j.payload->>'cityId')::int
    left join sectors s on s.id = (j.payload->>'sectorId')::int
    where j.kind = 'test_city' and j.status = 'dead' and j.payload->>'runLabel' = ${label}`;
  const sites = await sql<{ city_id: number; city: string; failed: number; error: string | null }[]>`
    select c.city_id, ci.name as city, count(*)::int as failed, max(r.error) as error
    from site_test_runs r join clinics c on c.id = r.clinic_id join cities ci on ci.id = c.city_id
    where r.run_label = ${label} and r.status <> 'running'
    group by c.city_id, ci.name
    having count(*) filter (where r.status = 'done') = 0 and count(*) >= ${ALERT_LIMITS.cityMinSiteTests}`;
  const items = [
    ...tests.map((t) => ({ id: `test:${t.id}`, line: `- Question test for ${t.city ?? "unknown city"} (${t.sector ?? "unknown sector"}) failed: ${short(t.last_error)}` })),
    ...sites.map((s) => ({ id: `site:${s.city_id}:${label}`, line: `- All ${s.failed} site tests in ${s.city} failed this month: ${short(s.error)}` })),
  ];
  const fresh = new Set(await unseenIds("alert:city_failing", items.map((i) => i.id)));
  const list = items.filter((i) => fresh.has(i.id));
  if (!list.length) return { raised: false };
  const title = `Tests are failing for a whole city (${plural(list.length, "problem", "problems")})`;
  return raiseAlert({
    kind: "alert:city_failing",
    day: localDate(now),
    ids: list.map((i) => i.id),
    subject: `In The Answer: ${title.toLowerCase()}`,
    body: [`${title}. Clinics there wait until this is fixed.`, "", ...list.map((i) => i.line), "", `Jobs: ${portalUrl("/system")}`].join("\n"),
    task: { title, body: list.map((i) => i.line).join("\n") },
  });
}

async function checkWaiting(now: Date, o: { kind: string; status: string; column: "updated_at" | "created_at"; olderThanMs: number;
  title: (n: number) => string; link: string }) {
  const sql = db();
  const cutoff = new Date(now.getTime() - o.olderThanMs);
  const rows = await sql<{ id: string; subject: string; type: string }[]>`
    select id, subject, type::text from messages
    where status = ${o.status} and ${sql(o.column)} < ${cutoff} and type not in ('owner_alert', 'owner_digest')
    order by created_at limit 200`;
  const fresh = new Set(await unseenIds(o.kind, rows.map((r) => r.id)));
  const list = rows.filter((r) => fresh.has(r.id));
  if (!list.length) return { raised: false };
  const title = o.title(list.length);
  const lines = list.slice(0, 15).map((r) => `- ${r.type.replaceAll("_", " ")}: ${short(r.subject, 90)}`);
  return raiseAlert({
    kind: o.kind,
    day: localDate(now),
    ids: list.map((r) => r.id),
    subject: `In The Answer: ${title.toLowerCase()}`,
    body: [`${title}.`, "", ...lines, "", o.link].join("\n"),
    task: { title, body: lines.join("\n") },
  });
}

export const checkHeldTooLong = (now: Date) =>
  checkWaiting(now, {
    kind: "alert:held_48h", status: "held", column: "updated_at", olderThanMs: ALERT_LIMITS.heldHours * 3600e3,
    title: (n) => `${plural(n, "item has", "items have")} been held by the verification gate for over ${ALERT_LIMITS.heldHours} hours`,
    link: `Held: ${portalUrl("/held")}`,
  });

export const checkApprovalQueue = (now: Date) =>
  checkWaiting(now, {
    kind: "alert:approval_3d", status: "pending_review", column: "created_at", olderThanMs: ALERT_LIMITS.approvalDays * 86400e3,
    title: (n) => `${plural(n, "item has", "items have")} waited for approval for over ${ALERT_LIMITS.approvalDays} days`,
    link: `Queue: ${portalUrl()}`,
  });

/** A subscriber's monthly retest that started but produced no report. */
export async function checkStuckRetests(now: Date) {
  const sql = db();
  const cutoff = new Date(now.getTime() - ALERT_LIMITS.stuckRetestHours * 3600e3);
  const rows = await sql<{ id: string; clinic_id: string; name: string; cycle: string }[]>`
    select j.id, c.id as clinic_id, coalesce(c.site_name, c.name) as name, j.payload->>'cycle' as cycle
    from jobs j join clinics c on c.id = (j.payload->>'clinicId')::uuid
    where j.kind = 'monthly_retest' and j.status = 'done' and j.finished_at < ${cutoff}
      and coalesce(j.result->>'skipped', '') = ''
      and not exists (select 1 from reports r where r.clinic_id = c.id and r.kind = 'monthly' and r.data->>'cycle' = j.payload->>'cycle')`;
  const fresh = new Set(await unseenIds("alert:retest_stuck", rows.map((r) => r.id)));
  const list = rows.filter((r) => fresh.has(r.id));
  if (!list.length) return { raised: false };
  const title = `${plural(list.length, "monthly retest has", "monthly retests have")} no report after ${ALERT_LIMITS.stuckRetestHours} hours`;
  const lines = list.map((r) => `- ${r.name} (${r.cycle}): ${portalUrl(`/clinic/${r.clinic_id}`)}`);
  return raiseAlert({
    kind: "alert:retest_stuck",
    day: localDate(now),
    ids: list.map((r) => r.id),
    subject: `In The Answer: ${title}`,
    body: [`${title}. The audit or a test for the clinic did not finish.`, "", ...lines, "", `Jobs: ${portalUrl("/system")}`].join("\n"),
    task: { title, body: lines.join("\n"), clinicId: list.length === 1 ? list[0].clinic_id : null },
  });
}

export const ALERT_CHECKS = {
  dead_jobs: checkDeadJobs,
  auto_paused: checkAutoPause,
  spend_cap: checkSpendCap,
  city_failing: checkCityFailures,
  held_48h: checkHeldTooLong,
  approval_3d: checkApprovalQueue,
  retest_stuck: checkStuckRetests,
};

/** Runs every check; one failing check does not stop the others. */
export async function runAlertChecks(now: Date = new Date()): Promise<{ raised: string[]; errors: string[] }> {
  const raised: string[] = [];
  const errors: string[] = [];
  for (const [name, check] of Object.entries(ALERT_CHECKS)) {
    try {
      if ((await check(now)).raised) raised.push(name);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  if (errors.length && errors.length === Object.keys(ALERT_CHECKS).length) throw new Error(errors.join("; "));
  return { raised, errors };
}
