import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { enqueue, runJobs, PermanentJobError, DeferJob } from "@/lib/jobs/queue";
import { resetData } from "./helpers";

describe("job queue", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  it("enqueue is idempotent on the key", async () => {
    const a = await enqueue("noop", "k1", { a: 1 });
    const b = await enqueue("noop", "k1", { a: 2 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    const [n] = await db()`select count(*)::int as n from jobs`;
    expect(n.n).toBe(1);
  });

  it("runs, logs, records cost and stores the result", async () => {
    await enqueue("work", "w1", { x: 2 });
    const r = await runJobs({
      work: async (ctx) => {
        await ctx.log("hello");
        await ctx.cost({ provider: "anthropic", operation: "test", costUsd: 0.01 });
        return { doubled: (ctx.job.payload as { x: number }).x * 2 };
      },
    });
    expect(r).toMatchObject({ claimed: 1, done: 1 });
    const [j] = await db()`select status::text, result from jobs`;
    expect(j.status).toBe("done");
    expect(j.result).toEqual({ doubled: 4 });
    const [c] = await db()`select count(*)::int as n from cost_records`;
    expect(c.n).toBe(1);
  });

  it("retries a failing job with backoff, then marks it dead", async () => {
    await enqueue("flaky", "f1", {}, { maxAttempts: 2 });
    const h = { flaky: async () => { throw new Error("boom"); } };
    await runJobs(h);
    let [j] = await db()`select status::text, attempts, run_after > now() as later from jobs`;
    expect(j).toMatchObject({ status: "queued", attempts: 1, later: true });
    await db()`update jobs set run_after = now()`;
    await runJobs(h);
    [j] = await db()`select status::text, attempts from jobs`;
    expect(j).toMatchObject({ status: "dead", attempts: 2 });
  });

  it("permanent errors stop immediately", async () => {
    await enqueue("bad", "b1");
    await runJobs({ bad: async () => { throw new PermanentJobError("bad input"); } });
    const [j] = await db()`select status::text from jobs`;
    expect(j.status).toBe("dead");
  });

  it("deferred jobs do not burn an attempt", async () => {
    await enqueue("later", "l1");
    await runJobs({ later: async () => { throw new DeferJob(60); } });
    const [j] = await db()`select status::text, attempts from jobs`;
    expect(j).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("a gate puts the job back untouched", async () => {
    await enqueue("gated", "g1");
    const r = await runJobs({ gated: async () => "ran" }, { gate: async () => "paused" });
    expect(r.deferred).toBe(1);
    const [j] = await db()`select status::text, attempts from jobs`;
    expect(j).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("two workers never claim the same job", async () => {
    for (let i = 0; i < 6; i++) await enqueue("c", `c${i}`);
    const seen: string[] = [];
    const h = { c: async (ctx: { job: { id: string } }) => { seen.push(ctx.job.id); } };
    await Promise.all([runJobs(h, { worker: "a", limit: 4 }), runJobs(h, { worker: "b", limit: 4 })]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(6);
  });
});
