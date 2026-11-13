import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { checkDeadJobs, checkHeldTooLong, checkApprovalQueue, checkSpendCap, checkAutoPause, checkCityFailures, runAlertChecks } from "@/lib/alerts/checks";
import { buildDigest, sendDigest, digestWindow } from "@/lib/alerts/digest";
import { resetData, makeClinic, makeMessage } from "./helpers";

const at = (ymd: string, hhmm = "10:00") => new Date(`${ymd}T${hhmm}:00-05:00`);
const WED = at("2026-11-11");
const THU = at("2026-11-12");

const deadJob = async (key: string, kind = "audit_clinic", error = "Error: boom") =>
  (await db()<{ id: string }[]>`insert into jobs (kind, idempotency_key, status, attempts, last_error) values (${kind}, ${key}, 'dead', 5, ${error}) returning id`)[0].id;
const alertMails = () => db()<{ subject: string; body_text: string; status: string; to_email: string }[]>`
  select subject, body_text, status::text, to_email from messages where type = 'owner_alert' order by created_at`;
const count = async (table: string) => (await db()`select count(*)::int as n from ${db()(table)}`)[0].n as number;

describe("owner alerts", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  it("dead jobs: one alert a day, listing only jobs not reported before", async () => {
    await deadJob("d1", "audit_clinic", "Error: site unreachable");
    await deadJob("d2", "test_city", "PermanentJobError: no active question set");
    expect((await checkDeadJobs(WED)).raised).toBe(true);
    let mails = await alertMails();
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toMatch(/2 jobs failed/);
    expect(mails[0].body_text).toContain("audit_clinic: Error: site unreachable");
    expect(mails[0].body_text).toContain("test_city: PermanentJobError: no active question set");
    expect(mails[0].body_text).toContain("https://intheanswer.test/portal/system");
    expect(mails[0].status).toBe("approved"); // owner mail is never held for review
    expect(await count("owner_notifications")).toBe(1);
    const tasks = await db()`select kind, title, status from owner_tasks`;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "alert", status: "open" });

    // again the same day, and with one more dead job: still one alert, one task
    expect((await checkDeadJobs(WED)).raised).toBe(false);
    await deadJob("d3", "site_test", "Error: browser crashed");
    expect((await checkDeadJobs(new Date(WED.getTime() + 3600_000))).raised).toBe(false);
    expect(await alertMails()).toHaveLength(1);
    expect(await count("owner_tasks")).toBe(1);

    // the next day: only the job that was not reported yet
    expect((await checkDeadJobs(THU)).raised).toBe(true);
    mails = await alertMails();
    expect(mails).toHaveLength(2);
    expect(mails[1].subject).toMatch(/1 job failed/);
    expect(mails[1].body_text).toContain("site_test: Error: browser crashed");
    expect(mails[1].body_text).not.toContain("audit_clinic");
    // and nothing more while nothing new dies
    expect((await checkDeadJobs(at("2026-11-13"))).raised).toBe(false);
    expect(await alertMails()).toHaveLength(2);
  });

  it("held for over 48 hours and waiting for approval for over 3 days", async () => {
    const clinic = await makeClinic();
    const hoursAgo = (h: number) => new Date(WED.getTime() - h * 3600e3);
    await makeMessage({ clinic_id: clinic, status: "held", subject: "Old held", updated_at: hoursAgo(49), created_at: hoursAgo(49) });
    await makeMessage({ clinic_id: clinic, status: "held", subject: "Fresh held", updated_at: hoursAgo(47), created_at: hoursAgo(47) });
    await makeMessage({ clinic_id: clinic, status: "pending_review", subject: "Old pending", created_at: hoursAgo(73) });
    await makeMessage({ clinic_id: clinic, status: "pending_review", subject: "Fresh pending", created_at: hoursAgo(71) });
    expect((await checkHeldTooLong(WED)).raised).toBe(true);
    expect((await checkApprovalQueue(WED)).raised).toBe(true);
    const mails = await alertMails();
    expect(mails).toHaveLength(2);
    expect(mails[0].body_text).toContain("Old held");
    expect(mails[0].body_text).not.toContain("Fresh held");
    expect(mails[1].body_text).toContain("Old pending");
    expect(mails[1].body_text).not.toContain("Fresh pending");
    // the same items are not reported again the next day
    expect((await checkHeldTooLong(THU)).raised).toBe(true); // "Fresh held" is now over 48 h
    expect((await checkHeldTooLong(at("2026-11-13"))).raised).toBe(false);
  });

  it("spend cap, auto-pause and a failing city", async () => {
    const sql = db();
    expect((await runAlertChecks(WED)).raised).toEqual([]);
    await sql`insert into cost_records (provider, operation, cost_usd, at) values ('anthropic', 'test', 26, ${WED})`;
    await sql`update app_settings set auto_paused = true, auto_pause_reason = 'a spam complaint', auto_paused_at = ${WED} where id`;
    const [city] = await sql<{ id: number }[]>`select id from cities where name = 'Barrie'`;
    const [sector] = await sql<{ id: number }[]>`select id from sectors where slug = 'dental'`;
    await sql`insert into jobs (kind, idempotency_key, status, last_error, payload)
              values ('test_city', 't1', 'dead', 'Error: overloaded', ${sql.json({ sectorId: sector.id, cityId: city.id, runLabel: "2026-11" })})`;
    for (const d of ["s1.example", "s2.example", "s3.example"]) {
      const c = await makeClinic({ domain: d, website: `https://${d}` });
      await sql`insert into site_test_runs (clinic_id, run_label, status, page_cap, error, finished_at) values (${c}, '2026-11', 'failed', 40, 'no browser', now())`;
    }
    const r = await runAlertChecks(WED);
    expect(r.errors).toEqual([]);
    expect(r.raised.sort()).toEqual(["auto_paused", "city_failing", "dead_jobs", "spend_cap"]);
    const mails = await alertMails();
    const city_ = mails.find((m) => /whole city/.test(m.subject));
    expect(city_?.body_text).toContain("Question test for Barrie");
    expect(city_?.body_text).toContain("All 3 site tests in Barrie failed");
    expect(mails.find((m) => /spend cap/.test(m.subject))?.body_text).toContain("26.00 USD");
    expect(mails.find((m) => /paused itself/.test(m.subject))?.body_text).toContain("a spam complaint");
    // an hour later nothing is repeated
    expect((await runAlertChecks(new Date(WED.getTime() + 3600_000))).raised).toEqual([]);
    expect(await alertMails()).toHaveLength(mails.length);
    // spend cap has no task (nothing to do but wait or raise the cap); the others do
    expect(await count("owner_tasks")).toBe(3);
    expect((await checkSpendCap(WED)).raised).toBe(false);
    expect((await checkAutoPause(WED)).raised).toBe(false);
    expect((await checkCityFailures(THU)).raised).toBe(false);
  });
});

