import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, db } from "@/lib/db";
import { resetEnvForTests } from "@/lib/env";
import { setVoiceProvider, twilioSignature, voice, type OutboundCall, type VoiceProvider } from "@/lib/adapters/voice";
import { setMailProvider } from "@/lib/adapters/mail";
import { sampleTeaser } from "@/lib/reports/sample";
import { randomToken } from "@/lib/tokens";
import { torontoToUtc } from "@/lib/time";
import { isSuppressed } from "@/lib/sending/suppression";
import { normalizeCanadianPhone, spokenCode, speakablePhone } from "@/lib/calls/phone";
import { sayAndHangUp, sayAndListen } from "@/lib/calls/twiml";
import { checkSpoken, hearsOptOut, FALLBACK_LINE } from "@/lib/calls/guard";
import { allowedAmounts, briefForClinic, briefText, generalBrief, offerLines } from "@/lib/calls/brief";
import { systemPrompt, type Brain, type AgentTurn } from "@/lib/calls/agent";
import { isPhoneSuppressed, suppressPhone } from "@/lib/calls/rules";
import { cancelCall, consentWording, ensureCallCode, requestCall, scheduleOwnerCall } from "@/lib/calls/request";
import { callHousekeeping, onAmd, onAnswer, onIncoming, onStatus, onTurn, placeCall, reviewCall, setBrain, setReviewer } from "@/lib/calls/engine";
import { makeClinic, resetData } from "./helpers";

const tue10 = torontoToUtc("2026-11-10", "10:00");
const tue20 = torontoToUtc("2026-11-10", "20:00");
const PHONE = "+17055550142";
const LIVE = {
  OWNER_NAME: "Sam Owner", OWNER_BUSINESS_NAME: "In The Answer Inc.", OWNER_MAILING_ADDRESS: "1 Main St, Barrie ON L4M 1A1", OWNER_PHONE: "705-555-0100",
  MONTHLY_MIN_TERM_MONTHS: "12", TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "12345", TWILIO_PHONE_NUMBER: "+17055550199", ANTHROPIC_API_KEY: "test-key",
};
const log = { log: async () => {} };

const placed: OutboundCall[] = [];
const ended: string[] = [];
const fakeVoice: VoiceProvider = {
  async placeCall(c) { placed.push(c); return { sid: `CA${placed.length}` }; },
  async endCall(sid) { ended.push(sid); },
  validate: () => true,
};

/** A scripted model: answers each turn from a queue, and records what it was asked. */
let script: (AgentTurn | Error)[] = [];
const asked: Parameters<Brain>[0][] = [];
const scriptedBrain: Brain = async (i) => {
  asked.push(i);
  const next = script.shift() ?? line("Is there anything else in the report I can explain?");
  if (next instanceof Error) throw next;
  return { turn: next, usage: null, costUsd: 0.001, model: "test" };
};
function line(say: string, action: AgentTurn["action"] = "continue", more: { handoff_note?: string; email_links?: boolean } = {}): AgentTurn {
  return { say, action, email_links: more.email_links ?? false, handoff_note: more.handoff_note ?? null };
}

async function setEnv(vars: Record<string, string>) {
  Object.assign(process.env, vars);
  resetEnvForTests();
}

async function goLive() {
  await setEnv({ ...LIVE, DRY_RUN: "0" });
  await db()`update app_settings set dry_run=false, live_enabled=true, calls_enabled=true where id`;
}

/** A clinic with a verified teaser report and a published contact address. */
async function clinicWithReport(over: Record<string, unknown> = {}) {
  const sql = db();
  const clinicId = await makeClinic({ status: "contacted", ...over });
  const token = randomToken();
  const data = { ...sampleTeaser(), kind: "teaser", verified: true, clinic: { id: clinicId, name: "Test Dental", city: "Barrie", website: "https://testdental.example", domain: "testdental.example" } };
  const [r] = await sql<{ id: string }[]>`insert into reports (clinic_id, kind, token, data, html) values (${clinicId}, 'teaser', ${token}, ${sql.json(data as never)}, '<html><body><main></main><footer class="rp-foot"></footer></body></html>') returning id`;
  await sql`insert into contacts (clinic_id, email, source_url, on_own_domain, is_primary) values (${clinicId}, 'info@testdental.example', 'https://testdental.example/contact', true, true)`;
  return { clinicId, reportId: r.id, token };
}

