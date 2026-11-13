import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { runJobs } from "@/lib/jobs/queue";
import { handlers } from "@/lib/jobs/handlers";
import "@/lib/schedule";
import { runScheduleTick, registerScheduled, unregisterScheduled, periodKey } from "@/lib/schedule/tick";
import { planDiscovery, planMonthlyRetests, planPurchaseRetests } from "@/lib/schedule/plan";
import { runRetention, RETENTION } from "@/lib/schedule/retention";
import { retestDueDate, cyclesDue, nextRetest } from "@/lib/retests/due";
import { resetData, makeClinic } from "./helpers";

// Toronto is UTC-5 in November and December 2026.
const at = (ymd: string, hhmm = "10:00") => new Date(`${ymd}T${hhmm}:00-05:00`);
const WED = at("2026-11-11");

const keys = async (kind: string) =>
  (await db()<{ k: string }[]>`select idempotency_key as k from jobs where kind = ${kind} order by idempotency_key`).map((r) => r.k);

async function makeSubscription(clinicId: string, over: Record<string, unknown> = {}) {
  const sql = db();
  const row = { clinic_id: clinicId, stripe_subscription_id: `sub_${Math.random().toString(36).slice(2)}`, status: "active", created_at: at("2026-10-11"), ...over };
  const [s] = await sql<{ id: string }[]>`insert into subscriptions ${sql(row as never)} returning id`;
  return s.id;
}

async function makeOrder(clinicId: string, over: Record<string, unknown> = {}) {
  const sql = db();
  const row = { clinic_id: clinicId, kind: "one_time", status: "paid", customer_email: "owner@testdental.example", amount_cents: 20000, paid_at: at("2026-10-14"), ...over };
  const [o] = await sql<{ id: string }[]>`insert into orders ${sql(row as never)} returning id`;
  return o.id;
}

