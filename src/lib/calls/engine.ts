import { db } from "../db";
import { env, ownerDetails } from "../env";
import { DeferJob, PermanentJobError, enqueue, recordCost, type JobContext } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { registerScheduled } from "../schedule/tick";
import { effectiveDryRun, getSettings } from "../settings";
import { voice } from "../adapters/voice";
import { queueMessage, queueOwnerMail, signature } from "../sending/outbox";
import { nextWindowStart } from "../sending/rules";
import { spendToday } from "../jobs/worker";
import { VOICE_NAME } from "../brand";
import { randomToken } from "../tokens";
import { addBusinessDays, formatLongDate } from "../time";
import { scanLanguage } from "../pipeline/verify";
import { REPORT_CREDIT_TEXT, TIERS, emailOfferLines, isOnlineTier, offeredTo, priceText, termText, tierIncludes, type OnlineTier, type PillarKey } from "../offer";
import { priceNote } from "../env";
import { BUYING_LINES, PAINS, checkPlaybook, iceBreaker, linkSent, readBack, stageRank, type Pain, type PlaybookFlag, type Stage } from "./playbook";
import { briefForClinic, generalBrief, linkRecipient, type CallBrief } from "./brief";
import { claudeBrain, claudeReviewer, numberAnswer, type Action, type Brain, type Reviewer, type TranscriptLine } from "./agent";
import { FALLBACK_LINE, checkSpoken, hearsOptOut, type SpokenFlag } from "./guard";
import { displayPhone, lastTen, normalizeCanadianPhone, spokenCode } from "./phone";
import { MAX_ATTEMPTS, callsReady, checkCall, stopAllContact, suppressPhone } from "./rules";
import { hangUp, sayAndHangUp, sayAndListen } from "./twiml";
import { findClinics } from "./lookup";
import { resolveVoice } from "./voices";

/**
 * The life of a call.
 *
 *   queued -> place_call job -> dialing -> (answered) in_progress -> completed
 *                                       -> no_answer | busy | voicemail (one retry) | failed
 *
 * The provider drives a call by HTTP: it asks for the first line when the call
 * is answered (`onAnswer`, or `onIncoming` when a clinic phones us), posts
 * what the person said after every line (`onTurn`), and reports the end
 * (`onStatus`). Each of these returns the next thing to say and never throws:
 * a failure on our side becomes a spoken apology, not a dead line.
 */

interface CallState {
  silences?: number;      // consecutive turns with nothing heard
  blocked?: number;       // lines the spoken-word check replaced
  failures?: number;      // model calls that failed or timed out
  codeAttempts?: number;  // inbound: report codes that matched nothing
  /** Inbound, no code: the clinics found for the name the caller gave (waiting for a yes), and the names that matched nothing. */
  lookup?: { found: { id: string; name: string; city: string | null }[]; misses: number };
  turns?: number;
  voicemail?: boolean;    // an answering machine picked up
  // The playbook (see playbook.ts): where the call stands, kept so its rules can be enforced.
  stage?: Stage;
  pains?: Pain[];             // problems the caller's own words pointed to
  buying?: boolean;           // the caller asked the price, what is included or how to start
  declined?: boolean;         // the caller said not now to the offer
  reassured?: boolean;        // the one reassurance sentence has been said
  pillars?: PillarKey[];      // parts of the service already named
  pendingCheckout?: OnlineTier | null; // the plan just read back, waiting for the caller's yes
  offTrack?: number;          // lines the playbook check replaced
  unclear?: number;           // turns in a row where the caller could not be made out
}

interface Signals {
  handoff?: string[];        // what the person needed, for the owner
  email_links?: "queued" | "no_address";
  do_not_call?: boolean;
  do_not_contact?: boolean;
  wrong_number?: boolean;
  guard_blocks?: number;
  /** Inbound: how we know which clinic is calling. By name is the caller's word only. */
  identified_by?: "caller_id" | "code" | "name";
  // What the call came to, for the owner and the after-call review.
  stage?: Stage;                      // the furthest step reached
  pains?: Pain[];
  plan?: string;                      // the plan discussed or chosen
  choice?: "start_now" | "think_it_over" | "talk_to_person";
  sent?: string[];                    // what was emailed at the caller's request: report, checkout:<plan>
  summary_wanted?: boolean;           // a summary email is written after the call (it waits for the owner's approval)
  follow_up_ok?: boolean;             // the caller agreed to one follow-up email
  not_decision_maker?: boolean;
  playbook_blocks?: number;
}

interface CallRow {
  id: string;
  token: string;
  direction: "outbound" | "inbound";
  status: string;
  clinic_id: string | null;
  report_id: string | null;
  consent_id: string | null;
  phone: string;
  contact_name: string | null;
  provider_call_sid: string | null;
  attempts: number;
  started_at: Date | null;
  duration_seconds: number | null;
  created_at: Date;
  brief: CallBrief | null;
  state: CallState;
  signals: Signals;
  dry_run: boolean;
}

const FINAL = new Set(["completed", "no_answer", "busy", "voicemail", "failed", "cancelled", "blocked"]);
const MAX_TURNS = 80;

export const voiceUrl = (kind: "answer" | "turn" | "status" | "amd", token: string) => `${env().APP_URL.replace(/\/$/, "")}/api/voice/${kind}/${token}`;

let brain: Brain = claudeBrain;
let reviewer: Reviewer = claudeReviewer;
/** Tests: swap the model for a scripted one (pass null to restore). */
export function setBrain(b: Brain | null) { brain = b ?? claudeBrain; }
export function setReviewer(r: Reviewer | null) { reviewer = r ?? claudeReviewer; }

async function loadCall(where: { token: string } | { id: string } | { sid: string }): Promise<CallRow | null> {
  const sql = db();
  const cond = "token" in where ? sql`token=${where.token}` : "id" in where ? sql`id=${where.id}` : sql`provider_call_sid=${where.sid}`;
  const [c] = await sql<CallRow[]>`
    select id, token, direction, status, clinic_id, report_id, consent_id, phone, contact_name, provider_call_sid, attempts,
           started_at, duration_seconds, created_at, brief, state, signals, dry_run
    from calls where ${cond}`;
  return c ?? null;
}

/**
 * `fixed` marks a line the service wrote (the opening, what a lookup found, a closing line, the line
 * that replaces a stopped one), as opposed to one the model wrote. The after-call review reads only
 * the model's lines against the brief: the service's own wording is not a claim to be checked.
 */