async function call(id: string) {
  const [c] = await db()<{ status: string; dry_run: boolean; attempts: number; outcome: string | null; last_error: string | null; clinic_id: string | null; token: string; signals: Record<string, unknown>; summary: string | null; review_flags: unknown[]; duration_seconds: number | null }[]>`
    select status, dry_run, attempts, outcome, last_error, clinic_id, token, signals, summary, review_flags, duration_seconds from calls where id=${id}`;
  return c;
}
const turns = (id: string) => db()<{ role: string; text: string; action: string | null; blocked_text: string | null }[]>`select role, text, action, blocked_text from call_turns where call_id=${id} order by seq`;
const onlyCall = async () => (await db()<{ id: string; token: string }[]>`select id, token from calls order by created_at desc limit 1`)[0];

/** Ask for a call on the report page and bring it to the point where the person has answered. */
async function answeredCall() {
  const r = await clinicWithReport();
  await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10);
  const c = await onlyCall();
  await placeCall(c.id, log, tue10);
  await onAnswer(c.token);
  return { ...r, ...c };
}

beforeEach(async () => {
  await resetData();
  for (const k of [...Object.keys(LIVE), "DRY_RUN", "VOICE_MODEL", "STRIPE_TAX_RATE_ID"]) delete process.env[k];
  process.env.DRY_RUN = "1";
  resetEnvForTests();
  placed.length = 0; ended.length = 0; asked.length = 0; script = [];
  setVoiceProvider(fakeVoice);
  setBrain(scriptedBrain);
  setReviewer(async () => ({ review: { summary: "They asked about the result.", outcome: "asked_questions", follow_up: null, unsupported: [] }, usage: null, costUsd: 0 }));
  setMailProvider({ async send() { return { id: "re_1" }; }, async getInbound() { throw new Error("unused"); }, async domainState() { return null; }, verifyWebhook() { throw new Error("unused"); } });
});

afterAll(async () => {
  setVoiceProvider(null); setBrain(null); setReviewer(null); setMailProvider(null);
  await closeDb();
});

describe("phone numbers", () => {
  it("accepts Canadian numbers in the forms people type, as E.164", () => {
    expect(normalizeCanadianPhone("705-555-0142")).toBe(PHONE);
    expect(normalizeCanadianPhone("+1 (416) 555 0199")).toBe("+14165550199");
    expect(normalizeCanadianPhone("1.905.555.0100")).toBe("+19055550100");
  });
  it("refuses premium, toll-free, US, overseas and malformed numbers", () => {
    for (const n of ["900-555-0100", "1-800-555-0100", "212-555-0100", "876-555-0100", "+44 20 7946 0958", "555-0100", "705-555-01420", "call me", "705-155-0142"]) {
      expect(normalizeCanadianPhone(n), n).toBeNull();
    }
  });
  it("reads a six-digit report code out of speech, and nothing else", () => {
    expect(spokenCode("482913")).toBe("482913");
    expect(spokenCode("my code is four eight two, nine one three")).toBe("482913");
    expect(spokenCode("4 8 2 9 oh 3")).toBe("482903");
    expect(spokenCode("I would like to book for two people")).toBeNull();
    expect(spokenCode("48291")).toBeNull();
    expect(spokenCode("")).toBeNull();
  });
  it("spells a number for a voice", () => {
    expect(speakablePhone("705-555-0100")).toBe("7 0 5, 5 5 5, 0 1 0 0");
  });
});

