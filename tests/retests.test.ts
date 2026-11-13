import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { enqueue, runJobs } from "@/lib/jobs/queue";
import { handlers } from "@/lib/jobs/handlers";
import "@/lib/pipeline/score";
import "@/lib/schedule";
import { deliverMonthlyReport, deliverRetestUpgrade } from "@/lib/retests/jobs";
import { buildComparisonData, verifyComparison } from "@/lib/retests/report";
import { resetData, makeClinic } from "./helpers";

const at = (ymd: string, hhmm = "10:00") => new Date(`${ymd}T${hhmm}:00-05:00`);
const QUESTIONS = ["Who is a good dentist in Barrie?", "Which Barrie dentist takes new patients?", "Where can I get an emergency dental visit in Barrie?"];
const deps = { pdf: async () => Buffer.from("%PDF-test"), put: async (key: string) => `local:${key}` };

/** A customer with last month's test and audit, this month's, and the full report it bought. */
async function fixture() {
  const sql = db();
  const clinic = await makeClinic({ status: "customer", name: "Maple Dental", site_name: "Maple Dental", domain: "mapledental.example", website: "https://mapledental.example" });
  await sql`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary)
            values (${clinic}, 'info@mapledental.example', 'https://mapledental.example/contact', true, true)`;
  const [c] = await sql<{ sector_id: number; city_id: number }[]>`select sector_id, city_id from clinics where id = ${clinic}`;
  const [qs] = await sql<{ id: number }[]>`select id from question_sets where sector_id = ${c.sector_id} limit 1`;
  const run = async (label: string, finished: Date, statuses: string[]) => {
    const [r] = await sql<{ id: string }[]>`
      insert into test_runs (sector_id, city_id, question_set_id, assistant, model, run_label, started_at, finished_at)
      values (${c.sector_id}, ${c.city_id}, ${qs.id}, 'Claude', 'claude-test', ${label}, ${finished}, ${finished}) returning id`;
    const answers: string[] = [];
    for (const [i, q] of QUESTIONS.entries()) {
      const named = statuses[i] === "not_named" ? [] : [{ name: "Maple Dental", url: null, status: statuses[i], quote: "Maple Dental on Bayfield Street is one option to call" }];
      const [a] = await sql<{ id: string }[]>`
        insert into test_answers (test_run_id, question_index, question, answer_text, clinics_named, asked_at)
        values (${r.id}, ${i}, ${q}, ${named.length ? "Maple Dental on Bayfield Street is one option to call." : "Lakeside Dentistry is one option to call."},
                ${sql.json(named)}, ${finished}) returning id`;
      await sql`insert into clinic_test_results (clinic_id, test_answer_id, status) values (${clinic}, ${a.id}, ${statuses[i]})`;
      answers.push(a.id);
    }
    return { id: r.id, answers };
  };
  const audit = async (when: Date, hoursFound: boolean) => {
    const [a] = await sql<{ id: string }[]>`insert into audits (clinic_id, run_at, pages_read) values (${clinic}, ${when}, ${["https://mapledental.example/"]}) returning id`;
    await sql`insert into audit_checks (audit_id, check_key, result, summary, is_gap, severity, finding_text) values
      (${a.id}, 'hours', ${hoursFound ? "found" : "not_found"}, ${hoursFound ? "Opening hours are listed on the contact page." : "No opening hours on the pages read."},
       ${!hoursFound}, 8, ${hoursFound ? null : "We did not find opening hours on the pages we read."}),
      (${a.id}, 'fees', 'not_found', 'No fees on the pages read.', true, 6, 'We did not find fees for uninsured services on the pages we read.'),
      (${a.id}, 'languages', 'could_not_verify', 'Could not tell.', false, 2, null)`;
    return a.id;
  };
  const score = async (runId: string, auditId: string, rec: number, when: Date) =>
    (await sql<{ id: string }[]>`
      insert into scores (clinic_id, test_run_id, audit_id, recommended, listed_only, not_named, total, confirmed_findings, qualifies, reason, created_at)
      values (${clinic}, ${runId}, ${auditId}, ${rec}, 1, ${2 - rec}, 3, 2, true, 'test', ${when}) returning id`)[0].id;

  const runA = await run("2026-10", at("2026-10-05"), ["not_named", "listed_only", "recommended"]);
  const runB = await run("2026-11", at("2026-11-11"), ["recommended", "listed_only", "not_named"]);
  const auditA = await audit(at("2026-10-05"), false);
  const auditB = await audit(at("2026-11-11"), true);
  const scoreA = await score(runA.id, auditA, 1, at("2026-10-05"));
  const scoreB = await score(runB.id, auditB, 1, at("2026-11-11"));
  const [full] = await sql<{ id: string }[]>`
    insert into reports (clinic_id, kind, token, score_id, data, html, created_at)
    values (${clinic}, 'full', 'full-token-000000001', ${scoreA}, ${sql.json({ verified: true, kind: "full" })}, '', ${at("2026-10-14")}) returning id`;
  await sql`insert into reports (clinic_id, kind, token, score_id, data, html, created_at)
            values (${clinic}, 'teaser', 'teaser-token-0000001', ${scoreA}, ${sql.json({ verified: true })}, '', ${at("2026-10-06")})`;
  return { clinic, sectorId: c.sector_id, cityId: c.city_id, runA, runB, auditA, auditB, scoreA, scoreB, full: full.id };
}

