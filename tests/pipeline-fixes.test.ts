import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, closeDb } from "@/lib/db";
import { enqueue, PermanentJobError, DeferJob, type JobContext } from "@/lib/jobs/queue";
import { resetData, makeClinic } from "./helpers";
import { SITE, siteFrom, HOME } from "./fixtures/site";

// SYNTHETIC data throughout: invented clinics, invented assistant answers.
// The Claude, Places and site-reading adapters are replaced, so nothing is
// requested and nothing is charged.
const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  structured: vi.fn(),
  readSite: vi.fn(),
  textSearch: vi.fn(),
  readWithWebFetch: vi.fn(),
}));
vi.mock("@/lib/adapters/claude", async (orig) => ({
  ...(await orig<typeof import("@/lib/adapters/claude")>()),
  askPatientQuestion: mocks.ask,
  structured: mocks.structured,
  readWithWebFetch: mocks.readWithWebFetch,
}));
vi.mock("@/lib/site/crawl", async (orig) => ({ ...(await orig<typeof import("@/lib/site/crawl")>()), readSite: mocks.readSite }));
vi.mock("@/lib/adapters/places", async (orig) => ({ ...(await orig<typeof import("@/lib/adapters/places")>()), textSearch: mocks.textSearch }));
vi.mock("@/lib/adapters/http", async (orig) => ({
  ...(await orig<typeof import("@/lib/adapters/http")>()),
  getRobots: async () => ({ txt: "", status: 404 }),
}));

import { ClaudeIncompleteError, ClaudeRefusalError, type PatientAnswer } from "@/lib/adapters/claude";
import { handleTestCity, MIN_ANSWERED } from "@/lib/pipeline/test";
import { handleAudit } from "@/lib/pipeline/audit/run";
import { handleDiscover } from "@/lib/pipeline/discover";
import { handleFindContact } from "@/lib/pipeline/contact";
import { checkDirectories, listingIsClinics, sameDocUrl } from "@/lib/pipeline/audit/directories";
import { computeClinicResults } from "@/lib/pipeline/score";

const USAGE = { input_tokens: 100, output_tokens: 50 };

interface Captured {
  costs: { operation: string; costUsd: number; units?: Record<string, unknown> }[];
  logs: string[];
  enqueued: string[];
}
function fakeCtx(kind: string, payload: Record<string, unknown>, attempts = 1, maxAttempts = 5): JobContext & Captured {
  const cap: Captured = { costs: [], logs: [], enqueued: [] };
  return {
    ...cap,
    job: { id: "00000000-0000-0000-0000-000000000001", kind, idempotency_key: "k", payload, attempts, max_attempts: maxAttempts },
    log: async (m) => void cap.logs.push(m),
    cost: async (c) => void cap.costs.push(c),
    enqueue: async (k, key, p, o) => {
      cap.enqueued.push(k);
      return enqueue(k, key, p, o);
    },
  };
}

const answer = (text: string): PatientAnswer => ({
  text, sources: [], citations: [], requestedModel: "claude-opus-5-5", servedModel: "claude-opus-5-5",
  stopReason: "end_turn", usage: USAGE, costUsd: 0.02, askedAt: "2026-11-10T15:00:00.000Z",
});
const extraction = (names: string[]) => ({
  data: { clinics: names.map((n) => ({ name: n, url: null, status: "recommended", quote: `${n} is accepting new patients` })) },
  usage: USAGE, costUsd: 0.001, model: "claude-opus-5-5",
});

async function ids() {
  const sql = db();
  const [s] = await sql<{ id: number }[]>`select id from sectors where slug='dental'`;
  const [c] = await sql<{ id: number }[]>`select id from cities where name='Barrie'`;
  const [q] = await sql<{ questions: string[] }[]>`select questions from question_sets where sector_id=${s.id} and active order by version desc limit 1`;
  return { sectorId: s.id, cityId: c.id, questions: q.questions.length };
}

beforeEach(async () => {
  await resetData();
  for (const m of Object.values(mocks)) m.mockReset();
});
afterAll(closeDb);

