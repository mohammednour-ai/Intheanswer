import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { buildTeaserData } from "@/lib/reports/teaser";
import { renderTeaser } from "@/lib/reports/renderTeaser";
import { buildFirstEmail } from "@/lib/emails/firstEmail";
import { verifyTeaser, scanLanguage, type ModelVerifier } from "@/lib/pipeline/verify";
import { computeClinicResults } from "@/lib/pipeline/score";
import { resetData, makeClinic } from "./helpers";
import { HOME, CONTACT, FEES } from "./fixtures/site";

// SYNTHETIC data: an invented clinic and invented assistant answers.
const allSupported: ModelVerifier = async (items) => ({
  verdicts: items.map((i) => ({ id: i.id, supported: true, issue: "none" as const, explanation: "" })),
  usage: null,
  costUsd: 0,
});

async function setup(opts: { recommendedIn?: number[] } = {}) {
  const sql = db();
  const clinicId = await makeClinic({ name: "Maple Grove Dental", website: "https://maplegrove.example/", domain: "maplegrove.example", status: "audited" });
  for (const [u, h] of [["https://maplegrove.example/", HOME], ["https://maplegrove.example/contact/", CONTACT], ["https://maplegrove.example/fees", FEES]]) {
    await sql`insert into page_cache (url, domain, http_status, content_type, body) values (${u}, 'maplegrove.example', 200, 'text/html', ${h})`;
  }
  const [qs] = await sql<{ id: number; sector_id: number }[]>`select q.id, q.sector_id from question_sets q join sectors s on s.id=q.sector_id where s.slug='dental'`;
  const [city] = await sql<{ id: number }[]>`select id from cities where name='Barrie'`;
  const [run] = await sql<{ id: string }[]>`
    insert into test_runs (sector_id, city_id, question_set_id, assistant, model, run_label, finished_at)
    values (${qs.sector_id}, ${city.id}, ${qs.id}, 'Claude', 'claude-opus-5-5', 'test', '2026-11-10T15:00:00Z') returning id`;
  for (let i = 0; i < 6; i++) {
    const rec = opts.recommendedIn?.includes(i);
    const named = [{ name: "Lakeshore Dental Studio", url: null, status: "recommended", quote: "Lakeshore Dental Studio is accepting new patients" }];
    if (rec) named.push({ name: "Maple Grove Dental", url: null, status: "recommended", quote: "Maple Grove Dental also takes new patients" });
    const text = `Here are some options. Lakeshore Dental Studio is accepting new patients. ${rec ? "Maple Grove Dental also takes new patients." : ""}`;
    await sql`insert into test_answers (test_run_id, question_index, question, answer_text, clinics_named, served_model)
              values (${run.id}, ${i}, ${"Question " + (i + 1) + " in Barrie?"}, ${text}, ${sql.json(named)}, 'claude-opus-5-5')`;
  }
  const [audit] = await sql<{ id: string }[]>`insert into audits (clinic_id, pages_read) values (${clinicId}, ${["https://maplegrove.example/", "https://maplegrove.example/contact/", "https://maplegrove.example/fees"]}) returning id`;
  const checks = [
    { k: "hours_conflict", sev: 90, text: 'Two different sets of hours appear on your site: "Monday to Friday 9:00 am to 5:00 pm" (https://maplegrove.example/) and "Monday to Friday 8:00 am to 4:00 pm" (https://maplegrove.example/contact/).',
      ev: [{ kind: "page_quote", url: "https://maplegrove.example/", quote: "Monday to Friday 9:00 am to 5:00 pm" }, { kind: "page_quote", url: "https://maplegrove.example/contact/", quote: "Monday to Friday 8:00 am to 4:00 pm" }] },
    { k: "outdated_notices", sev: 70, text: 'Your site still shows a notice that appears out of date: "masks are required in the clinic during the COVID-19 pandemic" (https://maplegrove.example/fees).',
      ev: [{ kind: "page_quote", url: "https://maplegrove.example/fees", quote: "masks are required in the clinic during the COVID-19 pandemic" }] },
    { k: "practitioners", sev: 55, text: "We did not find the names of the practitioners who see patients on the 3 pages we read on maplegrove.example.", ev: [{ kind: "pages_read", label: "3 pages" }] },
    { k: "languages", sev: 30, text: "We did not find the languages spoken at the clinic on the 3 pages we read on maplegrove.example.", ev: [{ kind: "pages_read", label: "3 pages" }] },
  ];
  for (const c of checks) {
    await sql`insert into audit_checks (audit_id, check_key, result, summary, evidence, is_gap, severity, finding_text)
              values (${audit.id}, ${c.k}, ${c.k === "hours_conflict" || c.k === "outdated_notices" ? "found" : "not_found"}, 's',
                      ${sql.json(c.ev)}, true, ${c.sev}, ${c.text})`;
  }
  await sql`insert into audit_checks (audit_id, check_key, result, summary, evidence, is_gap, severity, finding_text)
            values (${audit.id}, 'fees', 'could_not_verify', 'site unreadable', '[]', false, 0, null)`;
  await computeClinicResults(clinicId, run.id);
  const rec = opts.recommendedIn?.length ?? 0;
  const [score] = await sql<{ id: string }[]>`
    insert into scores (clinic_id, test_run_id, audit_id, recommended, listed_only, not_named, total, confirmed_findings, qualifies, reason)
    values (${clinicId}, ${run.id}, ${audit.id}, ${rec}, 0, ${6 - rec}, 6, 4, true, 'ok') returning id`;
  const data = await buildTeaserData(clinicId, score.id, "tok_test_000000000000");
  const draft = buildFirstEmail(data, { toEmail: "info@maplegrove.example", sourceUrl: "https://maplegrove.example/", reportUrl: "https://intheanswer.test/r/tok" });
  return { clinicId, scoreId: score.id, auditId: audit.id, data, draft };
}