const jobKinds = async () => (await db()<{ kind: string }[]>`select kind from jobs order by kind`).map((j) => j.kind);

describe("scoring step for customers", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  it("hands a retest score to the monthly report and never builds a teaser or parks", async () => {
    const f = await fixture();
    await enqueue("score_clinic", `score:${f.clinic}:${f.auditB}`, {
      clinicId: f.clinic, auditId: f.auditB, testRunId: f.runB.id, runLabel: "2026-11",
      retest: { kind: "monthly", cycle: "2026-11", subscriptionId: null, grace: false },
    });
    await runJobs({ score_clinic: handlers.score_clinic }, { kinds: ["score_clinic"] });
    const [j] = await db()`select status::text, result from jobs where kind = 'score_clinic'`;
    expect(j.status).toBe("done");
    expect(j.result).toMatchObject({ customer: true, next: "monthly_report" });
    const kinds = await jobKinds();
    expect(kinds).toContain("monthly_report");
    expect(kinds).not.toContain("build_teaser");
    const [m] = await db()`select idempotency_key, payload from jobs where kind = 'monthly_report'`;
    expect(m.idempotency_key).toBe(`monthly_report:${f.clinic}:2026-11`);
    expect(m.payload).toMatchObject({ clinicId: f.clinic, scoreId: f.scoreB, cycle: "2026-11" });
    const [c] = await db()`select status::text from clinics where id = ${f.clinic}`;
    expect(c.status).toBe("customer");
  });

  it("hands a retest after a purchase to its own message", async () => {
    const f = await fixture();
    const orderId = "11111111-2222-4333-8444-555555555555";
    await enqueue("score_clinic", "s-purchase", {
      clinicId: f.clinic, auditId: f.auditB, testRunId: f.runB.id, runLabel: "retest-2026-11-11", retest: { kind: "purchase", orderId },
    });
    await runJobs({ score_clinic: handlers.score_clinic }, { kinds: ["score_clinic"] });
    const kinds = await jobKinds();
    expect(kinds).toEqual(["retest_upgrade", "score_clinic"]); // no teaser, and no page proposals for a one-off run label
    expect((await db()`select idempotency_key as k from jobs where kind = 'retest_upgrade'`)[0].k).toBe(`retest_upgrade:${orderId}`);
  });

  it("a customer scored outside a retest is left alone; a prospect still follows the outreach path", async () => {
    const f = await fixture();
    await enqueue("score_clinic", "s-customer", { clinicId: f.clinic, auditId: f.auditB, testRunId: f.runB.id });
    await runJobs({ score_clinic: handlers.score_clinic }, { kinds: ["score_clinic"] });
    expect(await jobKinds()).toEqual(["score_clinic"]);
    expect((await db()`select status::text from clinics where id = ${f.clinic}`)[0].status).toBe("customer");

    // the same data for a clinic that is not a customer: scored, then parked or sent on to a teaser
    await db()`update clinics set status = 'audited' where id = ${f.clinic}`;
    await enqueue("score_clinic", "s-prospect", { clinicId: f.clinic, auditId: f.auditB, testRunId: f.runB.id });
    await runJobs({ score_clinic: handlers.score_clinic }, { kinds: ["score_clinic"] });
    const status = (await db()`select status::text from clinics where id = ${f.clinic}`)[0].status;
    const kinds = await jobKinds();
    expect(status === "parked" || kinds.includes("build_teaser")).toBe(true);
  });
});