// ---------------------------------------------------------------------------
describe("city test: one bad question does not end the run", () => {
  it("a refused question is skipped; the run finishes and scores count answered questions only", async () => {
    const { sectorId, cityId, questions } = await ids();
    mocks.ask.mockImplementation(async (q: string) => {
      if (mocks.ask.mock.calls.length === 2) {
        throw new ClaudeRefusalError("refused: {\"category\":null}", { usage: USAGE, costUsd: 0.004, servedModel: "claude-opus-5-5" });
      }
      return answer(`For ${q} Lakeshore Dental Studio is accepting new patients.`);
    });
    mocks.structured.mockResolvedValue(extraction(["Lakeshore Dental Studio"]));
    const ctx = fakeCtx("test_city", { sectorId, cityId, runLabel: "t1" });
    const out = (await handleTestCity(ctx)) as { testRunId: string; answered: number; skipped: number[] };

    expect(out.answered).toBe(questions - 1);
    expect(out.skipped).toEqual([1]);
    const sql = db();
    const [run] = await sql`select finished_at, skipped_questions, error from test_runs where id=${out.testRunId}`;
    expect(run.finished_at).not.toBeNull();
    expect(run.skipped_questions).toHaveLength(1);
    expect(run.skipped_questions[0]).toMatchObject({ index: 1 });
    expect(run.skipped_questions[0].reason).toMatch(/declined/);
    const rows = await sql<{ question_index: number }[]>`select question_index from test_answers where test_run_id=${out.testRunId} order by 1`;
    expect(rows.map((r) => r.question_index)).not.toContain(1);
    expect(rows).toHaveLength(questions - 1);
    // the refused call was billed and is recorded, flagged as failed
    expect(ctx.costs.filter((c) => c.operation === "test_question")).toHaveLength(questions);
    expect(ctx.costs.find((c) => c.units?.failed)).toMatchObject({ operation: "test_question", costUsd: 0.004 });
    // the refused question was asked once, not retried
    expect(mocks.ask).toHaveBeenCalledTimes(questions);

    // every consumer totals the answered questions
    const clinicId = await makeClinic({ name: "Maple Grove Dental", domain: "maplegrove.example" });
    expect(await computeClinicResults(clinicId, out.testRunId)).toHaveLength(questions - 1);
  });

  it("a cut-off or empty answer is asked again and never stored as an answer", async () => {
    const { sectorId, cityId, questions } = await ids();
    let n = 0;
    mocks.ask.mockImplementation(async () => {
      n++;
      if (n === 1) throw new ClaudeIncompleteError("answer not complete (stop_reason max_tokens)", "max_tokens", { usage: USAGE, costUsd: 0.05, servedModel: "claude-opus-5-5" });
      if (n === 3) throw new ClaudeIncompleteError("answer has no text", "empty", { usage: USAGE, costUsd: 0.01, servedModel: "claude-opus-5-5" });
      return answer("Lakeshore Dental Studio is accepting new patients.");
    });
    mocks.structured.mockResolvedValue(extraction(["Lakeshore Dental Studio"]));
    const ctx = fakeCtx("test_city", { sectorId, cityId, runLabel: "t2" });
    const out = (await handleTestCity(ctx)) as { testRunId: string; answered: number; skipped: number[] };
    expect(out).toMatchObject({ answered: questions, skipped: [] });
    expect(mocks.ask).toHaveBeenCalledTimes(questions + 2);
    const rows = await db()`select answer_text, stop_reason from test_answers where test_run_id=${out.testRunId}`;
    expect(rows.every((r) => r.stop_reason === "end_turn" && r.answer_text.length > 0)).toBe(true);
    // both wasted calls were still costed, before anything else could fail
    expect(ctx.costs.filter((c) => c.units?.failed).map((c) => c.costUsd)).toEqual([0.05, 0.01]);
  });

  it("the question's cost is recorded even when reading the answer then fails", async () => {
    const { sectorId, cityId } = await ids();
    mocks.ask.mockResolvedValue(answer("Lakeshore Dental Studio is accepting new patients."));
    mocks.structured.mockRejectedValue(new Error("529 overloaded"));
    const ctx = fakeCtx("test_city", { sectorId, cityId, runLabel: "t3" }, 1, 5);
    await expect(handleTestCity(ctx)).rejects.toThrow(/question\(s\) failed/);
    expect(ctx.costs.filter((c) => c.operation === "test_question").length).toBeGreaterThan(0);
    expect((await db()`select count(*)::int as n from test_answers`)[0].n).toBe(0);
    expect((await db()`select finished_at from test_runs`)[0].finished_at).toBeNull();
  });

  it("a failing question is retried by the job, then skipped on the last attempt; answered ones are not asked twice", async () => {
    const { sectorId, cityId, questions } = await ids();
    const failing = (q: string) => q === asked[2];
    const asked: string[] = [];
    mocks.ask.mockImplementation(async (q: string) => {
      if (!asked.includes(q)) asked.push(q);
      if (asked.length >= 3 && failing(q)) throw new Error("connection error");
      return answer("Lakeshore Dental Studio is accepting new patients.");
    });
    mocks.structured.mockResolvedValue(extraction(["Lakeshore Dental Studio"]));
    // first attempt: not final, so the job fails to be retried, but the other answers are kept
    await expect(handleTestCity(fakeCtx("test_city", { sectorId, cityId, runLabel: "t4" }, 1, 3))).rejects.not.toBeInstanceOf(PermanentJobError);
    expect((await db()`select count(*)::int as n from test_answers`)[0].n).toBe(questions - 1);
    expect(mocks.ask).toHaveBeenCalledTimes(questions);
    // last attempt: only the failing question is asked again, then skipped; the run finishes
    mocks.ask.mockClear();
    const out = (await handleTestCity(fakeCtx("test_city", { sectorId, cityId, runLabel: "t4" }, 3, 3))) as { answered: number; skipped: number[] };
    expect(mocks.ask).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ answered: questions - 1, skipped: [2] });
    expect((await db()`select finished_at from test_runs`)[0].finished_at).not.toBeNull();
  });

  it(`fails for good, with a clear error, when fewer than ${MIN_ANSWERED} questions are answered`, async () => {
    const { sectorId, cityId, questions } = await ids();
    mocks.ask.mockImplementation(async () => {
      if (mocks.ask.mock.calls.length > MIN_ANSWERED - 1) throw new ClaudeRefusalError("refused", null);
      return answer("Lakeshore Dental Studio is accepting new patients.");
    });
    mocks.structured.mockResolvedValue(extraction(["Lakeshore Dental Studio"]));
    const err = await handleTestCity(fakeCtx("test_city", { sectorId, cityId, runLabel: "t5" })).catch((e) => e);
    expect(err).toBeInstanceOf(PermanentJobError);
    expect(err.message).toMatch(new RegExp(`only ${MIN_ANSWERED - 1} of ${questions} questions were answered`));
    const [run] = await db()`select finished_at, error from test_runs`;
    expect(run.finished_at).toBeNull();
    expect(run.error).toMatch(/only 3 of/);
  });
});

