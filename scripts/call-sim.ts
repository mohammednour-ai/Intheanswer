/**
 * Talk to the phone agent in the terminal, as if you were the clinic.
 *
 *   npm run call:sim                    the public sample report (invented clinic); needs no database
 *   npm run call:sim -- <report token>  a real report from the database (the part of its link after /r/)
 *   npm run call:sim -- --general       someone phones our number: no report until they name their clinic
 *                                       (looked up in the database) and confirm it
 *
 * The same brief, the same model call and the same spoken-word check as on a
 * real call; only the telephone is missing. Type what the caller says and
 * press Enter; an empty line is a silence; Ctrl+C ends. Nothing is stored,
 * dialled or sent: an action such as "email the links" is only printed.
 * Each reply is one model call on your ANTHROPIC_API_KEY.
 */
import readline from "node:readline";
import { closeDb, db } from "../src/lib/db";
import { ownerDetails } from "../src/lib/env";
import { sampleTeaser } from "../src/lib/reports/sample";
import { COPILOT_NAME } from "../src/lib/brand";
import { allowedAmounts, briefForClinic, generalBrief, offerLines, type CallBrief } from "../src/lib/calls/brief";
import { claudeBrain, voiceModel, type TranscriptLine } from "../src/lib/calls/agent";
import { checkSpoken, hearsOptOut } from "../src/lib/calls/guard";
import { LINES, MAX_NAME_MISSES, inboundGreeting } from "../src/lib/calls/engine";
import { findClinics } from "../src/lib/calls/lookup";

/** The sample report as a brief, built without the database. */
function sampleBrief(): CallBrief {
  const d = sampleTeaser();
  const o = ownerDetails();
  const status: Record<string, string> = { recommended: "Recommended", listed_only: "Listed only", not_named: "Not named" };
  return {
    kind: "teaser",
    clinic: { id: "sample", name: d.clinic.name, city: d.clinic.city, domain: d.clinic.domain },
    reportId: null, reportToken: null, plan: null,
    report: [
      `This is the free report for ${d.clinic.name} in ${d.clinic.city}, Ontario.`,
      ...d.summary,
      ...d.rows.map((r) => `Question ${r.questionIndex + 1}: "${r.question}" Result: ${status[r.status]}. Clinics the answer recommended: ${r.namedInstead.join(", ") || "none"}.`),
      ...d.findings.map((f, i) => `Website finding ${i + 1}, ${f.title}: ${f.text}`),
      `Limits of the test: ${d.limits}`,
    ],
    offers: offerLines(null),
    company: [`In The Answer is a small Ontario service run by ${o.name}. It tests whether AI assistants name a local clinic when patients ask for a recommendation.`],
    answers: [],
    contact: { ownerName: o.name, title: o.title, businessName: o.businessName, phone: o.phone, email: o.email },
    allowedAmounts: allowedAmounts(),
    names: [d.clinic.name, ...d.rows.flatMap((r) => r.namedInstead)],
    quoted: d.rows.map((r) => r.question),
    canEmailLinks: true,
  };
}

async function loadBrief(arg: string | undefined): Promise<CallBrief> {
  if (!arg) return sampleBrief();
  if (arg === "--general") return generalBrief();
  const [r] = await db()<{ id: string; clinic_id: string | null }[]>`select id, clinic_id from reports where token=${arg}`;
  if (!r?.clinic_id) throw new Error("no report with that token (use the part of the report link after /r/)");
  const b = await briefForClinic(r.clinic_id, r.id);
  if (!b) throw new Error("that clinic has no verified report to explain");
  return b;
}