describe("provider requests", () => {
  it("computes the provider's signature (the example from Twilio's documentation)", () => {
    const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
    expect(twilioSignature("12345", "https://mycompany.com/myapp.php?foo=1&bar=2", params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });
  it("accepts a signed request and refuses a wrong, missing or tampered one", async () => {
    await setEnv(LIVE);
    setVoiceProvider(null);
    const url = "https://intheanswer.test/api/voice/turn/abc";
    const params = { CallSid: "CA1", SpeechResult: "hello" };
    const sig = twilioSignature("12345", url, params);
    expect(voice().validate(url, params, sig)).toBe(true);
    expect(voice().validate(url, { ...params, SpeechResult: "do not call" }, sig)).toBe(false);
    expect(voice().validate(url + "x", params, sig)).toBe(false);
    expect(voice().validate(url, params, null)).toBe(false);
    expect(voice().validate(url, params, "nonsense")).toBe(false);
  });
  it("escapes what is spoken and keeps it to one plain line", () => {
    const xml = sayAndListen(`Tom & "Jerry" <b>Dental</b>\n**recommended**`, "https://x.test/turn?a=1&b=2", { hints: ["A, B"] });
    expect(xml).toContain("Tom &amp; &quot;Jerry&quot; &lt;b&gt;Dental&lt;/b&gt; recommended");
    expect(xml).toContain('action="https://x.test/turn?a=1&amp;b=2"');
    expect(xml).toContain('input="speech dtmf"');
    expect(sayAndHangUp("Goodbye.")).toMatch(/<Say[^>]*>Goodbye\.<\/Say><Hangup\/>/);
  });
});

describe("the spoken-word check", () => {
  const brief = { allowedAmounts: allowedAmounts(), names: ["Premier Dental"], quoted: ["Can you recommend a good dentist?"] };
  it("lets a plain, factual line through", () => {
    const r = checkSpoken("Claude recommended your clinic in 1 of 6 answers. The full report is 200 dollars, one time.", brief);
    expect(r.ok).toBe(true);
    expect(checkSpoken("Monthly reports are 150 dollars for the first month, then 50 dollars a month.", brief).ok).toBe(true);
    expect(checkSpoken("No one can guarantee what an assistant will say.", brief).ok).toBe(true);
    // declining to promise is not a promise
    expect(checkSpoken("No one can guarantee it, so I can't promise your clinic will be recommended next month.", brief).ok).toBe(true);
    expect(checkSpoken("Nobody can say whether a clinic would be named after the fixes.", brief).ok).toBe(true);
    // nor is saying that there is no discount
    expect(checkSpoken("The price is 200 dollars a month, and I do not have any discount to offer.", brief).ok).toBe(true);
    expect(checkSpoken("There are no discounts or special offers.", brief).ok).toBe(true);
  });
  it("lets a clinic's own name through even when it contains a banned word", () => {
    expect(checkSpoken("The answer named Premier Dental for that question.", brief).ok).toBe(true);
    expect(checkSpoken("Premier Dental is the premier choice.", brief).ok).toBe(false);
  });
  it.each([
    ["a superlative", "We are the best service for clinics."],
    ["a promise", "After the fixes your clinic will be recommended."],
    ["a promise behind a disclaimer", "I cannot promise anything, but your clinic will be recommended."],
    ["a guarantee", "We guarantee results."],
    ["urgency", "This offer is for a limited time."],
    ["a price that is not published", "I can do it for 99 dollars."],
    ["a discount", "I can give you a discount today."],
    ["a discount after a no", "No problem, I can give you a discount."],
    ["a review number", "You have 4.8 stars on Google."],
    ["passing for a person", "No, I am a real person."],
    ["denying it is an AI", "I'm not a robot."],
    ["criticism of another clinic", "Their site is worse than yours."],
    ["asking for a card", "Please read me your credit card number."],
  ])("stops %s and says the fallback instead", (_what, said) => {
    const r = checkSpoken(said, brief);
    expect(r.ok).toBe(false);
    expect(r.text).toBe(FALLBACK_LINE);
    expect(r.flags.length).toBeGreaterThan(0);
  });
  it("never speaks a web address or a paragraph", () => {
    expect(checkSpoken("See https://intheanswer.ca/r/abc for it.", brief).text).toBe("See intheanswer dot c a for it.");
    expect(checkSpoken("One sentence here. ".repeat(80), brief).text.length).toBeLessThanOrEqual(700);
  });
  it("hears a request to stop calls or all contact", () => {
    expect(hearsOptOut("please stop calling us")).toBe("do_not_call");
    expect(hearsOptOut("Don't call here again.")).toBe("do_not_call");
    expect(hearsOptOut("take us off your list")).toBe("do_not_call");
    expect(hearsOptOut("do not contact us again")).toBe("do_not_contact");
    expect(hearsOptOut("I do not call the shots here, ask the manager")).toBeNull();
    expect(hearsOptOut("can you call back tomorrow")).toBeNull();
  });
});

describe("the brief", () => {
  it("is built from the stored, verified report and the published prices", async () => {
    const r = await clinicWithReport();
    const b = (await briefForClinic(r.clinicId))!;
    const text = briefText(b);
    expect(b.kind).toBe("teaser");
    expect(text).toContain("It recommended Birchwood Dental Clinic in 1 of them");
    expect(text).toContain('Question 1: "I just moved to Orillia');
    expect(text).toContain("200 CAD, one time");
    expect(text).toContain("150 CAD for the first month, then 50 CAD a month");
    expect(b.allowedAmounts.sort((x, y) => x - y)).toEqual([50, 150, 200]);
    expect(b.names).toContain("Lakeside Smiles (invented)");
    expect(b.canEmailLinks).toBe(true);
    expect(systemPrompt(b, "outbound", "asked")).toContain("You are an AI assistant");
  });
  it("does not use a report that has not passed the gate", async () => {
    const r = await clinicWithReport();
    await db()`update reports set data = data || '{"verified": false}'::jsonb where id=${r.reportId}`;
    expect(await briefForClinic(r.clinicId)).toBeNull();
  });
  it("does not sell a customer the plan it already has", async () => {
    const r = await clinicWithReport();
    await db()`insert into subscriptions (clinic_id, stripe_subscription_id, status, plan) values (${r.clinicId}, 'sub_1', 'active', 'monthly')`;
    const b = (await briefForClinic(r.clinicId))!;
    expect(b.plan).toBe("monthly");
    expect(b.offers).toEqual([]);
    expect(offerLines("reports").join(" ")).not.toContain("one time, no contract");
  });
  it("has no report for a caller we cannot place", async () => {
    const b = await generalBrief();
    expect(b.report).toEqual([]);
    expect(briefText(b)).toContain("There is no report in front of you");
  });
});

describe("asking for a call", () => {
  it("needs the tick box, a Canadian number and calls switched on", async () => {
    const r = await clinicWithReport();
    await db()`update app_settings set calls_enabled=true where id`;
    expect((await requestCall({ token: r.token, phone: "705-555-0142", agreed: false, ip: "1.1.1.1" }, tue10)).ok).toBe(false);
    expect((await requestCall({ token: r.token, phone: "1-900-555-0142", agreed: true, ip: "1.1.1.1" }, tue10)).ok).toBe(false);
    expect((await requestCall({ token: "x".repeat(20), phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10)).ok).toBe(false);
    await db()`update app_settings set calls_enabled=false where id`;
    expect((await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10)).ok).toBe(false);
    expect(await db()`select 1 from calls`).toHaveLength(0);
  });
  it("records the consent as given, and queues one call", async () => {
    const r = await clinicWithReport();
    await db()`update app_settings set calls_enabled=true where id`;
    const res = await requestCall({ token: r.token, phone: "(705) 555-0142", name: "Dana", agreed: true, ip: "1.1.1.1" }, tue10);
    expect(res).toEqual({ ok: true, message: "Thank you. Our assistant will call 705-555-0142 within the next few minutes." });
    const [k] = await db()`select phone, source, wording, contact_name, recorded_by, ip_hash from call_consents`;
    expect(k).toMatchObject({ phone: PHONE, source: "web_form", wording: consentWording(), contact_name: "Dana", recorded_by: "clinic" });
    expect(k.ip_hash).not.toContain("1.1.1.1");
    const c = await onlyCall();
    expect((await call(c.id)).status).toBe("queued");
    expect(await db()`select 1 from jobs where kind='place_call'`).toHaveLength(1);
    // a second request while the first is waiting changes nothing
    expect((await requestCall({ token: r.token, phone: "705-555-0143", agreed: true, ip: "2.2.2.2" }, tue10)).message).toMatch(/already on its way/);
    expect(await db()`select 1 from calls`).toHaveLength(1);
  });
  it("outside calling hours, says when the call will come", async () => {
    const r = await clinicWithReport();
    await db()`update app_settings set calls_enabled=true where id`;
    const res = await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue20);
    expect(res.message).toMatch(/Wednesday/);
    const [j] = await db()<{ run_after: Date }[]>`select run_after from jobs where kind='place_call'`;
    expect(j.run_after.toISOString()).toBe(torontoToUtc("2026-11-11", "09:30").toISOString());
  });
  it("limits requests per report, ignores bots, and refuses a suppressed number or clinic", async () => {
    const r = await clinicWithReport();
    await db()`update app_settings set calls_enabled=true, call_requests_per_report_per_day=1 where id`;
    expect((await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1", honeypot: "x" }, tue10)).ok).toBe(true);
    expect(await db()`select 1 from calls`).toHaveLength(0);
    await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10);
    await cancelCall((await onlyCall()).id);
    expect((await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10)).message).toMatch(/already requested for this report today/);

    const other = await clinicWithReport({ domain: "other.example", name: "Other Dental" });
    await suppressPhone("+17055550150", "asked not to be called", "call");
    expect((await requestCall({ token: other.token, phone: "705-555-0150", agreed: true, ip: "3.3.3.3" }, tue10)).message).toMatch(/asked not to call that number/);
    await db()`update clinics set status='do_not_contact' where id=${other.clinicId}`;
    expect((await requestCall({ token: other.token, phone: "705-555-0151", agreed: true, ip: "3.3.3.3" }, tue10)).ok).toBe(false);
  });
  it("lets the owner record a request made another way, with a note", async () => {
    const r = await clinicWithReport();
    const bad = await scheduleOwnerCall({ clinicId: r.clinicId, phone: "705-555-0142", source: "email_reply", note: "", actorEmail: "owner@x.test" }, tue10);
    expect(bad.ok).toBe(false);
    const ok = await scheduleOwnerCall({ clinicId: r.clinicId, phone: "705-555-0142", source: "email_reply", note: "Reply of 9 Nov: call Tuesday", actorEmail: "owner@x.test" }, tue10);
    expect(ok.ok).toBe(true);
    const [k] = await db()`select source, note, recorded_by from call_consents`;
    expect(k).toMatchObject({ source: "email_reply", note: "Reply of 9 Nov: call Tuesday", recorded_by: "owner@x.test" });
  });
  it("gives each report one stable six-digit code", async () => {
    const r = await clinicWithReport();
    const code = await ensureCallCode(r.reportId);
    expect(code).toMatch(/^\d{6}$/);
    expect(await ensureCallCode(r.reportId)).toBe(code);
  });
});

describe("placing a call", () => {
  it("in a dry run records the call and dials nothing", async () => {
    const r = await clinicWithReport();
    await db()`update app_settings set calls_enabled=true where id`;
    await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10);
    const c = await onlyCall();
    await placeCall(c.id, log, tue10);
    expect(placed).toHaveLength(0);
    expect(await call(c.id)).toMatchObject({ status: "completed", dry_run: true, outcome: "dry_run" });
  });
  it("live, dials the number that asked, from our number, with the provider's webhooks", async () => {
    const r = await clinicWithReport();
    await goLive();
    await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10);
    const c = await onlyCall();
    await placeCall(c.id, log, tue10);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ to: PHONE, from: "+17055550199", answerUrl: `https://intheanswer.test/api/voice/answer/${c.token}`, statusUrl: `https://intheanswer.test/api/voice/status/${c.token}` });
    expect(await call(c.id)).toMatchObject({ status: "dialing", dry_run: false, attempts: 1 });
    // running the job again does not dial twice
    await placeCall(c.id, log, tue10);
    expect(placed).toHaveLength(1);
  });
  it("never dials without a recorded request", async () => {
    const r = await clinicWithReport();
    await goLive();
    const [c] = await db()<{ id: string }[]>`insert into calls (token, direction, phone, clinic_id) values (${randomToken(24)}, 'outbound', ${PHONE}, ${r.clinicId}) returning id`;
    await placeCall(c.id, log, tue10);
    expect(placed).toHaveLength(0);
    expect(await call(c.id)).toMatchObject({ status: "blocked" });
    expect((await call(c.id)).last_error).toMatch(/no recorded request/);
  });
  it("refuses a number that asked not to be called, a withdrawn request and a closed clinic", async () => {
    await goLive();
    const a = await clinicWithReport();
    await requestCall({ token: a.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10);
    const ca = await onlyCall();
    await db()`insert into call_suppressions (phone, reason, source) values (${PHONE}, 'asked', 'call')`;
    await placeCall(ca.id, log, tue10);
    expect((await call(ca.id)).status).toBe("blocked");

    const b = await clinicWithReport({ domain: "b.example", name: "B Dental" });
    await requestCall({ token: b.token, phone: "705-555-0143", agreed: true, ip: "2.2.2.2" }, tue10);
    const cb = await onlyCall();
    await db()`update clinics set status='suppressed' where id=${b.clinicId}`;
    await placeCall(cb.id, log, tue10);
    expect((await call(cb.id)).status).toBe("blocked");
    expect(placed).toHaveLength(0);
  });
  it("waits for calling hours, the switch, the kill switch and the daily cap", async () => {
    const r = await clinicWithReport();
    await goLive();
    await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10);
    const c = await onlyCall();
    await expect(placeCall(c.id, log, tue20)).rejects.toThrow(/outside calling hours/);
    await db()`update app_settings set calls_enabled=false where id`;
    await expect(placeCall(c.id, log, tue10)).rejects.toThrow(/switched off/);
    await db()`update app_settings set calls_enabled=true, kill_switch=true where id`;
    await expect(placeCall(c.id, log, tue10)).rejects.toThrow(/kill switch/);
    await db()`update app_settings set kill_switch=false, calls_daily_cap=0 where id`;
    await expect(placeCall(c.id, log, tue10)).rejects.toThrow(/daily call cap/);
    expect(placed).toHaveLength(0);
    expect((await call(c.id)).status).toBe("queued");
  });
  it("is not set up without the provider, the model key or the owner's details", async () => {
    const r = await clinicWithReport();
    await goLive();
    await setEnv({ OWNER_PHONE: "[PHONE]" });
    await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10);
    await expect(placeCall((await onlyCall()).id, log, tue10)).rejects.toThrow(/not set up: owner details/);
  });
});