describe("teaser and verification gate", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  it("builds the teaser from stored evidence: score, rows, names instead, three findings", async () => {
    const { data } = await setup({ recommendedIn: [0] });
    expect(data.score).toEqual({ recommended: 1, listedOnly: 0, total: 6 });
    expect(data.rows[0].status).toBe("recommended");
    expect(data.rows[1]).toMatchObject({ status: "not_named", namedInstead: ["Lakeshore Dental Studio"] });
    expect(data.findings.map((f) => f.checkKey)).toEqual(["hours_conflict", "outdated_notices", "practitioners"]);
    expect(data.test).toMatchObject({ assistant: "Claude", model: "claude-opus-5-5", date: "November 10, 2026" });
    const html = renderTeaser(data);
    expect(html).toContain("In the answer");
    expect(html).toContain("1 of 6");
    expect(html).toContain("Monthly plan");
    expect(html).not.toMatch(/gradient/i);
  });

  it("email: specific subject, two findings, link, both offers, identity and unsubscribe", async () => {
    const { draft } = await setup({ recommendedIn: [0] });
    expect(draft.subject).toBe("Maple Grove Dental was recommended in 1 of 6 AI answers for Barrie patients");
    expect(draft.bodyText).toContain("1. Two different sets of hours");
    expect(draft.bodyText).toContain("2. Your site still shows a notice");
    expect(draft.bodyText).toContain("https://intheanswer.test/r/tok");
    expect(draft.bodyText).toMatch(/200 CAD, one time/);
    expect(draft.bodyText).toMatch(/200 CAD a month/);
    expect(draft.bodyText).toMatch(/intheanswer\.test\/unsubscribe\//);
    expect(draft.bodyText).toContain("published on https://maplegrove.example/");
  });

  it("passes when every claim holds (placeholders only warn in dry run)", async () => {
    const s = await setup();
    const v = await verifyTeaser({ data: s.data, draft: s.draft, scoreId: s.scoreId, live: false, withModel: true, verifier: allSupported });
    expect(v.data.findings).toHaveLength(3);
    expect(v.flags.filter((f) => f.severity === "block")).toEqual([]);
    expect(v.flags.map((f) => f.code)).toContain("owner_details_placeholder");
    expect(v.passed).toBe(true);
  });

  it("placeholders block a live send", async () => {
    const s = await setup();
    const v = await verifyTeaser({ data: s.data, draft: s.draft, scoreId: s.scoreId, live: true, withModel: true, verifier: allSupported });
    expect(v.passed).toBe(false);
  });

  it("removes a finding whose quote is no longer on the page, then holds with fewer than three", async () => {
    const s = await setup();
    await db()`update page_cache set body = '<html><body>Hours vary.</body></html>' where url='https://maplegrove.example/contact/'`;
    // only the first three findings are in the teaser; removing one leaves two
    const v = await verifyTeaser({ data: s.data, draft: s.draft, scoreId: s.scoreId, live: false, withModel: true, verifier: allSupported });
    expect(v.removed.map((r) => r.what)).toContain("Hours that disagree");
    expect(v.data.findings).toHaveLength(2);
    expect(v.flags.map((f) => f.code)).toContain("fewer_than_three_findings");
    expect(v.passed).toBe(false);
  });

  it("holds when a could-not-verify check is used as a finding", async () => {
    const s = await setup();
    s.data.findings[2] = { checkKey: "fees", title: "Fees", text: "You do not publish fees.", evidence: [] };
    const v = await verifyTeaser({ data: s.data, draft: s.draft, scoreId: s.scoreId, live: false, withModel: true, verifier: allSupported });
    expect(v.flags.map((f) => f.code)).toContain("unverified_as_fact");
    expect(v.passed).toBe(false);
  });

  it("holds on a score that does not match stored results", async () => {
    const s = await setup();
    s.data.score.recommended = 3;
    const v = await verifyTeaser({ data: s.data, draft: s.draft, scoreId: s.scoreId, live: false, withModel: true, verifier: allSupported });
    expect(v.flags.map((f) => f.code)).toContain("score_mismatch");
  });

  it("drops a competitor name that is not a recommendation in the stored answer", async () => {
    const s = await setup();
    s.data.rows[1].namedInstead.push("Invented Dental Group");
    const v = await verifyTeaser({ data: s.data, draft: s.draft, scoreId: s.scoreId, live: false, withModel: true, verifier: allSupported });
    expect(v.data.rows[1].namedInstead).toEqual(["Lakeshore Dental Studio"]);
    expect(v.removed[0].what).toContain("Invented Dental Group");
  });

  it("model pass: an unsupported finding is removed; an unsupported summary holds", async () => {
    const s = await setup();
    const strict: ModelVerifier = async (items) => ({
      verdicts: items.map((i) => ({
        id: i.id,
        supported: !(i.id === "finding-2" || i.id === "summary-0"),
        issue: i.id === "finding-2" || i.id === "summary-0" ? ("overstated" as const) : ("none" as const),
        explanation: "test",
      })),
      usage: null,
      costUsd: 0,
    });
    const v = await verifyTeaser({ data: s.data, draft: s.draft, scoreId: s.scoreId, live: false, withModel: true, verifier: strict });
    expect(v.data.findings).toHaveLength(2);
    expect(v.flags.map((f) => f.code)).toEqual(expect.arrayContaining(["verifier_overstated", "fewer_than_three_findings"]));
    expect(v.passed).toBe(false);
  });

  it("refuses to pass when the model pass did not run", async () => {
    const s = await setup();
    const v = await verifyTeaser({ data: s.data, draft: s.draft, scoreId: s.scoreId, live: false, withModel: false });
    expect(v.passed).toBe(false);
  });

  it("language scan blocks superlatives, promises and urgency but allows the limits line", () => {
    expect(scanLanguage("We are the best clinic", "x")[0].message).toMatch(/superlative/);
    expect(scanLanguage("You will be recommended next month", "x")[0].message).toMatch(/promise/);
    expect(scanLanguage("Act now, limited time", "x").length).toBeGreaterThan(0);
    expect(scanLanguage("We guarantee results", "x")[0].code).toBe("language_guarantee");
    expect(scanLanguage("No one can guarantee what an assistant will say.", "x")).toEqual([]);
  });
});

