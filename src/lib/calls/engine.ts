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
import { COPILOT_NAME } from "../brand";
import { randomToken } from "../tokens";
import { PLAN_NAMES, PLAN_PRICES } from "../payments/stripe";
import { briefForClinic, generalBrief, linkRecipient, type CallBrief } from "./brief";
import { claudeBrain, claudeReviewer, type Action, type Brain, type Reviewer, type TranscriptLine } from "./agent";
import { checkSpoken, hearsOptOut, type SpokenFlag } from "./guard";
import { displayPhone, lastTen, normalizeCanadianPhone, spokenCode } from "./phone";
import { MAX_ATTEMPTS, callsReady, checkCall, stopAllContact, suppressPhone } from "./rules";
import { hangUp, sayAndHangUp, sayAndListen } from "./twiml";

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
  turns?: number;
  voicemail?: boolean;    // an answering machine picked up
}

interface Signals {
  handoff?: string[];        // what the person needed, for the owner
  email_links?: "queued" | "no_address";
  do_not_call?: boolean;
  do_not_contact?: boolean;
  wrong_number?: boolean;
  guard_blocks?: number;
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

async function addTurn(callId: string, role: TranscriptLine["role"], text: string, extra: { action?: string; blockedText?: string | null; flags?: SpokenFlag[] } = {}) {
  const sql = db();
  await sql`
    insert into call_turns (call_id, seq, role, text, action, blocked_text, flags)
    select ${callId}, coalesce(max(seq), 0) + 1, ${role}, ${text.slice(0, 4000)}, ${extra.action ?? null}, ${extra.blockedText ?? null},
           ${sql.json((extra.flags ?? []) as never)}
    from call_turns where call_id=${callId}`;
}

async function transcript(callId: string): Promise<TranscriptLine[]> {
  return db()<TranscriptLine[]>`select role, text from call_turns where call_id=${callId} order by seq`;
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

function outboundGreeting(c: CallRow, source: string | null): string {
  const clinic = c.brief?.clinic?.name ?? "your clinic";
  const why = source === "web_form"
    ? "Someone at your clinic asked on our website for this call about your AI visibility report."
    : "Your clinic asked us to call about your AI visibility report.";
  return `Hello${c.contact_name ? ` ${c.contact_name}` : ""}, this is the ${COPILOT_NAME}, an AI assistant calling from In The Answer. ${why} ${TRANSCRIBED} Is now a good time to go through the report for ${clinic}?`;
}

function reasonFor(c: CallRow, source: string | null): string {
  if (c.direction === "inbound") return "The caller phoned In The Answer's number.";
  return source === "web_form"
    ? "Someone at the clinic asked for this call on the page their report links to, and agreed there to be called by an AI assistant."
    : "The clinic asked to be called about its report; the owner recorded the request and scheduled this call.";
}

/** Outbound call answered: say who is calling, that it is an AI, and why. */
export async function onAnswer(token: string): Promise<string> {
  const c = await loadCall({ token });
  if (!c || c.direction !== "outbound" || !c.brief) return hangUp();
  if (c.status !== "dialing") return hangUp(); // answered twice, or already over
  const sql = db();
  await sql`update calls set status='in_progress', started_at=now(), updated_at=now() where id=${c.id} and status='dialing'`;
  const line = outboundGreeting(c, await consentSource(c.consent_id));
  await addTurn(c.id, "agent", line, { action: "continue" });
  return sayAndListen(line, voiceUrl("turn", c.token), { hints: hintsFor(c.brief) });
}

function hintsFor(b: CallBrief | null): string[] {
  return [b?.clinic?.name ?? "", "report", "In The Answer", "full report", "monthly reports", "full service plan", "recommended", "not named", "listed only"].filter(Boolean);
}

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
  return `Thank you for calling In The Answer. Our phone assistant is not available right now. Please email ${o.email.replace("@", " at ")}, or visit intheanswer dot c a. Goodbye.`;
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
    return sayAndHangUp(unavailableLine());
  }
  const clinicId = await clinicForCaller(p.from);
  const brief = (clinicId ? await briefForClinic(clinicId) : null) ?? (await generalBrief());
  await sql`update calls set clinic_id=${brief.clinic?.id ?? null}, report_id=${brief.reportId}, brief=${sql.json(brief as never)} where id=${id}`;
  const c = (await loadCall({ id }))!;
  const hello = `Thank you for calling In The Answer. This is the ${COPILOT_NAME}, an AI assistant. ${TRANSCRIBED}`;
  const line = brief.clinic
    ? `${hello} I see you are calling from the number for ${brief.clinic.name}. Would you like me to walk you through its report?`
    : `${hello} If you have a report from us, please say or key in its six digit report code. Otherwise, just tell me how I can help.`;
  await addTurn(id, "agent", line, { action: "continue" });
  return sayAndListen(line, voiceUrl("turn", c.token), { hints: hintsFor(brief), digits: brief.clinic ? undefined : 6 });
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

/** Queue the email the caller asked for: their report and the checkout links. It goes through the usual review and sending rules. */
async function emailLinks(c: CallRow): Promise<boolean> {
  if (!c.clinic_id || !c.brief?.reportToken) return false;
  const to = await linkRecipient(c.clinic_id);
  if (!to) return false;
  const base = env().APP_URL.replace(/\/$/, "");
  const [teaser] = await db()<{ token: string }[]>`
    select token from reports where clinic_id=${c.clinic_id} and kind='teaser' and data->>'verified' = 'true' order by created_at desc limit 1`;
  const p = PLAN_PRICES;
  const cad = (cents: number | null) => `${(cents ?? 0) / 100} CAD`;
  const has = c.brief.plan;
  const options = !teaser || has === "monthly" ? [] : [
    ...(has ? [] : [`- ${PLAN_NAMES.report}, ${cad(p.report.oneTime)}, one time: ${base}/buy/${teaser.token}/report`]),
    ...(has === "reports" ? [] : [`- ${PLAN_NAMES.reports}, ${cad((p.reports.monthly ?? 0) + (p.reports.firstExtra ?? 0))} for the first month, then ${cad(p.reports.monthly)} a month: ${base}/buy/${teaser.token}/reports`]),
    ...(has === "reports" ? [] : [`- ${PLAN_NAMES.monthly}, ${cad(p.monthly.monthly)} a month: ${base}/buy/${teaser.token}/monthly`]),
  ];
  const body = [
    `Hello,`, ``,
    `As you asked on the phone, here is your report:`, `${base}/r/${c.brief.reportToken}`, ``,
    ...(options.length ? [`And the options we talked about:`, ``, ...options, ``] : []),
    `If you would rather talk to a person first, reply to this email.`, ``, signature(),
  ].join("\n");
  await queueMessage({
    type: "interested_reply", toEmail: to, subject: "Your In The Answer report, as asked on the phone", bodyText: body,
    clinicId: c.clinic_id, idempotencyKey: `call-links:${c.id}`, priority: 15,
  });
  return true;
}

const LINES = {
  stillThere: "Are you still there?",
  silenceBye: "I cannot hear anyone, so I will end the call here. You can reach us any time at intheanswer dot c a. Goodbye.",
  repeat: "Sorry, I missed that. Could you say it again?",
  trouble: (owner: string) => `I am sorry, I am having trouble on my end. ${owner} will follow up with you. Thank you, and goodbye.`,
  noCalls: "Understood. We will not call this number again. Goodbye.",
  noContact: "Understood. We will not contact you again, by phone or by email. Goodbye.",
  timeUp: (owner: string) => `We have reached the end of the time for this call. ${owner} will follow up on anything still open. Thank you, and goodbye.`,
  codeFound: (clinic: string) => `Thank you. I have the report for ${clinic} in front of me. Would you like the headline result first, or do you have a question about it?`,
  codeMissing: "I could not find a report with that code. Could you give me the six digits again?",
  codeGiveUp: "I still cannot find that report. I can tell you how the service works, or have our team follow up. Which would you like?",
  wrongNumber: "I am sorry to have troubled you. We will not call this number again. Goodbye.",
};

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
  const say = async (line: string, action: Action, extra: { blockedText?: string | null; flags?: SpokenFlag[] } = {}) => {
    await addTurn(c.id, "agent", line, { action, ...extra });
    await saveProgress(c);
    if (action === "continue") return sayAndListen(line, turnUrl, { hints: hintsFor(c.brief) });
    await closeOurEnd(c);
    return sayAndHangUp(line);
  };
  c.state.turns = (c.state.turns ?? 0) + 1;