async function main() {
  const arg = process.argv[2];
  let brief = await loadBrief(arg);
  const inbound = arg === "--general";
  const transcript: TranscriptLine[] = [];
  // a caller with no code names their clinic: what was found for the name, and how often nothing was
  let found: { id: string; name: string; city: string | null }[] = [];
  let misses = 0;
  const opening = inbound
    ? inboundGreeting(null)
    : `Hi, this is the ${COPILOT_NAME}. I'm an AI assistant. Someone at your clinic asked on our website for this call about your AI visibility report. This call is transcribed so our team can review it. Is now a good time to go through the report for ${brief.clinic?.name}?`;
  console.log(`\nModel: ${voiceModel()}   Brief: ${brief.kind}${brief.clinic ? `, ${brief.clinic.name}` : ""}\n`);
  console.log(`Assistant: ${opening}\n`);
  transcript.push({ role: "agent", text: opening });

  // Lines are read one at a time, so a typed conversation and a piped script both work.
  const rl = readline.createInterface({ input: process.stdin });
  const input = rl[Symbol.asyncIterator]();
  const started = Date.now();
  for (;;) {
    process.stdout.write("Caller: ");
    const next = await input.next();
    if (next.done) break;
    const heard = String(next.value).trim();
    if (!process.stdin.isTTY) console.log(heard);
    if (heard) transcript.push({ role: "caller", text: heard });
    const out = heard ? hearsOptOut(heard) : null;
    if (out) {
      console.log(`\n[acted on without the model: ${out}; the number would be suppressed and the call ended]\n`);
      break;
    }
    const t0 = Date.now();
    let turn;
    try {
      ({ turn } = await claudeBrain({
        brief, direction: inbound ? "inbound" : "outbound",
        reason: inbound ? "The caller phoned In The Answer's number." : "Someone at the clinic asked for this call on the page their report links to.",
        transcript, heard: heard || null, minutesElapsed: (Date.now() - started) / 60e3, minutesLimit: 10,
        found: brief.clinic ? undefined : found.map((f) => ({ name: f.name, city: f.city })),
      }));
    } catch (e) {
      console.log(`\n[model call failed: ${(e as Error).message}; on a real call the caller hears "Sorry, I missed that. Could you say it again?"]\n`);
      continue;
    }
    const ms = Date.now() - t0;
    // The engine's own steps for a caller with no code: look the name up, ask, and attach the report on a yes.
    if (inbound && !brief.clinic && turn.action === "continue") {
      const chosen = turn.clinic_choice ? found[Number(turn.clinic_choice) - 1] : undefined;
      const picked = chosen ? await briefForClinic(chosen.id) : null;
      let ours: string | null = null;
      if (picked?.clinic) {
        brief = picked;
        found = [];
        ours = LINES.reportReady(picked.clinic.name);
      } else if (turn.clinic_search?.trim()) {
        found = (await findClinics(turn.clinic_search)).map((m) => ({ id: m.id, name: m.name, city: m.city }));
        if (!found.length) misses++;
        console.log(`\n[looked up "${turn.clinic_search}": ${found.length ? found.map((f) => `${f.name}${f.city ? `, ${f.city}` : ""}`).join("; ") : "nothing close"}]`);
        ours = found.length === 1 ? LINES.clinicOne(found[0]) : found.length > 1 ? LINES.clinicSeveral(found)
          : misses >= MAX_NAME_MISSES ? LINES.clinicGiveUp(brief.contact.ownerName) : LINES.clinicMissing;
      }
      if (ours) {
        console.log(`\nAssistant: ${ours}\n[the system's own line · ${ms} ms]\n`);
        transcript.push({ role: "agent", text: ours });
        continue;
      }
    }
    const checked = checkSpoken(turn.say, brief);
    if (!checked.ok) console.log(`\n[stopped before it was spoken: ${checked.flags.map((f) => f.message).join("; ")}]\n[the model wrote: ${turn.say}]`);
    const follow = [turn.email_links ? "email the links" : "", turn.handoff_note ? `hand over to the owner: ${turn.handoff_note}` : ""].filter(Boolean).join("; ");
    console.log(`\nAssistant: ${checked.text}\n[${turn.action}${follow ? ` · ${follow}` : ""} · ${ms} ms]\n`);
    transcript.push({ role: "agent", text: checked.text });
    if (["end_call", "do_not_call", "do_not_contact", "wrong_number", "voicemail"].includes(turn.action)) break;
  }
  rl.close();
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
