import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, closeDb } from "@/lib/db";
import { resetEnvForTests } from "@/lib/env";
import { newCode, CODE_RE, ensureCode, resolveCode, revokeCode, visitSource, deviceType } from "@/lib/qr";
import { channelOpen, saveChannel, saveRouting, setKillSwitch, MIN_COOLDOWN_DAYS } from "@/lib/channels/settings";
import { route, splitArm, previewRouting, type RouteFacts } from "@/lib/channels/routing";
import { optOutClinic } from "@/lib/channels/optout";
import { CALL_CONSENT_TEXT, createCallRequest, createEmailConsent, dial, DialRefused, hasEmailConsent, validWindow, normalizePhone } from "@/lib/calls/consent";
import { renderActions } from "@/lib/teaserPage";
import { buildLetterData, gateLetter, renderLetter, letterText } from "@/lib/mail/letter";
import { approveBatch, buildLetterBatch, buildPostcardBatch, batchCost, followUpCandidates, markReturned, rejectBatch, sendBatch, applyProviderEvent, MailError } from "@/lib/mail/batches";
import { FakeProvider, setMailProvider, decodeWebhook } from "@/lib/mail/provider";
import { compare, funnel, type ClinicRow } from "@/lib/channels/report";
import { isSuppressed } from "@/lib/sending/suppression";
import { checkSend } from "@/lib/sending/rules";
import { getSettings } from "@/lib/settings";
import { unsubscribe } from "@/lib/unsubscribe";
import { torontoToUtc } from "@/lib/time";
import crypto from "node:crypto";
import { resetData } from "./helpers";
import { clinicWithTeaser, allSupported } from "./fixtures/teaser";

const OWNER = { OWNER_NAME: "Alex Example", OWNER_BUSINESS_NAME: "Example Business Inc", OWNER_MAILING_ADDRESS: "100 Example Street, Toronto, ON M5V 2T6", OWNER_PHONE: "416-555-0100" };
const saved: Record<string, string | undefined> = {};
let provider: FakeProvider;
const cityId = async () => (await db()<{ id: number }[]>`select id from cities where name='Barrie'`)[0].id;
const build = async (over: Record<string, unknown> = {}) => buildLetterBatch({ cityId: await cityId(), verifier: allSupported, renderPdf: false, testMode: false, ...over });
const goLive = () => db()`update app_settings set live_enabled=true, dry_run=false where id`;
async function fakePdfs(batchId: string) {
  // tests skip Chromium: give each piece a tiny stored "PDF"
  const { putFile } = await import("@/lib/storage");
  for (const p of await db()<{ id: string }[]>`select id from mail_pieces where batch_id=${batchId}`) {
    await db()`update mail_pieces set pdf_path=${await putFile(`mail/test/${p.id}.pdf`, Buffer.from("%PDF-test"), "application/pdf")} where id=${p.id}`;
  }
}