async function addTurn(callId: string, role: TranscriptLine["role"], text: string, extra: { action?: string; blockedText?: string | null; flags?: SpokenFlag[]; fixed?: boolean } = {}) {
  const sql = db();
  await sql`
    insert into call_turns (call_id, seq, role, text, action, blocked_text, flags, fixed)
    select ${callId}, coalesce(max(seq), 0) + 1, ${role}, ${text.slice(0, 4000)}, ${extra.action ?? null}, ${extra.blockedText ?? null},
           ${sql.json((extra.flags ?? []) as never)}, ${extra.fixed ?? false}
    from call_turns where call_id=${callId}`;
}

async function transcript(callId: string): Promise<TranscriptLine[]> {
  return db()<TranscriptLine[]>`select role, text, fixed from call_turns where call_id=${callId} order by seq`;
}

async function saveProgress(c: CallRow) {
  const sql = db();
  await sql`update calls set state=${sql.json(c.state as never)}, signals=${sql.json(c.signals as never)}, updated_at=now() where id=${c.id}`;
}

// ---------------------------------------------------------------------------
// Placing a call
// ---------------------------------------------------------------------------

/** Place one queued call, if every rule allows it right now. `now` is passed in so the rules can be tested at a fixed time. */
export async function placeCall(callId: string, ctx: Pick<JobContext, "log">, now = new Date()) {
  const sql = db();
  const settings = await getSettings();
  const dry = await effectiveDryRun(settings);

  const call = await loadCall({ id: callId });
  if (!call) throw new PermanentJobError("call not found");
  if (call.status !== "queued") return { skipped: `call is ${call.status}` };
  if (call.direction !== "outbound") throw new PermanentJobError("only outbound calls are placed");

  // The brief first: a call with nothing verified to explain is not made.
  const brief = call.clinic_id ? await briefForClinic(call.clinic_id, call.report_id) : null;

  // Check and claim under one lock, so two workers cannot both pass the daily cap or dial the same call.
  const decision = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('place_call'))`;
    const [fresh] = await tx<{ status: string }[]>`select status from calls where id=${callId} for update`;
    if (fresh.status !== "queued") return { outcome: "skip" as const, reason: `call is ${fresh.status}` };
    const check = await checkCall(call, settings, now, { dryRun: dry });
    if (check.outcome === "block") {
      await tx`update calls set status='blocked', last_error=${check.reason}, updated_at=now() where id=${callId}`;
      return check;
    }
    if (check.outcome === "defer") {
      await tx`update calls set last_error=${check.reason}, scheduled_for=${check.retryAt ?? null}, updated_at=now() where id=${callId}`;
      return check;
    }
    if (!brief) {
      await tx`update calls set status='blocked', last_error='no verified report to explain for this clinic', updated_at=now() where id=${callId}`;
      return { outcome: "block" as const, reason: "no verified report to explain for this clinic" };
    }
    if (dry) {
      // As with email: recorded as done, nothing leaves, and it stays a dry-run call after going live.
      await tx`update calls set status='completed', dry_run=true, outcome='dry_run', attempts=attempts+1, brief=${tx.json(brief as never)},
                 summary='Dry run: the call was not placed.', ended_at=now(), updated_at=now() where id=${callId}`;
      return { outcome: "dry" as const, reason: "dry run" };
    }
    await tx`update calls set status='dialing', dry_run=false, attempts=attempts+1, brief=${tx.json(brief as never)}, state='{}'::jsonb,
               last_error=null, updated_at=now() where id=${callId}`;
    return check;
  });

  if (decision.outcome === "skip" || decision.outcome === "block" || decision.outcome === "dry") return decision;
  if (decision.outcome === "defer") {
    const seconds = Math.max(60, Math.ceil(((decision.retryAt ?? new Date(now.getTime() + 3600e3)).getTime() - now.getTime()) / 1000));
    throw new DeferJob(seconds, decision.reason);
  }
  try {
    const { sid } = await voice().placeCall({
      to: call.phone,
      from: env().TWILIO_PHONE_NUMBER!,
      answerUrl: voiceUrl("answer", call.token),
      statusUrl: voiceUrl("status", call.token),
      amdUrl: voiceUrl("amd", call.token),
      ringSeconds: 30,
      timeLimitSeconds: (settings.call_max_minutes + 2) * 60,
    });
    await sql`update calls set provider_call_sid=${sid}, updated_at=now() where id=${callId}`;
    await ctx.log("call placed", { sid });
    return { placed: sid };
  } catch (e) {
    // nothing was dialled: put the call back as it was and let the job retry
    await sql`update calls set status='queued', attempts=greatest(attempts-1, 0), last_error=${(e as Error).message.slice(0, 300)}, updated_at=now()
              where id=${callId} and status='dialing'`;
    throw e;
  }
}

register("place_call", (ctx) => placeCall((ctx.job.payload as { callId: string }).callId, ctx));

// ---------------------------------------------------------------------------
// The opening line
// ---------------------------------------------------------------------------

const TRANSCRIBED = "This call is transcribed so our team can review it.";

async function consentSource(consentId: string | null): Promise<string | null> {
  if (!consentId) return null;
  const [c] = await db()<{ source: string }[]>`select source from call_consents where id=${consentId}`;
  return c?.source ?? null;
}

/** Who is calling, that it is an AI, that the call is transcribed: the same words on every call. */
const HELLO = `this is ${VOICE_NAME}, the AI assistant from In The Answer. ${TRANSCRIBED}`;

/**
 * The opening of a call we place: the disclosure, exactly one ice-breaker from the approved set
 * (chosen from how the call came about), and whether now is still a good time.
 */
export function outboundGreeting(x: { contactName: string | null; clinic: string | null; source: string | null }, now = new Date()): string {
  const ice = iceBreaker({ direction: "outbound", source: x.source, now });
  const about = x.clinic ? `the report for ${x.clinic}` : "your report";
  // a call that follows a web request or an email reply says so in its ice-breaker; any other request is named here
  const asked = x.source === "web_form" || x.source === "email_reply" ? "" : ` You asked us to call about ${about}.`;
  return `Hi${x.contactName ? ` ${x.contactName}` : ""}, ${HELLO} ${ice}${asked} Is now still a good time${asked ? "" : ` to go through ${about}`}?`;
}

function reasonFor(c: CallRow, source: string | null): string {
  if (c.direction === "inbound") return "The caller phoned In The Answer's number.";
  return source === "web_form"
    ? "Someone at the clinic asked for this call on the page their report links to, typed in this number, and agreed there to be called by an AI assistant."
    : source === "email_reply"
      ? "The clinic replied to our email and asked to be called at this number about its report."
      : "The clinic asked to be called at this number about its report; our team recorded the request and scheduled this call.";
}

/** Outbound call answered: say who is calling, that it is an AI, and why. */
export async function onAnswer(token: string): Promise<string> {
  const c = await loadCall({ token });
  if (!c || c.direction !== "outbound" || !c.brief) return hangUp();
  if (c.status !== "dialing") return hangUp(); // answered twice, or already over
  const sql = db();
  await sql`update calls set status='in_progress', started_at=now(), updated_at=now() where id=${c.id} and status='dialing'`;
  const line = outboundGreeting({ contactName: c.contact_name, clinic: c.brief.clinic?.name ?? null, source: await consentSource(c.consent_id) });
  await addTurn(c.id, "agent", line, { action: "continue", fixed: true });
  return sayAndListen(line, voiceUrl("turn", c.token), { hints: hintsFor(c.brief), voice: resolveVoice((await getSettings()).call_voice), timeout: listenFor(line) });
}

function hintsFor(b: CallBrief | null): string[] {
  return [b?.clinic?.name ?? "", "report", "In The Answer", VOICE_NAME, "full report", "Visibility", "Growth", "Transformation", "recommended", "not named", "listed only"].filter(Boolean);
}

/** Seconds of silence before we check the caller is still there: 4, or 6 after a question, so they can think. */
const listenFor = (line: string) => (/\?\s*$/.test(line) ? 6 : 4);

// ---------------------------------------------------------------------------
// A clinic phones us
// ---------------------------------------------------------------------------

async function clinicForCaller(from: string): Promise<string | null> {
  const sql = db();
  const e164 = normalizeCanadianPhone(from);
  if (e164) {
    const [byConsent] = await sql<{ clinic_id: string | null }[]>`
      select clinic_id from call_consents where phone=${e164} and clinic_id is not null order by granted_at desc limit 1`;
    if (byConsent?.clinic_id) return byConsent.clinic_id;
  }
  const ten = lastTen(from);
  if (!ten) return null;
  // the number a clinic publishes on its own site; only when it points at exactly one clinic
  const rows = await sql<{ id: string }[]>`
    select id from clinics where phone is not null and right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ${ten} limit 2`;
  return rows.length === 1 ? rows[0].id : null;
}

function unavailableLine(): string {
  const o = ownerDetails();
  return `Thanks for calling In The Answer. Our phone assistant isn't available right now. Please email ${o.email.replace("@", " at ")}, or visit intheanswer dot c a. Goodbye.`;
}

