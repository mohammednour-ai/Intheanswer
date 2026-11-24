import crypto from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/reports/pdf", async (orig) => ({
  ...(await orig<typeof import("@/lib/reports/pdf")>()),
  htmlToPdf: async (html: string) => Buffer.from(`%PDF-fake ${html.length}`),
}));

const fits = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/letters/measure", () => ({ letterFits: async () => fits.value }));

import { closeDb, db } from "@/lib/db";
import { resetEnvForTests } from "@/lib/env";
import { sampleTeaser } from "@/lib/reports/sample";
import { randomToken } from "@/lib/tokens";
import { stopClinic } from "@/lib/calls/rules";
import { buildLetter, checkLetter, letterText, newLetterCode, renderLetterHtml, LETTER_CODE_RE } from "@/lib/letters/content";
import { FakeMail, decodeWebhook, setMailProvider } from "@/lib/letters/provider";
import {
  applyMailEvent, approveLetter, letterForStop, letterVisit, postLetter, prepareLetters, rejectLetter, sendTestCopy,
} from "@/lib/letters/letters";
import { runWorkerOnce } from "@/lib/jobs/worker";
import "@/lib/letters/jobs";
import { makeClinic, makeMessage, resetData } from "./helpers";
import type { TeaserData } from "@/lib/reports/types";

const OWNER = { OWNER_NAME: "Sam Owner", OWNER_TITLE: "Founder", OWNER_BUSINESS_NAME: "In The Answer Inc.", OWNER_MAILING_ADDRESS: "1 Main St, Barrie ON L4M 1A1", OWNER_PHONE: "705-555-0100" };
const DAY = 86400e3;

function teaser(over: Partial<TeaserData> = {}): TeaserData & { verified: boolean } {
  return { ...sampleTeaser(), kind: "teaser", verified: true, clinic: { id: null, name: "Test Dental", city: "Barrie", website: "https://testdental.example", domain: "testdental.example" }, ...over };
}

let mail: FakeMail;

beforeEach(async () => {
  await resetData();
  Object.assign(process.env, OWNER, { POSTGRID_API_KEY: "", POSTGRID_WEBHOOK_SECRET: "" });
  resetEnvForTests();
  mail = new FakeMail();
  setMailProvider(mail);
  fits.value = true;
  await db()`update app_settings set letters_enabled = true where id`;
});

afterAll(async () => {
  setMailProvider(null);
  await closeDb();
});

/** A clinic emailed `daysAgo` days ago, with a verified teaser and its street address. */
async function emailedClinic(daysAgo = 15, over: Record<string, unknown> = {}) {
  const sql = db();
  const domain = (over.domain as string | undefined) ?? `${String(over.name ?? "Test Dental").toLowerCase().replace(/\W+/g, "")}.example`;
  const clinicId = await makeClinic({ status: "contacted", address: "411 Bayfield St Unit B12, Barrie, ON L4M 3C1", address_confirmed_on_site: true, domain, website: `https://${domain}`, ...over });
  const token = randomToken();
  const data = teaser();
  data.clinic.id = clinicId;
  const [r] = await sql<{ id: string }[]>`insert into reports (clinic_id, kind, token, data, html) values (${clinicId}, 'teaser', ${token}, ${sql.json(data as never)}, '<html></html>') returning id`;
  const messageId = await makeMessage({ clinic_id: clinicId, to_email: `info@${domain}`, status: "sent", dry_run: false, sent_at: new Date(Date.now() - daysAgo * DAY), report_id: r.id });
  return { clinicId, reportId: r.id, token, messageId };
}

const letters = () => db()<{ id: string; clinic_id: string; status: string; flags: { code: string }[]; live: boolean | null; cost_usd: string | null; provider_order_id: string | null; last_error: string | null; code: string; test_orders: unknown[]; reject_reason: string | null }[]>`select * from letters order by created_at`;