beforeAll(() => {
  for (const [k, v] of Object.entries(OWNER)) { saved[k] = process.env[k]; process.env[k] = v; }
  resetEnvForTests();
});
afterAll(async () => {
  for (const k of Object.keys(OWNER)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  resetEnvForTests();
  setMailProvider(null);
  await closeDb();
});
beforeEach(async () => {
  await resetData();
  provider = new FakeProvider();
  setMailProvider(provider);
});

describe("QR codes", () => {
  it("are random, at least 10 characters, never sequential, and unique", () => {
    const codes = new Set(Array.from({ length: 2000 }, newCode));
    expect(codes.size).toBe(2000);
    for (const c of codes) expect(c).toMatch(CODE_RE);
    expect([...codes][0].length).toBeGreaterThanOrEqual(10);
  });
  it("one live code per clinic, revocable, and a revoked or guessed code opens nothing", async () => {
    const { clinicId } = await clinicWithTeaser();
    const code = await ensureCode(clinicId);
    expect(await ensureCode(clinicId)).toBe(code);
    expect((await resolveCode(code))?.clinicId).toBe(clinicId);
    expect(await resolveCode("aaaaaaaaaaaa")).toBeNull();
    expect(await resolveCode("1")).toBeNull();
    await revokeCode(code, "owner@example.com");
    expect(await resolveCode(code)).toBeNull();
    expect(await ensureCode(clinicId)).not.toBe(code);
  });
  it("tells QR, typed and email visits apart, and the device type", () => {
    expect([visitSource("q"), visitSource("e"), visitSource(null)]).toEqual(["qr", "email", "typed"]);
    expect(deviceType("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile")).toBe("phone");
    expect(deviceType("Mozilla/5.0 (iPad; CPU OS 17_0)")).toBe("tablet");
    expect(deviceType("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("computer");
  });
});

describe("consent", () => {
  const good = { name: "Dana Lee", role: "Office manager", phone: "(705) 555-0142", date: "2026-11-16", start: "10:00", end: "12:00", consent: true, ip: "203.0.113.9", pageUrl: "https://intheanswer.test/r/x", sourceChannel: "letter" };
  it("both checkboxes are unticked by default and required", () => {
    const html = renderActions("abcdefghjkmn", "Maple Grove Dental", "q", {});
    const boxes = html.match(/<input type="checkbox"[^>]*>/g)!;
    expect(boxes).toHaveLength(2);
    for (const b of boxes) { expect(b).toContain("required"); expect(b).not.toContain("checked"); }
    expect(html).toContain(CALL_CONSENT_TEXT);
  });
  it("a call request without the ticked box is refused; with it, the exact wording and evidence are stored for 30 days", async () => {
    const { clinicId } = await clinicWithTeaser();
    expect((await createCallRequest({ ...good, clinicId, consent: false })).ok).toBe(false);
    const r = await createCallRequest({ ...good, clinicId });
    expect(r.ok).toBe(true);
    const [c] = await db()`select phone, consent_text, ip, page_url, (expires_at - consented_at) as life from call_consents`;
    expect(c).toMatchObject({ phone: "+17055550142", consent_text: CALL_CONSENT_TEXT, ip: "203.0.113.9", page_url: "https://intheanswer.test/r/x" });
    expect(String(c.life)).toMatch(/30 days/);
  });
  it("a call window outside Mon to Fri, 9:30 am to 5:00 pm is rejected", () => {
    const now = new Date("2026-11-13T15:00:00Z");
    expect(validWindow("2026-11-16", "10:00", "12:00", now)).toBeNull();
    expect(validWindow("2026-11-14", "10:00", "12:00", now)).toMatch(/Monday to Friday/); // Saturday
    expect(validWindow("2026-11-16", "09:00", "10:00", now)).toMatch(/9:30/);
    expect(validWindow("2026-11-16", "16:00", "17:30", now)).toMatch(/5:00/);
    expect(validWindow("2026-11-10", "10:00", "12:00", now)).toMatch(/passed/);
    expect(normalizePhone("123")).toBeNull();
  });
  it("the dial function enforces consent: revoked, expired, out of hours and opted out are all refused", async () => {
    const { clinicId } = await clinicWithTeaser();
    const r = await createCallRequest({ ...good, clinicId });
    if (!r.ok) throw new Error("setup");
    const inHours = torontoToUtc("2026-11-16", "10:30"), evening = torontoToUtc("2026-11-16", "18:00"), saturday = torontoToUtc("2026-11-14", "10:30");
    expect((await dial(r.id, inHours)).phone).toBe("+17055550142");
    await expect(dial(r.id, evening)).rejects.toThrow(/outside calling hours/);
    await expect(dial(r.id, saturday)).rejects.toThrow(DialRefused);
    await expect(dial(r.id, new Date(inHours.getTime() + 35 * 86400e3))).rejects.toThrow(/expired/);
    await db()`update call_consents set revoked_at=now()`;
    await expect(dial(r.id, inHours)).rejects.toThrow(/revoked/);
  });
  it("email consent must be ticked, and only then is there a basis to email that address", async () => {
    const { clinicId } = await clinicWithTeaser();
    const base = { clinicId, email: "owner@clinic.example", consentText: "I agree...", ip: "1.2.3.4", pageUrl: "u", sourceChannel: "letter" };
    expect((await createEmailConsent({ ...base, consent: false })).ok).toBe(false);
    expect(await hasEmailConsent(clinicId, "owner@clinic.example")).toBe(false);
    expect((await createEmailConsent({ ...base, consent: true })).ok).toBe(true);
    expect(await hasEmailConsent(clinicId, "Owner@Clinic.example")).toBe(true);
  });
});

describe("channel settings", () => {
  it("a disabled channel receives nothing, a paused one waits, and the kill switch stops all outbound", async () => {
    expect((await channelOpen("letter")).open).toBe(true);
    await saveChannel("letter", { on: false }, "owner@example.com");
    expect(await channelOpen("letter")).toMatchObject({ open: false, reason: expect.stringMatching(/switched off/) });
    await saveChannel("letter", { on: true, pause_until: "2099-01-01" }, "owner@example.com");
    expect((await channelOpen("letter")).reason).toMatch(/paused until 2099-01-01/);
    await saveChannel("letter", { pause_until: null }, "owner@example.com");
    await setKillSwitch(true, "owner@example.com");
    for (const ch of ["letter", "email", "call_me", "reply_consent"] as const) expect((await channelOpen(ch)).reason).toMatch(/kill switch/);
  });
  it("letters are locked to REVIEW, and invalid values are refused", async () => {
    expect((await saveChannel("letter", { mode: "AUTO" }, "o")).mode).toBe("REVIEW");
    await expect(saveChannel("email", { daily_cap: -1 }, "o")).rejects.toThrow(/daily cap/);
    await expect(saveRouting({ score_threshold: 5, split_on: false, split_letter_pct: 50, cooldown_days: MIN_COOLDOWN_DAYS - 1 }, "o")).rejects.toThrow(/at least 14/);
  });
  it("every change is logged with who and when", async () => {
    await saveChannel("email", { daily_cap: 12 }, "owner@example.com");
    await saveRouting({ score_threshold: 3, split_on: true, split_letter_pct: 40, cooldown_days: 21 }, "owner@example.com");
    const log = await db()`select scope, actor, before, after, at from settings_audit_log order by id`;
    expect(log.map((l) => l.scope)).toEqual(["channel:email", "routing"]);
    expect(log[0]).toMatchObject({ actor: "owner@example.com", before: { daily_cap: 40 }, after: { daily_cap: 12 } });
    expect(log[1].after).toMatchObject({ score_threshold: 3, cooldown_days: 21 });
    expect(log[0].at).toBeInstanceOf(Date);
  });
  it("cold email obeys the email channel switch", async () => {
    await db()`update app_settings set dns_verified=true where id`;
    await saveChannel("email", { on: false }, "o");
    const r = await checkSend({ id: "x", type: "first_email", to_email: "a@b.example", clinic_id: null }, await getSettings(), torontoToUtc("2026-11-10", "10:00"));
    expect(r).toMatchObject({ outcome: "defer", reason: expect.stringMatching(/switched off/) });
  });
});

describe("routing rules, in order", () => {
  const rules = { score_threshold: 5, split_on: false, split_letter_pct: 50, cooldown_days: 30 };
  const f = (o: Partial<RouteFacts> = {}): RouteFacts => ({ clinicId: "c1", name: "C", excluded: null, score: 3, hasEmail: true, hasAddress: true, engaged: false, history: [], mailPieces: 0, storedArm: null, ...o });
  const now = new Date("2026-11-13T12:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * 86400e3);
  it("1: chains, suppressed and opted-out clinics are excluded before anything else", () => {
    expect(route(f({ excluded: "opted out", score: 9 }), rules, now)).toMatchObject({ channel: "excluded", rule: 1 });
  });
  it("2: score at or above the threshold gets a letter first, below it email first", () => {
    expect(route(f({ score: 5 }), rules, now)).toMatchObject({ channel: "letter", rule: 2 });
    expect(route(f({ score: 4 }), rules, now)).toMatchObject({ channel: "email", rule: 2 });
  });
  it("3: no public email -> letter; no verified address -> email; neither -> skipped", () => {
    expect(route(f({ score: 1, hasEmail: false }), rules, now)).toMatchObject({ channel: "letter", rule: 3 });
    expect(route(f({ score: 9, hasAddress: false }), rules, now)).toMatchObject({ channel: "email", rule: 3 });
    expect(route(f({ hasEmail: false, hasAddress: false }), rules, now)).toMatchObject({ channel: "skipped", rule: 3 });
  });
  it("4: the test split ignores the score, is stable per clinic, and roughly follows the percentage", () => {
    const on = { ...rules, split_on: true };
    const r = route(f({ score: 9 }), on, now);
    expect(r.rule).toBe(4);
    expect(r.arm).toBe(splitArm("c1", 50));
    expect(route(f({ score: 0, storedArm: "letter" }), on, now)).toMatchObject({ channel: "letter", arm: "letter" });
    const letters = Array.from({ length: 1000 }, (_, i) => splitArm("clinic-" + i, 30)).filter((a) => a === "letter").length;
    expect(letters).toBeGreaterThan(240);
    expect(letters).toBeLessThan(360);
  });
  it("5: cool-down: no second channel inside the window; afterwards the other channel, once", () => {
    expect(route(f({ history: [{ channel: "letter", at: ago(10) }] }), rules, now)).toMatchObject({ channel: "wait", rule: 5 });
    expect(route(f({ history: [{ channel: "letter", at: ago(31) }] }), rules, now)).toMatchObject({ channel: "email", rule: 5 });
    expect(route(f({ history: [{ channel: "email", at: ago(40) }, { channel: "letter", at: ago(80) }] }), rules, now)).toMatchObject({ channel: "done" });
  });
  it("6: a clinic that engaged is never routed for cold contact; consent contact is not subject to the cool-down", async () => {
    expect(route(f({ engaged: true, history: [{ channel: "letter", at: ago(2) }] }), rules, now)).toMatchObject({ channel: "done", rule: 6 });
    // consent-based call two days after a letter: dial() does not look at the cool-down
    const { clinicId } = await clinicWithTeaser({ score: 6 });
    const b = await build();
    await db()`update mail_pieces set mailed_at=now() - interval '2 days', status='mailed' where batch_id=${b.batchId}`;
    const r = await createCallRequest({ clinicId, name: "Dana Lee", role: "", phone: "7055550142", date: "2026-11-16", start: "10:00", end: "12:00", consent: true, ip: "", pageUrl: "", sourceChannel: "letter" });
    if (!r.ok) throw new Error(r.message);
    expect((await dial(r.id, torontoToUtc("2026-11-16", "10:30"))).clinicId).toBe(clinicId);
  });
  it("7: one mail piece per clinic: the two-piece limit closes the letter channel", () => {
    expect(route(f({ score: 9, mailPieces: 2, hasEmail: false }), rules, now)).toMatchObject({ channel: "skipped" });
  });
  it("preview compares the next clinics under current and proposed rules without saving", async () => {
    await clinicWithTeaser({ score: 5 });
    await clinicWithTeaser({ score: 2 });
    const p = await previewRouting({ score_threshold: 1, split_on: false, split_letter_pct: 50, cooldown_days: 30 });
    expect(p.total).toBe(2);
    expect(p.counts.current).toEqual({ letter: 1, email: 1 });
    expect(p.counts.proposed).toEqual({ letter: 2 });
    expect(p.changed).toBe(1);
    expect((await db()`select values from channel_settings where channel='routing'`)[0].values.score_threshold).toBe(5);
  });
  it("a cold email is deferred while a letter is inside the cool-down", async () => {
    const { clinicId } = await clinicWithTeaser({ score: 6 });
    const b = await build();
    await db()`update mail_pieces set mailed_at=now() - interval '3 days' where batch_id=${b.batchId}`;
    await db()`update app_settings set dns_verified=true where id`;
    const r = await checkSend({ id: "x", type: "first_email", to_email: "a@b.example", clinic_id: clinicId }, await getSettings(), torontoToUtc("2026-11-10", "10:00"));
    expect(r.reason).toMatch(/cool-down/);
  });
});

describe("the letter", () => {
  it("is built from the stored teaser only: headline fact, three dated findings, clinics named, QR, typed URL, opt-out, no prices", async () => {
    const { clinicId, name } = await clinicWithTeaser();
    const d = await buildLetterData(clinicId, "letter", "A");
    expect(d.headline).toBe(`We asked an AI assistant 6 questions a patient in Barrie would ask. It recommended ${name} in 0 of 6.`);
    expect(d.findings).toHaveLength(3);
    expect(d.findings.every((f) => f.date === "November 10, 2026")).toBe(true);
    expect(d.namedInstead).toEqual(["Lakeshore Dental Studio"]);
    expect(d.qrUrl).toMatch(new RegExp(`/r/${d.code}\\?s=q$`));
    expect(d.typedUrl).toBe(`intheanswer.test/r/${d.code}`);
    expect(d.optOutLine).toBe("Don't want mail from us? Visit intheanswer.test/optout or call 705-555-0199.");
    const html = await renderLetter(d);
    expect(html).toContain("Scan to see your full results and request a short call.");
    expect(html).toContain("Or call 705-555-0199 to hear your results explained.");
    expect(html).toContain("<svg");
    expect(letterText(d)).not.toMatch(/\$|CAD|guarantee|best|urgent/i);
    const g = await gateLetter(d, { live: true, verifier: allSupported });
    expect(g.flags.filter((x) => x.severity === "block")).toEqual([]);
  });
  it("the gate blocks a letter with an unsupported claim, a price, or a changed headline", async () => {
    const { clinicId } = await clinicWithTeaser();
    const d = await buildLetterData(clinicId, "letter", "A");
    const codes = async (x: typeof d) => (await gateLetter(x, { live: true, verifier: allSupported })).flags.map((f) => f.code);
    expect(await codes({ ...d, findings: [{ ...d.findings[0], text: "Your site is missing its hours." }, ...d.findings.slice(1)] })).toContain("letter_finding_unsupported");
    expect(await codes({ ...d, headline: d.headline.replace("0 of 6", "1 of 6") })).toContain("letter_headline_unsupported");
    expect(await codes({ ...d, namedInstead: ["Invented Dental Group"] })).toContain("letter_named_unsupported");
    expect(await codes({ ...d, findings: [{ ...d.findings[0], title: "Only 200 CAD to fix" }, ...d.findings.slice(1)] })).toContain("letter_price");
    // evidence that no longer holds removes the finding, so the letter cannot be queued
    await db()`update page_cache set body='<html><body>Hours vary.</body></html>' where url like '%/contact'`;
    expect((await gateLetter(d, { live: true, verifier: allSupported })).passed).toBe(false);
  });
  it("placeholders in the sender's details block a real letter", async () => {
    const { clinicId } = await clinicWithTeaser();
    await db()`update channel_settings set values = values || '{"number": "[INBOUND NUMBER]"}'::jsonb where channel='inbound'`;
    const d = await buildLetterData(clinicId, "letter", "A");
    expect((await gateLetter(d, { live: true, verifier: allSupported })).passed).toBe(false);
    expect((await gateLetter(d, { live: false, verifier: allSupported })).passed).toBe(true);
  });
});

describe("mail batches", () => {
  it("an unapproved batch never reaches the provider", async () => {
    await clinicWithTeaser({ score: 6 });
    const b = await build();
    await fakePdfs(b.batchId);
    await expect(sendBatch(b.batchId)).rejects.toThrow(/has not been approved/);
    expect(provider.sent).toHaveLength(0);
  });
  it("approve selected sends only those; total cost is known before approval; rejecting needs a reason", async () => {
    await clinicWithTeaser({ score: 6 });
    await clinicWithTeaser({ score: 7 });
    const b = await build();
    await fakePdfs(b.batchId);
    expect(await batchCost(b.batchId)).toEqual({ pieces: 2, usd: 4.44 });
    await expect(rejectBatch(b.batchId, "o", " ")).rejects.toThrow(/reason/);
    await goLive();
    expect(await approveBatch(b.batchId, "owner@example.com", [b.pieces[0].id])).toBe(1);
    const s = await sendBatch(b.batchId);
    expect(s.submitted).toBe(1);
    expect(provider.sent).toHaveLength(1);
    const rows = await db()`select status, approved_by from mail_pieces where batch_id=${b.batchId} order by status`;
    expect(rows.map((r) => r.status)).toEqual(["rejected", "submitted"]);
    expect(rows[1].approved_by).toBe("owner@example.com");
  });
  it("an address that fails verification is skipped and logged, never sent, and marked bad", async () => {
    const bad = await clinicWithTeaser({ score: 6, address: "Undeliverable Rd, Nowhere" });
    await clinicWithTeaser({ score: 6 });
    const b = await build();
    await fakePdfs(b.batchId);
    await goLive();
    await approveBatch(b.batchId, "o");
    const s = await sendBatch(b.batchId);
    expect(s.submitted).toBe(1);
    expect(s.skipped).toEqual([{ clinicId: bad.clinicId, reason: "address failed verification" }]);
    const [p] = await db()`select status, status_reason, address_status from mail_pieces where clinic_id=${bad.clinicId}`;
    expect(p).toEqual({ status: "skipped", status_reason: "address failed verification", address_status: "failed" });
    expect((await db()`select address_bad from clinics where id=${bad.clinicId}`)[0].address_bad).toBe(true);
  });
  it("a clinic with no address confirmed on its site is never batched for a letter", async () => {
    await clinicWithTeaser({ score: 9, address: null });
    await expect(build()).rejects.toThrow(MailError);
  });
  it("the spend cap pauses the channel; the remaining pieces wait", async () => {
    for (let i = 0; i < 3; i++) await clinicWithTeaser({ score: 6 });
    const b = await build();
    await fakePdfs(b.batchId);
    await goLive();
    await saveChannel("letter", { monthly_spend_cap_usd: 5 }, "o"); // two letters at 2.22 fit, the third does not
    await approveBatch(b.batchId, "o");
    const s = await sendBatch(b.batchId);
    expect(s.submitted).toBe(2);
    expect(s.stopped).toMatch(/monthly spend cap/);
    expect((await db()`select count(*)::int as n from mail_pieces where status='approved'`)[0].n).toBe(1);
    expect((await channelOpen("letter", 2.22)).open).toBe(false);
  });
  it("the kill switch stops a send, and real mailing is refused in dry run", async () => {
    await clinicWithTeaser({ score: 6 });
    const b = await build();
    await fakePdfs(b.batchId);
    await approveBatch(b.batchId, "o");
    provider.live = true;
    await expect(sendBatch(b.batchId)).rejects.toThrow(/not enabled/);
    provider.live = false;
    await setKillSwitch(true, "o");
    const s = await sendBatch(b.batchId);
    expect(s.stopped).toMatch(/kill switch/);
    expect(provider.sent).toHaveLength(0);
  });
  it("test mode sends every piece to the owner's own address, and it never counts as mail to the clinic", async () => {
    const c = await clinicWithTeaser({ score: 6 });
    const b = await build({ testMode: true });
    await fakePdfs(b.batchId);
    await approveBatch(b.batchId, "o");
    const s = await sendBatch(b.batchId);
    expect(s.submitted).toBe(1);
    expect(provider.sent[0].to).toBe(provider.sent[0].from);
    expect(provider.contacts.get(provider.sent[0].to)?.line).toBe(OWNER.OWNER_MAILING_ADDRESS);
    const [p] = await db()`select mailed_at, address_status from mail_pieces where clinic_id=${c.clinicId}`;
    expect(p).toEqual({ mailed_at: null, address_status: "test: owner address" });
  });
  it("the first real batch is capped at 50 letters", async () => {
    await saveChannel("letter", { first_batch_max: 2 }, "o");
    for (let i = 0; i < 4; i++) await clinicWithTeaser({ score: 6 });
    expect((await build()).pieces).toHaveLength(2);
  });
  it("two mail pieces per clinic, ever; a postcard only when the code was not visited within 14 days", async () => {
    const quiet = await clinicWithTeaser({ score: 6 });
    const visited = await clinicWithTeaser({ score: 6 });
    const recent = await clinicWithTeaser({ score: 6 });
    const b = await build();
    await db()`update mail_pieces set status='mailed', mailed_at = now() - interval '20 days' where batch_id=${b.batchId}`;
    await db()`update mail_pieces set mailed_at = now() - interval '5 days' where clinic_id=${recent.clinicId}`;
    await db()`insert into page_visits (code, clinic_id, source, device) values (${await ensureCode(visited.clinicId)}, ${visited.clinicId}, 'qr', 'phone')`;
    expect(await followUpCandidates()).toEqual([quiet.clinicId]);
    const pc = await buildPostcardBatch({ verifier: allSupported, renderPdf: false, testMode: false });
    await fakePdfs(pc.batchId);
    await goLive();
    await approveBatch(pc.batchId, "o");
    expect((await sendBatch(pc.batchId)).submitted).toBe(1);
    expect(await followUpCandidates()).toEqual([]); // already has its postcard
    // a third piece is refused at send time even if one is somehow approved
    const [extra] = await db()<{ id: string }[]>`insert into mail_batches (label, kind, test_mode, status) values ('x', 'postcard', false, 'approved') returning id`;
    await db()`insert into mail_pieces (clinic_id, batch_id, type, status, data, gate_passed, address_text, pdf_path)
               select clinic_id, ${extra.id}, 'postcard', 'approved', data, true, address_text, pdf_path from mail_pieces where batch_id=${pc.batchId}`;
    const s = await sendBatch(extra.id);
    expect(s.skipped[0].reason).toMatch(/mail limit of 2/);
  });
  it("returned mail marks the address as bad; provider events update status", async () => {
    const c = await clinicWithTeaser({ score: 6 });
    const b = await build();
    await fakePdfs(b.batchId);
    await goLive();
    await approveBatch(b.batchId, "o");
    await sendBatch(b.batchId);
    const [p] = await db()<{ id: string; provider_id: string }[]>`select id, provider_id from mail_pieces where clinic_id=${c.clinicId}`;
    await applyProviderEvent({ type: "letter.updated", data: { id: p.provider_id, status: "printing" } });
    expect((await db()`select status from mail_pieces where id=${p.id}`)[0].status).toBe("printing");
    await applyProviderEvent({ type: "letter.updated", data: { id: p.provider_id, status: "processed_for_delivery" } });
    expect((await db()`select status from mail_pieces where id=${p.id}`)[0].status).toBe("mailed");
    await markReturned(p.id);
    expect((await db()`select address_bad from clinics where id=${c.clinicId}`)[0].address_bad).toBe(true);
    expect((await db()`select status from mail_pieces where id=${p.id}`)[0].status).toBe("returned");
  });
  it("webhooks are accepted only with a valid signature", () => {
    const secret = "webhook_secret_test_0123456789";
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ type: "letter.updated", data: { id: "letter_1", status: "printing" } })}`;
    const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    expect(decodeWebhook(`${body}.${sig}`, secret)?.data.status).toBe("printing");
    expect(decodeWebhook(`${body}.${sig}`, "another_secret_0123456789")).toBeNull();
    expect(decodeWebhook(`${enc({ alg: "none" })}.${body.split(".")[1]}.`, secret)).toBeNull();
  });
});

describe("opt-out stops every channel", () => {
  it("from the opt-out page: mail, email and calls all stop", async () => {
    const c = await clinicWithTeaser({ score: 6 });
    const b = await build();
    await fakePdfs(b.batchId);
    await approveBatch(b.batchId, "o");
    const r = await createCallRequest({ clinicId: c.clinicId, name: "Dana Lee", role: "", phone: "7055550142", date: "2026-11-16", start: "10:00", end: "12:00", consent: true, ip: "", pageUrl: "", sourceChannel: "letter" });
    if (!r.ok) throw new Error(r.message);
    await optOutClinic(c.clinicId, "web", "optout_page");
    expect((await isSuppressed(`info@${c.domain}`)).suppressed).toBe(true);
    await goLive();
    const s = await sendBatch(b.batchId);
    expect(s.submitted).toBe(0);
    expect(provider.sent).toHaveLength(0);
    await expect(dial(r.id, torontoToUtc("2026-11-16", "10:30"))).rejects.toThrow(DialRefused);
    expect((await createEmailConsent({ clinicId: c.clinicId, email: "a@b.example", consent: true, consentText: "t", ip: "", pageUrl: "", sourceChannel: "letter" })).ok).toBe(false);
    expect((await db()`select channel, source from optouts`)[0]).toEqual({ channel: "web", source: "optout_page" });
  });
  it("an email unsubscribe also stops letters and calls", async () => {
    const c = await clinicWithTeaser({ score: 6 });
    const b = await build();
    await unsubscribe(`info@${c.domain}`, "unsubscribe_link");
    expect((await db()`select status from mail_pieces where batch_id=${b.batchId}`)[0].status).toBe("cancelled");
    expect((await db()`select opted_out_at is not null as o from clinics where id=${c.clinicId}`)[0].o).toBe(true);
  });
});

describe("reporting", () => {
  const row = (o: Partial<ClinicRow>): ClinicRow => ({ clinicId: "x", channel: "letter", city: "Barrie", batch: "b", arm: null, headline: null, contacted: true, delivered: true, visited: false, callRequested: false, emailAsked: false, called: false, bought: false, costUsd: 2.22, ...o });
  it("funnel counts and cost per visit, call request and sale", () => {
    const f = funnel("letter", [row({ visited: true, callRequested: true, bought: true }), row({ visited: true }), row({}), row({ delivered: false })]);
    expect(f).toMatchObject({ contacted: 4, delivered: 3, visited: 2, callRequests: 1, bought: 1, costUsd: 8.88, costPerVisit: 4.44, costPerCallRequest: 8.88, costPerSale: 8.88 });
    expect(funnel("email", [row({ costUsd: 0 })]).costPerVisit).toBeNull();
  });
  it("no arm is called ahead under 30 responses per arm, and sample sizes are always in the note", () => {
    const arm = (g: string, contacted: number, visited: number) => funnel(g, [...Array(visited).fill(row({ visited: true })), ...Array(contacted - visited).fill(row({}))]);
    const small = compare([arm("letter", 100, 29), arm("email", 100, 45)]);
    expect(small.ahead).toBeNull();
    expect(small.note).toMatch(/letter 29 of 100, email 45 of 100/);
    const big = compare([arm("letter", 100, 31), arm("email", 100, 45)]);
    expect(big.ahead).toBe("email");
    expect(big.note).toMatch(/letter 31 of 100/);
    expect(big.note).not.toMatch(/winner/i);
  });
});