/** The first thing a caller to our number hears: that this is an AI, that the call is transcribed, one thank-you, and how to get to their report. */
export function inboundGreeting(clinicName: string | null): string {
  const ice = iceBreaker({ direction: "inbound", clinicKnown: !!clinicName });
  return clinicName
    ? `Hi, ${HELLO} ${ice} I see you're calling from the number for ${clinicName}. Shall I start with the headline result?`
    : `Hi, ${HELLO} ${ice} Are you calling about your clinic's report? If so, tell me the clinic's name and its city, or key in the six digit code from the report.`;
}

/** The provider's request when someone calls our number. */
export async function onIncoming(p: { callSid: string; from: string }): Promise<string> {
  const sql = db();
  const settings = await getSettings();
  const usable = settings.calls_enabled && !settings.kill_switch && callsReady().ok && (await spendToday()) < settings.claude_daily_spend_cap_usd;
  const phone = normalizeCanadianPhone(p.from) ?? (p.from || "unknown").slice(0, 40);
  const made = await sql<{ id: string }[]>`
    insert into calls (token, direction, status, phone, provider_call_sid, started_at, dry_run, attempts)
    values (${randomToken(24)}, 'inbound', ${usable ? "in_progress" : "completed"}, ${phone}, ${p.callSid}, now(), false, 1)
    on conflict (provider_call_sid) do nothing returning id`;
  if (!made.length) return hangUp(); // the same call announced twice
  const id = made[0].id;
  if (!usable) {
    await sql`update calls set outcome='unavailable', ended_at=now(), summary='Answered with the "not available" message: calls are off or not set up.' where id=${id}`;
    return sayAndHangUp(unavailableLine(), resolveVoice(settings.call_voice));
  }
  const clinicId = await clinicForCaller(p.from);
  const brief = (clinicId ? await briefForClinic(clinicId) : null) ?? (await generalBrief());
  const signals: Signals = brief.clinic ? { identified_by: "caller_id" } : {};
  await sql`update calls set clinic_id=${brief.clinic?.id ?? null}, report_id=${brief.reportId}, brief=${sql.json(brief as never)},
              signals=${sql.json(signals as never)} where id=${id}`;
  const c = (await loadCall({ id }))!;
  const line = inboundGreeting(brief.clinic?.name ?? null);
  await addTurn(id, "agent", line, { action: "continue", fixed: true });
  return sayAndListen(line, voiceUrl("turn", c.token), { hints: hintsFor(brief), digits: brief.clinic ? undefined : 6, voice: resolveVoice(settings.call_voice), timeout: listenFor(line) });
}

// ---------------------------------------------------------------------------
// One turn of the conversation
// ---------------------------------------------------------------------------

async function recordHandoff(c: CallRow, note: string) {
  const sql = db();
  const who = c.brief?.clinic?.name ?? displayPhone(c.phone);
  const first = !(c.signals.handoff?.length);
  c.signals.handoff = [...(c.signals.handoff ?? []), note].slice(-5);
  if (!first) return;
  await sql`insert into owner_tasks (kind, clinic_id, title, body)
            values ('escalation', ${c.clinic_id}, ${`Phone call: ${who} needs you`}, ${`${note}\n\nNumber: ${displayPhone(c.phone)}${c.contact_name ? ` (${c.contact_name})` : ""}\nTranscript: ${env().APP_URL}/portal/calls#call-${c.id}`})`;
  await queueOwnerMail("owner_alert", `call-handoff:${c.id}`, `Phone call: ${who} needs you`,
    [`On a call with our phone assistant, ${who} needs a person.`, ``, note, ``, `Number: ${displayPhone(c.phone)}${c.contact_name ? ` (${c.contact_name})` : ""}`,
     `Transcript: ${env().APP_URL}/portal/calls#call-${c.id}`].join("\n"));
}

/**
 * Send what the caller asked for on the phone: the report with the plans, or the checkout link for
 * one plan. Every word is the program's, built from the offer file, so these go out at once (the
 * type "requested_on_call" is never held for review). False when there is no address to send to.
 */