describe("the letter's wording", () => {
  const input = (d = teaser()) => ({ data: d, code: "abcdefghjk", emailedOn: "23 November 2026", phone: { display: "647-424-1480", code: "123456" }, date: "8 December 2026" });

  it("repeats the email's result, two findings, and the three ways in", () => {
    const l = buildLetter(input());
    const text = letterText(l);
    expect(l.headline).toMatch(/^Test Dental was (not )?recommended in/);
    expect(text).toContain("We emailed you about this on 23 November 2026");
    expect(l.findings).toHaveLength(2);
    expect(l.typedUrl).toBe("intheanswer.test/l/abcdefghjk");
    expect(l.qrUrl).toBe("https://intheanswer.test/l/abcdefghjk?s=qr");
    expect(l.phoneLine).toContain("give report code 123 456");
    expect(l.phoneLine).toContain("our AI assistant");
    expect(text).toContain("intheanswer.test/l/abcdefghjk/stop");
    expect(text).not.toMatch(/\$\s?\d/);
    expect(checkLetter(l, teaser(), "411 Bayfield St, Barrie ON L4M 3C1").filter((f) => f.severity === "block")).toEqual([]);
  });

  it("is held when the report is not verified, a price slips in, or the address is missing", () => {
    const d = teaser();
    d.findings[0] = { ...d.findings[0], text: "Fixing this costs $200 a month." };
    const l = buildLetter(input(d));
    const codes = (x: typeof l, dd: typeof d, a: string) => checkLetter(x, dd, a).map((f) => f.code);
    expect(codes(l, d, "411 Bayfield St")).toContain("letter_price");
    expect(codes(buildLetter(input()), { ...teaser(), verified: false }, "411 Bayfield St")).toContain("letter_unverified");
    expect(codes(buildLetter(input()), teaser(), "Barrie, ON")).toContain("letter_no_address");
  });

  it("leaves the address window empty and carries the QR code", async () => {
    const l = buildLetter(input());
    const html = await renderLetterHtml(l, "8 December 2026");
    expect(html).toContain("<svg");
    expect(html).toContain("intheanswer.test/l/abcdefghjk");
    // the content starts below the address zone (0.75 in + 2.5 in) and the heading block sits right of it (1.375 in + 2.5 in)
    expect(html).toMatch(/\.body\{position:absolute;left:0\.75in;right:0\.75in;top:3\.4in/);
    expect(html).toMatch(/\.top\{position:absolute;left:4\.25in;top:0\.75in;right:0\.6in;height:2\.5in/);
  });

  it("codes are short, unguessable and free of look-alike characters", () => {
    const seen = new Set(Array.from({ length: 500 }, () => newLetterCode()));
    expect(seen.size).toBe(500);
    for (const c of seen) expect(c).toMatch(LETTER_CODE_RE);
  });
});

describe("which clinics get a letter", () => {
  it("a clinic emailed 14+ days ago with no response gets one letter, waiting for approval", async () => {
    const { clinicId } = await emailedClinic(15);
    expect(await prepareLetters()).toEqual({ prepared: 1, held: 0 });
    const [l] = await letters();
    expect(l.clinic_id).toBe(clinicId);
    expect(l.status).toBe("review");
    // never a second one
    expect(await prepareLetters()).toEqual({ prepared: 0, held: 0 });
  });

  it("a letter that does not fit on its page is held, never cut off", async () => {
    fits.value = false;
    await emailedClinic(15);
    expect(await prepareLetters()).toEqual({ prepared: 0, held: 1 });
    const [l] = await letters();
    expect(l.flags.map((f) => f.code)).toContain("letter_too_long");
    expect((await approveLetter(l.id)).ok).toBe(false);
  });

  it("nobody while letters are off", async () => {
    await emailedClinic(15);
    await db()`update app_settings set letters_enabled = false where id`;
    expect(await prepareLetters()).toEqual({ prepared: 0, held: 0 });
  });

  it("not too soon after the email, and not to a clinic without a street address", async () => {
    await emailedClinic(5);
    await emailedClinic(20, { address: null, address_confirmed_on_site: false, name: "No Address Dental" });
    expect(await prepareLetters()).toEqual({ prepared: 0, held: 0 });
  });

  it("not after any response: a reply, an opened report, a call, a purchase or an unsubscribe", async () => {
    const sql = db();
    const a = await emailedClinic(15);
    await sql`update messages set replied_at = now() where id = ${a.messageId}`;
    const b = await emailedClinic(15, { name: "Viewed Dental" });
    await sql`update reports set view_count = 1, first_viewed_at = now() where id = ${b.reportId}`;
    const c = await emailedClinic(15, { name: "Called Dental" });
    await sql`insert into calls (clinic_id, direction, phone, status, token) values (${c.clinicId}, 'inbound', '+17055550100', 'completed', ${randomToken()})`;
    const d = await emailedClinic(15, { name: "Bought Dental" });
    await sql`insert into orders (clinic_id, kind, status, customer_email) values (${d.clinicId}, 'one_time', 'paid', 'x@bought.example')`;
    await emailedClinic(15, { name: "Unsubscribed Dental" });
    await sql`insert into suppressions (kind, value, reason, source) values ('address', 'info@unsubscribeddental.example', 'unsubscribed', 'unsubscribe_link')`;
    expect(await prepareLetters()).toEqual({ prepared: 0, held: 0 });
    // and the control: an untouched clinic does get one
    await emailedClinic(15, { name: "Quiet Dental" });
    expect((await prepareLetters()).prepared).toBe(1);
  });

  it("a bounced email does not stop a letter: post is the way to reach that clinic", async () => {
    await emailedClinic(15);
    await db()`insert into suppressions (kind, value, reason, source) values ('address', 'info@testdental.example', 'bounced', 'bounce')`;
    expect((await prepareLetters()).prepared).toBe(1);
  });

  it("at most the day's number", async () => {
    await db()`update app_settings set letters_per_day = 2 where id`;
    for (let i = 0; i < 3; i++) await emailedClinic(15, { name: `Clinic ${i}`, domain: `c${i}.example`, website: `https://c${i}.example` });
    expect((await prepareLetters()).prepared).toBe(2);
    expect((await prepareLetters()).prepared).toBe(0);
  });
});

describe("approving and posting", () => {
  it("approval posts it through the worker, to the clinic's address, from ours", async () => {
    await emailedClinic(15);
    await prepareLetters();
    const [l] = await letters();
    expect(await approveLetter(l.id)).toEqual({ ok: true });
    await runWorkerOnce({ kinds: ["send_letter"] });
    const [after] = await letters();
    expect(after.status).toBe("sent");
    expect(after.live).toBe(false);
    expect(Number(after.cost_usd)).toBe(0);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].mailingClass).toBe("ca_post_lettermail");
    expect(mail.sent[0].idempotencyKey).toBe(`letter:${l.id}`);
    expect(mail.contacts.get(mail.sent[0].to)?.line).toContain("411 Bayfield St");
    expect(mail.contacts.get(mail.sent[0].from)?.line).toBe(OWNER.OWNER_MAILING_ADDRESS);
  });

  it("a live key while real mailing is off posts nothing", async () => {
    mail.live = true;
    await emailedClinic(15);
    await prepareLetters();
    const [l] = await letters();
    await approveLetter(l.id);
    await expect(postLetter(l.id)).rejects.toThrow(/real mailing is off/);
    expect(mail.sent).toHaveLength(0);
    expect((await letters())[0].status).toBe("failed");
  });

  it("with real mailing on, a live letter is costed and counts toward the monthly limit", async () => {
    mail.live = true;
    await db()`update app_settings set letters_live = true, letters_monthly_budget_usd = 3 where id`;
    await emailedClinic(15);
    await emailedClinic(15, { name: "Second Dental", domain: "second.example", website: "https://second.example" });
    await prepareLetters();
    const [a, b] = await letters();
    await approveLetter(a.id);
    await postLetter(a.id);
    expect(Number((await letters())[0].cost_usd)).toBeCloseTo(2.22);
    const r = await approveLetter(b.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/monthly limit/);
  });

  it("a clinic that replied since the letter was prepared is not posted to", async () => {
    const { messageId } = await emailedClinic(15);
    await prepareLetters();
    const [l] = await letters();
    await db()`update messages set replied_at = now() where id = ${messageId}`;
    const r = await approveLetter(l.id);
    expect(r.ok).toBe(false);
    expect((await letters())[0].status).toBe("cancelled");
  });

  it("an address Canada Post cannot find fails the letter instead of posting it", async () => {
    await emailedClinic(15, { address: "12 Undeliverable Road, Nowhere ON" });
    await prepareLetters();
    const [l] = await letters();
    await approveLetter(l.id);
    await expect(postLetter(l.id)).rejects.toThrow(/address check failed/);
    expect(mail.sent).toHaveLength(0);
  });

  it("a cancelled letter is never prepared again for that clinic", async () => {
    await emailedClinic(15);
    await prepareLetters();
    const [l] = await letters();
    await rejectLetter(l.id, "not this one");
    expect(await prepareLetters()).toEqual({ prepared: 0, held: 0 });
  });

  it("a copy goes to the owner's own address, at most three times", async () => {
    await emailedClinic(15);
    await prepareLetters();
    const [l] = await letters();
    for (let i = 0; i < 3; i++) expect((await sendTestCopy(l.id)).ok).toBe(true);
    expect((await sendTestCopy(l.id)).ok).toBe(false);
    expect(mail.sent).toHaveLength(3);
    expect(mail.contacts.get(mail.sent[0].to)?.line).toBe(OWNER.OWNER_MAILING_ADDRESS);
    expect((await letters())[0].status).toBe("review");
  });
});