describe("monthly report", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  it("compares this month with the last, from stored results, and is delivered once", async () => {
    const sql = db();
    const f = await fixture();
    // an answer page for question 1 went live after the full report
    const [page] = await sql<{ id: string }[]>`
      insert into answer_pages (clinic_id, kind, intent, target_question, question_index, title, slug, reason, status, live_url)
      values (${f.clinic}, 'question', 'general', ${QUESTIONS[0]}, 0, 'Looking for a dentist in Barrie?', 'dentist-in-barrie', 'not recommended for this question', 'live',
              'https://mapledental.example/dentist-in-barrie') returning id`;
    await sql`insert into answer_page_events (page_id, to_status, actor, at) values (${page.id}, 'live', 'owner', ${at("2026-10-20")})`;
    // the clinic connected its own Business Profile: numbers for both months
    await sql`insert into gbp_connections (clinic_id, connect_token, status) values (${f.clinic}, 'connect-token-1', 'connected')`;
    await sql`insert into review_snapshots (clinic_id, run_label, average_rating, total_count, count_90d, reply_rate, analysis_level, created_at) values
              (${f.clinic}, '2026-10', 4.6, 40, 5, 0.5, 'full', ${at("2026-10-05")}), (${f.clinic}, '2026-11', 4.7, 46, 9, 0.6, 'full', ${at("2026-11-11")})`;

    const r = await deliverMonthlyReport({ clinicId: f.clinic, scoreId: f.scoreB, cycle: "2026-11" }, deps);
    expect(r.built).toBe(true);
    const [rep] = await sql`select * from reports where id = ${r.reportId}`;
    expect(rep.kind).toBe("monthly");
    expect(rep.previous_report_id).toBe(f.full);
    expect(rep.score_id).toBe(f.scoreB);
    expect(rep.pdf_path).toBe(`local:reports/${rep.token}.pdf`);
    const d = rep.data;
    expect(d).toMatchObject({ kind: "monthly", verified: true, cycle: "2026-11", grace: false });
    expect(d.score).toMatchObject({ recommended: 1, total: 3 });
    expect(d.previous).toMatchObject({ reportId: f.full, reportKind: "full", recommended: 1, total: 3 });
    expect(d.rows.map((x: { before: string; now: string }) => `${x.before}>${x.now}`)).toEqual([
      "not_named>recommended", "listed_only>listed_only", "recommended>not_named",
    ]);
    expect(d.summary).toContain("Of the 3 questions asked both times, 1 improved, 1 went lower and 1 stayed the same.");
    expect(d.installed).toHaveLength(1);
    expect(d.installed[0]).toMatchObject({ title: "Looking for a dentist in Barrie?" });
    expect(d.fixed.map((x: { key: string }) => x.key)).toEqual(["hours"]); // fees is still a gap; "could not verify" is never a change
    expect(d.services.reviews.current.total_count).toBe(46);
    expect(d.services.reviews.diff.totalChange).toBe(6);
    expect(d.services.pages[0]).toMatchObject({ before: "not_named", now: "recommended", trend: "improved" }); // updateLivePageResults ran
    expect(rep.html).toContain("Monthly report");
    expect(rep.html).toContain("Reviews this month");
    expect(rep.html).toContain("Opening hours are listed on the contact page.");

    const [msg] = await sql`select * from messages where id = ${r.message}`;
    expect(msg).toMatchObject({ type: "monthly_report", status: "pending_review", to_email: "info@mapledental.example", attach_pdf: true, report_id: r.reportId, clinic_id: f.clinic });
    expect(msg.subject).toBe("Maple Dental: your November 2026 report");
    expect(msg.body_text).toContain("Maple Dental was recommended in 1 of 3 answers.");
    expect(msg.body_text).toContain(`https://intheanswer.test/r/${rep.token}`);
    expect(msg.body_text).not.toMatch(/\d+ reviews?/); // review numbers stay in the report
    expect(msg.flags.every((x: { severity: string }) => x.severity === "warn")).toBe(true);

    // run again: the same report and the same message
    const again = await deliverMonthlyReport({ clinicId: f.clinic, scoreId: f.scoreB, cycle: "2026-11" }, deps);
    expect(again).toMatchObject({ built: false, reportId: r.reportId, message: r.message });
    expect((await sql`select count(*)::int as n from reports where kind = 'monthly'`)[0].n).toBe(1);
    expect((await sql`select count(*)::int as n from messages where type = 'monthly_report'`)[0].n).toBe(1);

  });

  it("states no change it has no stored evidence for", async () => {
    const sql = db();
    const f = await fixture();
    const [full] = await sql`select id, kind::text, score_id, created_at from reports where id = ${f.full}`;
    const data = await buildComparisonData(f.clinic, f.scoreB, { kind: "monthly", cycle: "2026-11", previousReport: full as never });
    expect(data.services.reviews).toBeNull(); // no connected profile, no review numbers
    const clean = await verifyComparison(data, { live: false });
    expect(clean.removed).toEqual([]);
    expect(clean.flags.filter((x) => x.severity === "block")).toEqual([]);

    // a "before" that the stored result does not support is dropped
    const t1 = structuredClone(data);
    t1.rows[1].before = "not_named";
    t1.fixed.push({ key: "fees", label: "Fees", before: "We did not find fees", now: "Fees are listed." });
    t1.installed.push({ pageId: "00000000-0000-4000-8000-000000000000", title: "A page that is not live", liveUrl: null, question: "q", wentLive: "today" });
    const v1 = await verifyComparison(t1, { live: false });
    expect(v1.data.rows[1].before).toBeNull();
    expect(v1.data.rows[0].before).toBe("not_named");
    expect(v1.data.fixed.map((x) => x.key)).toEqual(["hours"]);
    expect(v1.data.installed).toEqual([]);
    expect(v1.removed).toHaveLength(3);
    expect(v1.data.summary.join(" ")).toContain("Of the 2 questions asked both times");

    // a previous score that does not match the stored results: the whole comparison goes
    const t2 = structuredClone(data);
    t2.previous!.recommended = 0;
    const v2 = await verifyComparison(t2, { live: false });
    expect(v2.data.previous).toBeNull();
    expect(v2.data.rows.every((x) => x.before === null)).toBe(true);
    expect(v2.data.fixed).toEqual([]);
    expect(v2.data.summary).toHaveLength(1);

    // this month's own score must match, or the report is held
    const t3 = structuredClone(data);
    t3.score.recommended = 3;
    const v3 = await verifyComparison(t3, { live: false });
    expect(v3.flags.some((x) => x.code === "score_mismatch" && x.severity === "block")).toBe(true);

    // wording rules apply to everything quoted from the audit
    await sql`update audit_checks set summary = 'The best opening hours in Barrie are listed.' where audit_id = ${f.auditB} and check_key = 'hours'`;
    const worded = await buildComparisonData(f.clinic, f.scoreB, { kind: "monthly", cycle: "2026-11", previousReport: full as never });
    const v4 = await verifyComparison(worded, { live: false });
    expect(v4.flags.some((x) => x.code.startsWith("language_") && x.severity === "block")).toBe(true);
    const held = await deliverMonthlyReport({ clinicId: f.clinic, scoreId: f.scoreB, cycle: "2026-11" }, deps);
    expect(held.status).toBe("held");
  });
});