async function sendRequested(c: CallRow, what: "report" | "checkout", plan?: OnlineTier): Promise<boolean> {
  if (!c.clinic_id || !c.brief?.reportToken) return false;
  const to = await linkRecipient(c.clinic_id);
  if (!to) return false;
  const base = env().APP_URL.replace(/\/$/, "");
  const [teaser] = await db()<{ token: string }[]>`
    select token from reports where clinic_id=${c.clinic_id} and kind='teaser' and data->>'verified' = 'true' order by created_at desc limit 1`;
  const reportUrl = `${base}/r/${c.brief.reportToken}`;
  const close = [`If you would rather talk to a person first, reply to this email.`, ``, signature()];
  let subject: string;
  let lines: string[];
  if (what === "checkout") {
    if (!plan || !teaser) return false;
    const tier = TIERS[plan];
    const switches = c.brief.playbook?.switches;
    subject = `Your checkout link: ${tier.name}`;
    lines = [
      `Hello,`, ``,
      `As you asked on the phone, here is the secure checkout link for ${tier.inSentence}:`, `${base}/buy/${teaser.token}/${plan}`, ``,
      `${tier.name}: ${priceText(plan)}. ${termText(plan)[0].toUpperCase()}${termText(plan).slice(1)}.`,
      `What it includes:`, ...tierIncludes(plan, switches).map((l) => `- ${l}`), ``,
      priceNote(),
      ...(tier.kind === "subscription" && (!c.brief.plan || c.brief.plan === "report") ? [REPORT_CREDIT_TEXT] : []),
      `Payment is taken by Stripe on that page. We never take card details by phone or by email.`, ``,
      `Your report:`, reportUrl, ``, ...close,
    ];
  } else {
    const options = teaser ? emailOfferLines({ buyBase: `${base}/buy/${teaser.token}`, has: c.brief.plan, switches: c.brief.playbook?.switches }) : [];
    subject = "Your In The Answer report, as asked on the phone";
    lines = [
      `Hello,`, ``,
      `As you asked on the phone, here is your report:`, reportUrl, ``,
      ...(options.length ? [`The plans, if you want it fixed:`, ``, ...options, ``, priceNote(), ``] : []),
      ...close,
    ];
  }
  await queueMessage({
    type: "requested_on_call", toEmail: to, subject, bodyText: lines.join("\n"),
    clinicId: c.clinic_id, idempotencyKey: `call-send:${c.id}:${what}:${plan ?? ""}`, priority: 10,
  });
  c.signals.sent = [...new Set([...(c.signals.sent ?? []), what === "checkout" ? `checkout:${plan}` : what])];
  return true;
}

/** A line that asks whether to email something, as opposed to one that says it is being emailed. */
export const ASKS_TO_SEND = /\b(shall|should|would|could|can|may|want|like)\b[^.?!]*\b(i|we|me|us)\b[^.?!]*\b(e-?mail\w*|send\w*)\b[^.?!]*\?\s*$/i;

/** Said when the playbook check stops a line: back to the report, where every call is on firm ground. */
const BACK_TO_REPORT = "Let me stay with what's in your report. What would you like to hear more about?";

const inCity = (m: { name: string; city: string | null }) => `${m.name}${m.city ? ` in ${m.city}` : ""}`;

export const LINES = {
  stillThere: "Are you still there?",
  silenceBye: "I can't hear anyone, so I'll end the call here. You can reach us any time at intheanswer dot c a. Goodbye.",
  repeat: "Sorry, I missed that. Could you say it again?",
  trouble: (owner: string) => `I'm sorry, I'm having trouble on my end. ${owner} will follow up with you. Thanks, and goodbye.`,
  noCalls: "Understood. We won't call this number again. Goodbye.",
  noContact: "Understood. We won't contact you again, by phone or by email. Goodbye.",
  timeUp: (owner: string) => `We've reached the end of the time for this call. ${owner} will follow up on anything still open. Thanks, and goodbye.`,
  reportReady: (clinic: string) => `Thanks. I have the report for ${clinic} in front of me. Would you like the headline result first, or do you have a question about it?`,
  codeMissing: "I couldn't find a report with that code. Could you give me the six digits again, or just tell me the clinic's name and city?",
  codeGiveUp: "I still can't find that report. I can tell you how the service works, or have our team follow up. Which would you like?",
  clinicOne: (m: { name: string; city: string | null }) => `I found ${inCity(m)}. Is that your clinic?`,
  clinicSeveral: (found: { name: string; city: string | null }[]) =>
    `I found ${found.length === 2 ? "two" : "a few"} with a name like that: ${found.slice(0, -1).map(inCity).join(", ")}, and ${inCity(found[found.length - 1])}. Which one is yours?`,
  clinicMissing: "I couldn't find a report under that name. Could you say the clinic's name once more, and the city it's in? Or key in the six digit code from the report.",
  clinicGiveUp: (owner: string) => `I'm sorry, I still can't find it. I can tell you how the service works, or have ${owner} follow up with you. Which would you like?`,
  wrongNumber: "Sorry to have troubled you. We won't call this number again. Goodbye.",
};

/** How many names may match nothing before the agent stops asking and offers the owner instead. */
export const MAX_NAME_MISSES = 3;

export interface TurnInput {
  speech?: string | null;
  digits?: string | null;
}