describe("the conversation", () => {
  beforeEach(goLive);

  it("opens by saying who is calling, that it is an AI, why, and that the call is transcribed", async () => {
    const c = await answeredCall();
    const [first] = await turns(c.id);
    expect(first.role).toBe("agent");
    expect(first.text).toMatch(/an AI assistant calling from In The Answer/);
    expect(first.text).toMatch(/asked on our website for this call/);
    expect(first.text).toMatch(/transcribed/);
    expect((await call(c.id)).status).toBe("in_progress");
  });
  it("passes the brief and the transcript to the model and speaks its line", async () => {
    const c = await answeredCall();
    script = [line("Claude recommended your clinic in 1 of the 6 answers. Which question would you like to hear about?")];
    const xml = await onTurn(c.token, { speech: "Yes, go ahead." });
    expect(xml).toContain("recommended your clinic in 1 of the 6 answers");
    expect(xml).toContain("<Gather");
    expect(asked[0].heard).toBe("Yes, go ahead.");
    expect(asked[0].brief.report.join(" ")).toContain("Birchwood Dental Clinic");
    expect(asked[0].transcript.map((t) => t.role)).toEqual(["agent", "caller"]);
    expect(await db()`select 1 from cost_records where operation='call_turn'`).toHaveLength(1);
  });
  it("replaces a line that breaks the wording rules, keeps what the model wrote, and hands over after two", async () => {
    const c = await answeredCall();
    script = [line("We are the best, and your clinic will be recommended."), line("I guarantee it for 99 dollars.")];
    const xml = await onTurn(c.token, { speech: "Is it any good?" });
    expect(xml).toContain("I would rather not get that wrong");
    expect(xml).not.toContain("best");
    const t = await turns(c.id);
    expect(t.at(-1)!.blocked_text).toBe("We are the best, and your clinic will be recommended.");
    const end = await onTurn(c.token, { speech: "And the price?" });
    expect(end).toContain("<Hangup/>");
    expect(end).not.toContain("99");
    expect(await db()`select 1 from owner_tasks where kind='escalation'`).toHaveLength(1);
    expect((await call(c.id)).status).toBe("completed");
  });
  it("stops at once when asked not to call, without consulting the model", async () => {
    const c = await answeredCall();
    const xml = await onTurn(c.token, { speech: "Please stop calling us." });
    expect(xml).toContain("We will not call this number again");
    expect(xml).toContain("<Hangup/>");
    expect(asked).toHaveLength(0);
    expect((await isPhoneSuppressed(PHONE)).suppressed).toBe(true);
    expect((await call(c.id)).status).toBe("completed");
    // and a new request for that number is refused
    await db()`update calls set status='cancelled' where id=${c.id}`;
    expect((await requestCall({ token: c.token.length ? (await db()<{ token: string }[]>`select token from reports limit 1`)[0].token : "", phone: "705-555-0142", agreed: true, ip: "9.9.9.9" }, tue10)).ok).toBe(false);
  });
  it("on 'no contact at all' also suppresses the clinic's addresses and closes the clinic", async () => {
    const c = await answeredCall();
    script = [line("Understood. We will not contact you again. Goodbye.", "do_not_contact")];
    const xml = await onTurn(c.token, { speech: "We are not interested, lose our details." });
    expect(xml).toContain("<Hangup/>");
    expect((await isSuppressed("info@testdental.example")).suppressed).toBe(true);
    expect((await isPhoneSuppressed(PHONE)).suppressed).toBe(true);
    const [cl] = await db()`select status::text from clinics where id=${c.clinicId}`;
    expect(cl.status).toBe("suppressed");
  });
  it("hands over to the owner when a person is wanted, and keeps talking", async () => {
    const c = await answeredCall();
    script = [line("Sam Owner will follow up with you about that.", "continue", { handoff_note: "Wants to discuss a refund for last month." })];
    const xml = await onTurn(c.token, { speech: "I want to talk to a person about a refund." });
    expect(xml).toContain("<Gather");
    const [task] = await db()`select title, body from owner_tasks`;
    expect(task.title).toMatch(/Test Dental needs you/);
    expect(task.body).toContain("Wants to discuss a refund");
    expect(await db()`select 1 from messages where type='owner_alert'`).toHaveLength(1);
  });
  it("queues the links by email for review when asked, to the address on file", async () => {
    const c = await answeredCall();
    script = [line("I will have it sent to the address your report went to. Sam Owner will call you about the contract. Goodbye.", "end_call", { email_links: true, handoff_note: "Wants to talk about the contract." })];
    const xml = await onTurn(c.token, { speech: "Email me the options, and have the owner call me about the contract. Bye." });
    expect(xml).toContain("<Hangup/>");
    expect(await db()`select 1 from owner_tasks where kind='escalation'`).toHaveLength(1);
    const [m] = await db()`select type::text, to_email, status::text, body_text from messages where type='interested_reply'`;
    expect(m).toMatchObject({ type: "interested_reply", to_email: "info@testdental.example", status: "pending_review" });
    expect(m.body_text).toContain(`/buy/${(await db()<{ token: string }[]>`select token from reports limit 1`)[0].token}/monthly`);
    expect(m.body_text).toContain("In The Answer Inc.");
  });
  it("covers a model failure with a spoken line, and ends politely after two", async () => {
    const c = await answeredCall();
    script = [new Error("timeout"), new Error("timeout")];
    expect(await onTurn(c.token, { speech: "Hello?" })).toContain("Could you say it again?");
    const end = await onTurn(c.token, { speech: "Hello??" });
    expect(end).toContain("having trouble on my end");
    expect(end).toContain("<Hangup/>");
  });
  it("asks once after a silence, then lets the line go", async () => {
    const c = await answeredCall();
    expect(await onTurn(c.token, { speech: "" })).toContain("Are you still there?");
    expect(await onTurn(c.token, {})).toContain("<Hangup/>");
    expect(asked).toHaveLength(0);
    expect((await call(c.id)).outcome).toBe("no_conversation");
  });
  it("hangs up on a voicemail greeting without leaving a message, and tries once more", async () => {
    const c = await answeredCall();
    script = [line("", "voicemail")];
    const xml = await onTurn(c.token, { speech: "You have reached Test Dental, please leave a message after the tone." });
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    expect(await onStatus({ token: c.token }, { status: "completed", durationSeconds: 12 }, tue10)).toEqual({ status: "queued" });
    expect((await call(c.id)).status).toBe("queued");
    expect(await db()`select 1 from jobs where kind='place_call'`).toHaveLength(2);
  });
  it("ends a call that has run past its limit", async () => {
    const c = await answeredCall();
    await db()`update calls set started_at = now() - interval '20 minutes' where id=${c.id}`;
    const xml = await onTurn(c.token, { speech: "And another thing." });
    expect(xml).toContain("end of the time for this call");
    expect(xml).toContain("<Hangup/>");
  });
  it("ignores a turn for a call that is not in progress", async () => {
    const c = await answeredCall();
    await db()`update calls set status='completed' where id=${c.id}`;
    expect(await onTurn(c.token, { speech: "hello" })).toContain("<Hangup/>");
    expect(await onTurn("nope".repeat(6), { speech: "hello" })).toContain("<Hangup/>");
  });
});

