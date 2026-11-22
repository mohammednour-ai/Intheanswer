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
import { numberAnswer, reviewTranscript, systemPrompt, type Brain, type AgentTurn, type TranscriptLine } from "@/lib/calls/agent";
import { isPhoneSuppressed, suppressPhone } from "@/lib/calls/rules";
import { callOffer, cancelCall, consentWording, ensureCallCode, requestCall, scheduleOwnerCall } from "@/lib/calls/request";
import { callLinkHtml } from "@/lib/calls/reportLink";
import { findClinics, rankClinics, wordLikeness } from "@/lib/calls/lookup";
import { CALL_VOICES, DEFAULT_CALL_VOICE, resolveVoice } from "@/lib/calls/voices";
import { callFollowUp, callHousekeeping, inboundGreeting, onAmd, onAnswer, onIncoming, onStatus, onTurn, outboundGreeting, placeCall, reviewCall, setBrain, setReviewer } from "@/lib/calls/engine";
import { ICE_BREAKERS, PAINS, bridgeFor, checkPlaybook, iceBreaker, linkSent, painsOffered, type PlaybookState } from "@/lib/calls/playbook";
import { DEFAULT_SWITCHES, PILLAR_ORDER, PROMISE_ORDER, readBack, reassurance, type Switches } from "@/lib/offer";
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
function line(say: string, action: AgentTurn["action"] = "continue", more: Partial<Omit<AgentTurn, "say" | "action">> = {}): AgentTurn {
  return {
    say, action, stage: "facts", pains: [], buying_signal: false, declined: false, not_decision_maker: false,
    send: null, plan: null, confirmed: false, follow_up_ok: false, handoff_note: null, clinic_search: null, clinic_choice: null, ...more,
  };
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

/** A second answered call for a clinic that already had one (a new request, a later day). */
async function answeredCallFor(first: { clinicId: string; token: string; id: string }) {
  const sql = db();
  await sql`update calls set status='completed', ended_at=now() where id=${first.id}`;
  const [rep] = await sql<{ token: string }[]>`select token from reports where clinic_id=${first.clinicId} limit 1`;
  const wed10 = torontoToUtc("2026-11-12", "10:00");
  await requestCall({ token: rep.token, phone: "705-555-0142", agreed: true, ip: "2.2.2.2" }, wed10);
  const c = await onlyCall();
  await placeCall(c.id, log, wed10);
  await onAnswer(c.token);
  return c;
}

beforeEach(async () => {
  await resetData();
  for (const k of [...Object.keys(LIVE), "DRY_RUN", "VOICE_MODEL", "STRIPE_TAX_RATE_ID"]) delete process.env[k];
  process.env.DRY_RUN = "1";
  resetEnvForTests();
  placed.length = 0; ended.length = 0; asked.length = 0; script = [];
  setVoiceProvider(fakeVoice);
  setBrain(scriptedBrain);
  setReviewer(async () => ({ review: { summary: "They asked about the result.", outcome: "asked_questions", follow_up: null, unsupported: [], clinic_summary: null }, usage: null, costUsd: 0 }));
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

describe("finding a clinic by its spoken name", () => {
  const clinics = [
    { id: "a", name: "Bathurst Bloor Walk in Clinic", city: "Toronto" },
    { id: "b", name: "Bathurst Dental Centre", city: "Toronto" },
    { id: "c", name: "Lakeside Family Dental", city: "Barrie" },
    { id: "d", name: "Lakeside Family Dental", city: "Orillia" },
    { id: "e", name: "Clinique De Mode", city: "Toronto" },
    { id: "f", name: "Smile Dental Clinic", aliases: ["Dr. Patel Dentistry"], city: "Milton" },
  ];
  const ids = (said: string) => rankClinics(said, clinics).map((m) => m.id);

  it("finds the clinic from its name, whole or shortened, with or without the city", () => {
    expect(ids("Bathurst Bloor Walk in Clinic")).toEqual(["a"]);
    expect(ids("the Bathurst Bloor walk-in clinic in Toronto")).toEqual(["a"]);
    expect(ids("Bathurst Bloor")).toEqual(["a"]);
    expect(ids("Clinique de Mode")).toEqual(["e"]);
    expect(ids("Doctor Patel Dentistry, Milton")).toEqual(["f"]);
  });
  it("forgives what speech recognition does to a name", () => {
    expect(wordLikeness("bloor", "blur")).toBeGreaterThan(0.7);
    expect(wordLikeness("walking", "walk")).toBeGreaterThan(0.8);
    expect(wordLikeness("lakeside", "lakesides")).toBeGreaterThan(0.8);
    expect(wordLikeness("dental", "rental")).toBeLessThan(0.9);
    expect(wordLikeness("bloor", "smile")).toBe(0);
    expect(ids("Bathurst Blur walking clinic")).toEqual(["a"]);
    expect(ids("Lake Side Family Dental Barry")[0]).toBe("c");
  });
  it("uses the city to tell two clinics of the same name apart, and offers both without it", () => {
    expect(ids("Lakeside Family Dental in Orillia")).toEqual(["d"]);
    expect(ids("Lakeside Family Dental").sort()).toEqual(["c", "d"]);
  });
  it("finds nothing for a name that is only words every clinic uses, or for another clinic", () => {
    expect(ids("the dental clinic")).toEqual([]);
    expect(ids("medical centre")).toEqual([]);
    expect(ids("Maple Grove Physiotherapy")).toEqual([]);
    expect(ids("")).toEqual([]);
    expect(rankClinics("Bathurst Bloor", [])).toEqual([]);
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
  it("speaks in the voice it is given, and in the environment's voice without one", () => {
    expect(sayAndListen("Hello.", "https://x.test/turn", { voice: "ElevenLabs.abc123" })).toContain('<Say voice="ElevenLabs.abc123" language="en-US">');
    expect(sayAndHangUp("Goodbye.", "Google.en-US-Chirp3-HD-Aoede")).toContain('voice="Google.en-US-Chirp3-HD-Aoede"');
    expect(sayAndHangUp("Goodbye.")).toContain('voice="Polly.Danielle-Generative"');
  });
  it("only uses a voice that is on the list", () => {
    expect(resolveVoice(CALL_VOICES[2].id)).toBe(CALL_VOICES[2].id);
    expect(resolveVoice(null)).toBe(DEFAULT_CALL_VOICE);
    expect(resolveVoice('x" onerror="')).toBe(DEFAULT_CALL_VOICE);
    expect(new Set(CALL_VOICES.map((v) => v.id)).size).toBe(CALL_VOICES.length);
  });
});

describe("the spoken-word check", () => {
  const brief = { allowedAmounts: allowedAmounts(), names: ["Premier Dental"], quoted: ["Can you recommend a good dentist?"] };
  it("lets a plain, factual line through", () => {
    const r = checkSpoken("Claude recommended your clinic in 1 of 6 answers. The full report is 200 dollars, one time.", brief);
    expect(r.ok).toBe(true);
    expect(checkSpoken("Growth is 450 dollars a month plus 500 dollars setup, with a 6-month minimum.", brief).ok).toBe(true);
    expect(checkSpoken("Monthly reports are 150 dollars for the first month, then 50 dollars a month.", brief).ok).toBe(false); // a retired price
    expect(checkSpoken("No one can guarantee what an assistant will say.", brief).ok).toBe(true);
    // declining to promise is not a promise
    expect(checkSpoken("No one can guarantee it, so I can't promise your clinic will be recommended next month.", brief).ok).toBe(true);
    expect(checkSpoken("Nobody can say whether a clinic would be named after the fixes.", brief).ok).toBe(true);
    // nor is saying that there is no discount
    expect(checkSpoken("The price is 200 dollars a month, and I do not have any discount to offer.", brief).ok).toBe(true);
    expect(checkSpoken("There are no discounts or special offers.", brief).ok).toBe(true);
  });
  it("does not take everyday uses of 'top' for a superlative", () => {
    expect(checkSpoken("On top of that it adds a rebuilt website.", brief).ok).toBe(true);
    expect(checkSpoken("The notice at the top of your home page is from last October.", brief).ok).toBe(true);
    expect(checkSpoken("We are the top service for clinics.", brief).ok).toBe(false);
    expect(checkSpoken("It makes you a top rated clinic.", brief).ok).toBe(false);
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
    expect(text).toContain("Visibility: 200 CAD a month, month to month.");
    expect(text).toContain("Growth: 450 CAD a month, plus 500 CAD setup, 6-month minimum, then month to month.");
    expect(text).toContain("Transformation:");
    expect(text).toContain("It is never priced on a call.");
    expect(text).not.toMatch(/900|150 CAD|Monthly reports|Full service plan/);
    expect(text).toContain("credited to your first month");
    expect(b.allowedAmounts.sort((x, y) => x - y)).toEqual([200, 450, 500]);
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
    await db()`insert into subscriptions (clinic_id, stripe_subscription_id, status, plan) values (${r.clinicId}, 'sub_1', 'active', 'growth')`;
    const b = (await briefForClinic(r.clinicId))!;
    expect(b.plan).toBe("growth");
    expect(b.offers.filter((l) => /^(Full report|Visibility|Growth):/.test(l))).toEqual([]);
    expect(b.offers.join(" ")).toContain("Transformation:");
    expect(briefText(b)).toContain("already a customer (Growth)");
    // a clinic on the largest plan, or on a plan we cannot name, is offered nothing
    expect(offerLines("transformation")).toEqual([]);
    await db()`update subscriptions set plan = null`;
    expect((await briefForClinic(r.clinicId))!.offers).toEqual([]);
    // a plan from before the offer changed counts as Visibility
    expect(offerLines("monthly").join(" ")).not.toMatch(/^Visibility:|Full report and fix files:/);
    expect(offerLines("report").join(" ")).not.toContain("Full report and fix files:");
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
  it("shows our number and the report's code on the report page, only while calls are on", async () => {
    const r = await clinicWithReport();
    expect(await callOffer(r.reportId)).toBeNull();
    await goLive();
    const offer = await callOffer(r.reportId);
    const code = await ensureCallCode(r.reportId);
    expect(offer?.phone).toEqual({ e164: "+17055550199", display: "705-555-0199", code });
    const html = callLinkHtml(r.token, offer!);
    expect(html).toContain(`href="/call/${r.token}"`);
    expect(html).toContain('href="tel:+17055550199"');
    expect(html).toContain(`${code.slice(0, 3)} ${code.slice(3)}`);
    expect(html).toContain("Ansa, our AI assistant, can phone you");
    expect(callLinkHtml(r.token)).not.toContain("tel:");
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

  it("opens by saying who is calling, that it is an AI and that the call is transcribed, with one ice-breaker", async () => {
    const c = await answeredCall();
    const [first] = await turns(c.id);
    expect(first.role).toBe("agent");
    expect(first.text).toBe("Hi, this is Ansa, the AI assistant from In The Answer. This call is transcribed so our team can review it. Thanks for asking us to call. I'll keep it to a few minutes. Is now still a good time to go through the report for Test Dental?");
    expect(first.text).not.toMatch(/recorded/); // no audio is kept: "transcribed" is the true word
    expect((await call(c.id)).status).toBe("in_progress");
  });
  it("picks exactly one ice-breaker from the approved set, by how the call came about", () => {
    const morning = torontoToUtc("2026-11-10", "09:45"), midday = torontoToUtc("2026-11-10", "13:00"), late = torontoToUtc("2026-11-10", "16:00");
    expect(iceBreaker({ direction: "outbound", source: "web_form", now: morning })).toBe(ICE_BREAKERS.call_me);
    expect(iceBreaker({ direction: "outbound", source: "email_reply", now: late })).toBe(ICE_BREAKERS.reply);
    expect(iceBreaker({ direction: "outbound", source: "phone_request", now: morning })).toBe(ICE_BREAKERS.morning);
    expect(iceBreaker({ direction: "outbound", source: "in_person", now: late })).toBe(ICE_BREAKERS.end_of_day);
    expect(iceBreaker({ direction: "outbound", source: "phone_request", now: midday })).toBe(ICE_BREAKERS.call_me);
    expect(iceBreaker({ direction: "inbound", clinicKnown: true })).toBe(ICE_BREAKERS.inbound);
    expect(iceBreaker({ direction: "inbound" })).toBe(ICE_BREAKERS.inbound_unknown);
    const all = Object.values(ICE_BREAKERS) as string[];
    for (const g of [
      outboundGreeting({ contactName: "Dana", clinic: "Test Dental", source: "email_reply" }, late),
      outboundGreeting({ contactName: null, clinic: "Test Dental", source: "phone_request" }, morning),
      inboundGreeting("Test Dental"), inboundGreeting(null),
    ]) {
      expect(g).toMatch(/this is Ansa, the AI assistant from In The Answer\. This call is transcribed/);
      expect(all.filter((x) => g.includes(x)).length, g).toBeGreaterThanOrEqual(1);
      expect(all.filter((x) => g.includes(x) && !all.some((y) => y !== x && y.includes(x) && g.includes(y))).length, g).toBe(1);
    }
    expect(outboundGreeting({ contactName: "Dana", clinic: "Test Dental", source: "email_reply" }, late)).toBe(
      "Hi Dana, this is Ansa, the AI assistant from In The Answer. This call is transcribed so our team can review it. Thanks for your reply the other day. This should be quick. Is now still a good time to go through the report for Test Dental?");
    expect(outboundGreeting({ contactName: null, clinic: "Test Dental", source: "phone_request" }, morning)).toBe(
      "Hi, this is Ansa, the AI assistant from In The Answer. This call is transcribed so our team can review it. Thanks for making time this morning. You asked us to call about the report for Test Dental. Is now still a good time?");
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
    expect(xml).toContain("We won&apos;t call this number again");
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
  it("emails the report and the plans at once when asked, in the program's own words, to the address on file", async () => {
    const c = await answeredCall();
    script = [line("I'll have it sent to the address your report went to. Sam Owner will call you about the contract. Goodbye.", "end_call", { send: "report", handoff_note: "Wants to talk about the contract." })];
    const xml = await onTurn(c.token, { speech: "Email me the options, and have the owner call me about the contract. Bye." });
    expect(xml).toContain("<Hangup/>");
    expect(await db()`select 1 from owner_tasks where kind='escalation'`).toHaveLength(1);
    const [m] = await db()`select type::text, to_email, status::text, body_text from messages where type='requested_on_call'`;
    // fixed wording, nothing written by the model: it is not held for review
    expect(m).toMatchObject({ type: "requested_on_call", to_email: "info@testdental.example", status: "approved" });
    expect((await call(c.id)).signals).toMatchObject({ sent: ["report"], choice: "talk_to_person" });
    const buy = `/buy/${(await db()<{ token: string }[]>`select token from reports limit 1`)[0].token}`;
    expect(m.body_text).toContain(`- Visibility: 200 CAD a month. We publish the answer pages, fix the listings and retest every month. https://intheanswer.test${buy}/visibility`);
    expect(m.body_text).toContain(`${buy}/growth`);
    expect(m.body_text).toContain(`${buy}/report`);
    expect(m.body_text).not.toMatch(/\/monthly|\/reports|\/transformation/);
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
    const still = await onTurn(c.token, { speech: "" });
    expect(still).toContain("Are you still there?");
    expect(still).toContain('timeout="6"'); // after a question the caller gets longer to answer
    const bye = await onTurn(c.token, {});
    expect(bye).toContain("<Hangup/>");
    expect(bye).not.toContain("summary"); // nothing was said yet: there is nothing to summarise
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

describe("the playbook", () => {
  const ALL: Switches = { promises: [...PROMISE_ORDER], pillars: [...PILLAR_ORDER] };
  const st = (over: Partial<PlaybookState> = {}): PlaybookState => ({ pains: [], buyingSignal: false, declined: false, pillarsNamed: [], reassured: false, ...over });
  const codes = (text: string, state: PlaybookState, s: Switches = DEFAULT_SWITCHES) => checkPlaybook(text, state, s).flags.map((f) => f.code);

  it("names a part of the service only when the caller's own answer points to it", () => {
    const receptionist = bridgeFor("missed_calls");
    expect(codes(receptionist, st())).toEqual(["pillar_without_pain"]);
    expect(codes(receptionist, st({ pains: ["missed_calls"] }))).toEqual([]);
    expect(codes(bridgeFor("old_website"), st({ pains: ["missed_calls"] }))).toEqual(["pillar_without_pain"]);
    expect(codes(bridgeFor("reviews"), st({ pains: ["reviews"] }))).toEqual([]);
    // being found by AI assistants is what every call is about: it needs no pain on record
    expect(codes(bridgeFor("not_in_ai_answers"), st())).toEqual([]);
    expect(codes("Your clinic was recommended in 1 of the 6 answers.", st())).toEqual([]);
    // the caller asked what a plan includes: its contents may be described
    expect(codes("Growth includes a rebuilt website and an AI receptionist for missed calls.", st({ buyingSignal: true }))).toEqual([]);
    // the one-line answer to "what else do you do?" is always allowed
    expect(codes("We test how patients find a clinic through AI assistants, then rebuild and run what that depends on: the website, AI tools, integrations and reporting, under one monthly plan.", st())).toEqual([]);
  });
  it("lets the discovery questions through: asking about the clinic is not offering", () => {
    expect(codes("When someone calls after hours or when the front desk is busy, what usually happens to that call?", st())).toEqual([]);
    expect(codes("Thanks, that helps. When was your website last rebuilt, and who looks after it?", st())).toEqual([]);
    expect(codes("How do you ask patients for reviews now, and who replies to them?", st())).toEqual([]);
    // the same words as an offer are still an offer
    expect(codes("Shall we set up an AI receptionist for your after-hours calls?", st())).toEqual(["pillar_without_pain"]);
    expect(codes("Got it. We rebuild the site fully and keep it current.", st())).toEqual(["pillar_without_pain"]);
  });
  it("never lists the whole service: at most two parts on one call", () => {
    const two = st({ pains: ["missed_calls", "old_website", "too_many_vendors"], pillarsNamed: ["front_desk", "website"] });
    expect(codes(bridgeFor("too_many_vendors"), two)).toEqual(["too_many_pillars"]);
    expect(codes(bridgeFor("missed_calls"), two)).toEqual([]); // one already named may come up again
  });
  it("does not offer a part that is switched off, whatever the caller said", () => {
    const noFrontDesk: Switches = { ...DEFAULT_SWITCHES, pillars: ["found", "website", "systems", "proof"] };
    expect(painsOffered(noFrontDesk)).toEqual(["old_website", "too_many_vendors", "not_in_ai_answers"]);
    expect(codes(bridgeFor("missed_calls"), st({ pains: ["missed_calls"] }), noFrontDesk)).toEqual(["pillar_without_pain"]);
    expect(PAINS).toHaveLength(5);
  });
  it("states support, warranty and security only in the published sentence, and only once", () => {
    const sentence = reassurance()!;
    expect(codes(`Good question. ${sentence}`, st())).toEqual([]);
    expect(codes(sentence, st({ reassured: true }))).toEqual(["reassurance_twice"]);
    expect(codes("We offer 24/7 support and a full warranty on everything.", st())).toEqual(["promise_wording"]);
    expect(codes("Someone will fix it within one hour, free of charge.", st())).toEqual(["promise_wording"]);
    // a promise that is switched off is not said even in its own words
    const none: Switches = { ...DEFAULT_SWITCHES, promises: [] };
    expect(reassurance(none)).toBeNull();
    expect(codes(sentence, st(), none)).toEqual(["promise_wording"]);
    expect(codes(reassurance(ALL)!, st(), ALL)).toEqual([]);
  });
  it("makes one offer: after a not-now, no price is said again unless the caller asks", () => {
    expect(codes("Visibility is 200 dollars a month.", st({ declined: true }))).toEqual(["offer_after_no"]);
    expect(codes("Visibility is 200 dollars a month.", st({ declined: true, buyingSignal: true }))).toEqual([]);
    expect(codes("Of course. Is there anything else in the report I can explain?", st({ declined: true }))).toEqual([]);
  });
});

describe("the playbook on a call", () => {
  beforeEach(goLive);

  it("gives the model the playbook, and keeps what the caller showed on the call", async () => {
    const c = await answeredCall();
    script = [
      line("Got it. How do most new patients find you today?", "continue", { stage: "discovery" }),
      line("That makes sense. We set up an AI receptionist that answers after-hours and overflow calls, books or takes messages, and says it's an AI.", "continue", { stage: "bridge", pains: ["missed_calls"] }),
    ];
    await onTurn(c.token, { speech: "Yes, I'm the owner. Go ahead." });
    const prompt = systemPrompt(asked[0].brief, "outbound", "asked");
    expect(prompt).toContain("You are Ansa, the AI assistant that speaks on the phone for In The Answer.");
    expect(prompt).toContain('(missed_calls) "What happens when someone calls after hours or when the front desk is busy?"');
    expect(prompt).toContain(`Say this sentence word for word: "${reassurance()}"`);
    expect(prompt).toContain("Transformation is never priced on a call");
    expect(prompt).toContain("you never say them"); // review numbers
    expect(asked[0].progress).toMatchObject({ pains: [], reassured: false, declined: false, pendingCheckout: null });
    const xml = await onTurn(c.token, { speech: "Honestly we miss a lot of calls after five." });
    expect(xml).toContain("AI receptionist");
    const after = await call(c.id);
    expect(after.signals).toMatchObject({ pains: ["missed_calls"], stage: "bridge" });
    script = [line("Right.")];
    await onTurn(c.token, { speech: "Okay." });
    expect(asked[2].progress?.pains).toEqual(["missed_calls"]);
  });

  it("stops a part of the service nobody asked about, and stays on the report instead of ending the call", async () => {
    const c = await answeredCall();
    script = [line("We also rebuild websites and connect your booking system, and we set up an AI receptionist.", "continue", { stage: "bridge" })];
    const xml = await onTurn(c.token, { speech: "Okay, what was the result?" });
    expect(xml).toContain("Let me stay with what&apos;s in your report.");
    expect(xml).toContain("<Gather");
    const [, , stopped] = await turns(c.id);
    expect(stopped.blocked_text).toContain("rebuild websites");
    const after = await call(c.id);
    expect(after.status).toBe("in_progress");
    expect(after.signals).toMatchObject({ playbook_blocks: 1 });
    expect(after.signals.guard_blocks).toBeUndefined(); // not a wording fault: it does not count toward ending the call
  });

  it("reads the plan back in the published words, and sends the checkout link only after a clear yes", async () => {
    const c = await answeredCall();
    const sql = db();
    script = [
      line("Great, I'll set that up.", "continue", { stage: "offer", buying_signal: true, send: "checkout", plan: "growth" }),
      line("Sure, take your time.", "continue", { stage: "offer" }),
      line("Okay.", "continue", { stage: "offer", send: "checkout", plan: "growth" }),
      line("Perfect.", "continue", { stage: "offer", send: "checkout", plan: "growth", confirmed: true }),
    ];
    const back = await onTurn(c.token, { speech: "How do we start with the Growth one?" });
    expect(back).toContain(readBack("growth").replace(/'/g, "&apos;"));
    expect(back).not.toContain("set that up"); // the read-back is the program's line, not the model's
    expect(await sql`select 1 from messages where type='requested_on_call'`).toHaveLength(0);
    // a maybe is not a yes: the read-back lapses, and a later yes needs a new read-back
    await onTurn(c.token, { speech: "Hmm, let me think about the setup fee." });
    expect((await call(c.id)).status).toBe("in_progress");
    const again = await onTurn(c.token, { speech: "Okay, let's do it." });
    expect(again).toContain("Just to confirm: the Growth plan");
    expect(asked[3]?.progress?.pendingCheckout ?? asked[2].progress?.pendingCheckout).toBeDefined();
    const sent = await onTurn(c.token, { speech: "Yes, that's right." });
    expect(asked[3].progress?.pendingCheckout).toBe("growth");
    expect(sent).toContain(linkSent("growth").replace(/'/g, "&apos;"));
    const [m] = await sql`select status::text, subject, body_text, to_email from messages where type='requested_on_call'`;
    expect(m).toMatchObject({ status: "approved", subject: "Your checkout link: Growth", to_email: "info@testdental.example" });
    const [rep] = await sql<{ token: string }[]>`select token from reports limit 1`;
    expect(m.body_text).toContain(`https://intheanswer.test/buy/${rep.token}/growth`);
    expect(m.body_text).toContain("Growth: 450 CAD a month, plus 500 CAD setup. 6-month minimum, then month to month.");
    expect(m.body_text).toContain("We never take card details by phone or by email.");
    expect(m.body_text).toContain("credited to your first month");
    expect((await call(c.id)).signals).toMatchObject({ plan: "growth", choice: "start_now", sent: ["checkout:growth"] });
    // saying yes twice sends one email
    script = [line("Done.", "continue", { send: "checkout", plan: "growth", confirmed: true })];
    await onTurn(c.token, { speech: "Yes." });
    expect(await sql`select 1 from messages where type='requested_on_call'`).toHaveLength(1);
  });

  it("does not send a checkout link without the read-back, to a clinic already on a plan, or with no address", async () => {
    const c = await answeredCall();
    const sql = db();
    // "confirmed" on the first mention is not a yes to anything that was read out
    script = [line("Sending it now.", "continue", { buying_signal: true, send: "checkout", plan: "visibility", confirmed: true })];
    expect(await onTurn(c.token, { speech: "Send me the link for the 200 one." })).toContain("Just to confirm: the Visibility plan, 200 dollars a month, month to month.");
    expect(await sql`select 1 from messages where type='requested_on_call'`).toHaveLength(0);
    // already a customer: the change is arranged by email, by a person
    await sql`insert into subscriptions (clinic_id, stripe_subscription_id, status, plan) values (${c.clinicId}, 'sub_1', 'active', 'visibility')`;
    const other = await answeredCallFor(c);
    script = [line("Okay.", "continue", { buying_signal: true, send: "checkout", plan: "growth" })];
    expect(await onTurn(other.token, { speech: "We want to move up to Growth." })).toContain("the change is arranged by email");
    expect(await sql`select 1 from owner_tasks where title like 'Phone call:%'`).toHaveLength(1);
    expect(await sql`select 1 from messages where type='requested_on_call'`).toHaveLength(0);
  });

  it("never prices the plan that is quoted: it becomes a callback for the owner", async () => {
    const c = await answeredCall();
    script = [
      line("Transformation starts at 900 dollars a month.", "continue", { stage: "offer", buying_signal: true }),
      line("That one is quoted after a short review, so Sam Owner will call you to go through it.", "continue", { stage: "offer", handoff_note: "Wants a quote for Transformation: connect their booking system. Call Tuesday afternoon." }),
    ];
    const blocked = await onTurn(c.token, { speech: "What does the big plan cost?" });
    expect(blocked).not.toContain("900");
    const ok = await onTurn(c.token, { speech: "Okay, have someone call me Tuesday afternoon." });
    expect(ok).toContain("quoted after a short review");
    expect((await db()`select body from owner_tasks where kind='escalation'`)[0].body).toContain("Tuesday afternoon");
    expect((await call(c.id)).signals).toMatchObject({ choice: "talk_to_person" });
  });

  it("with someone who is not the owner or manager, records it and does not sell", async () => {
    const c = await answeredCall();
    script = [line("No problem. When is a good time to reach the owner? I can email the report in the meantime.", "continue", { stage: "role", not_decision_maker: true, send: "report", handoff_note: "Front desk answered. Owner is Dr. Lee, in on Thursday mornings." })];
    await onTurn(c.token, { speech: "I'm just the receptionist, Dr. Lee is in Thursday mornings." });
    const after = await call(c.id);
    expect(after.signals).toMatchObject({ not_decision_maker: true, sent: ["report"] });
    expect(await db()`select 1 from messages where type='requested_on_call'`).toHaveLength(1);
  });

  it("does not email anything on the turn that is still asking whether to", async () => {
    const c = await answeredCall();
    const sql = db();
    script = [
      line("Fair enough. Would it help if I emailed you the full report and the plans?", "continue", { send: "report" }),
      line("Done, it's on its way to the address your report went to.", "continue", { send: "report" }),
    ];
    await onTurn(c.token, { speech: "It's a lot to take in." });
    expect(await sql`select 1 from messages where type='requested_on_call'`).toHaveLength(0);
    await onTurn(c.token, { speech: "Yes please." });
    expect(await sql`select 1 from messages where type='requested_on_call'`).toHaveLength(1);
  });

  it("answers 'how did you get this number?' from the request the call rests on", () => {
    expect(numberAnswer("outbound", "Someone at the clinic asked for this call on the page their report links to, typed in this number, and agreed there to be called by an AI assistant."))
      .toBe("Someone at your clinic asked for this call on your report page and typed in this number.");
    expect(numberAnswer("outbound", "The clinic replied to our email and asked to be called at this number about its report.")).toBe("Your clinic replied to our email and asked us to call this number.");
    expect(numberAnswer("outbound", "The clinic asked to be called at this number about its report; our team recorded the request and scheduled this call.")).toBe("Your clinic asked us to call this number about its report.");
    expect(numberAnswer("inbound", "The caller phoned In The Answer's number.")).toMatch(/You phoned our number/);
  });

  it("after a think-it-over, writes the summary for the owner to approve, and one agreed follow-up three business days later", async () => {
    const c = await answeredCall();
    const sql = db();
    script = [
      line("Of course. I'll email a short summary of today's call and the plans. Would one follow-up email in a few days be all right?", "continue", { stage: "offer", buying_signal: true, send: "summary" }),
      line("Thanks. You'll have the summary by email. Goodbye.", "end_call", { stage: "close", follow_up_ok: true }),
    ];
    await onTurn(c.token, { speech: "What does it cost? Actually, let me think it over." });
    await onTurn(c.token, { speech: "Yes, one email is fine. Bye." });
    expect((await call(c.id)).signals).toMatchObject({ summary_wanted: true, choice: "think_it_over", follow_up_ok: true });
    let asksFor: boolean | undefined;
    setReviewer(async (_b, _t, opts) => {
      asksFor = opts?.summaryForClinic;
      return { review: { summary: "Wants to think it over.", outcome: "interested", follow_up: null, unsupported: [], clinic_summary: "We went through the result of your report: Test Dental was recommended in 1 of the 6 answers. You asked about the plans and wanted time to think." }, usage: null, costUsd: 0 };
    });
    await reviewCall(c.id);
    expect(asksFor).toBe(true);
    const [summary] = await sql`select status::text, subject, body_text, review_reason from messages where type='interested_reply'`;
    expect(summary).toMatchObject({ status: "pending_review", subject: "A summary of our call" });
    expect(summary.review_reason).toMatch(/written by the AI/);
    expect(summary.body_text).toContain("Thank you for speaking with Ansa, our AI assistant.");
    expect(summary.body_text).toContain("recommended in 1 of the 6 answers");
    expect(summary.body_text).toContain("- Growth: 450 CAD a month, plus 500 CAD setup, 6-month minimum, then month to month.");
    // the follow-up: once, three business days on, and it waits for the owner too
    const [job] = await sql<{ run_after: Date; idempotency_key: string }[]>`select run_after, idempotency_key from jobs where kind='call_follow_up'`;
    expect(job.idempotency_key).toBe(`call_follow_up:${c.id}`);
    expect(job.run_after.getTime() - Date.now()).toBeGreaterThan(2.5 * 86400e3);
    expect(await callFollowUp(c.id)).toEqual({ queued: true });
    expect(await callFollowUp(c.id)).toEqual({ queued: false });
    const follow = (await sql`select status::text, body_text from messages where subject='Following up on our call'`);
    expect(follow).toHaveLength(1);
    expect(follow[0].status).toBe("pending_review");
    expect(follow[0].body_text).toContain("there will be no other");
    // not sent to a clinic that has bought in the meantime
    await sql`delete from messages where subject='Following up on our call'`;
    await sql`update clinics set status='customer' where id=${c.clinicId}`;
    expect(await callFollowUp(c.id)).toMatchObject({ queued: false, reason: "clinic is customer" });
  });

  it("tells a caller who goes silent mid-call that a summary follows by email", async () => {
    const c = await answeredCall();
    script = [line("It was recommended in 1 of the 6 answers. Does that match what you'd expect?")];
    await onTurn(c.token, { speech: "Yes, go ahead." });
    await onTurn(c.token, { speech: "" });
    const bye = await onTurn(c.token, { speech: "" });
    expect(bye).toContain("we&apos;ll email you a summary");
    expect(bye).toContain("<Hangup/>");
    expect((await call(c.id)).signals).toMatchObject({ summary_wanted: true });
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
      review: { summary: "Spoke to the front desk about the result.", outcome: "interested", follow_up: "Send the full report link.", unsupported: [{ said: t.find((x) => x.role === "agent")!.text, issue: "Not in the brief." }], clinic_summary: null },
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
    expect(hello).toContain("Hi, this is Ansa, the AI assistant from In The Answer. This call is transcribed so our team can review it. Thanks for calling in.");
    expect(hello).toMatch(/tell me the clinic&apos;s name and its city, or key in the six digit code/);
    expect(hello).toContain(`voice="${DEFAULT_CALL_VOICE}"`);
    expect(hello).toContain('numDigits="6"');
    const c = await onlyCall();
    expect((await call(c.id)).clinic_id).toBeNull();
    const missed = await onTurn(c.token, { digits: "000000" });
    expect(missed).toContain("couldn&apos;t find a report with that code");
    expect(missed).toContain('numDigits="6"');
    const found = await onTurn(c.token, { speech: code.split("").join(" ") });
    expect(found).toContain("I have the report for Test Dental in front of me");
    expect((await call(c.id)).clinic_id).toBe(r.clinicId);
    expect((await call(c.id)).signals.identified_by).toBe("code");
    script = [line("It was recommended in 1 of 6 answers.")];
    const next = await onTurn(c.token, { speech: "The headline please." });
    expect(next).not.toContain("numDigits");
    expect(asked[0].direction).toBe("inbound");
    expect(asked[0].brief.clinic?.name).toBe("Test Dental");
  });
  it("finds the report from the clinic's name when the caller has no code, and asks before using it", async () => {
    const r = await clinicWithReport();
    await onIncoming({ callSid: "CAname1", from: "+14165550123" });
    const c = await onlyCall();
    // the model only passes on the name it heard; the system looks it up and words the answer
    script = [line("One moment.", "continue", { clinic_search: "Test Dental, Barrie" })];
    const asks = await onTurn(c.token, { speech: "I don't have a code. It's Test Dental in Barrie." });
    expect(asked[0].brief.kind).toBe("general");
    expect(systemPrompt(asked[0].brief, "inbound", "x")).toContain("Finding the caller's report");
    expect(asks).toContain("I found Test Dental in Barrie. Is that your clinic?");
    expect(asks).not.toContain("One moment");
    expect((await call(c.id)).clinic_id).toBeNull();
    // the caller confirms: only then is the report attached
    script = [line("Great.", "continue", { clinic_choice: "1" })];
    const ready = await onTurn(c.token, { speech: "Yes, that's us." });
    expect(asked[1].found).toEqual([{ name: "Test Dental", city: "Barrie" }]);
    expect(ready).toContain("I have the report for Test Dental in front of me");
    const after = await call(c.id);
    expect(after.clinic_id).toBe(r.clinicId);
    expect(after.signals.identified_by).toBe("name");
    script = [line("It was recommended in 1 of 6 answers.")];
    await onTurn(c.token, { speech: "What was the result?" });
    expect(asked[2].brief.clinic?.name).toBe("Test Dental");
    expect(asked[2].found).toBeUndefined();
    expect(systemPrompt(asked[2].brief, "inbound", "x")).not.toContain("Finding the caller's report");
    expect((await turns(c.id)).filter((t) => t.role === "system").map((t) => t.text)).toEqual(['Looked up "Test Dental, Barrie": Test Dental in Barrie.']);
  });
  it("does not attach a report the caller has not confirmed", async () => {
    await clinicWithReport();
    await onIncoming({ callSid: "CAname2", from: "+14165550123" });
    const c = await onlyCall();
    script = [line("One moment.", "continue", { clinic_search: "Test Dental" }), line("Sorry about that. What's the clinic's name?")];
    await onTurn(c.token, { speech: "Test Dental." });
    const xml = await onTurn(c.token, { speech: "No, that's not us." });
    expect(xml).toContain("What&apos;s the clinic&apos;s name?");
    expect((await call(c.id)).clinic_id).toBeNull();
    // a choice the system never offered is ignored
    script = [line("Is there anything else?", "continue", { clinic_choice: "3" })];
    await onTurn(c.token, { speech: "The third one." });
    expect((await call(c.id)).clinic_id).toBeNull();
  });
  it("reads out the clinics when the name fits more than one, and takes the one the caller picks", async () => {
    const [toronto] = await db()<{ id: number }[]>`insert into cities (name, province) values ('Toronto', 'ON') on conflict (name, province) do update set name=excluded.name returning id`;
    await clinicWithReport({ name: "Lakeside Dental" });
    const second = await clinicWithReport({ name: "Lakeside Dental", city_id: toronto.id, website: "https://lakesidetoronto.example", domain: "lakesidetoronto.example" });
    await onIncoming({ callSid: "CAname3", from: "+14165550123" });
    const c = await onlyCall();
    script = [line("One moment.", "continue", { clinic_search: "Lakeside Dental" }), line("Thanks.", "continue", { clinic_choice: "2" })];
    const which = await onTurn(c.token, { speech: "Lakeside Dental." });
    expect(which).toMatch(/I found two with a name like that: Lakeside Dental in Barrie, and Lakeside Dental in Toronto\. Which one is yours\?/);
    await onTurn(c.token, { speech: "The one in Toronto." });
    expect((await call(c.id)).clinic_id).toBe(second.clinicId);
  });
  it("says so when no clinic fits the name, and offers the owner after three tries", async () => {
    await clinicWithReport();
    await onIncoming({ callSid: "CAname4", from: "+14165550123" });
    const c = await onlyCall();
    script = [1, 2, 3].map(() => line("One moment.", "continue", { clinic_search: "Maple Grove Physiotherapy" }));
    expect(await onTurn(c.token, { speech: "Maple Grove Physiotherapy." })).toContain("couldn&apos;t find a report under that name");
    expect(await onTurn(c.token, { speech: "Maple Grove Physiotherapy in Orillia." })).toContain("couldn&apos;t find a report under that name");
    expect(await onTurn(c.token, { speech: "Maple Grove." })).toContain("Sam Owner follow up with you");
    expect((await call(c.id)).clinic_id).toBeNull();
  });
  it("does not offer a clinic whose report has not passed the gate", async () => {
    const r = await clinicWithReport();
    await db()`update reports set data = jsonb_set(data, '{verified}', 'false') where id=${r.reportId}`;
    expect(await findClinics("Test Dental")).toEqual([]);
  });
  it("has the after-call review read the model's lines only, not the service's own fixed lines", async () => {
    await clinicWithReport();
    await onIncoming({ callSid: "CAfixed1", from: "+14165550123" });
    const c = await onlyCall();
    script = [
      line("One moment.", "continue", { clinic_search: "Test Dental, Barrie" }),
      line("Great.", "continue", { clinic_choice: "1" }),
      line("It was recommended in 1 of the 6 answers."),
      line("The best clinic in town will be recommended."),
    ];
    await onTurn(c.token, { speech: "Test Dental in Barrie." });
    await onTurn(c.token, { speech: "Yes." });
    await onTurn(c.token, { speech: "What was the result?" });
    await onTurn(c.token, { speech: "And next month?" }); // stopped by the wording check: our fixed line is said instead
    let seen: TranscriptLine[] = [];
    setReviewer(async (_brief, transcript) => {
      seen = transcript;
      return { review: { summary: "Asked about the result.", outcome: "asked_questions", follow_up: null, unsupported: [], clinic_summary: null }, usage: null, costUsd: 0 };
    });
    await reviewCall(c.id);
    const agentLines = seen.filter((t) => t.role === "agent").map((t) => [t.fixed, t.text.slice(0, 28)]);
    expect(agentLines).toEqual([
      [true, "Hi, this is Ansa, the AI ass"],
      [true, "I found Test Dental in Barri"],
      [true, "Thanks. I have the report fo"],
      [false, "It was recommended in 1 of t"],
      [true, FALLBACK_LINE.slice(0, 28)],
    ]);
    const shown = reviewTranscript(seen);
    expect(shown).toContain("Service line: Hi, this is Ansa, the AI assistant from In The Answer.");
    expect(shown).toContain("Assistant: It was recommended in 1 of the 6 answers.");
    expect(shown).toContain("Caller: What was the result?");
    expect(shown).toContain('Note: Looked up "Test Dental, Barrie"');
    expect(shown).not.toMatch(/Assistant: (Hi, this is Ansa|I found|Thanks\. I have the report)/);
  });
  it("speaks in the voice chosen in Settings", async () => {
    await db()`update app_settings set call_voice=${CALL_VOICES[1].id} where id`;
    const hello = await onIncoming({ callSid: "CAvoice1", from: "+14165550123" });
    expect(hello).toContain(`voice="${CALL_VOICES[1].id}"`);
    const c = await onlyCall();
    script = [line("Sure. We test whether AI assistants name a clinic.")];
    expect(await onTurn(c.token, { speech: "What do you do?" })).toContain(`voice="${CALL_VOICES[1].id}"`);
    expect(await onTurn(c.token, { speech: "Please stop calling us." })).toContain(`voice="${CALL_VOICES[1].id}"`);
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
    expect(xml).toContain("isn&apos;t available right now");
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