describe("gate rules for site test and review claims", () => {
  beforeEach(resetData);

  async function addSiteRun(clinicId: string, checks: { key: string; result: string; impact: number; text: string | null }[]) {
    const sql = db();
    const [run] = await sql<{ id: string }[]>`
      insert into site_test_runs (clinic_id, run_label, status, page_cap, pages_crawled, finished_at)
      values (${clinicId}, 'test', 'done', 40, 30, now()) returning id`;
    for (const c of checks) {
      await sql`insert into site_test_checks (run_id, check_key, category, result, impact, line, finding_text, evidence)
                values (${run.id}, ${c.key}, 'x', ${c.result}, ${c.impact}, 'line', ${c.text}, ${sql.json([{ kind: "raw_source", url: "https://maplegrove.example/", label: "lab" }])})`;
    }
    return run.id;
  }

  it("the teaser may take one site finding when it is among the strongest, never two, never could-not-test", async () => {
    const s = await setup();
    await addSiteRun(s.clinicId, [
      { key: "booking_path", result: "needs_work", impact: 100, text: "From your home page we did not find a booking link or a phone number a patient can tap." },
      { key: "mobile_layout", result: "needs_work", impact: 92, text: "On a simulated phone your home page is wider than the screen." },
      { key: "speed_mobile", result: "could_not_test", impact: 99, text: null },
    ]);
    const data = await buildTeaserData(s.clinicId, s.scoreId, "tok_test_111111111111");
    const site = data.findings.filter((f) => f.source === "site");
    expect(data.findings).toHaveLength(3);
    expect(site).toHaveLength(1);
    expect(site[0].checkKey).toBe("site:booking_path");
    expect(data.findings.some((f) => f.checkKey === "site:speed_mobile")).toBe(false);
    const draft = buildFirstEmail(data, { toEmail: "info@maplegrove.example", sourceUrl: "https://maplegrove.example/", reportUrl: "https://intheanswer.test/r/t" });
    const v = await verifyTeaser({ data, draft, scoreId: s.scoreId, live: false, withModel: true, verifier: allSupported });
    expect(v.data.findings).toHaveLength(3);
    expect(v.flags.filter((f) => f.severity === "block")).toEqual([]);
  });

  it("a site check that turns out to be could-not-test can never be stated as a problem", async () => {
    const s = await setup();
    const runId = await addSiteRun(s.clinicId, [{ key: "booking_path", result: "needs_work", impact: 100, text: "From your home page we did not find a booking link." }]);
    const data = await buildTeaserData(s.clinicId, s.scoreId, "tok_test_222222222222");
    await db()`update site_test_checks set result='could_not_test' where run_id=${runId}`;
    const v = await verifyTeaser({ data, draft: s.draft, scoreId: s.scoreId, live: false, withModel: true, verifier: allSupported });
    expect(v.flags.map((f) => f.code)).toContain("unverified_as_fact");
    expect(v.passed).toBe(false);
  });

  it("a site finding whose text no longer matches the stored result is removed", async () => {
    const s = await setup();
    await addSiteRun(s.clinicId, [{ key: "booking_path", result: "needs_work", impact: 100, text: "Stored sentence." }]);
    const data = await buildTeaserData(s.clinicId, s.scoreId, "tok_test_333333333333");
    const f = data.findings.find((x) => x.source === "site")!;
    f.text = "Your site has no way to book at all.";
    const v = await verifyTeaser({ data, draft: s.draft, scoreId: s.scoreId, live: false, withModel: true, verifier: allSupported });
    expect(v.removed.map((r) => r.what)).toContain(f.title);
  });

  it("review numbers may not be baked into the stored report or the email", async () => {
    const s = await setup();
    const draft = { ...s.draft, bodyText: s.draft.bodyText.replace("Two things I noticed", "Your clinic has 7 reviews. Two things I noticed") };
    const v = await verifyTeaser({ data: s.data, draft, scoreId: s.scoreId, live: false, withModel: true, verifier: allSupported });
    expect(v.flags.map((f) => f.code)).toContain("review_number_stored");
    expect(v.passed).toBe(false);
  });

  it("the stored teaser keeps only a marker for the live review table", async () => {
    const s = await setup();
    const html = renderTeaser(s.data);
    expect(html).toContain("<!--LIVE_REVIEWS-->");
    expect(html).not.toMatch(/Google Maps/);
  });
});