describe("the end of a call", () => {
  beforeEach(goLive);

  it("retries once after no answer, then stops", async () => {
    const r = await clinicWithReport();
    await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10);
    const c = await onlyCall();
    await placeCall(c.id, log, tue10);
    expect(await onStatus({ token: c.token }, { status: "no-answer" }, tue10)).toEqual({ status: "queued" });
    const [j] = await db()<{ run_after: Date }[]>`select run_after from jobs where idempotency_key=${`call:${c.id}:2`}`;
    expect(j.run_after.toISOString()).toBe(torontoToUtc("2026-11-10", "12:00").toISOString());
    await placeCall(c.id, log, torontoToUtc("2026-11-10", "12:00"));
    expect(placed).toHaveLength(2);
    expect(await onStatus({ token: c.token }, { status: "busy" }, tue10)).toEqual({ status: "busy" });
    expect(await call(c.id)).toMatchObject({ status: "busy", attempts: 2, outcome: "busy" });
  });
  it("records the length once, counts it toward the spend cap, and reviews the conversation", async () => {
    const c = await answeredCall();
    script = [line("Thanks for your time. Goodbye.", "end_call")];
    await onTurn(c.token, { speech: "That is all, thank you." });
    expect((await call(c.id)).status).toBe("completed");
    await onStatus({ token: c.token }, { status: "completed", durationSeconds: 125 }, tue10);
    await onStatus({ token: c.token }, { status: "completed", durationSeconds: 125 }, tue10);
    const costs = await db()<{ cost_usd: number }[]>`select cost_usd from cost_records where provider='twilio'`;
    expect(costs).toHaveLength(1);
    expect(costs[0].cost_usd).toBeCloseTo(0.3);
    expect((await call(c.id)).duration_seconds).toBe(125);
    expect(await db()`select 1 from jobs where kind='review_call'`).toHaveLength(1);
  });
  it("after the call, writes the summary and flags anything the brief does not support", async () => {
    const c = await answeredCall();
    script = [line("Your clinic was recommended in 1 of 6.")];
    await onTurn(c.token, { speech: "What was the result?" });
    setReviewer(async (_b, t) => ({
      review: { summary: "Spoke to the front desk about the result.", outcome: "interested", follow_up: "Send the full report link.", unsupported: [{ said: t.find((x) => x.role === "agent")!.text, issue: "Not in the brief." }] },
      usage: null, costUsd: 0,
    }));
    expect(await reviewCall(c.id)).toEqual({ outcome: "interested", unsupported: 1 });
    expect(await call(c.id)).toMatchObject({ summary: "Spoke to the front desk about the result.", outcome: "interested" });
    expect((await call(c.id)).review_flags).toHaveLength(1);
    expect((await db()`select title from owner_tasks`)[0].title).toMatch(/1 statement\(s\) to check/);
    expect(await db()`select 1 from messages where type='owner_alert'`).toHaveLength(1);
  });
  it("hangs up on an answering machine", async () => {
    const r = await clinicWithReport();
    await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10);
    const c = await onlyCall();
    await placeCall(c.id, log, tue10);
    await onAmd(c.token, "human");
    expect(ended).toHaveLength(0);
    await onAmd(c.token, "machine_start");
    expect(ended).toEqual(["CA1"]);
    expect(await onStatus({ token: c.token }, { status: "completed", durationSeconds: 3 }, tue10)).toEqual({ status: "queued" });
  });
  it("closes calls the provider never closed, and drops old transcripts", async () => {
    const c = await answeredCall();
    script = [line("Hello.")];
    await onTurn(c.token, { speech: "Hi." });
    await db()`update calls set updated_at = now() - interval '3 hours' where id=${c.id}`;
    expect((await callHousekeeping()).stuck).toBe(1);
    expect((await call(c.id)).status).toBe("completed");
    await db()`update calls set ended_at = now() - interval '200 days' where id=${c.id}`;
    expect((await callHousekeeping()).transcripts).toBe(3);
    expect(await turns(c.id)).toHaveLength(0);
  });
});