describe("retest message after a one-time purchase", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  const order = async (clinic: string, reportId: string | null, over: Record<string, unknown> = {}) => {
    const sql = db();
    const row = { clinic_id: clinic, kind: "one_time", status: "paid", customer_email: "owner@mapledental.example", amount_cents: 20000, paid_at: at("2026-10-14"), report_id: reportId, ...over };
    return (await sql<{ id: string }[]>`insert into orders ${sql(row as never)} returning id`)[0].id;
  };

  it("sends the before and after with the full service plan link, once", async () => {
    const sql = db();
    const f = await fixture();
    const o = await order(f.clinic, f.full);
    const r = (await deliverRetestUpgrade({ clinicId: f.clinic, scoreId: f.scoreB, orderId: o }, deps)) as { reportId: string; status: string; message: string };
    expect(r.status).toBe("pending_review");
    const [msg] = await sql`select * from messages where type = 'retest_upgrade'`;
    expect(msg.to_email).toBe("owner@mapledental.example");
    expect(msg.attach_pdf).toBe(false);
    expect(msg.body_text).toContain("was recommended in 1 of 3 answers");
    expect(msg.body_text).toContain("At the previous test on October 5, 2026 it was recommended in 1 of 3.");
    expect(msg.body_text).toContain("https://intheanswer.test/buy/teaser-token-0000001/monthly");
    const [rep] = await sql`select kind::text, previous_report_id, data from reports where id = ${r.reportId}`;
    expect(rep).toMatchObject({ kind: "retest", previous_report_id: f.full });
    expect(rep.data.offer.monthlyUrl).toBe("https://intheanswer.test/buy/teaser-token-0000001/monthly");
    const [done] = await sql`select retest_done_at, retest_note from orders where id = ${o}`;
    expect(done.retest_done_at).not.toBeNull();

    expect(await deliverRetestUpgrade({ clinicId: f.clinic, scoreId: f.scoreB, orderId: o }, deps)).toEqual({ skipped: "already handled" });
    expect((await sql`select count(*)::int as n from messages where type = 'retest_upgrade'`)[0].n).toBe(1);
  });

  it("sends nothing after a refund, and asks the owner when there is no plan link to give", async () => {
    const sql = db();
    const f = await fixture();
    const refunded = await order(f.clinic, f.full, { status: "refunded", refunded_at: at("2026-11-01") });
    expect(await deliverRetestUpgrade({ clinicId: f.clinic, scoreId: f.scoreB, orderId: refunded }, deps)).toEqual({ skipped: "order is refunded" });
    expect((await sql`select count(*)::int as n from messages`)[0].n).toBe(0);

    await sql`delete from reports where kind = 'teaser'`;
    const o = await order(f.clinic, f.full);
    const r = (await deliverRetestUpgrade({ clinicId: f.clinic, scoreId: f.scoreB, orderId: o }, deps)) as { reportId: string; status: string; message: string };
    const [msg] = await sql`select status::text, review_reason, body_text from messages where id = ${r.message}`;
    expect(msg.status).toBe("pending_review");
    expect(msg.review_reason).toMatch(/no teaser report/);
    expect(msg.body_text).toContain("https://intheanswer.test/pricing");
  });
});
