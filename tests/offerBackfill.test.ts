import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { sha256 } from "@/lib/tokens";
import { emailOfferLines } from "@/lib/offer";
import { sampleTeaser } from "@/lib/reports/sample";
import { renderTeaser } from "@/lib/reports/renderTeaser";
import { OFFER_MARKER } from "@/lib/reports/offerSection";
import { buildFirstEmail } from "@/lib/emails/firstEmail";
import { backfillReport, parseBackfillArgs, runOfferBackfill } from "@/lib/reports/offerBackfill";
import type { TeaserData } from "@/lib/reports/types";
import { resetData, makeClinic } from "./helpers";

// SYNTHETIC data: invented clinics, with reports and emails as they were stored before the plans changed.

const SITE = "https://intheanswer.test";
const OLD_LINES = [
  "- Full report and fix files: 200 CAD, one time.",
  "- Monthly reports: 150 CAD for the first month, then 50 CAD a month. The same report, updated after a fresh retest each month.",
  "- Full service plan: 200 CAD a month. We renovate your site or take it over, install every fix and retest each month.",
];
const OLD = /\b150 CAD|Monthly reports|Full service plan/;

/** The cards as they were frozen into a stored report. */
const oldCards = (token: string) => `<section class="rp-band rp-plansec" aria-labelledby="plans-h"><div class="rp-wrap rp-stack">
  <h2 id="plans-h" class="rp-h2">Three ways to fix it</h2>
  <article class="rp-plan"><h3 class="rp-planname">Monthly reports</h3><p class="rp-price">150 CAD <small>first month</small></p><a class="rp-btn" href="${SITE}/buy/${token}/reports">Start monthly reports</a></article>
  <article class="rp-plan main"><h3 class="rp-planname">Full service plan</h3><p class="rp-price">200 CAD</p><a class="rp-btn" href="${SITE}/buy/${token}/monthly">Start the full service plan</a></article>
</div></section>`;

/** The email as the teaser job wrote it before the plans changed: the same text, with the old option lines. */
function oldBody(data: TeaserData, to: string, token: string): string {
  const lines = buildFirstEmail(data, { toEmail: to, sourceUrl: "https://maplegrove.example/contact", reportUrl: `${SITE}/r/${token}` }).bodyText.split("\n");
  const at = lines.indexOf("If you want it fixed:");
  lines.splice(at + 1, emailOfferLines().length, ...OLD_LINES);
  return lines.join("\n");
}

let n = 0;
/** One clinic with its stored teaser and, unless `status` is null, the email that carries it. */
async function seed(status: string | null, over: { body?: (b: string) => string; message?: Record<string, unknown>; report?: Record<string, unknown>; verified?: boolean } = {}) {
  const sql = db();
  const i = ++n;
  const token = `teaser-token-${String(i).padStart(7, "0")}`;
  const to = `info${i}@maplegrove.example`;
  const clinicId = await makeClinic({ name: `Maple Grove Dental ${i}`, domain: `maplegrove${i}.example`, website: `https://maplegrove${i}.example/`, status: "queued" });
  const { siteUrl: _siteUrl, ...sample } = sampleTeaser();
  void _siteUrl;
  // stored before 23 November 2026: checkout links and terms in the data, the cards in the page
  const data = {
    ...sample, kind: "teaser" as const,
    clinic: { id: clinicId, name: `Maple Grove Dental ${i}`, city: "Barrie", website: `https://maplegrove${i}.example/`, domain: `maplegrove${i}.example` },
    offers: { oneTimeUrl: `${SITE}/buy/${token}/report`, reportsUrl: `${SITE}/buy/${token}/reports`, monthlyUrl: `${SITE}/buy/${token}/monthly`, minTerm: "12 months", reportsMinTerm: "3 months" },
  };
  const html = renderTeaser(data).replace(OFFER_MARKER, oldCards(token));
  const [rep] = await sql<{ id: string }[]>`
    insert into reports ${sql({ clinic_id: clinicId, kind: "teaser", token, data: sql.json({ ...data, verified: over.verified ?? true } as never), html,
      pdf_path: `local:reports/${token}.pdf`, pdf_bytes: 9, ...over.report } as never)} returning id`;
  let messageId: string | null = null;
  if (status) {
    const body = (over.body ?? ((b: string) => b))(oldBody(data, to, token));
    const subject = buildFirstEmail(data, { toEmail: to, sourceUrl: "", reportUrl: "" }).subject;
    const [m] = await sql<{ id: string }[]>`
      insert into messages ${sql({
        clinic_id: clinicId, type: "first_email", status, to_email: to, contact_source_url: "https://maplegrove.example/contact", subject, body_text: body,
        report_id: rep.id, attach_pdf: true, claims: sql.json([{ id: "old-claim" }]), flags: sql.json([{ code: "kept", message: "a flag from the gate", severity: "warn" }]),
        gate_passed: true, requires_review: status !== "approved" && status !== "scheduled", review_reason: `reason for ${status}`, mode_at_creation: "REVIEW",
        content_hash: sha256(subject + "\n" + body), dry_run: false, ...over.message,
      } as never)} returning id`;
    messageId = m.id;
  }
  return { clinicId, reportId: rep.id, messageId: messageId!, token, to, data };
}

