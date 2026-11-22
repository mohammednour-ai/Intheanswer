/**
 * Talk to the phone agent in the terminal, as if you were the clinic.
 *
 *   npm run call:sim                    the public sample report (invented clinic); needs no database
 *   npm run call:sim -- <report token>  a real report from the database (the part of its link after /r/)
 *   npm run call:sim -- --general       someone phones our number: no report until they name their clinic
 *                                       (looked up in the database) and confirm it
 *
 * The same brief, the same model call, the same spoken-word check and the same
 * playbook rules as on a real call; only the telephone is missing. Type what
 * the caller says and press Enter; an empty line is a silence; Ctrl+C ends.
 * Nothing is stored, dialled or sent: an email the agent would send is only
 * printed. Each reply is one model call on your ANTHROPIC_API_KEY.
 */
import readline from "node:readline";
import { closeDb, db } from "../src/lib/db";
import { ownerDetails } from "../src/lib/env";
import { sampleTeaser } from "../src/lib/reports/sample";
import { DEFAULT_SWITCHES, TIERS, isOnlineTier, offeredTo, type OnlineTier, type PillarKey } from "../src/lib/offer";
import { allowedAmounts, briefForClinic, generalBrief, offerLines, playbookFor, type CallBrief } from "../src/lib/calls/brief";
import { claudeBrain, voiceModel, type TranscriptLine } from "../src/lib/calls/agent";
import { FALLBACK_LINE, checkSpoken, hearsOptOut } from "../src/lib/calls/guard";
import { ASKS_TO_SEND, LINES, MAX_NAME_MISSES, inboundGreeting, outboundGreeting } from "../src/lib/calls/engine";
import { BUYING_LINES, PAINS, checkPlaybook, fixedSentences, linkSent, readBack, type Pain } from "../src/lib/calls/playbook";
import { findClinics } from "../src/lib/calls/lookup";
import { answersFor } from "../src/lib/answers";

