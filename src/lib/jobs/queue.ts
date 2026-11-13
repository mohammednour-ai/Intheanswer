import { db } from "../db";

/**
 * Postgres-backed job queue. Every pipeline stage is a job:
 * - idempotent: enqueue() is keyed by idempotency_key, duplicates are ignored
 * - resumable: failed jobs retry with backoff; stale running jobs are reaped
 * - logged: job_logs rows
 * - costed: cost_records rows (see recordCost)
 */

export interface Job<P = Record<string, unknown>> {
  id: string;
  kind: string;
  idempotency_key: string;
  payload: P;
  attempts: number;
  max_attempts: number;
}

export interface JobContext {
  job: Job;
  log: (message: string, data?: unknown, level?: "info" | "warn" | "error") => Promise<void>;
  cost: (c: CostInput) => Promise<void>;
  enqueue: typeof enqueue;
}

export interface CostInput {
  provider: string;
  operation: string;
  units?: Record<string, unknown>;
  costUsd: number;
  clinicId?: string | null;
}

export type Handler = (ctx: JobContext) => Promise<unknown>;

/** Thrown by a handler to stop retries (e.g. bad input). */
export class PermanentJobError extends Error {}
/** Thrown by a handler to re-run later without counting as a failure. */
export class DeferJob extends Error {
  constructor(public readonly seconds: number, message = "deferred") {
    super(message);
  }
}

export async function enqueue(
  kind: string,
  idempotencyKey: string,
  payload: Record<string, unknown> = {},
  opts: { runAfter?: Date; priority?: number; maxAttempts?: number } = {},
): Promise<{ id: string; created: boolean }> {
  const sql = db();
  const rows = await sql<{ id: string }[]>`
    insert into jobs (kind, idempotency_key, payload, run_after, priority, max_attempts)
    values (${kind}, ${idempotencyKey}, ${sql.json(payload as never)},
            ${opts.runAfter ?? new Date()}, ${opts.priority ?? 100}, ${opts.maxAttempts ?? 5})
    on conflict (idempotency_key) do nothing
    returning id`;
  if (rows.length) return { id: rows[0].id, created: true };
  const [existing] = await sql<{ id: string }[]>`select id from jobs where idempotency_key = ${idempotencyKey}`;
  return { id: existing.id, created: false };
}

export async function recordCost(jobId: string | null, c: CostInput) {
  const sql = db();
  await sql`
    insert into cost_records (job_id, clinic_id, provider, operation, units, cost_usd)
    values (${jobId}, ${c.clinicId ?? null}, ${c.provider}, ${c.operation},
            ${sql.json((c.units ?? {}) as never)}, ${c.costUsd})`;
}

export async function jobLog(jobId: string | null, message: string, data?: unknown, level = "info") {
  const sql = db();
  await sql`insert into job_logs (job_id, level, message, data)
            values (${jobId}, ${level}, ${message}, ${data === undefined ? null : sql.json(data as never)})`;
}

function backoffSeconds(attempt: number) {
  return Math.min(3600, 30 * 2 ** (attempt - 1));
}

export interface RunResult {
  claimed: number;
  done: number;
  failed: number;
  deferred: number;
}

/**
 * Claim and run up to `limit` jobs. Called by the cron worker route and by
 * `npm run worker` locally. `gate` lets the caller stop work (kill switch,
 * spend cap) before each job.
 */
export async function runJobs(
  handlers: Record<string, Handler>,
  opts: { worker?: string; limit?: number; kinds?: string[]; gate?: (kind: string) => Promise<string | null> } = {},
): Promise<RunResult> {
  const sql = db();
  const worker = opts.worker ?? `w-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const kinds = opts.kinds ?? Object.keys(handlers);
  await sql`select reap_stale_jobs()`;
  const jobs = await sql<Job[]>`select * from claim_jobs(${worker}, ${opts.limit ?? 10}, ${kinds})`;
  const res: RunResult = { claimed: jobs.length, done: 0, failed: 0, deferred: 0 };

  for (const job of jobs) {
    const handler = handlers[job.kind];
    // Heartbeat: the lock is stamped when the batch is claimed, so refresh it as
    // each job starts. If the row is gone the job was reaped while it waited
    // behind slower ones and another worker owns it now: do not run it twice.
    const mine = await sql`update jobs set locked_at = now() where id = ${job.id} and status = 'running' and locked_by = ${worker} returning id`;
    if (!mine.length) continue;
    const stop = opts.gate ? await opts.gate(job.kind) : null;
    if (stop) {
      // put it back untouched (do not burn an attempt)
      await sql`update jobs set status='queued', locked_at=null, locked_by=null,
                attempts = attempts - 1, run_after = now() + interval '10 minutes',
                last_error = ${"paused: " + stop} where id = ${job.id} and locked_by = ${worker}`;
      res.deferred++;
      continue;
    }
    const ctx: JobContext = {
      job,
      log: (m, d, level = "info") => jobLog(job.id, m, d, level),
      cost: (c) => recordCost(job.id, c),
      enqueue,
    };
    try {
      if (!handler) throw new PermanentJobError(`no handler for ${job.kind}`);
      const result = await handler(ctx);
      await sql`update jobs set status='done', finished_at=now(), locked_at=null,
                result=${result === undefined ? null : sql.json(result as never)}, last_error=null
                where id=${job.id} and locked_by = ${worker}`;
      res.done++;
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (err instanceof DeferJob) {
        await sql`update jobs set status='queued', locked_at=null, locked_by=null, attempts = attempts - 1,
                  run_after = now() + make_interval(secs => ${err.seconds}), last_error=${msg}
                  where id=${job.id} and locked_by = ${worker}`;
        res.deferred++;
        continue;
      }
      const permanent = err instanceof PermanentJobError || job.attempts >= job.max_attempts;
      await jobLog(job.id, "job failed", { error: msg, attempt: job.attempts }, "error");
      await sql`update jobs set
                  status = ${permanent ? "dead" : "queued"},
                  run_after = now() + make_interval(secs => ${backoffSeconds(job.attempts)}),
                  locked_at=null, locked_by=null, last_error=${msg}
                where id=${job.id} and locked_by = ${worker}`;
      res.failed++;
    }
  }
  return res;
}