const KEPT = ["status", "scheduled_for", "expires_at", "requires_review", "review_reason", "flags", "gate_passed", "mode_at_creation", "dry_run", "sent_at", "attach_pdf", "updated_at", "to_email", "report_id"] as const;
const message = async (id: string) => (await db()`select *, status::text as status from messages where id=${id}`)[0];
/** A stored report; its page comes back without the stylesheet and fonts, so a failed check prints something readable. */
const report = async (id: string) => {
  const [r] = await db()<{ html: string; data: Record<string, unknown>; pdf_path: string | null; pdf_bytes: number | null }[]>`
    select html, data, pdf_path, pdf_bytes from reports where id=${id}`;
  return { ...r, html: r.html.replace(/<style>[\s\S]*?<\/style>/, "") };
};
const snapshot = async () => JSON.stringify([
  await db()`select id, subject, body_text, body_html, claims, content_hash, status::text, updated_at from messages order by id`,
  await db()`select id, html, data, pdf_path, pdf_bytes from reports order by id`,
  await db()`select count(*)::int as n from approval_log`,
]);

describe("offer backfill", () => {
  beforeEach(resetData);
  afterAll(closeDb);

  const printed: string[] = [];
  const deps = {
    pdf: async (html: string) => { printed.push(html.replace(/<style>[\s\S]*?<\/style>/, "")); return Buffer.from("%PDF-new"); },
    put: async (key: string) => `local:${key}`,
  };

  it("a dry run counts what it would do and writes nothing", async () => {
    const waiting = await seed("pending_review");
    await seed("scheduled", { message: { scheduled_for: new Date("2026-11-24T15:00:00Z") } });
    await seed("held");
    await seed("sent", { message: { sent_at: new Date("2026-11-20T15:00:00Z") } });
    await seed("draft", { verified: false });
    await seed(null, { report: { superseded: true } });
    await db()`insert into messages (clinic_id, type, status, to_email, subject, body_text)
               values (${waiting.clinicId}, 'interested_reply', 'pending_review', ${waiting.to}, 'Re: your report', 'Monthly reports, 150 CAD for the first month')`;
    const before = await snapshot();

    const r = await runOfferBackfill({ dry: true, ...deps });
    expect(await snapshot()).toBe(before);
    expect(printed).toEqual([]);
    expect(r.teasers).toEqual({ total: 5, rendered: 5, current: 0, failed: [] }); // the superseded one is not in use
    expect(r.emails.total).toBe(3);
    expect(r.emails.byStatus).toEqual({ pending_review: 1, scheduled: 1, held: 1 });
    expect(r.emails.rebuilt).toHaveLength(3);
    expect(r.emails.current).toBe(0);
    expect(r.emails.left).toEqual({});
    expect(r.drafts).toBe(1);
    expect(r.otherMentions).toEqual({ interested_reply: 1 });
    const lines = backfillReport(r);
    expect(lines).toContain("Teaser reports in use: 5");
    expect(lines).toContain("  to render again, with the plan marker: 5");
    expect(lines).toContain("Unsent teaser emails: 3 (pending_review 1, scheduled 1, held 1)");
    expect(lines).toContain("  to rebuild, text and PDF: 3");
    expect(lines.join("\n")).toContain("Other unsent messages that name a retired plan or price (not changed; reword them in the portal): 1 (interested_reply 1)");
  });

  it("rebuilds every unsent teaser email and its PDF, keeps its status, schedule and review fields, and never touches a sent one", async () => {
    printed.length = 0;
    const expires = new Date("2026-11-29T15:00:00Z");
    const when = new Date("2026-11-24T15:00:00Z");
    const waiting = await seed("pending_review", { message: { expires_at: expires } });
    const scheduled = await seed("scheduled", { message: { scheduled_for: when } });
    const approved = await seed("approved");
    const held = await seed("held");
    const sent = await seed("sent", { message: { sent_at: new Date("2026-11-20T15:00:00Z") } });
    const replaced = await seed(null, { report: { superseded: true } });
    const was = Object.fromEntries(await Promise.all([waiting, scheduled, approved, held, sent].map(async (s) => [s.messageId, await message(s.messageId)])));
    const sentReport = await report(sent.reportId);

    const r = await runOfferBackfill({ dry: false, ...deps });
    expect(r.teasers).toMatchObject({ total: 5, rendered: 5, current: 0 });
    expect(r.emails.rebuilt.sort()).toEqual([waiting, scheduled, approved, held].map((s) => s.messageId).sort());
    expect(r.emails.left).toEqual({});

    for (const s of [waiting, scheduled, approved, held]) {
      const m = await message(s.messageId);
      const old = was[s.messageId];
      // the text: the published option lines, and nothing else changed
      expect(m.body_text).not.toMatch(OLD);
      expect(m.body_text).toContain(`If you want it fixed:\n${emailOfferLines().join("\n")}\n\nWhichever you choose`);
      expect(m.body_text.split("\n").filter((l: string) => !l.startsWith("- "))).toEqual(old.body_text.split("\n").filter((l: string) => !l.startsWith("- ")));
      expect(m.subject).toBe(old.subject);
      // what the job stores with the text
      expect(m.content_hash).toBe(sha256(m.subject + "\n" + m.body_text));
      expect(m.claims.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(["email-result", "email-finding-0", "email-finding-1"]));
      expect(m.claims.some((c: { id: string }) => c.id === "old-claim")).toBe(false);
      // everything that decides whether and when it is sent is exactly as it was
      for (const k of KEPT) expect(m[k], `${old.status}: ${k}`).toEqual(old[k]);
      // the report it carries: the page holds the marker, and the PDF was rendered with the plans written in
      const rep = await report(s.reportId);
      expect(rep.html).toContain(OFFER_MARKER);
      expect(rep.html).not.toMatch(OLD);
      expect(rep.html).toContain(`href="${SITE}/"`);
      expect(rep.pdf_path).toBe(`local:reports/${s.token}.pdf`);
      expect(rep.pdf_bytes).toBe(8);
      expect(rep.data.verified).toBe(true);
      const pdfHtml = printed.find((h) => h.includes(`${SITE}/buy/${s.token}/growth`))!;
      expect(pdfHtml).toContain("450 CAD");
      expect(pdfHtml).toContain(`${SITE}/buy/${s.token}/transformation`);
      expect(pdfHtml).not.toContain(OFFER_MARKER);
      expect(pdfHtml).not.toMatch(OLD);
      // what it replaced is kept, so the change can be read back
      const [log] = await db()`select action, actor_email, before, after from approval_log where message_id=${s.messageId}`;
      expect(log).toMatchObject({ action: "edit", actor_email: "system: offer backfill" });
      expect(log.before.body_text).toBe(old.body_text);
      expect(log.after.body_text).toBe(m.body_text);
    }
    expect(printed).toHaveLength(4);
    expect((await message(waiting.messageId)).expires_at).toEqual(expires);
    expect((await message(scheduled.messageId)).scheduled_for).toEqual(when);

    // the sent email is as it was sent, with the PDF that went with it; its page is rendered again like every report in use
    expect(await message(sent.messageId)).toEqual(was[sent.messageId]);
    const after = await report(sent.reportId);
    expect(after.pdf_path).toBe(sentReport.pdf_path);
    expect(after.pdf_bytes).toBe(9);
    expect(after.data).toEqual(sentReport.data);
    expect(after.html).toContain(OFFER_MARKER);
    expect(after.html).not.toMatch(OLD);
    // a replaced report with no email waiting is left alone (its old cards are swapped when it is opened)
    expect((await report(replaced.reportId)).html).toMatch(OLD);

    // run again: nothing left to do
    const before = await snapshot();
    printed.length = 0;
    const again = await runOfferBackfill({ dry: false, ...deps });
    expect(again.teasers).toMatchObject({ total: 5, rendered: 0, current: 5 });
    expect(again.emails).toMatchObject({ total: 4, rebuilt: [], current: 4, left: {} });
    expect(printed).toEqual([]);
    expect(await snapshot()).toBe(before);
  });

  it("leaves an email alone when more than the option lines would change, when the owner edited it, or when it was not written in this environment", async () => {
    printed.length = 0;
    const sql = db();
    const plain = await seed("pending_review");
    const reworded = await seed("held", { body: (b) => b.replace(/^Hello .* team,$/m, "Hi there,") });
    const edited = await seed("approved", { body: (b) => b.replace("Two things we noticed", "As promised on the phone, two things we noticed") });
    await sql`insert into approval_log (message_id, action, actor_user_id, actor_email) values (${edited.messageId}, 'edit', '00000000-0000-0000-0000-000000000001', 'owner@intheanswer.test')`;
    const elsewhere = await seed("pending_review", { body: (b) => b.replace(`${SITE}/r/`, "https://staging.intheanswer.test/r/") });
    const unverified = await seed("held", { verified: false });
    // a report whose stored data is of a shape the current templates cannot read: left alone, and the run goes on
    const ancient = await seed("pending_review");
    await sql`update reports set data = ${sql.json({ verified: true, kind: "teaser" })} where id=${ancient.reportId}`;
    const was = Object.fromEntries(await Promise.all([reworded, edited, elsewhere, unverified, ancient].map(async (s) => [s.messageId, await message(s.messageId)])));

    const r = await runOfferBackfill({ dry: false, ...deps });
    expect(r.emails.rebuilt).toEqual([plain.messageId]);
    expect(r.emails.left).toEqual({ other_lines: [reworded.messageId], edited: [edited.messageId], links: [elsewhere.messageId], no_report: [unverified.messageId], unreadable: [ancient.messageId] });
    expect(r.teasers).toMatchObject({ total: 6, rendered: 5, failed: [ancient.reportId] });
    expect((await report(ancient.reportId)).html).toMatch(OLD);
    expect(r.emails.samples).toEqual([{ id: reworded.messageId, was: "Hi there,", now: `Hello ${reworded.data.clinic.name} team,` }]);
    for (const s of [reworded, edited, elsewhere, unverified, ancient]) expect(await message(s.messageId)).toEqual(was[s.messageId]);
    expect(printed).toHaveLength(1);
    const lines = backfillReport(r).join("\n");
    expect(lines).toContain("other lines would change too (run with --all to rebuild these): 1");
    expect(lines).toContain("edited by the owner (never rebuilt): 1");

    // --all: the reworded one is brought up to date as well, still held; the owner's edit and the foreign link stay
    const all = await runOfferBackfill({ dry: false, all: true, ...deps });
    expect(all.emails.rebuilt).toEqual([reworded.messageId]);
    expect(all.emails.rebuiltOtherLines).toBe(1);
    expect(all.emails.current).toBe(1);
    expect(all.emails.left).toEqual({ edited: [edited.messageId], links: [elsewhere.messageId], no_report: [unverified.messageId], unreadable: [ancient.messageId] });
    const m = await message(reworded.messageId);
    expect(m.body_text).toContain(`Hello ${reworded.data.clinic.name} team,`);
    expect(m.body_text).not.toMatch(OLD);
    expect(m.status).toBe("held");
    expect(m.review_reason).toBe("reason for held");
    expect(await message(edited.messageId)).toEqual(was[edited.messageId]);
    expect(await message(elsewhere.messageId)).toEqual(was[elsewhere.messageId]);
  });

  it("the script refuses an argument it does not know, so a mistyped --dry never becomes a run that writes", () => {
    expect(parseBackfillArgs([])).toEqual({ dry: false, all: false });
    expect(parseBackfillArgs(["--dry"])).toEqual({ dry: true, all: false });
    expect(parseBackfillArgs(["--dry-run", "--all"])).toEqual({ dry: true, all: true });
    expect(parseBackfillArgs(["--limit", "5", "--dry"])).toEqual({ dry: true, all: false, limit: 5 });
    expect(parseBackfillArgs(["--limit", "0"])).toEqual({ dry: false, all: false, limit: 0 });
    for (const bad of [["--nope"], ["-dry"], ["--dryrun"], ["dry"], ["--dry", "extra"], ["--limit"], ["--limit", "--dry"], ["--limit", "-1"], ["--limit", "2.5"], ["--Dry"]]) {
      expect(() => parseBackfillArgs(bad), bad.join(" ")).toThrow(/usage:/);
    }
  });

  it("changes the email and its PDF together or not at all, and stops at the limit", async () => {
    const a = await seed("pending_review");
    const b = await seed("pending_review");
    const c = await seed("pending_review");
    const wasA = await message(a.messageId);
    // the PDF cannot be rendered: the text is not changed either
    const failed = await runOfferBackfill({ dry: false, limit: 1, pdf: async (html) => { if (html.includes(a.token)) throw new Error("no browser"); return Buffer.from("%PDF-new"); }, put: deps.put });
    expect(failed.emails.left).toEqual({ pdf_failed: [a.messageId], limit: [c.messageId] });
    expect(failed.emails.rebuilt).toEqual([b.messageId]);
    expect(await message(a.messageId)).toEqual(wasA);
    expect((await report(a.reportId)).pdf_bytes).toBe(9);
    // the next run picks up what is left
    const rest = await runOfferBackfill({ dry: false, ...deps });
    expect(rest.emails.rebuilt.sort()).toEqual([a.messageId, c.messageId].sort());
    expect(rest.emails.current).toBe(1);
  });
});