describe("scheduler", () => {
  beforeEach(async () => {
    await resetData();
    await db()`update discovery_targets set last_run_at = null, active = true`;
    await db()`update app_settings set discovery_targets_per_day = 2, retest_after_purchase_days = 28, digest_hour_local = 8 where id`;
  });
  afterAll(closeDb);

  describe("tick", () => {
    it("starts each due thing once: same minute, a minute apart, and at the same time", async () => {
      let runs = 0;
      registerScheduled({ name: "test_hourly", every: "hour", run: async () => { runs++; return { ok: true }; } });
      try {
        const first = await runScheduleTick(WED);
        expect(first.tasks).toContain("sched:test_hourly:2026-11-11T10");
        expect(first.tasks).toContain("sched:retention:2026-11-11");
        expect(first.tasks).toContain("sched:owner_alerts:2026-11-11T10");
        expect(first.tasks).toContain("sched:owner_digest:2026-11-11");
        expect(first.tasks).toContain("sched:purge_places:week-2026-11-09");
        const n1 = (await db()`select count(*)::int as n from jobs`)[0].n;

        const again = await runScheduleTick(WED);
        const later = await runScheduleTick(new Date(WED.getTime() + 60_000));
        const both = await Promise.all([runScheduleTick(new Date(WED.getTime() + 90_000)), runScheduleTick(new Date(WED.getTime() + 90_000))]);
        for (const r of [again, later, ...both]) {
          expect(r.tasks).toEqual([]);
          expect(r.discovery).toEqual([]);
        }
        expect((await db()`select count(*)::int as n from jobs`)[0].n).toBe(n1);

        // the next hour starts the hourly tasks again, and nothing else
        const nextHour = await runScheduleTick(new Date(WED.getTime() + 3600_000));
        expect(nextHour.tasks.sort()).toEqual(["sched:owner_alerts:2026-11-11T11", "sched:test_hourly:2026-11-11T11"]);

        // the job calls the registered function with the tick's time
        await runJobs({ scheduled_task: handlers.scheduled_task }, { kinds: ["scheduled_task"], limit: 20 });
        expect(runs).toBe(2);
        const [j] = await db()`select status::text, result from jobs where idempotency_key = 'sched:test_hourly:2026-11-11T10'`;
        expect(j).toMatchObject({ status: "done", result: { ok: true } });
      } finally {
        unregisterScheduled("test_hourly");
      }
    });

    it("waits for a task's hour and skips business-day tasks at the weekend", async () => {
      const early = await runScheduleTick(at("2026-11-11", "02:30"));
      expect(early.tasks).not.toContain("sched:retention:2026-11-11"); // 03:00
      expect(early.tasks).not.toContain("sched:owner_digest:2026-11-11"); // 08:00
      const saturday = await runScheduleTick(at("2026-11-14"));
      expect(saturday.tasks).toContain("sched:retention:2026-11-14");
      expect(saturday.tasks.some((t) => t.startsWith("sched:owner_digest"))).toBe(false);
      expect(saturday.discovery).toEqual([]);
    });

    it("names periods in Toronto time", () => {
      const lateEvening = new Date("2026-11-12T03:30:00Z"); // 22:30 on the 11th in Toronto
      expect(periodKey("day", lateEvening)).toBe("2026-11-11");
      expect(periodKey("hour", lateEvening)).toBe("2026-11-11T22");
      expect(periodKey("month", new Date("2026-12-01T02:00:00Z"))).toBe("2026-11");
      expect(periodKey("week", at("2026-11-15"))).toBe("week-2026-11-09"); // Sunday belongs to the week that began Monday
    });

    it("starts no pipeline work while the kill switch is on, but keeps alerts and clean-up", async () => {
      const clinic = await makeClinic({ status: "customer" });
      await makeSubscription(clinic);
      await makeOrder(clinic);
      registerScheduled({ name: "test_pipeline", every: "day", pipeline: true, run: async () => null });
      try {
        await db()`update app_settings set kill_switch = true where id`;
        const r = await runScheduleTick(WED);
        expect(r.skipped).toMatch(/kill switch/);
        expect(r.tasks).toContain("sched:owner_alerts:2026-11-11T10");
        expect(r.tasks).toContain("sched:retention:2026-11-11");
        expect(r.tasks).not.toContain("sched:test_pipeline:2026-11-11");
        expect(await keys("discover")).toEqual([]);
        expect(await keys("monthly_retest")).toEqual([]);
        expect(await keys("purchase_retest")).toEqual([]);

        await db()`update app_settings set kill_switch = false where id`;
        const on = await runScheduleTick(new Date(WED.getTime() + 60_000));
        expect(on.discovery).toHaveLength(2);
        expect(on.monthlyRetests).toHaveLength(1);
        expect(on.tasks).toEqual(["sched:test_pipeline:2026-11-11"]);
      } finally {
        unregisterScheduled("test_pipeline");
      }
    });
  });

  describe("discovery", () => {
    it("staggers targets, oldest first, and runs each once a month", async () => {
      const sql = db();
      const targets = await sql<{ id: number }[]>`select id from discovery_targets order by id`;
      expect(targets.length).toBe(6);
      // the last two were discovered longest ago; the first two never
      await sql`update discovery_targets set last_run_at = '2026-10-20T15:00:00Z'`;
      await sql`update discovery_targets set last_run_at = '2026-09-01T15:00:00Z' where id = ${targets[5].id}`;
      await sql`update discovery_targets set last_run_at = null where id = ${targets[0].id}`;
      const s = { discovery_targets_per_day: 2 };

      const day1 = await planDiscovery(WED, s);
      expect(day1).toEqual([`discover:${targets[0].id}:2026-11`, `discover:${targets[5].id}:2026-11`]);
      expect(await planDiscovery(new Date(WED.getTime() + 3600_000), s)).toEqual([]); // the day's two are used
      const day2 = await planDiscovery(at("2026-11-12"), s);
      const day3 = await planDiscovery(at("2026-11-13"), s);
      expect(day2).toHaveLength(2);
      expect(day3).toHaveLength(2);
      expect(await planDiscovery(at("2026-11-14"), s)).toEqual([]); // Saturday
      expect(await planDiscovery(at("2026-11-16"), s)).toEqual([]); // every target has had its turn this month
      expect(new Set(await keys("discover")).size).toBe(6);

      // a target discovered this month by hand (the CLI) is not discovered again
      await sql`delete from jobs`;
      await sql`update discovery_targets set last_run_at = ${at("2026-11-03")} where id <> ${targets[2].id}`;
      expect(await planDiscovery(WED, s)).toEqual([`discover:${targets[2].id}:2026-11`]);

      // next month every target is due again
      const dec = await planDiscovery(at("2026-12-01"), s);
      expect(dec).toHaveLength(2);
      expect(dec.every((k) => k.endsWith(":2026-12"))).toBe(true);
    });

    it("leaves inactive targets alone and carries what the discover job needs", async () => {
      const sql = db();
      const [keep] = await sql<{ id: number; sector_id: number; city_id: number }[]>`select id, sector_id, city_id from discovery_targets order by id limit 1`;
      await sql`update discovery_targets set active = false where id <> ${keep.id}`;
      expect(await planDiscovery(WED, { discovery_targets_per_day: 5 })).toEqual([`discover:${keep.id}:2026-11`]);
      const [j] = await sql`select payload from jobs where kind = 'discover'`;
      expect(j.payload).toMatchObject({ sectorId: keep.sector_id, cityId: keep.city_id, day: "2026-11-11" });
    });
  });

  describe("monthly retest", () => {
    it("knows the due day: anniversary, short months, weekends", () => {
      expect(retestDueDate("2026-10-11", "2026-11")).toBe("2026-11-11");
      expect(retestDueDate("2026-10-14", "2026-11")).toBe("2026-11-16"); // the 14th is a Saturday
      expect(retestDueDate("2026-08-31", "2026-09")).toBe("2026-09-30"); // no 31st
      expect(retestDueDate("2026-01-31", "2026-02")).toBe("2026-03-02"); // Feb 28 is a Saturday: Monday, in March
      expect(cyclesDue("2026-01-31", "2026-03-02")).toEqual([{ cycle: "2026-02", due: "2026-03-02" }]);
      expect(cyclesDue("2026-10-11", "2026-10-11")).toEqual([]); // not in the month it started
      expect(cyclesDue("2026-10-11", "2026-11-10")).toEqual([]);
      expect(cyclesDue("2026-10-11", "2026-11-25").map((c) => c.cycle)).toEqual(["2026-11"]); // caught up within the window
      expect(cyclesDue("2026-10-11", "2026-12-05")).toEqual([]); // too late: wait for the next cycle
      expect(nextRetest("2026-10-11", "2026-11-12")).toEqual({ cycle: "2026-12", due: "2026-12-11" });
    });

    it("starts one retest per clinic per cycle on the due day", async () => {
      const clinic = await makeClinic({ status: "customer" });
      const sub = await makeSubscription(clinic);
      expect(await planMonthlyRetests(at("2026-11-10"))).toEqual([]);
      expect(await planMonthlyRetests(WED)).toEqual([`monthly_retest:${clinic}:2026-11`]);
      expect(await planMonthlyRetests(new Date(WED.getTime() + 60_000))).toEqual([]);
      expect(await planMonthlyRetests(at("2026-11-12"))).toEqual([]);
      const [j] = await db()`select payload, kind from jobs where kind = 'monthly_retest'`;
      expect(j.payload).toMatchObject({ clinicId: clinic, subscriptionId: sub, cycle: "2026-11", runLabel: "2026-11", grace: false });
      expect(await planMonthlyRetests(at("2026-12-11"))).toEqual([`monthly_retest:${clinic}:2026-12`]);
    });

    it("skips cancelled subscriptions and gives past_due one cycle", async () => {
      const cancelled = await makeClinic({ status: "customer", domain: "a.example", website: "https://a.example" });
      const pastDue = await makeClinic({ status: "customer", domain: "b.example", website: "https://b.example" });
      const trial = await makeClinic({ status: "customer", domain: "c.example", website: "https://c.example" });
      await makeSubscription(cancelled, { status: "canceled" });
      await makeSubscription(pastDue, { status: "past_due" });
      await makeSubscription(trial, { status: "trialing" });
      const started = await planMonthlyRetests(WED);
      expect(started.sort()).toEqual([`monthly_retest:${pastDue}:2026-11`, `monthly_retest:${trial}:2026-11`].sort());
      const [g] = await db()`select payload from jobs where idempotency_key = ${`monthly_retest:${pastDue}:2026-11`}`;
      expect(g.payload.grace).toBe(true);

      // the grace report was delivered; still past_due a month later: no further cycle
      const sql = db();
      await sql`insert into reports (clinic_id, kind, token, data, html)
                values (${pastDue}, 'monthly', 'tok-grace-0000000001', ${sql.json({ cycle: "2026-11", grace: true })}, '')`;
      expect(await planMonthlyRetests(at("2026-12-11"))).toEqual([`monthly_retest:${trial}:2026-12`]);
      // paid up again: back on the normal cadence
      await sql`update subscriptions set status = 'active' where clinic_id = ${pastDue}`;
      expect(await planMonthlyRetests(at("2026-12-11"))).toEqual([`monthly_retest:${pastDue}:2026-12`]);
    });

    it("a retest whose subscription ended before it ran does nothing", async () => {
      const clinic = await makeClinic({ status: "customer" });
      await makeSubscription(clinic);
      await planMonthlyRetests(WED);
      await db()`update subscriptions set status = 'canceled'`;
      await runJobs({ monthly_retest: handlers.monthly_retest }, { kinds: ["monthly_retest"] });
      const [j] = await db()`select status::text, result from jobs where kind = 'monthly_retest'`;
      expect(j.status).toBe("done");
      expect(j.result.skipped).toMatch(/no longer active/);
      expect((await db()`select count(*)::int as n from jobs`)[0].n).toBe(1); // nothing else was started
    });
  });

  describe("retest after a one-time purchase", () => {
    const s = { retest_after_purchase_days: 28 };

    it("starts once per order, 28 days after payment", async () => {
      const clinic = await makeClinic({ status: "customer" });
      const order = await makeOrder(clinic); // paid 2026-10-14 10:00
      expect(await planPurchaseRetests(at("2026-11-10"), s)).toEqual([]); // day 27
      expect(await planPurchaseRetests(WED, s)).toEqual([`purchase_retest:${order}`]);
      expect(await planPurchaseRetests(new Date(WED.getTime() + 60_000), s)).toEqual([]);
      const [j] = await db()`select payload from jobs where kind = 'purchase_retest'`;
      expect(j.payload).toMatchObject({ orderId: order, clinicId: clinic, runLabel: "retest-2026-11-11" });
      // finished jobs are deleted after 60 days: the mark on the order keeps it from starting again
      await db()`delete from jobs`;
      await db()`update orders set retest_done_at = now()`;
      expect(await planPurchaseRetests(at("2026-11-12"), s)).toEqual([]);
    });

    it("not for clinics that subscribed, unsubscribed or were refunded", async () => {
      const sql = db();
      const mk = (d: string, over: Record<string, unknown> = {}) => makeClinic({ status: "customer", domain: d, website: `https://${d}`, ...over });
      const subscribed = await mk("sub.example");
      await makeOrder(subscribed);
      await makeSubscription(subscribed, { status: "active" });
      const refunded = await mk("ref.example");
      await makeOrder(refunded, { refunded_at: at("2026-10-20") });
      const partly = await mk("part.example");
      await makeOrder(partly, { status: "partially_refunded" });
      const unsubAddress = await mk("unsub.example");
      await makeOrder(unsubAddress, { customer_email: "Owner@Unsub.example" });
      await sql`insert into suppressions (kind, value, reason, source) values ('address', 'owner@unsub.example', 'asked', 'unsubscribe_link')`;
      const unsubDomain = await mk("dom.example");
      await makeOrder(unsubDomain, { customer_email: "someone@gmail.example" });
      await sql`insert into suppressions (kind, value, reason, source) values ('domain', 'dom.example', 'asked', 'reply')`;
      const closed = await mk("closed.example", { status: "suppressed" });
      await makeOrder(closed);
      const subscriptionOrder = await mk("plan.example");
      await makeOrder(subscriptionOrder, { kind: "subscription" });
      const tooOld = await mk("old.example");
      await makeOrder(tooOld, { paid_at: at("2026-08-01") });
      const ok = await mk("ok.example");
      const okOrder = await makeOrder(ok);
      expect(await planPurchaseRetests(WED, s)).toEqual([`purchase_retest:${okOrder}`]);
    });

    it("a clinic that subscribes after the retest was queued gets no message", async () => {
      const clinic = await makeClinic({ status: "customer" });
      const order = await makeOrder(clinic);
      await planPurchaseRetests(WED, s);
      await makeSubscription(clinic, { created_at: at("2026-11-11", "09:00") });
      await runJobs({ purchase_retest: handlers.purchase_retest }, { kinds: ["purchase_retest"] });
      const [j] = await db()`select status::text, result from jobs where kind = 'purchase_retest'`;
      expect(j.result.skipped).toMatch(/subscribed/);
      const [o] = await db()`select retest_done_at, retest_note from orders where id = ${order}`;
      expect(o.retest_done_at).not.toBeNull();
      expect(o.retest_note).toMatch(/^skipped/);
    });
  });

  describe("retention", () => {
    it("deletes only what is past its window", async () => {
      const sql = db();
      const now = at("2026-11-11");
      const ago = (days: number) => new Date(now.getTime() - days * 86400e3);
      const clinic = await makeClinic();

      await sql`insert into page_cache (url, domain, fetched_at) values ('https://x.example/old', 'x.example', ${ago(31)}), ('https://x.example/new', 'x.example', ${ago(29)})`;
      const mkJob = async (key: string, status: string, finished: Date | null) =>
        (await sql<{ id: string }[]>`insert into jobs (kind, idempotency_key, status, finished_at, created_at)
          values ('noop', ${key}, ${status}, ${finished}, ${finished ?? ago(100)}) returning id`)[0].id;
      const oldDone = await mkJob("old-done", "done", ago(61));
      const newDone = await mkJob("new-done", "done", ago(59));
      await mkJob("old-cancelled", "cancelled", ago(70));
      await mkJob("old-dead", "dead", null);     // dead jobs stay for the owner
      await mkJob("old-queued", "queued", null); // waiting work is never deleted
      await sql`insert into job_logs (job_id, at, message) values (${newDone}, ${ago(61)}, 'old'), (${newDone}, ${ago(10)}, 'new'), (${oldDone}, ${ago(5)}, 'goes with its job')`;
      const [rep] = await sql<{ id: string }[]>`insert into reports (clinic_id, kind, token, data, html) values (${clinic}, 'teaser', 'tok-retention-000001', '{}', '') returning id`;
      await sql`insert into report_views (report_id, viewed_at) values (${rep.id}, ${ago(181)}), (${rep.id}, ${ago(179)})`;
      await sql`insert into api_cache (key, provider, value, expires_at) values ('old', 'pagespeed', '{}', ${ago(1)}), ('new', 'pagespeed', '{}', ${new Date(now.getTime() + 86400e3)})`;
      const [sector] = await sql<{ id: number }[]>`select id from sectors where slug = 'dental'`;
      const [city] = await sql<{ id: number }[]>`select id from cities where name = 'Barrie'`;
      const [qs] = await sql<{ id: number }[]>`select id from question_sets where sector_id = ${sector.id} limit 1`;
      const [run] = await sql<{ id: string }[]>`insert into test_runs (sector_id, city_id, question_set_id, assistant, model, run_label)
        values (${sector.id}, ${city.id}, ${qs.id}, 'Claude', 'm', '2026-08') returning id`;
      await sql`insert into test_answers (test_run_id, question_index, question, answer_text, raw, asked_at) values
        (${run.id}, 0, 'q0', 'kept answer', '{"a":1}', ${ago(91)}), (${run.id}, 1, 'q1', 'a', '{"a":1}', ${ago(89)})`;
      await sql`insert into inbound_messages (from_email, raw, received_at, body_text) values
        ('a@x.example', '{"h":1}', ${ago(91)}, 'kept body'), ('b@x.example', '{"h":1}', ${ago(89)}, 'b')`;
      await sql`insert into self_serve_requests (website, email, created_at) values
        ('https://old.example', 'a@old.example', ${ago(181)}), ('https://new.example', 'a@new.example', ${ago(179)})`;

      const r = await runRetention(now);
      expect(r).toEqual({ page_cache: 1, job_logs: 1, jobs: 2, report_views: 1, api_cache: 1, test_answers_raw: 1, inbound_messages_raw: 1, self_serve_requests: 1 });

      expect((await sql`select url from page_cache`).map((x) => x.url)).toEqual(["https://x.example/new"]);
      expect((await sql`select idempotency_key as k from jobs order by 1`).map((x) => x.k)).toEqual(["new-done", "old-dead", "old-queued"]);
      expect((await sql`select message from job_logs`).map((x) => x.message)).toEqual(["new"]);
      expect((await sql`select count(*)::int as n from report_views`)[0].n).toBe(1);
      expect((await sql`select key from api_cache`).map((x) => x.key)).toEqual(["new"]);
      const answers = await sql`select question_index, raw, answer_text from test_answers order by question_index`;
      expect(answers[0]).toMatchObject({ raw: null, answer_text: "kept answer" }); // the evidence stays, the raw payload goes
      expect(answers[1].raw).toEqual({ a: 1 });
      const inbound = await sql`select from_email, raw, body_text from inbound_messages order by from_email`;
      expect(inbound[0]).toMatchObject({ raw: null, body_text: "kept body" });
      expect(inbound[1].raw).toEqual({ h: 1 });
      expect((await sql`select website from self_serve_requests`).map((x) => x.website)).toEqual(["https://new.example"]);

      expect(Object.values(await runRetention(now)).every((n) => n === 0)).toBe(true);
    });

    it("works in batches", async () => {
      const sql = db();
      const now = at("2026-11-11");
      const old = new Date(now.getTime() - (RETENTION.pageCacheDays + 5) * 86400e3);
      for (let i = 0; i < 5; i++) await sql`insert into page_cache (url, domain, fetched_at) values (${`https://x.example/${i}`}, 'x.example', ${old})`;
      expect((await runRetention(now, 2)).page_cache).toBe(2);
      expect((await runRetention(now, 2)).page_cache).toBe(2);
      expect((await runRetention(now, 2)).page_cache).toBe(1);
    });
  });
});