/** The sample report as a brief. It needs no database; when one is reachable, the approved answers are read from it. */
async function sampleBrief(): Promise<CallBrief> {
  const answers = await answersFor("phone").then((rows) => rows.filter((a) => a.key !== "price").map(({ question, answer }) => ({ question, answer }))).catch(() => []);
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
    company: [`In The Answer is an Ontario company. It tests whether AI assistants name a local clinic when patients ask for a recommendation, and rebuilds and runs what that depends on.`],
    answers,
    contact: { ownerName: o.name, title: o.title, businessName: o.businessName, phone: o.phone, email: o.email },
    allowedAmounts: allowedAmounts(),
    names: [d.clinic.name, ...d.rows.flatMap((r) => r.namedInstead)],
    quoted: [...d.rows.map((r) => r.question), ...fixedSentences(DEFAULT_SWITCHES)],
    canEmailLinks: true,
    playbook: playbookFor(DEFAULT_SWITCHES),
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
  // where the call stands against the playbook (the engine keeps the same on the call row)
  const st = { pains: [] as Pain[], buying: false, declined: false, reassured: false, pillars: [] as PillarKey[], pendingCheckout: null as OnlineTier | null, unclear: 0 };
  const opening = inbound
    ? inboundGreeting(null)
    : outboundGreeting({ contactName: null, clinic: brief.clinic?.name ?? null, source: "web_form" });
  console.log(`\nModel: ${voiceModel()}   Brief: ${brief.kind}${brief.clinic ? `, ${brief.clinic.name}` : ""}\n`);
  console.log(`Assistant: ${opening}\n`);
  transcript.push({ role: "agent", text: opening, fixed: true });

  // Lines are read one at a time, so a typed conversation and a piped script both work.
  const rl = readline.createInterface({ input: process.stdin });
  const input = rl[Symbol.asyncIterator]();
  const started = Date.now();
  const ours = (line: string, note: string, ms: number) => {
    console.log(`\nAssistant: ${line}\n[${note} · ${ms} ms]\n`);
    transcript.push({ role: "agent", text: line, fixed: true });
  };
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
        reason: inbound ? "The caller phoned In The Answer's number." : "Someone at the clinic asked for this call on the page their report links to, typed in this number, and agreed there to be called by an AI assistant.",
        transcript, heard: heard || null, minutesElapsed: (Date.now() - started) / 60e3, minutesLimit: 10,
        found: brief.clinic ? undefined : found.map((f) => ({ name: f.name, city: f.city })),
        progress: { pains: st.pains, reassured: st.reassured, declined: st.declined, pendingCheckout: st.pendingCheckout, unclear: st.unclear >= 1 },
      }));
    } catch (e) {
      console.log(`\n[model call failed: ${(e as Error).message}; on a real call the caller hears "${LINES.repeat}"]\n`);
      continue;
    }
    const ms = Date.now() - t0;

    // what the caller showed, as the model reports it
    st.pains = PAINS.filter((p) => st.pains.includes(p) || turn.pains.includes(p));
    if (turn.buying_signal) { st.buying = true; st.declined = false; }
    if (turn.declined) { st.declined = true; st.buying = false; st.pendingCheckout = null; }
    const marks = [
      `stage ${turn.stage}`, st.pains.length ? `pains ${st.pains.join(",")}` : "", turn.buying_signal ? "buying signal" : "", turn.declined ? "declined" : "",
      turn.not_decision_maker ? "not the decision maker" : "", turn.follow_up_ok ? "follow-up agreed" : "",
      turn.handoff_note ? `hand over to the owner: ${turn.handoff_note}` : "",
    ].filter(Boolean).join(" · ");

    // The engine's own steps for a caller with no code: look the name up, ask, and attach the report on a yes.
    if (inbound && !brief.clinic && turn.action === "continue") {
      const chosen = turn.clinic_choice ? found[Number(turn.clinic_choice) - 1] : undefined;
      const picked = chosen ? await briefForClinic(chosen.id) : null;
      let line: string | null = null;
      if (picked?.clinic) {
        brief = picked;
        found = [];
        line = LINES.reportReady(picked.clinic.name);
      } else if (turn.clinic_search?.trim()) {
        found = (await findClinics(turn.clinic_search)).map((m) => ({ id: m.id, name: m.name, city: m.city }));
        if (!found.length) misses++;
        console.log(`\n[looked up "${turn.clinic_search}": ${found.length ? found.map((f) => `${f.name}${f.city ? `, ${f.city}` : ""}`).join("; ") : "nothing close"}]`);
        line = found.length === 1 ? LINES.clinicOne(found[0]) : found.length > 1 ? LINES.clinicSeveral(found)
          : misses >= MAX_NAME_MISSES ? LINES.clinicGiveUp(brief.contact.ownerName) : LINES.clinicMissing;
      }
      if (line) { ours(line, "the system's own line", ms); continue; }
    }

    // The buying step: read the plan back in the published words; the link goes out only on a clear yes.
    const plan = isOnlineTier(turn.plan) ? turn.plan : null;
    const wantsCheckout = turn.send === "checkout" && plan != null;
    if (!wantsCheckout) st.pendingCheckout = null;
    if (turn.send && !brief.canEmailLinks) { ours(BUYING_LINES.noAddress(brief.contact.ownerName), `${marks} · no address on file: handed to the owner`, ms); continue; }
    if (wantsCheckout) {
      if (!offeredTo(brief.plan).includes(plan) || (brief.plan && brief.plan !== "report")) { ours(BUYING_LINES.changeByEmail(brief.contact.ownerName), `${marks} · already a customer`, ms); continue; }
      if (turn.confirmed && st.pendingCheckout === plan) {
        st.pendingCheckout = null;
        ours(linkSent(plan), `${marks} · the checkout link for ${TIERS[plan].name} would be emailed now, without review`, ms);
        continue;
      }
      st.pendingCheckout = plan;
      st.buying = true;
      ours(readBack(plan), `${marks} · read-back, waiting for a yes`, ms);
      continue;
    }
    const sends = turn.send && ASKS_TO_SEND.test(turn.say) ? "only offering to email: nothing is sent until they say yes"
      : turn.send === "report" ? "the report and the plans would be emailed now, without review" : turn.send === "summary" ? "a summary would be written after the call and wait for the owner's approval" : "";

    let checked = checkSpoken(turn.say, brief);
    let note = "";
    if (checked.ok && brief.playbook) {
      const play = checkPlaybook(checked.text, { pains: st.pains, buyingSignal: st.buying, declined: st.declined, pillarsNamed: st.pillars, reassured: st.reassured }, brief.playbook.switches);
      if (!play.flags.length) {
        st.pillars = [...new Set([...st.pillars, ...play.pillars])];
        if (brief.playbook.reassurance && checked.text.includes(brief.playbook.reassurance)) st.reassured = true;
      } else {
        note = `stopped by the playbook: ${play.flags.map((f) => f.message).join("; ")}`;
        const wording = play.flags.some((f) => f.code === "promise_wording" || f.code === "reassurance_twice");
        checked = { ok: true, flags: [], text: wording ? FALLBACK_LINE : play.flags.some((f) => f.code === "offer_after_no") ? BUYING_LINES.afterNo : "Let me stay with what's in your report. What would you like to hear more about?" };
      }
    } else if (!checked.ok) {
      note = `stopped before it was spoken: ${checked.flags.map((f) => f.message).join("; ")}`;
    }
    if (note) console.log(`\n[${note}]\n[the model wrote: ${turn.say}]`);
    st.unclear = /\b(say (it|that) again|repeat that|didn'?t (quite )?catch|missed that)\b/i.test(checked.text) ? st.unclear + 1 : 0;
    console.log(`\nAssistant: ${checked.text}\n[${turn.action} · ${marks}${sends ? ` · ${sends}` : ""} · ${ms} ms]\n`);
    transcript.push({ role: "agent", text: checked.text, fixed: !!note });
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