describe("owner digest", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  it("covers the previous business day; Monday covers the weekend", () => {
    const thu = digestWindow(THU);
    expect(thu.from.toISOString()).toBe("2026-11-11T05:00:00.000Z");
    expect(thu.to.toISOString()).toBe("2026-11-12T05:00:00.000Z");
    expect(thu.label).toBe("yesterday");
    const mon = digestWindow(at("2026-11-16"));
    expect(mon.from.toISOString()).toBe("2026-11-13T05:00:00.000Z");
    expect(mon.label).toBe("since Friday");
  });

  it("is skipped when there is nothing to report, and at the weekend", async () => {
    const d = await buildDigest(THU);
    expect(d.empty).toBe(true);
    expect(await sendDigest(THU)).toEqual({ sent: false, reason: "nothing to report" });
    await makeMessage({ status: "pending_review" });
    expect(await sendDigest(at("2026-11-14"))).toEqual({ sent: false, reason: "not a business day" });
    expect((await db()`select count(*)::int as n from messages where type = 'owner_digest'`)[0].n).toBe(0);
  });

  it("lists what happened, with portal links, once a day", async () => {
    const sql = db();
    const yesterday = at("2026-11-11", "14:00");
    const older = at("2026-11-10", "14:00");
    const clinic = await makeClinic({ status: "customer", site_name: "Maple Dental" });
    await makeMessage({ clinic_id: clinic, status: "pending_review" });
    await makeMessage({ clinic_id: clinic, status: "pending_review" });
    await makeMessage({ clinic_id: clinic, status: "held" });
    await makeMessage({ clinic_id: clinic, status: "sent", sent_at: yesterday });
    await makeMessage({ clinic_id: clinic, status: "sent", sent_at: yesterday, bounced_at: yesterday });
    await makeMessage({ clinic_id: clinic, status: "sent", sent_at: older }); // before the window
    await sql`insert into inbound_messages (from_email, received_at, classification, handled) values
              ('a@x.example', ${yesterday}, 'interested', false), ('b@x.example', ${yesterday}, 'auto_reply', false)`;
    await sql`insert into orders (clinic_id, kind, status, amount_cents, paid_at) values (${clinic}, 'one_time', 'paid', 20000, ${yesterday})`;
    await sql`insert into subscriptions (clinic_id, stripe_subscription_id, status, created_at) values (${clinic}, 'sub_1', 'active', ${at("2026-10-16")})`;
    await sql`insert into cost_records (provider, operation, cost_usd, at) values ('anthropic', 'x', 3.5, ${yesterday}), ('anthropic', 'x', 1.25, ${at("2026-11-02")})`;
    await sql`insert into jobs (kind, idempotency_key, status, last_error) values ('audit_clinic', 'dead1', 'dead', 'boom')`;
    await sql`insert into owner_tasks (kind, title) values ('onboarding', 'Set up Maple Dental')`;

    const d = await buildDigest(THU);
    expect(d.empty).toBe(false);
    expect(d.subject).toBe("In The Answer: 2026-11-12, 2 to review");
    expect(d.body).toContain("Waiting for your review: 2  https://intheanswer.test/portal");
    expect(d.body).toContain("Held by the verification gate: 1 item, 0 clinics  https://intheanswer.test/portal/held");
    expect(d.body).toContain("Sent yesterday: 2 (1 bounce, 0 complaints)");
    expect(d.body).toContain("New replies yesterday: 1; not handled yet: 1");
    expect(d.body).toContain("New yesterday: 1 paid order (200.00 CAD), 0 new subscriptions");
    expect(d.body).toContain("Monthly reports due in the next 7 days: 1");
    expect(d.body).toContain("  - Maple Dental: 2026-11-16");
    expect(d.body).toContain("Jobs that failed for good: 1  https://intheanswer.test/portal/system");
    expect(d.body).toContain("Open tasks: 1");
    expect(d.body).toContain("  - Set up Maple Dental");
    expect(d.body).toContain("API spend yesterday: 3.50 USD; this month so far: 4.75 USD");

    expect((await sendDigest(THU)).sent).toBe(true);
    expect((await sendDigest(new Date(THU.getTime() + 600_000))).sent).toBe(false);
    const mails = await sql`select subject, status::text, to_email from messages where type = 'owner_digest'`;
    expect(mails).toHaveLength(1);
    expect(mails[0].status).toBe("approved");
    expect((await sql`select count(*)::int as n from owner_notifications where kind = 'digest'`)[0].n).toBe(1);
  });
});