describe("a clinic phones us", () => {
  beforeEach(goLive);

  it("answers as an AI, asks for the report code, and attaches the report when it is given", async () => {
    const r = await clinicWithReport();
    const code = await ensureCallCode(r.reportId);
    const hello = await onIncoming({ callSid: "CAin1", from: "+14165550123" });
    expect(hello).toMatch(/an AI assistant/);
    expect(hello).toMatch(/six digit report code/);
    const c = await onlyCall();
    expect((await call(c.id)).clinic_id).toBeNull();
    expect(await onTurn(c.token, { digits: "000000" })).toContain("could not find a report with that code");
    const found = await onTurn(c.token, { speech: code.split("").join(" ") });
    expect(found).toContain("I have the report for Test Dental in front of me");
    expect((await call(c.id)).clinic_id).toBe(r.clinicId);
    script = [line("It was recommended in 1 of 6 answers.")];
    await onTurn(c.token, { speech: "The headline please." });
    expect(asked[0].direction).toBe("inbound");
    expect(asked[0].brief.clinic?.name).toBe("Test Dental");
  });
  it("recognises the number of a clinic that asked for a call before", async () => {
    const r = await clinicWithReport();
    await requestCall({ token: r.token, phone: "705-555-0142", agreed: true, ip: "1.1.1.1" }, tue10);
    await cancelCall((await onlyCall()).id);
    const hello = await onIncoming({ callSid: "CAin2", from: PHONE });
    expect(hello).toContain("the number for Test Dental");
  });
  it("answers general questions for a caller with no report, from the general brief", async () => {
    await onIncoming({ callSid: "CAin3", from: "anonymous" });
    const c = await onlyCall();
    script = [line("In The Answer tests whether AI assistants name a clinic when patients ask.")];
    await onTurn(c.token, { speech: "What is it that you do?" });
    expect(asked[0].brief.kind).toBe("general");
  });
  it("plays the 'not available' message while calls are off, and is closed by the status report", async () => {
    await db()`update app_settings set calls_enabled=false where id`;
    const xml = await onIncoming({ callSid: "CAin4", from: PHONE });
    expect(xml).toContain("not available right now");
    expect(xml).toContain("<Hangup/>");
    expect(asked).toHaveLength(0);
    expect(await onIncoming({ callSid: "CAin4", from: PHONE })).toContain("<Hangup/>");
    expect(await db()`select 1 from calls`).toHaveLength(1);
  });
  it("is closed by the provider's status report, by call id", async () => {
    await onIncoming({ callSid: "CAin5", from: "+14165550123" });
    const c = await onlyCall();
    script = [line("Hello.")];
    await onTurn(c.token, { speech: "Hi there." });
    expect(await onStatus({ sid: "CAin5" }, { status: "completed", durationSeconds: 40 })).toEqual({ status: "completed" });
    expect(await db()`select 1 from jobs where kind='review_call'`).toHaveLength(1);
  });
});