describe("after posting", () => {
  async function posted() {
    const c = await emailedClinic(15);
    await prepareLetters();
    const [l] = await letters();
    await approveLetter(l.id);
    await postLetter(l.id);
    return { ...c, letter: (await letters())[0] };
  }

  it("the printed address counts a visit and opens the clinic's report", async () => {
    const { letter, token } = await posted();
    expect(await letterVisit(letter.code, true)).toEqual({ reportToken: token });
    const [l] = await db()<{ visit_count: number; first_visit_at: Date | null }[]>`select visit_count, first_visit_at from letters`;
    expect(l.visit_count).toBe(1);
    expect(l.first_visit_at).not.toBeNull();
    expect(await letterVisit("zzzzzzzzzz", true)).toBeNull();
  });

  it("the stop page closes the clinic to all contact", async () => {
    const { letter, clinicId } = await posted();
    const s = await letterForStop(letter.code);
    expect(s?.clinicId).toBe(clinicId);
    await stopClinic(clinicId, "asked on the stop page of our letter not to be contacted", "letter");
    const [c] = await db()<{ status: string }[]>`select status::text from clinics where id = ${clinicId}`;
    expect(c.status).toBe("suppressed");
    const sup = await db()`select 1 from suppressions where value = 'info@testdental.example'`;
    expect(sup.length).toBe(1);
  });

  it("PostGrid's signed status updates are applied; unsigned ones are refused", async () => {
    const { letter } = await posted();
    const secret = "whsec_test";
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const h = enc({ alg: "HS256", typ: "JWT" });
    const p = enc({ type: "letter.updated", data: { id: letter.provider_order_id, status: "completed" } });
    const sig = crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
    const ev = decodeWebhook(`${h}.${p}.${sig}`, secret);
    expect(ev?.data.status).toBe("completed");
    expect(decodeWebhook(`${h}.${p}.${sig}x`, secret)).toBeNull();
    expect(decodeWebhook(`${h}.${p}.${sig}`, "other")).toBeNull();
    expect(await applyMailEvent(letter.provider_order_id!, "completed")).toBe(true);
    const [l] = await db()<{ completed_at: Date | null; provider_status: string }[]>`select completed_at, provider_status from letters`;
    expect(l.provider_status).toBe("completed");
    expect(l.completed_at).not.toBeNull();
  });
});
