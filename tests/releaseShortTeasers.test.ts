import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// the job renders the PDF itself: no browser in tests
vi.mock("@/lib/reports/pdf", async (orig) => ({
  ...(await orig<typeof import("@/lib/reports/pdf")>()),
  htmlToPdf: async (html: string) => Buffer.from(`%PDF-fake ${html.length}`),
}));
import { db, closeDb } from "@/lib/db";
import { sha256 } from "@/lib/tokens";
import { sampleTeaser } from "@/lib/reports/sample";
import { renderTeaser } from "@/lib/reports/renderTeaser";
import { buildFirstEmail } from "@/lib/emails/firstEmail";
import { HELD_FOR_TWO, releaseReport, releaseShortTeasers } from "@/lib/pipeline/releaseShortTeasers";
import { enqueue } from "@/lib/jobs/queue";
import { runWorkerOnce } from "@/lib/jobs/worker";
import { resetData, makeClinic } from "./helpers";
import { HOME } from "./fixtures/site";

// SYNTHETIC data: invented clinics whose first email was held because only two findings survived verification.

const SITE = "https://intheanswer.test";
let n = 0;

/** A held first email, written before 28 November: two findings, but the old "three" wording. */
async function seed(over: { reason?: string; clinic?: Record<string, unknown>; findings?: number; dry?: boolean } = {}) {
  const sql = db();
  const i = ++n;
  const token = `short-token-${String(i).padStart(8, "0")}`;
  const to = `info${i}@birch.example`;
  const domain = `birch${i}.example`;
  const clinicId = await makeClinic({ name: `Birch Dental ${i}`, domain, website: `https://${domain}/`, status: "held", ...over.clinic });
  const { siteUrl: _s, ...sample } = sampleTeaser();
  void _s;
  const data = {
    ...sample,
    clinic: { id: clinicId, name: `Birch Dental ${i}`, city: "Barrie", website: `https://${domain}/`, domain },
    findings: sample.findings.slice(0, over.findings ?? 2),
  };
  expect(data.summary[1]).toMatch(/The three most concrete are below\.$/);
  const [rep] = await sql<{ id: string }[]>`
    insert into reports (clinic_id, kind, token, data, html, pdf_path, pdf_bytes)
    values (${clinicId}, 'teaser', ${token}, ${sql.json({ ...data, verified: true } as never)}, ${renderTeaser(data)}, ${`local:reports/${token}.pdf`}, 9)
    returning id`;
  const old = buildFirstEmail({ ...data, findings: sample.findings.slice(0, 3) }, { toEmail: to, sourceUrl: `https://${domain}/contact`, reportUrl: `${SITE}/r/${token}` });
  const [m] = await sql<{ id: string }[]>`
    insert into messages ${sql({
      clinic_id: clinicId, type: "first_email", status: "held", to_email: to, contact_source_url: `https://${domain}/contact`,
      subject: old.subject, body_text: old.bodyText, report_id: rep.id, attach_pdf: true, claims: sql.json([]), flags: sql.json([]),
      gate_passed: false, requires_review: true, review_reason: over.reason ?? HELD_FOR_TWO, mode_at_creation: "AUTO",
      content_hash: sha256(old.subject + "\n" + old.bodyText), dry_run: over.dry ?? false,
    } as never)} returning id`;
  await sql`update clinics set status_reason=${over.reason ?? HELD_FOR_TWO} where id=${clinicId}`;
  return { clinicId, reportId: rep.id, messageId: m.id, token, domain };
}

const deps = { pdf: async () => Buffer.from("%PDF-new"), put: async (key: string) => `local:${key}` };
const msg = async (id: string) => (await db()`select *, status::text as status from messages where id=${id}`)[0];

describe("releasing first emails held for two findings", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  it("rebuilds them for two findings, approves them and hands them to the send job", async () => {
    const s = await seed();
    expect((await msg(s.messageId)).body_text).toContain("and a third finding");

    const r = await releaseShortTeasers({ dry: false, ...deps });
    expect(r.released).toEqual([s.messageId]);

    const m = await msg(s.messageId);
    expect(m.status).toBe("approved");
    expect(m.requires_review).toBe(false);
    expect(m.review_reason).toBeNull();
    expect(m.gate_passed).toBe(true);
    expect(m.body_text).toContain("The free report has every question and who was named:");
    expect(m.body_text).not.toMatch(/third finding/);
    expect(m.content_hash).toBe(sha256(m.subject + "\n" + m.body_text));

    const [rep] = await db()<{ data: { summary: string[] }; html: string; pdf_path: string }[]>`select data, html, pdf_path from reports where id=${s.reportId}`;
    expect(rep.data.summary[1]).toMatch(/The two most concrete are below\.$/);
    expect(rep.html).toContain("Two things we found on your website");
    expect(rep.pdf_path).toBe(`local:reports/${s.token}.pdf`);

    const [c] = await db()<{ status: string; status_reason: string | null }[]>`select status::text, status_reason from clinics where id=${s.clinicId}`;
    expect(c).toEqual({ status: "queued", status_reason: null });
    const log = await db()`select action, actor_email from approval_log where message_id=${s.messageId}`;
    expect(log).toEqual([{ action: "approve", actor_email: "system: two-finding release (owner approved 2026-11-28)" }]);
    const jobs = await db()`select kind, status from jobs where idempotency_key=${`send:${s.messageId}`}`;
    expect(jobs).toEqual([{ kind: "send_message", status: "queued" }]);

    // a second run finds nothing
    const again = await releaseShortTeasers({ dry: false, ...deps });
    expect(again.total).toBe(0);
  });

  it("as a production job: releases a batch, and queues the next batch only when one was full", async () => {
    const s = await seed();
    await enqueue("release_short_teasers", "release_short_teasers:1", { round: 1 });
    await runWorkerOnce({ kinds: ["release_short_teasers"] });
    expect((await msg(s.messageId)).status).toBe("approved");
    const [job] = await db()<{ status: string; result: { released: number } }[]>`select status::text, result from jobs where kind='release_short_teasers'`;
    expect(job.status).toBe("done");
    expect(job.result.released).toBe(1);
    expect(await db()`select 1 from jobs where kind='release_short_teasers'`).toHaveLength(1); // a batch of 1 < 10: no next round
  });

  it("a dry run counts and writes nothing", async () => {
    const s = await seed();
    const before = JSON.stringify(await msg(s.messageId));
    const r = await releaseShortTeasers({ dry: true, ...deps });
    expect(r.released).toEqual([s.messageId]);
    expect(JSON.stringify(await msg(s.messageId))).toBe(before);
    expect(await db()`select 1 from jobs`).toHaveLength(0);
    expect(releaseReport(r)[1]).toContain("would be released: 1");
  });

  it("leaves alone emails held for any other reason, dry runs, and clinics no longer held", async () => {
    await seed({ reason: "verification gate: summary-1: the counts do not match; only 2 finding(s) survived verification" });
    await seed({ reason: "verification gate: only 1 finding(s) survived verification" });
    await seed({ dry: true });
    await seed({ clinic: { status: "suppressed" } });
    const r = await releaseShortTeasers({ dry: false, ...deps });
    expect(r.total).toBe(0);
    expect(await db()`select 1 from messages where status <> 'held'`).toHaveLength(0);
  });

  it("keeps one held when the sector check says it is not of its sector, with that reason", async () => {
    const [medspa] = await db()<{ id: number }[]>`select id from sectors where slug='medspa'`;
    const s = await seed({ clinic: { sector_id: medspa.id } });
    const physio = HOME.replace("<footer>", `<section>${"<p>Physiotherapy, chiropractic care, registered massage therapy and acupuncture for injury recovery and pelvic floor health.</p>".repeat(4)}</section><footer>`);
    await db()`insert into page_cache (url, domain, http_status, content_type, body) values (${`https://${s.domain}/`}, ${s.domain}, 200, 'text/html', ${physio})`;

    const r = await releaseShortTeasers({ dry: false, ...deps });
    expect(r.released).toEqual([]);
    expect(r.left.sector).toHaveLength(1);
    const m = await msg(s.messageId);
    expect(m.status).toBe("held");
    expect(m.review_reason).toMatch(/^verification gate: category check: not a medspa/);
    expect(await db()`select 1 from jobs`).toHaveLength(0);
  });
});