/** The provider posts what the person said; the answer is the next line. */
export async function onTurn(token: string, input: TurnInput): Promise<string> {
  const c = await loadCall({ token });
  if (!c || c.status !== "in_progress" || !c.brief) return hangUp();
  const settings = await getSettings();
  const turnUrl = voiceUrl("turn", c.token);
  const owner = c.brief.contact.ownerName;
  const heard = (input.speech ?? "").replace(/\s+/g, " ").trim().slice(0, 1000) || (input.digits ?? "").replace(/\D/g, "").slice(0, 20);
  const spokenIn = resolveVoice(settings.call_voice);
  // Every line said through here is the service's own fixed text unless it is marked as the model's.
  const say = async (line: string, action: Action, extra: { blockedText?: string | null; flags?: SpokenFlag[]; fromModel?: boolean } = {}) => {
    await addTurn(c.id, "agent", line, { action, blockedText: extra.blockedText, flags: extra.flags, fixed: !extra.fromModel });
    await saveProgress(c);
    if (action === "continue") {
      // until the clinic is known, six keyed digits end the wait at once: they are a report code
      const hints = [...hintsFor(c.brief), ...(c.state.lookup?.found ?? []).flatMap((f) => [f.name, f.city ?? ""])].filter(Boolean);
      return sayAndListen(line, turnUrl, { hints, digits: c.clinic_id ? undefined : 6, voice: spokenIn, timeout: listenFor(line) });
    }
    await closeOurEnd(c);
    return sayAndHangUp(line, spokenIn);
  };
  /** Put a clinic's report in front of the agent for the rest of the call. False when it has none that passed the gate. */
  const attach = async (clinicId: string, reportId: string | null, by: NonNullable<Signals["identified_by"]>): Promise<boolean> => {
    const brief = await briefForClinic(clinicId, reportId);
    if (!brief?.clinic) return false;
    const sql = db();
    c.clinic_id = clinicId;
    c.brief = brief;
    c.signals.identified_by = by;
    delete c.state.lookup;
    await sql`update calls set clinic_id=${clinicId}, report_id=${brief.reportId}, brief=${sql.json(brief as never)} where id=${c.id}`;
    return true;
  };
  c.state.turns = (c.state.turns ?? 0) + 1;

  // Silence: ask once, then let the line go. A caller we were already talking with, and can write to,
  // is told a summary follows by email (it is written after the call and waits for the owner's approval).
  if (!heard) {
    c.state.silences = (c.state.silences ?? 0) + 1;
    if (c.state.silences < 2) return say(LINES.stillThere, "continue");
    if (c.clinic_id && c.brief.canEmailLinks && (await callerSpoke(c.id))) {
      c.signals.summary_wanted = true;
      return say(BUYING_LINES.silenceSummary, "end_call");
    }
    return say(LINES.silenceBye, "end_call");
  }
  c.state.silences = 0;
  await addTurn(c.id, "caller", heard);

  // "Stop calling" is acted on at once, whatever the model would have made of it.
  const out = hearsOptOut(heard);
  if (out === "do_not_contact") {
    c.signals.do_not_contact = true;
    await stopAllContact(c.phone, c.clinic_id);
    return say(LINES.noContact, "do_not_contact");
  }
  if (out === "do_not_call") {
    c.signals.do_not_call = true;
    await suppressPhone(c.phone, "asked on a call not to be called", "call", c.clinic_id);
    return say(LINES.noCalls, "do_not_call");
  }

  // A caller we could not place: a report code attaches the report.
  if (!c.clinic_id) {
    const code = spokenCode(input.digits || heard);
    if (code) {
      const [rep] = await db()<{ id: string; clinic_id: string }[]>`
        select id, clinic_id from reports where call_code=${code} and clinic_id is not null and not superseded
          and coalesce(data->>'verified', 'true') <> 'false'`;
      if (rep && (await attach(rep.clinic_id, rep.id, "code"))) return say(LINES.reportReady(c.brief.clinic!.name), "continue");
      c.state.codeAttempts = (c.state.codeAttempts ?? 0) + 1;
      return say(c.state.codeAttempts >= 3 ? LINES.codeGiveUp : LINES.codeMissing, "continue");
    }
  }

  // Length: the model is told to wrap up near the limit; past it the call ends whatever it says.
  const minutes = c.started_at ? (Date.now() - c.started_at.getTime()) / 60e3 : 0;
  if (minutes > settings.call_max_minutes + 1 || c.state.turns > MAX_TURNS) return say(LINES.timeUp(owner), "end_call");

  let turn;
  try {
    const r = await brain({
      brief: c.brief, direction: c.direction, reason: reasonFor(c, await consentSource(c.consent_id)),
      transcript: await transcript(c.id), heard, minutesElapsed: minutes, minutesLimit: settings.call_max_minutes,
      found: c.clinic_id ? undefined : c.state.lookup?.found.map((f) => ({ name: f.name, city: f.city })),
      progress: {
        pains: c.state.pains ?? [], reassured: !!c.state.reassured, declined: !!c.state.declined,
        pendingCheckout: c.state.pendingCheckout ?? null, unclear: (c.state.unclear ?? 0) >= 1,
      },
    });
    turn = r.turn;
    if (r.costUsd > 0) await recordCost(null, { provider: "anthropic", operation: "call_turn", units: (r.usage ?? {}) as never, costUsd: r.costUsd, clinicId: c.clinic_id });
  } catch (e) {
    c.state.failures = (c.state.failures ?? 0) + 1;
    await addTurn(c.id, "system", `The model did not answer in time: ${(e as Error).message.slice(0, 200)}`);
    if (c.state.failures >= 2) {
      await recordHandoff(c, "The phone assistant failed twice during this call and ended it. Please follow up.");
      return say(LINES.trouble(owner), "end_call");
    }
    return say(LINES.repeat, "continue");
  }

  if (turn.action === "voicemail") {
    c.state.voicemail = true;
    await addTurn(c.id, "system", "Answering machine or phone menu: the call was ended without leaving a message.");
    await saveProgress(c);
    return hangUp();
  }

  // What the caller has shown, as the model reports it, is kept on the call: the playbook's rules read
  // it, and the after-call review checks it against what was actually said.
  const pains = PAINS.filter((p) => (c.state.pains ?? []).includes(p) || turn.pains.includes(p));
  c.state.pains = pains;
  if (turn.buying_signal) { c.state.buying = true; c.state.declined = false; }
  if (turn.declined) { c.state.declined = true; c.state.buying = false; c.state.pendingCheckout = null; }
  if (stageRank(turn.stage) > stageRank(c.state.stage)) c.state.stage = turn.stage;
  if (pains.length) c.signals.pains = pains;
  c.signals.stage = c.state.stage;
  if (turn.not_decision_maker) c.signals.not_decision_maker = true;
  if (turn.follow_up_ok) c.signals.follow_up_ok = true;

  // A caller with no code names their clinic: the system looks it up and asks them to confirm.
  // These lines are ours, not the model's, so what the caller hears about a match is always what was found.
  if (!c.clinic_id && c.direction === "inbound" && turn.action === "continue") {
    const chosen = turn.clinic_choice ? c.state.lookup?.found[Number(turn.clinic_choice) - 1] : undefined;
    if (chosen && (await attach(chosen.id, null, "name"))) return say(LINES.reportReady(c.brief.clinic!.name), "continue");
    const asked = (turn.clinic_search ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (asked) {
      const found = (await findClinics(asked)).map((m) => ({ id: m.id, name: m.name, city: m.city }));
      const misses = (c.state.lookup?.misses ?? 0) + (found.length ? 0 : 1);
      c.state.lookup = { found, misses };
      await addTurn(c.id, "system", `Looked up "${asked}": ${found.length ? found.map(inCity).join("; ") : "nothing close"}.`);
      if (found.length === 1) return say(LINES.clinicOne(found[0]), "continue");
      if (found.length > 1) return say(LINES.clinicSeveral(found), "continue");
      return say(misses >= MAX_NAME_MISSES ? LINES.clinicGiveUp(owner) : LINES.clinicMissing, "continue");
    }
  }

  // A person is wanted, or a plan must be quoted: the owner hears of it whatever happens to the call next.
  const note = (turn.handoff_note ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (note) {
    await recordHandoff(c, note);
    c.signals.choice ??= "talk_to_person";
  }

  // What the caller asked to be emailed. The buying step is the program's own: the plan, its price and
  // its term are read back in the published words, and the link goes out only on a clear yes.
  const leaving = turn.action === "do_not_call" || turn.action === "do_not_contact" || turn.action === "wrong_number";
  const plan = isOnlineTier(turn.plan) ? turn.plan : null;
  const wantsCheckout = turn.send === "checkout" && plan != null;
  if (!wantsCheckout) c.state.pendingCheckout = null; // a read-back that is not answered with a yes lapses
  // "Shall I email it to you?" is an offer, not a request: nothing is sent until the caller has answered it.
  const stillAsking = turn.send !== "checkout" && ASKS_TO_SEND.test(turn.say);
  if (turn.send && !leaving && !stillAsking) {
    if (!c.clinic_id || !c.brief.canEmailLinks) {
      await recordHandoff(c, `Asked to be emailed ${turn.send === "checkout" ? "a checkout link" : turn.send === "summary" ? "a summary of the call" : "the report"}, but no address is on file for this caller.`);
      return say(BUYING_LINES.noAddress(owner), "continue");
    }
    if (wantsCheckout) {
      c.signals.plan = plan;
      if (!offeredTo(c.brief.plan).includes(plan) || (c.brief.plan && c.brief.plan !== "report")) {
        // already on a plan: moving to another is arranged by email, so nobody is charged twice
        await recordHandoff(c, `Already a customer (${c.brief.plan}) and wants ${TIERS[plan].inSentence}: arrange the change by email.`);
        return say(BUYING_LINES.changeByEmail(owner), "continue");
      }
      if (turn.confirmed && c.state.pendingCheckout === plan) {
        c.state.pendingCheckout = null;
        if (!(await sendRequested(c, "checkout", plan))) {
          await recordHandoff(c, `Said yes to ${TIERS[plan].inSentence}, but the checkout link could not be sent. Please send it.`);
          return say(BUYING_LINES.noAddress(owner), "continue");
        }
        c.signals.choice = "start_now";
        return say(linkSent(plan), "continue");
      }
      c.state.pendingCheckout = plan;
      c.state.buying = true;
      return say(readBack(plan), "continue");
    }
    if (turn.send === "report") await sendRequested(c, "report");
    if (turn.send === "summary") {
      c.signals.summary_wanted = true;
      c.signals.choice ??= "think_it_over";
    }
  }

  // Nothing reaches the caller's ear unchecked: first the wording rules every email obeys, then the playbook.
  let checked = checkSpoken(turn.say, c.brief);
  let playFlags: PlaybookFlag[] = [];
  if (checked.ok && c.brief.playbook) {
    const pb = c.brief.playbook;
    const play = checkPlaybook(checked.text, {
      pains, buyingSignal: !!c.state.buying, declined: !!c.state.declined, pillarsNamed: c.state.pillars ?? [], reassured: !!c.state.reassured,
    }, pb.switches);
    playFlags = play.flags;
    if (!playFlags.length) {
      c.state.pillars = [...new Set([...(c.state.pillars ?? []), ...play.pillars])];
      if (pb.reassurance && checked.text.includes(pb.reassurance)) c.state.reassured = true;
    } else if (playFlags.some((f) => f.code === "promise_wording" || f.code === "reassurance_twice")) {
      // a promise in other words than the published ones is a wording fault, like any other
      checked = { ok: false, text: FALLBACK_LINE, flags: playFlags };
      playFlags = [];
    }
  }
  // a line that passed is the model's; a stopped one is replaced by a fixed line of ours
  const extra = checked.ok && !playFlags.length ? { fromModel: true } : { blockedText: turn.say, flags: [...checked.flags, ...playFlags] };
  if (!checked.ok) {
    c.state.blocked = (c.state.blocked ?? 0) + 1;
    c.signals.guard_blocks = c.state.blocked;
  }
  if (playFlags.length) {
    // off the playbook (a service nobody asked about, a second offer after a no): not a wording fault,
    // so the call goes on, back on the report
    c.state.offTrack = (c.state.offTrack ?? 0) + 1;
    c.signals.playbook_blocks = c.state.offTrack;
    checked = { ok: true, text: playFlags.some((f) => f.code === "offer_after_no") ? BUYING_LINES.afterNo : BACK_TO_REPORT, flags: [] };
  }
  // "could you say that again" twice in a row: the model is told to offer email instead
  c.state.unclear = /\b(say (it|that) again|repeat that|didn'?t (quite )?catch|missed that)\b/i.test(checked.text) ? (c.state.unclear ?? 0) + 1 : 0;

  switch (turn.action) {
    case "do_not_contact":
      c.signals.do_not_contact = true;
      await stopAllContact(c.phone, c.clinic_id);
      return say(checked.ok ? checked.text : LINES.noContact, "do_not_contact", extra);
    case "do_not_call":
      c.signals.do_not_call = true;
      await suppressPhone(c.phone, "asked on a call not to be called", "call", c.clinic_id);
      return say(checked.ok ? checked.text : LINES.noCalls, "do_not_call", extra);
    case "wrong_number":
      c.signals.wrong_number = true;
      await suppressPhone(c.phone, "wrong number", "wrong_number", c.clinic_id);
      return say(checked.ok ? checked.text : LINES.wrongNumber, "wrong_number", extra);
  }
  // Two lines stopped in one call: the model is off its brief, so a person takes over.
  if ((c.state.blocked ?? 0) >= 2) {
    await recordHandoff(c, "The phone assistant's wording was stopped twice by the spoken-word check, so it ended the call. Please read the transcript and follow up.");
    return say(LINES.trouble(owner), "end_call", { ...extra, fromModel: false });
  }
  return say(checked.text, turn.action === "end_call" && !checked.ok ? "continue" : turn.action, extra);
}

// ---------------------------------------------------------------------------
// The end of a call
// ---------------------------------------------------------------------------

const PROVIDER_FINAL: Record<string, string> = { completed: "completed", busy: "busy", "no-answer": "no_answer", failed: "failed", canceled: "failed" };

/** Answering-machine detection: a machine answered, so hang up without leaving a message. */
export async function onAmd(token: string, answeredBy: string): Promise<void> {
  if (!/^(machine|fax)/i.test(answeredBy)) return;
  const c = await loadCall({ token });
  if (!c || FINAL.has(c.status) || !c.provider_call_sid) return;
  c.state.voicemail = true;
  await saveProgress(c);
  await addTurn(c.id, "system", `Answered by ${answeredBy.replace(/[^a-z_]/gi, "")}: ended without leaving a message.`);
  await voice().endCall(c.provider_call_sid).catch(() => {});
}

/** Whether the person on the other end said anything at all. */
async function callerSpoke(callId: string): Promise<boolean> {
  const [r] = await db()<{ n: number }[]>`select count(*)::int as n from call_turns where call_id=${callId} and role='caller'`;
  return r.n > 0;
}

/**
 * We hung up (a goodbye, an opt-out, the time limit): the conversation is
 * over whether or not the provider's own report arrives, so it is closed and
 * handed to the after-call review here. An answering machine is left to
 * `onStatus`, which decides about the retry.
 */
async function closeOurEnd(c: CallRow): Promise<void> {
  const closed = await db()`update calls set status='completed', ended_at=now(), updated_at=now() where id=${c.id} and status='in_progress' returning id`;
  if (!closed.length) return;
  if (await callerSpoke(c.id)) await enqueue("review_call", `review_call:${c.id}`, { callId: c.id }, { priority: 40, maxAttempts: 3 });
  else await db()`update calls set outcome='no_conversation' where id=${c.id}`;
}

/**
 * The provider reports that the call is over, or was never answered. Outbound
 * calls report to a URL carrying the call's token; calls made to our number
 * report by the provider's own call id.
 */
export async function onStatus(where: { token: string } | { sid: string }, p: { status: string; durationSeconds?: number | null }, now = new Date()): Promise<{ status: string } | null> {
  const final = PROVIDER_FINAL[p.status];
  if (!final) return null; // ringing, in-progress: nothing to record
  const sql = db();
  const c = await loadCall(where);
  if (!c) return null;
  const seconds = Math.max(0, Math.round(p.durationSeconds ?? 0));
  // The length is recorded once, also for a call we had already closed from our end.
  if (seconds > 0 && c.duration_seconds == null) {
    await sql`update calls set duration_seconds=${seconds} where id=${c.id} and duration_seconds is null`;
    await recordCost(null, {
      provider: "twilio", operation: `call_${c.direction}`, units: { seconds, estimate: true },
      costUsd: Math.ceil(seconds / 60) * env().VOICE_EST_USD_PER_MIN, clinicId: c.clinic_id,
    });
  }
  if (FINAL.has(c.status) || c.status === "queued") return null;
  const status = final === "completed" && c.state.voicemail ? "voicemail" : final === "completed" && !c.started_at ? "no_answer" : final;
  // Nobody was reached: one more try, a couple of hours later or on the next business day.
  const retry = c.direction === "outbound" && ["no_answer", "busy", "voicemail"].includes(status) && c.attempts < MAX_ATTEMPTS
    && !c.signals.do_not_call && !c.signals.do_not_contact && !c.signals.wrong_number;
  if (retry) {
    const settings = await getSettings();
    const at = nextWindowStart(new Date(now.getTime() + 2 * 3600e3), settings);
    await sql`update calls set status='queued', provider_call_sid=null, started_at=null, duration_seconds=null, scheduled_for=${at},
                last_error=${`attempt ${c.attempts}: ${status.replace("_", " ")}`}, updated_at=now() where id=${c.id}`;
    await enqueue("place_call", `call:${c.id}:${c.attempts + 1}`, { callId: c.id }, { runAfter: at, priority: 20, maxAttempts: 4 });
    return { status: "queued" };
  }
  const spoke = await callerSpoke(c.id);
  await sql`update calls set status=${status}, ended_at=${now}, updated_at=now(),
              outcome=${spoke ? null : status === "completed" ? "no_conversation" : status} where id=${c.id}`;
  if (spoke) await enqueue("review_call", `review_call:${c.id}`, { callId: c.id }, { priority: 40, maxAttempts: 3 });
  return { status };
}

// ---------------------------------------------------------------------------
// After the call: summary for the owner, and the strict reading of what was said
// ---------------------------------------------------------------------------

export async function reviewCall(callId: string, ctx?: Pick<JobContext, "cost">): Promise<{ outcome: string; unsupported: number }> {
  const sql = db();
  const c = await loadCall({ id: callId });
  if (!c || !c.brief) throw new PermanentJobError("call or its brief is missing");
  const lines = await transcript(callId);
  const to = c.clinic_id ? await linkRecipient(c.clinic_id) : null;
  const summaryWanted = !!c.signals.summary_wanted && !!to && !c.signals.do_not_contact;
  const r = await reviewer(c.brief, lines, {
    summaryForClinic: summaryWanted,
    // the reviewer knows the brief, not how the call was asked for: without this it reports the approved answer as unsupported
    numberAnswer: numberAnswer(c.direction, reasonFor(c, await consentSource(c.consent_id))),
  });
  if (r.costUsd > 0) await ctx?.cost({ provider: "anthropic", operation: "call_review", units: (r.usage ?? {}) as never, costUsd: r.costUsd, clinicId: c.clinic_id });
  // What was done on the call outranks how the reviewer reads it.
  const outcome = c.signals.do_not_contact ? "no_contact_wanted" : c.signals.wrong_number ? "wrong_number" : r.review.outcome;
  await sql`update calls set summary=${r.review.summary}, outcome=${outcome}, review_flags=${sql.json(r.review.unsupported as never)}, updated_at=now() where id=${callId}`;

  const who = c.brief.clinic?.name ?? displayPhone(c.phone);
  const link = `${env().APP_URL}/portal/calls#call-${c.id}`;
  if (r.review.unsupported.length) {
    await sql`insert into owner_tasks (kind, clinic_id, title, body)
              values ('escalation', ${c.clinic_id}, ${`Phone call with ${who}: ${r.review.unsupported.length} statement(s) to check`},
                      ${r.review.unsupported.map((u) => `"${u.said}"\n${u.issue}`).join("\n\n") + `\n\nTranscript: ${link}`})`;
  }
  const worthMail = r.review.unsupported.length > 0 || ["interested", "wants_person"].includes(outcome) || r.review.follow_up;
  if (worthMail) {
    await queueOwnerMail("owner_alert", `call-review:${c.id}`, `Phone call with ${who}: ${outcome.replace(/_/g, " ")}`,
      [r.review.summary, ``, r.review.follow_up ? `Next step: ${r.review.follow_up}` : "",
       r.review.unsupported.length ? `\nTo check (the assistant said something its brief does not support):\n${r.review.unsupported.map((u) => `- "${u.said}": ${u.issue}`).join("\n")}` : "",
       ``, `Transcript: ${link}`].filter((x) => x !== "").join("\n"));
  }
  // The summary the caller was promised. It is written by the model, so unlike the links it is never
  // sent as it is: it waits for the owner in the review queue, and the wording check reads it first.
  const summary = (r.review.clinic_summary ?? "").replace(/\s+/g, " ").trim();
  if (summaryWanted && to && summary && c.clinic_id) {
    await queueMessage({
      type: "interested_reply", toEmail: to, subject: "A summary of our call",
      bodyText: [
        `Hello,`, ``,
        `Thank you for speaking with ${VOICE_NAME}, our AI assistant. Here is the short summary we said we would send.`, ``,
        summary, ``,
        ...(await plansBlock(c)),
        `If you would rather talk to a person, reply to this email.`, ``, signature(),
      ].join("\n"),
      clinicId: c.clinic_id, idempotencyKey: `call-summary:${c.id}`, priority: 15,
      flags: scanLanguage(summary, "call summary"), forceReview: "written by the AI after a phone call: read it before it goes",
    });
  }
  // One follow-up email, only because the caller agreed to it on the call, three business days later.
  if (c.signals.follow_up_ok && c.clinic_id && to && !c.signals.do_not_contact && !c.signals.do_not_call) {
    const at = addBusinessDays(new Date(), FOLLOW_UP_BUSINESS_DAYS);
    await enqueue("call_follow_up", `call_follow_up:${c.id}`, { callId: c.id }, { runAfter: at, priority: 40, maxAttempts: 3 });
  }
  return { outcome, unsupported: r.review.unsupported.length };
}

register("review_call", async (ctx) => reviewCall((ctx.job.payload as { callId: string }).callId, ctx));

export const FOLLOW_UP_BUSINESS_DAYS = 3;

/** The report link and the plans this clinic can still be offered, as the lines of an email. */
async function plansBlock(c: CallRow): Promise<string[]> {
  if (!c.clinic_id || !c.brief?.reportToken) return [];
  const base = env().APP_URL.replace(/\/$/, "");
  const [teaser] = await db()<{ token: string }[]>`
    select token from reports where clinic_id=${c.clinic_id} and kind='teaser' and data->>'verified' = 'true' order by created_at desc limit 1`;
  const options = teaser ? emailOfferLines({ buyBase: `${base}/buy/${teaser.token}`, has: c.brief.plan, switches: c.brief.playbook?.switches }) : [];
  return [
    `Your report:`, `${base}/r/${c.brief.reportToken}`, ``,
    ...(options.length ? [`The plans:`, ``, ...options, ``, priceNote(), ...(!c.brief.plan || c.brief.plan === "report" ? [REPORT_CREDIT_TEXT] : []), ``] : []),
  ];
}

/**
 * The one follow-up a caller agreed to. Nothing is sent to a clinic that has since bought, replied,
 * asked for no contact or been called again; and it is the only one: the job key is the call.
 * Like every email to a clinic that the program did not word for a direct request, it waits for
 * the owner's approval.
 */
export async function callFollowUp(callId: string): Promise<{ queued: boolean; reason?: string }> {
  const sql = db();
  const c = await loadCall({ id: callId });
  if (!c?.clinic_id || !c.brief) return { queued: false, reason: "call or clinic missing" };
  const [clinic] = await sql<{ status: string; replied: boolean }[]>`select status::text, replied from clinics where id=${c.clinic_id}`;
  if (!clinic || ["customer", "do_not_contact", "suppressed"].includes(clinic.status)) return { queued: false, reason: `clinic is ${clinic?.status ?? "gone"}` };
  const [later] = await sql`select 1 from calls where clinic_id=${c.clinic_id} and created_at > ${c.created_at} and status='completed' and id <> ${c.id} limit 1`;
  if (later) return { queued: false, reason: "the clinic has been spoken to since" };
  const [inbound] = await sql`select 1 from inbound_messages where clinic_id=${c.clinic_id} and received_at > ${c.created_at} limit 1`.catch(() => []);
  if (inbound) return { queued: false, reason: "the clinic has written since" };
  const to = await linkRecipient(c.clinic_id);
  if (!to) return { queued: false, reason: "no address on file" };
  const msg = await queueMessage({
    type: "interested_reply", toEmail: to, subject: "Following up on our call",
    bodyText: [
      `Hello,`, ``,
      `You spoke with ${VOICE_NAME}, our AI assistant, on ${formatLongDate(c.started_at ?? c.created_at)} and said one follow-up was fine. This is it; there will be no other.`, ``,
      ...(await plansBlock(c)),
      `If the timing is not right, there is nothing you need to do. If you would rather talk to a person, reply to this email.`, ``, signature(),
    ].join("\n"),
    clinicId: c.clinic_id, idempotencyKey: `call-follow-up:${c.id}`, priority: 30,
  });
  return { queued: msg.created };
}

register("call_follow_up", async (ctx) => callFollowUp((ctx.job.payload as { callId: string }).callId));

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

export const CALL_RETENTION = { transcriptDays: 180, stuckMinutes: 60 } as const;

/**
 * Calls the provider never closed, and transcripts past their keep time.
 * A conversation that simply stopped (the caller hung up and no final status
 * reached us) is closed and reviewed like any other; a call that never
 * connected is marked failed.
 */
export async function callHousekeeping(now = new Date()): Promise<{ stuck: number; transcripts: number }> {
  const sql = db();
  const stale = await sql<{ id: string; status: string }[]>`
    select id, status from calls where status in ('dialing', 'in_progress') and updated_at < ${new Date(now.getTime() - CALL_RETENTION.stuckMinutes * 60e3)}`;
  for (const c of stale) {
    const spoke = c.status === "in_progress" && (await callerSpoke(c.id));
    await sql`update calls set status=${spoke ? "completed" : "failed"}, ended_at=${now}, updated_at=now(),
                last_error=${spoke ? null : "no final status from the phone provider"} where id=${c.id} and status=${c.status}`;
    if (spoke) await enqueue("review_call", `review_call:${c.id}`, { callId: c.id }, { priority: 40, maxAttempts: 3 });
  }
  const old = new Date(now.getTime() - CALL_RETENTION.transcriptDays * 86400e3);
  const gone = await sql`
    delete from call_turns where id in (
      select t.id from call_turns t join calls c on c.id=t.call_id where coalesce(c.ended_at, c.created_at) < ${old} limit 5000)
    returning 1`;
  await sql`update calls set brief=null where brief is not null and coalesce(ended_at, created_at) < ${old}`;
  return { stuck: stale.length, transcripts: gone.length };
}

registerScheduled({
  name: "call_housekeeping",
  every: "hour",
  // If this code runs before the calls migration has been applied, there is nothing to tidy:
  // say so in the job result instead of failing every hour and raising a dead-job alert.
  run: ({ now }) =>
    callHousekeeping(now).catch((e: { code?: string }) => {
      if (e.code === "42P01") return { skipped: "the calls tables do not exist yet: apply supabase/migrations/20261122000001_calls.sql" };
      throw e;
    }),
});
