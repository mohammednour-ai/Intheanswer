/**
 * The scheduler.
 *
 * `runScheduleTick(now)` is called every minute by /api/cron/worker, before the
 * worker runs. It never does work itself: everything it starts is an
 * `enqueue` with a deterministic idempotency key, so calling it twice in the
 * same minute, a minute apart, or from two servers at once starts each thing
 * once. An advisory lock makes a second concurrent call return at once.
 *
 * What it starts:
 *   - registered tasks (below), as `scheduled_task` jobs keyed `sched:<name>:<period>`
 *   - discovery, one target a month, a few targets a day        (src/lib/schedule/plan.ts)
 *   - the monthly retest of each subscriber                      (same file)
 *   - the retest some weeks after a one-time purchase            (same file)
 *
 * Kill switch: while it is on, no pipeline work is started (discovery,
 * retests, and tasks registered with `pipeline: true`). Housekeeping, owner
 * alerts and the digest keep running so the owner still hears about problems.
 *
 * ADDING A TASK
 *
 *   import { registerScheduled } from "@/lib/schedule/tick";
 *
 *   registerScheduled({
 *     name: "follow_ups",          // unique; part of the job key
 *     every: "day",                // "hour" | "day" | "week" | "month" (Toronto time)
 *     atHour: 9,                   // optional, day/week/month only: not before 09:00 Toronto
 *     businessDaysOnly: true,      // optional: skipped on Saturday and Sunday
 *     pipeline: true,              // optional: not started while the kill switch is on
 *     run: async ({ now, period, job }) => {
 *       // `now` is the time of the tick that scheduled this run (use it, not new Date(),
 *       // so the task is testable). `period` is e.g. "2026-11-12". `job` is the usual
 *       // JobContext (job.log, job.cost, job.enqueue). Throw to retry (3 attempts).
 *       return { queued: 3 };       // stored as the job result
 *     },
 *   });
 *
 * Call it at module load, in a module that src/lib/jobs/register.ts imports
 * (so the cron route and the local worker both see it). The task runs at most
 * once per period. `run` must be safe to run again after a failure part way.
 */
import { db } from "../db";
import { enqueue, jobLog, PermanentJobError, type JobContext } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { getSettings, type AppSettings } from "../settings";
import { isBusinessDay, localDate, localParts } from "../time";
import { planDiscovery, planMonthlyRetests, planPurchaseRetests } from "./plan";

export type Every = "hour" | "day" | "week" | "month";

export interface ScheduledRun {
  now: Date;
  period: string;
  job: JobContext;
}

export interface ScheduledTask {
  name: string;
  every: Every;
  /** Toronto hour (0-23) before which a day/week/month task is not started. */
  atHour?: number | ((s: AppSettings) => number);
  businessDaysOnly?: boolean;
  /** Pipeline work: not started while the kill switch is on. */
  pipeline?: boolean;
  run: (r: ScheduledRun) => Promise<unknown>;
}

const tasks = new Map<string, ScheduledTask>();

export function registerScheduled(task: ScheduledTask): void {
  if (!/^[a-z0-9_]+$/.test(task.name)) throw new Error(`scheduled task name "${task.name}": use lower-case letters, digits and _`);
  tasks.set(task.name, task);
}

/** Test helper. */
export function unregisterScheduled(name: string): void {
  tasks.delete(name);
}

export function scheduledTasks(): ScheduledTask[] {
  return [...tasks.values()];
}

/** The period a moment falls in, in Toronto time. Weeks start on Monday. */
export function periodKey(every: Every, now: Date): string {
  const day = localDate(now);
  if (every === "day") return day;
  if (every === "month") return day.slice(0, 7);
  const p = localParts(now);
  if (every === "hour") return `${day}T${String(p.hour).padStart(2, "0")}`;
  const [y, m, d] = day.split("-").map(Number);
  const monday = new Date(Date.UTC(y, m - 1, d - ((p.weekday + 6) % 7)));
  return `week-${monday.toISOString().slice(0, 10)}`;
}

export interface TickResult {
  skipped?: string;
  tasks: string[];
  discovery: string[];
  monthlyRetests: string[];
  purchaseRetests: string[];
}

const LOCK_KEY = 4_211_112; // any constant; shared by every caller of the tick

export async function runScheduleTick(now: Date = new Date()): Promise<TickResult> {
  const sql = db();
  const empty: TickResult = { tasks: [], discovery: [], monthlyRetests: [], purchaseRetests: [] };
  return sql.begin(async (tx) => {
    // released when this transaction ends; a concurrent tick does nothing
    const [lock] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(${LOCK_KEY}) as ok`;
    if (!lock.ok) return { ...empty, skipped: "another tick is running" };
    const settings = await getSettings();
    const res: TickResult = { ...empty };
    res.tasks = await startDueTasks(now, settings);
    if (settings.kill_switch) return { ...res, skipped: "kill switch: no pipeline work started" };
    res.discovery = await planDiscovery(now, settings);
    res.monthlyRetests = await planMonthlyRetests(now);
    res.purchaseRetests = await planPurchaseRetests(now, settings);
    return res;
  }) as Promise<TickResult>;
}

/** For the cron route: a scheduler problem is logged and must never stop the worker. */
export async function scheduleTickSafely(now: Date = new Date()): Promise<TickResult | null> {
  try {
    return await runScheduleTick(now);
  } catch (e) {
    await jobLog(null, "schedule tick failed", { error: (e as Error).message }, "error").catch(() => {});
    return null;
  }
}

async function startDueTasks(now: Date, settings: AppSettings): Promise<string[]> {
  const hour = localParts(now).hour;
  const business = isBusinessDay(now);
  const due: { task: ScheduledTask; period: string; key: string }[] = [];
  for (const task of tasks.values()) {
    if (task.pipeline && settings.kill_switch) continue;
    if (task.businessDaysOnly && !business) continue;
    if (task.every !== "hour" && task.atHour !== undefined) {
      const at = typeof task.atHour === "function" ? task.atHour(settings) : task.atHour;
      if (hour < at) continue;
    }
    const period = periodKey(task.every, now);
    due.push({ task, period, key: `sched:${task.name}:${period}` });
  }
  if (!due.length) return [];
  // one lookup for all of them; almost always nothing is missing
  const have = new Set(
    (await db()<{ idempotency_key: string }[]>`select idempotency_key from jobs where idempotency_key = any(${due.map((d) => d.key)})`)
      .map((r) => r.idempotency_key),
  );
  const started: string[] = [];
  for (const d of due) {
    if (have.has(d.key)) continue;
    const r = await enqueue("scheduled_task", d.key, { name: d.task.name, period: d.period, at: now.toISOString() }, { priority: 80, maxAttempts: 3 });
    if (r.created) started.push(d.key);
  }
  return started;
}

register("scheduled_task", async (ctx) => {
  const { name, period, at } = ctx.job.payload as { name: string; period: string; at: string };
  const task = tasks.get(name);
  if (!task) throw new PermanentJobError(`no scheduled task named ${name}`);
  return (await task.run({ now: new Date(at), period, job: ctx })) ?? null;
});