  // Silence: ask once, then let the line go.
  if (!heard) {
    c.state.silences = (c.state.silences ?? 0) + 1;
    return c.state.silences >= 2 ? say(LINES.silenceBye, "end_call") : say(LINES.stillThere, "continue");
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
      const brief = rep ? await briefForClinic(rep.clinic_id, rep.id) : null;
      if (rep && brief) {
        const sql = db();
        c.clinic_id = rep.clinic_id;
        c.brief = brief;
        await sql`update calls set clinic_id=${rep.clinic_id}, report_id=${brief.reportId}, brief=${sql.json(brief as never)} where id=${c.id}`;
        return say(LINES.codeFound(brief.clinic!.name), "continue");
      }
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

  // Nothing reaches the caller's ear unchecked.
  const checked = checkSpoken(turn.say, c.brief);
  const extra = checked.ok ? {} : { blockedText: turn.say, flags: checked.flags };
  if (!checked.ok) {
    c.state.blocked = (c.state.blocked ?? 0) + 1;
    c.signals.guard_blocks = c.state.blocked;
  }

  // Follow-ups the model asked for go with whatever happens to the call next.
  const note = (turn.handoff_note ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (note) await recordHandoff(c, note);
  if (turn.email_links && c.signals.email_links !== "queued") {
    const queued = await emailLinks(c);
    c.signals.email_links = queued ? "queued" : "no_address";
    if (!queued) await recordHandoff(c, "Asked to be emailed the report and the links, but no address is on file for this caller.");
  }

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
    return say(LINES.trouble(owner), "end_call", extra);
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
  const r = await reviewer(c.brief, lines);
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
  return { outcome, unsupported: r.review.unsupported.length };
}

register("review_call", async (ctx) => reviewCall((ctx.job.payload as { callId: string }).callId, ctx));

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