// ---------------------------------------------------------------------------
describe("audit", () => {
  async function clinicWithContact(status = "contact_found") {
    const id = await makeClinic({ name: "Maple Grove Dental", website: "https://maplegrove.example/", domain: "maplegrove.example", status });
    await db()`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${id}, 'info@maplegrove.example', 'https://maplegrove.example/', true, true)`;
    return id;
  }

  it("keeps waiting while the city test is queued or running", async () => {
    const { sectorId, cityId } = await ids();
    const clinicId = await clinicWithContact();
    await enqueue("test_city", `test:${sectorId}:${cityId}:m1`, {});
    await expect(handleAudit(fakeCtx("audit_clinic", { clinicId, runLabel: "m1" }))).rejects.toBeInstanceOf(DeferJob);
  });

  it("stops waiting when the city test job is dead: the clinic is parked with the reason and the job finishes", async () => {
    const { sectorId, cityId } = await ids();
    const clinicId = await clinicWithContact();
    const j = await enqueue("test_city", `test:${sectorId}:${cityId}:m1`, {});
    await db()`update jobs set status='dead', last_error='PermanentJobError: only 2 of 6 questions were answered' where id=${j.id}`;
    const out = (await handleAudit(fakeCtx("audit_clinic", { clinicId, runLabel: "m1" }))) as { parked: string };
    expect(out.parked).toMatch(/AI test for Barrie did not complete/);
    const [c] = await db()`select status::text, status_reason from clinics where id=${clinicId}`;
    expect(c.status).toBe("parked");
    expect(c.status_reason).toMatch(/only 2 of 6 questions were answered/);
    expect(mocks.readSite).not.toHaveBeenCalled();
    // another month's test is a different job: that audit still waits
    await expect(handleAudit(fakeCtx("audit_clinic", { clinicId: await makeClinic({ domain: "b.example", status: "contact_found" }), runLabel: "m2" }))).rejects.toBeInstanceOf(DeferJob);
  });

  it("does not start for, or park, a clinic that is suppressed, do-not-contact or a customer", async () => {
    const { sectorId, cityId } = await ids();
    const j = await enqueue("test_city", `test:${sectorId}:${cityId}:m1`, {});
    await db()`update jobs set status='dead' where id=${j.id}`;
    for (const status of ["suppressed", "do_not_contact", "customer"]) {
      const clinicId = await makeClinic({ domain: `${status}.example`, status });
      const out = (await handleAudit(fakeCtx("audit_clinic", { clinicId, runLabel: "m1" }))) as { skipped: string };
      expect(out.skipped).toContain(status);
      expect((await db()`select status::text from clinics where id=${clinicId}`)[0].status).toBe(status);
    }
  });

  it("an audit in flight does not overwrite a clinic that unsubscribed meanwhile", async () => {
    const sql = db();
    const { sectorId, cityId } = await ids();
    const clinicId = await clinicWithContact();
    const [qs] = await sql<{ id: number }[]>`select id from question_sets where sector_id=${sectorId} and active`;
    const [run] = await sql<{ id: string }[]>`
      insert into test_runs (sector_id, city_id, question_set_id, assistant, model, run_label, finished_at)
      values (${sectorId}, ${cityId}, ${qs.id}, 'Claude', 'claude-opus-5-5', 'm1', now()) returning id`;
    await sql`insert into test_answers (test_run_id, question_index, question, answer_text) values (${run.id}, 0, 'Q1 in Barrie?', 'An answer.')`;
    mocks.readSite.mockResolvedValue(SITE());
    const empty = {
      site_name: null, address: null, phone: null, questions: [],
      new_patients: { status: "not_stated", quote: "", url: "" },
      hours: { blocks: [], conflict: { exists: false, a: null, b: null, explanation: "" } },
      fees: { published: false, quotes: [] },
      insurance: { stated: false, direct_billing: "not_stated", quotes: [] },
      practitioners: { named: false, with_credentials: false, quotes: [] },
      languages: { stated: false, quotes: [] },
      areas_served: { stated: false, quotes: [] },
      outdated: [],
    };
    // the clinic unsubscribes while the (slow) reading of its site is running
    mocks.structured.mockImplementation(async () => {
      await sql`update clinics set status='suppressed', status_reason='unsubscribed' where id=${clinicId}`;
      return { data: empty, usage: USAGE, costUsd: 0.01, model: "claude-opus-5-5" };
    });
    const ctx = fakeCtx("audit_clinic", { clinicId, runLabel: "m1" });
    const out = (await handleAudit(ctx)) as { skipped?: string };
    expect(out.skipped).toMatch(/during the audit/);
    const [c] = await sql`select status::text, status_reason from clinics where id=${clinicId}`;
    expect(c).toEqual({ status: "suppressed", status_reason: "unsubscribed" });
    expect((await sql`select count(*)::int as n from audits`)[0].n).toBe(0);
    expect(ctx.enqueued).toEqual([]);

    // control: the same audit on a clinic that did not change is stored and scored
    const other = await makeClinic({ name: "Other Dental", website: "https://maplegrove.example/", domain: "other.example", status: "contact_found" });
    mocks.structured.mockResolvedValue({ data: empty, usage: USAGE, costUsd: 0.01, model: "claude-opus-5-5" });
    const ctx2 = fakeCtx("audit_clinic", { clinicId: other, runLabel: "m1" });
    await handleAudit(ctx2);
    expect((await sql`select status::text from clinics where id=${other}`)[0].status).toBe("audited");
    expect(ctx2.enqueued).toContain("score_clinic");
  });
});

// ---------------------------------------------------------------------------
describe("discovery does not duplicate a clinic we already know by its website", () => {
  const place = (id: string, site: string) => ({ id, displayName: { text: "Some Dental" }, websiteUri: site, businessStatus: "OPERATIONAL", formattedAddress: "1 Main St, Barrie, ON" });

  it("skips a place whose domain belongs to another clinic row and counts it as existing", async () => {
    const { sectorId, cityId } = await ids();
    const seeded = await makeClinic({ name: "Adental Office", website: "https://seeded.example/", domain: "seeded.example", source: "seed", status: "contacted" });
    mocks.textSearch.mockResolvedValue({
      requests: 1,
      places: [place("p-seed", "https://www.seeded.example/"), place("p-new", "https://fresh.example/")],
    });
    const first = (await handleDiscover(fakeCtx("discover", { sectorId, cityId }))) as { added: number; existing: number };
    expect(first).toMatchObject({ found: 2, added: 1, existing: 1 });
    const sql = db();
    expect((await sql`select count(*)::int as n from clinics where domain='seeded.example'`)[0].n).toBe(1);
    expect((await sql`select place_id, status::text from clinics where id=${seeded}`)[0]).toEqual({ place_id: null, status: "contacted" });
    expect((await sql`select count(*)::int as n from jobs where kind='find_contact'`)[0].n).toBe(1);

    // running discovery again adds nothing and queues nothing
    const again = (await handleDiscover(fakeCtx("discover", { sectorId, cityId }))) as { added: number; existing: number };
    expect(again).toMatchObject({ added: 0, existing: 2 });
    expect((await sql`select count(*)::int as n from clinics`)[0].n).toBe(2);
    expect((await sql`select count(*)::int as n from jobs where kind='find_contact'`)[0].n).toBe(1);

    // the same practice listed under a second place_id (or found for another sector) is not added either
    mocks.textSearch.mockResolvedValue({ requests: 1, places: [place("p-new-second-listing", "https://fresh.example/")] });
    const [family] = await sql<{ id: number }[]>`select id from sectors where slug='family'`;
    const third = (await handleDiscover(fakeCtx("discover", { sectorId: family.id, cityId }))) as { added: number; existing: number };
    expect(third).toMatchObject({ added: 0, existing: 1 });
    expect((await sql`select count(*)::int as n from clinics where domain='fresh.example'`)[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("contact step", () => {
  it("leaves exactly one primary contact when the site's addresses change", async () => {
    const sql = db();
    const clinicId = await makeClinic({ website: "https://maplegrove.example/", domain: "maplegrove.example", status: "discovered", source: "seed" });
    // an older run made a different address primary
    await sql`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${clinicId}, 'old@maplegrove.example', 'https://maplegrove.example/old', true, true)`;
    mocks.readSite.mockResolvedValue(SITE());
    const out = (await handleFindContact(fakeCtx("find_contact", { clinicId }))) as { contact: string };
    const primaries = await sql<{ email: string }[]>`select email from contacts where clinic_id=${clinicId} and is_primary`;
    expect(primaries).toEqual([{ email: out.contact }]);
    expect(out.contact).not.toBe("old@maplegrove.example");
    // and the database itself refuses a second primary
    await expect(sql`update contacts set is_primary=true where clinic_id=${clinicId}`).rejects.toThrow(/contacts_one_primary_idx/);
  });

  it("self-serve: an on-domain address is accepted without being published, as the only primary", async () => {
    const sql = db();
    const clinicId = await makeClinic({ website: "https://maplegrove.example/", domain: "maplegrove.example", status: "discovered", source: "self_serve" });
    await sql`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${clinicId}, 'info@maplegrove.example', 'https://maplegrove.example/', true, true)`;
    await sql`insert into self_serve_requests (website, email, status, clinic_id) values ('https://maplegrove.example/', 'owner@maplegrove.example', 'received', ${clinicId})`;
    mocks.readSite.mockResolvedValue(SITE());
    const out = (await handleFindContact(fakeCtx("find_contact", { clinicId }))) as { contact: string };
    expect(out.contact).toBe("owner@maplegrove.example");
    expect(await sql`select email from contacts where clinic_id=${clinicId} and is_primary`).toEqual([{ email: "owner@maplegrove.example" }]);
  });

  it("self-serve: a no-solicitation notice on the site is honoured like on the normal path", async () => {
    const sql = db();
    const clinicId = await makeClinic({ website: "https://maplegrove.example/", domain: "maplegrove.example", status: "discovered", source: "self_serve" });
    await sql`insert into self_serve_requests (website, email, status, clinic_id) values ('https://maplegrove.example/', 'info@maplegrove.example', 'received', ${clinicId})`;
    mocks.readSite.mockResolvedValue(siteFrom({ "https://maplegrove.example/": HOME.replace("<footer>", "<p>No soliciting. We do not accept unsolicited offers.</p><footer>") }));
    const ctx = fakeCtx("find_contact", { clinicId });
    const out = (await handleFindContact(ctx)) as { doNotContact?: unknown };
    expect(out.doNotContact).toBeTruthy();
    expect((await sql`select status::text from clinics where id=${clinicId}`)[0].status).toBe("do_not_contact");
    expect((await sql`select count(*)::int as n from contacts`)[0].n).toBe(0);
    expect((await sql`select kind::text, value from suppressions`)[0]).toEqual({ kind: "domain", value: "maplegrove.example" });
    expect((await sql`select status from self_serve_requests`)[0].status).toBe("rejected");
    expect(ctx.enqueued).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("directory check: a quote must come from the clinic's own listing", () => {
  const opts = {
    clinicName: "Maple Grove Dental", siteName: "Maple Grove Dental", sitePhone: "705-555-0100", siteAddress: "12 Maple Street, Barrie, ON L4M 1A1",
    domain: "maplegrove.example", city: "Barrie",
    directoryUrls: ["https://www.yelp.ca/biz/maple-grove-dental-barrie", "https://www.ratemds.com/best-dentists/on/barrie/"],
  };
  const fetched = (text: string, docs: { url: string; text: string }[], incomplete?: string) => ({
    text, docs: docs.map((d) => ({ ...d, title: null })), usage: USAGE, costUsd: 0.03, incomplete,
  });
  const json = (rows: unknown[]) => "```json\n" + JSON.stringify(rows) + "\n```";

  it("another business's listing on a fetched page is not a name mismatch", async () => {
    // the model attributes a quote that exists only on the OTHER page, about another business
    mocks.readWithWebFetch.mockResolvedValue(
      fetched(json([{ url: opts.directoryUrls[0], name_quote: "Lakeshore Dental Studio", address_quote: null, phone_quote: null }]), [
        { url: opts.directoryUrls[0], text: "Maple Grove Dental. 12 Maple Street, Barrie. (705) 555-0100. maplegrove.example" },
        { url: opts.directoryUrls[1], text: "Top dentists in Barrie: Lakeshore Dental Studio, 40 Bay St, (705) 555-0199" },
      ]),
    );
    const r = await checkDirectories(opts);
    expect(r.outcome).toMatchObject({ result: "could_not_verify", isGap: false });
    expect(r.costUsd).toBe(0.03);
  });

  it("a listing on the right page that is not tied to this clinic is not a finding", async () => {
    // a list page: the quoted name is on the page the model names, but it is another business; ours is not there
    mocks.readWithWebFetch.mockResolvedValue(
      fetched(json([{ url: opts.directoryUrls[1], name_quote: "Lakeshore Dental Studio", address_quote: "40 Bay St", phone_quote: "(705) 555-0199" }]), [
        { url: opts.directoryUrls[1], text: "Top dentists in Barrie: Lakeshore Dental Studio, 40 Bay St, (705) 555-0199" },
      ]),
    );
    expect((await checkDirectories(opts)).outcome.result).toBe("could_not_verify");
  });

  it("a real difference on the clinic's own listing is still reported", async () => {
    mocks.readWithWebFetch.mockResolvedValue(
      fetched(json([{ url: "https://yelp.ca/biz/maple-grove-dental-barrie/", name_quote: "Maple Grove Dental", address_quote: "12 Maple Street", phone_quote: "(705) 555-0142" }]), [
        { url: opts.directoryUrls[0], text: "Maple Grove Dental\n12 Maple Street, Barrie\n(705) 555-0142\nWebsite: maplegrove.example" },
      ]),
    );
    const r = await checkDirectories(opts);
    expect(r.outcome).toMatchObject({ result: "found", isGap: true, severity: 85 });
    expect(r.outcome.findingText).toContain("(705) 555-0142");
    expect(r.outcome.findingText).toContain("705-555-0100");
  });

  it("a refused or cut-off reading is could-not-verify, and its cost is kept", async () => {
    mocks.readWithWebFetch.mockResolvedValue(fetched("", [], "refusal"));
    const r = await checkDirectories(opts);
    expect(r.outcome).toMatchObject({ result: "could_not_verify", isGap: false });
    expect(r.usage).toEqual(USAGE);
  });

  it("ties a listing to the clinic by domain or phone near the name, not anywhere on a long page", () => {
    expect(sameDocUrl("https://www.yelp.ca/biz/x/", "http://yelp.ca/biz/x#reviews")).toBe(true);
    expect(sameDocUrl("https://www.yelp.ca/biz/x", "https://www.yelp.ca/biz/y")).toBe(false);
    const far = "Lakeshore Dental Studio, 40 Bay St. " + "Another listing. ".repeat(200) + "Maple Grove Dental maplegrove.example";
    expect(listingIsClinics(far, "Lakeshore Dental Studio", "maplegrove.example", null)).toBe(false);
    expect(listingIsClinics(far, "Maple Grove Dental", "maplegrove.example", null)).toBe(true);
    expect(listingIsClinics("Maple Grove Dental, call 1 (705) 555-0100", "Maple Grove Dental", "maplegrove.example", "705.555.0100")).toBe(true);
    expect(listingIsClinics("Maple Grove Dental, visit notmaplegrove.example", "Maple Grove Dental", "maplegrove.example", null)).toBe(false);
  });
});
