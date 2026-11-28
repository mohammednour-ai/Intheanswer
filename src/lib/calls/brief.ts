import { db } from "../db";
import { ownerDetails, priceNote } from "../env";
import { DEFAULT_SWITCHES, POSITIONING_SHORT, REPORT_CREDIT_TEXT, phoneOfferLines, planName, reassurance, speakableAmounts, type Switches } from "../offer";
import { DISCOVERY, bridgeFor, fixedSentences, painsOffered, type Pain } from "./playbook";
import { offerSwitches } from "../offerSwitches";
import { answersFor } from "../answers";
import { LIVE_SUBSCRIPTION } from "../payments/checkout";
import { FIXES, type FullReportData } from "../reports/fullReport";
import { rowTrend, type ComparisonData } from "../reports/monthly";
import { headline } from "../reports/renderTeaser";
import type { TeaserData } from "../reports/types";

/**
 * What the phone agent is allowed to say on one call.
 *
 * The brief is assembled from stored data only: the report as it was saved
 * after the verification gate, the published prices, and the owner's approved
 * answers. The agent is told to state nothing that is not in it, and the brief
 * is frozen on the call row so the transcript can be checked against it later.
 */
export interface CallBrief {
  kind: "teaser" | "monthly" | "retest" | "full" | "general";
  clinic: { id: string; name: string; city: string | null; domain: string | null } | null;
  reportId: string | null;
  reportToken: string | null;
  /** What the clinic already pays for, if anything: a plan key from src/lib/offer.ts, as stored (a retired plan keeps its old key). */
  plan: string | null;
  /** The report, line by line. Empty for a caller we could not match to a report. */
  report: string[];
  /** The paid options this clinic can still be offered, from the published prices. */
  offers: string[];
  /** Who we are and how the service works. */
  company: string[];
  /** The owner's approved answers to common questions. */
  answers: { question: string; answer: string }[];
  contact: { ownerName: string; title: string; businessName: string; phone: string; email: string };
  /** Dollar amounts the agent may say. Anything else is stopped before it is spoken. */
  allowedAmounts: number[];
  /** Names and quoted text taken from stored data: not our wording, so the wording scan skips them. */
  names: string[];
  quoted: string[];
  /** An address is on file to send the report and the checkout links to. */
  canEmailLinks: boolean;
  /**
   * The playbook's own lines for this call (discovery questions, the bridge for each pain, the one
   * reassurance sentence), built from what the owner has switched on. Missing on a brief stored
   * before the playbook existed.
   */
  playbook?: CallPlaybook;
}

export interface CallPlaybook {
  switches: Switches;
  discovery: { pain: Pain; question: string }[];
  bridges: { pain: Pain; line: string }[];
  /** Null when no promise is switched on: then nothing is said about support, warranty or security. */
  reassurance: string | null;
  positioning: string;
}

export function playbookFor(switches: Switches): CallPlaybook {
  const offered = painsOffered(switches);
  return {
    switches,
    discovery: DISCOVERY.filter((d) => offered.includes(d.pain)),
    bridges: offered.map((pain) => ({ pain, line: bridgeFor(pain) })),
    reassurance: reassurance(switches),
    positioning: POSITIONING_SHORT,
  };
}

const STATUS: Record<string, string> = { recommended: "Recommended", listed_only: "Listed only", not_named: "Not named" };
const RESULT_KEY =
  "Each question has one of three results. Recommended: the assistant put the clinic forward as an option. Listed only: it mentioned or cited the clinic without recommending it. Not named: the clinic did not appear in the answer.";

/**
 * The paid plans as facts for the agent, from src/lib/offer.ts: the same names, prices and terms
 * the site, the report and checkout show. Nobody is sold what they already have.
 */
export function offerLines(has: string | null, switches: Switches = DEFAULT_SWITCHES): string[] {
  const plans = phoneOfferLines(has, switches);
  if (!plans.length) return [];
  return [
    ...plans,
    priceNote(),
    ...(has ? [] : [REPORT_CREDIT_TEXT]),
    "The free report is the clinic's to keep whether or not it buys anything.",
    "Buying is by card through a checkout link: the buttons at the end of the report, or a link emailed on request. Payment is never taken on a phone call.",
    "What happens after checkout: a receipt at once; the full report by email once it has been checked. On Visibility we then write to arrange access to the clinic's website, so we can publish the answer pages. On Growth there is a short form about the website, so the rebuild can begin. On both, the first monthly report comes about 30 days later.",
    "Refunds and cancelling: the one-time report is refunded when it has not yet been delivered. A monthly plan can be ended at any time after its minimum term; Visibility has no minimum term. Requests go by email from the address the clinic paid with.",
    ...(has && has !== "report" ? ["A clinic already on a monthly plan moves to a larger one by email, so the first plan is ended properly."] : []),
  ];
}

/** Dollar amounts the agent may say: the published prices of the plans bought online. Never the quoted one. */
export function allowedAmounts(): number[] {
  return speakableAmounts();
}

function companyLines(): string[] {
  const o = ownerDetails();
  // the business name is said only when it is not the brand itself
  const legal = o.businessName.trim().toLowerCase() === "in the answer" ? "" : ` (business name: ${o.businessName})`;
  return [
    `In The Answer is an Ontario company${legal} that builds websites and systems, connects AI to them, and does AI marketing. Website: intheanswer.ca.`,
    "It tests whether AI assistants name a local clinic when patients ask for a recommendation, sends the clinic a free report, and offers to fix what it finds.",
    "How the test works: we ask an AI assistant, with web search turned on, the questions a patient in the clinic's city would ask, and record every answer in full, including which clinics it named and the sources it used.",
    "How the website check works: we read the clinic's own public website (robots.txt is respected) and look at what it states for patients and for the tools assistants use to read it, such as hours, whether new patients are accepted, fees and insurance, who the practitioners are, and whether the site can be read on a phone and by AI crawlers.",
    "Any clinic can ask for its own free report by entering its website on intheanswer.ca; it is emailed, usually within one business day.",
    "We do not collect patient information. The email address we write to is one the clinic publishes on its own website.",
    "No one can guarantee what an AI assistant will say. We report what it said and fix what we can see.",
  ];
}

function teaserLines(d: TeaserData): string[] {
  const out = [
    `This is the free report for ${d.clinic.name} in ${d.clinic.city}, Ontario.`,
    `The test: on ${d.test.date} we asked ${d.test.assistant} (model ${d.test.servedModels.join(", ")}, web search on) ${d.test.questionCount} questions a patient in ${d.clinic.city} might ask when looking for a ${d.sector.patientNoun}.`,
    `Headline: ${headline(d)}`,
    d.summary[0],
    d.summary[1],
    RESULT_KEY,
  ];
  for (const r of d.rows) {
    const others = r.namedInstead.length ? r.namedInstead.join(", ") : "none";
    out.push(`Question ${r.questionIndex + 1}: "${r.question}" Result for ${d.clinic.name}: ${STATUS[r.status]}. ${r.status === "recommended" ? "Other clinics also recommended in that answer" : "Clinics the answer recommended"}: ${others}.`);
  }
  d.findings.forEach((f, i) => {
    const fix = FIXES[f.checkKey];
    out.push(`Website finding ${i + 1}, ${f.title}: ${f.text}${fix ? ` What the full report gives for it: ${fix}` : ""}`);
  });
  out.push(`The free report shows the ${d.findings.length === 1 ? "one" : d.findings.length === 2 ? "two" : "three"} most concrete findings. In all we found ${d.findingsTotal} gaps on the ${d.pagesRead} pages we read on ${d.clinic.domain}; the full report covers every one with its fix.`);
  out.push(`Limits of the test: ${d.limits}`);
  return out;
}

function comparisonLines(d: ComparisonData): string[] {
  const out = [
    `This is the ${d.kind === "monthly" ? "monthly report" : "retest report"} for ${d.clinic.name} in ${d.clinic.city}, Ontario.`,
    `The test: ${d.test.assistant} (model ${d.test.model}, web search on), on ${d.test.date}.`,
    ...d.summary,
    RESULT_KEY,
  ];
  for (const r of d.rows) {
    out.push(`Question ${r.questionIndex + 1}: "${r.question}" ${r.before ? `At the previous test: ${STATUS[r.before]}.` : "No earlier result for this question."} Now: ${STATUS[r.now]} (${rowTrend(r)}).`);
  }
  for (const p of d.installed) out.push(`Page that went live since the last report: "${p.title}", answering "${p.question}", live since ${p.wentLive}.`);
  for (const f of d.fixed) out.push(`Earlier finding no longer found, ${f.label}: before, ${f.before} Now, ${f.now}`);
  out.push(`Limits of the test: ${d.limits}`);
  return out;
}

function fullLines(d: FullReportData, teaser: TeaserData | null): string[] {
  const out = [`This is the full report and fix files for ${d.clinic.name} in ${d.clinic.city}, Ontario.`];
  if (d.score && d.testDate) out.push(`At the test on ${d.testDate}, ${d.clinic.name} was recommended in ${d.score.recommended} of ${d.score.total} answers.`);
  if (teaser) {
    out.push(RESULT_KEY);
    for (const r of teaser.rows) {
      out.push(`Question ${r.questionIndex + 1}: "${r.question}" Result: ${STATUS[r.status]}. Clinics the answer recommended: ${r.namedInstead.join(", ") || "none"}.`);
    }
  }
  out.push(`The report lists ${d.findings.length} findings, each with its fix.`);
  d.findings.slice(0, 14).forEach((f, i) => out.push(`Finding ${i + 1}, ${f.label}: ${f.seen}${f.fix ? ` Fix in the pack: ${f.fix}` : ""}`));
  if (d.findings.length > 14) out.push(`The remaining ${d.findings.length - 14} findings are in the report itself.`);
  if (d.siteTest) out.push(`The full site test crawled ${d.siteTest.pages} pages. "Could not test" in that table means the check could not be run, not that something is wrong.`);
  for (const p of d.pages.slice(0, 6)) out.push(`Page proposed for the site: "${p.title}". Why: ${p.reason}`);
  out.push("The fix files include structured data for the site, built from confirmed facts, with brackets where the clinic must confirm a fact.");
  out.push(`All wording for the site is a draft: the clinic confirms every fact before publishing. ${d.regulatorNote}`);
  out.push("This report reflects one assistant, the questions listed, on the test date. Assistants change what they recommend, and results can differ between assistants. No one can guarantee that a clinic will be named.");
  return out;
}

async function approvedAnswers(): Promise<{ question: string; answer: string }[]> {
  // The price answer is left out: the plans and their prices are listed in full just above it in the brief.
  return (await answersFor("phone")).filter((a) => a.key !== "price").map(({ question, answer }) => ({ question, answer }));
}

function contact(): CallBrief["contact"] {
  const o = ownerDetails();
  return { ownerName: o.name, title: o.title, businessName: o.businessName, phone: o.phone, email: o.email };
}

/** For a caller we cannot match to a clinic: the service and its prices, no report. */
export async function generalBrief(): Promise<CallBrief> {
  const switches = await offerSwitches();
  return {
    kind: "general", clinic: null, reportId: null, reportToken: null, plan: null, report: [],
    offers: offerLines(null, switches), company: companyLines(), answers: await approvedAnswers(), contact: contact(),
    allowedAmounts: allowedAmounts(), names: [], quoted: fixedSentences(switches), canEmailLinks: false,
    playbook: playbookFor(switches),
  };
}

const EXPLAINABLE = ["teaser", "monthly", "retest", "full"];

/**
 * What a clinic already pays for, as stored. A live subscription whose plan we cannot name counts as
 * the largest plan, so nothing is sold to it by mistake.
 */
export async function currentPlan(clinicId: string): Promise<string | null> {
  const sql = db();
  const [sub] = await sql<{ plan: string | null }[]>`
    select plan from subscriptions where clinic_id=${clinicId} and status in ${sql(LIVE_SUBSCRIPTION)} order by created_at desc limit 1`;
  if (sub) return sub.plan ?? "transformation";
  const [order] = await sql`select 1 from orders where clinic_id=${clinicId} and kind='one_time' and status in ('paid', 'partially_refunded') limit 1`;
  return order ? "report" : null;
}

/** The address the report and the checkout links can be sent to: the clinic's own contact, else where its report went. */
export async function linkRecipient(clinicId: string): Promise<string | null> {
  const sql = db();
  const [c] = await sql<{ email: string }[]>`select email from contacts where clinic_id=${clinicId} and is_primary order by found_at limit 1`;
  if (c) return c.email;
  const [m] = await sql<{ to_email: string }[]>`
    select to_email from messages where clinic_id=${clinicId} and type in ('first_email', 'self_serve_teaser', 'full_report_delivery', 'monthly_report')
    order by created_at desc limit 1`;
  return m?.to_email ?? null;
}

/**
 * The brief for a clinic: its newest report that passed the gate. `reportId`
 * picks a particular one (the report whose link the clinic used), unless it
 * has since been replaced.
 */
export async function briefForClinic(clinicId: string, reportId?: string | null): Promise<CallBrief | null> {
  const sql = db();
  const [c] = await sql<{ id: string; name: string; city: string | null; domain: string | null }[]>`
    select c.id, coalesce(c.site_name, c.name) as name, ci.name as city, c.domain
    from clinics c left join cities ci on ci.id=c.city_id where c.id=${clinicId}`;
  if (!c) return null;
  type Row = { id: string; kind: string; token: string; data: Record<string, unknown> };
  const usable = sql`kind::text in ${sql(EXPLAINABLE)} and coalesce(data->>'verified', 'true') <> 'false'`;
  let rep: Row | undefined;
  if (reportId) [rep] = await sql<Row[]>`select id, kind::text, token, data from reports where id=${reportId} and clinic_id=${clinicId} and not superseded and ${usable}`;
  if (!rep) [rep] = await sql<Row[]>`select id, kind::text, token, data from reports where clinic_id=${clinicId} and not superseded and ${usable} order by created_at desc limit 1`;
  if (!rep) return null;

  const [teaserRow] = await sql<{ data: TeaserData }[]>`
    select data from reports where clinic_id=${clinicId} and kind='teaser' and data->>'verified' = 'true' order by created_at desc limit 1`;
  const teaser = rep.kind === "teaser" ? (rep.data as unknown as TeaserData) : teaserRow?.data ?? null;
  const report =
    rep.kind === "teaser" ? teaserLines(rep.data as unknown as TeaserData)
    : rep.kind === "full" ? fullLines(rep.data as unknown as FullReportData, teaser)
    : comparisonLines(rep.data as unknown as ComparisonData);

  const plan = await currentPlan(clinicId);
  const switches = await offerSwitches();
  const names = [c.name, ...(teaser?.rows.flatMap((r) => r.namedInstead) ?? [])];
  const quoted = [
    ...(teaser?.rows.map((r) => r.question) ?? []),
    ...(teaser?.findings.flatMap((f) => f.evidence.map((e) => e.quote ?? "")) ?? []),
    ...(rep.kind === "full" ? (rep.data as unknown as FullReportData).pages.map((p) => p.title) : []),
    ...(rep.kind === "monthly" || rep.kind === "retest" ? (rep.data as unknown as ComparisonData).rows.map((r) => r.question) : []),
    // the published promise sentences are fixed wording, not ours to rephrase or to scan
    ...fixedSentences(switches),
  ];
  return {
    kind: rep.kind as CallBrief["kind"], clinic: c, reportId: rep.id, reportToken: rep.token, plan, report,
    offers: offerLines(plan, switches), company: companyLines(), answers: await approvedAnswers(), contact: contact(),
    allowedAmounts: allowedAmounts(), names: [...new Set(names.filter(Boolean))], quoted: [...new Set(quoted.filter(Boolean))],
    canEmailLinks: Boolean(await linkRecipient(clinicId)),
    playbook: playbookFor(switches),
  };
}

/** The brief as the model reads it. */
export function briefText(b: CallBrief): string {
  const c = b.contact;
  const section = (title: string, lines: string[]) => (lines.length ? `## ${title}\n${lines.map((l) => `- ${l}`).join("\n")}` : "");
  return [
    b.clinic ? `Clinic on this call: ${b.clinic.name}${b.clinic.city ? `, ${b.clinic.city}, Ontario` : ""}${b.clinic.domain ? ` (${b.clinic.domain})` : ""}.` : "Clinic on this call: not identified. There is no report in front of you.",
    b.plan ? `This clinic is already a customer (${planName(b.plan)}). Help them with their report; do not sell them what they have.` : "",
    section("The report", b.report),
    section(b.plan ? "Options this clinic does not have yet (mention only if they ask)" : "The paid options", b.offers),
    section("About In The Answer", b.company),
    b.answers.length
      ? `## Approved answers to common questions and objections\nSome were written by the owner in the first person. Give the same content speaking for the company ("we"); you are not the owner. Keep the shape: acknowledge, one fact, one question.\n${b.answers.map((a) => `- Q: ${a.question}\n  A: ${a.answer}`).join("\n")}`
      : "",
    `## Who to pass people to\n- ${c.ownerName}, ${c.title}, ${c.businessName}. Phone ${c.phone}. Email ${c.email}.`,
    b.canEmailLinks ? "An email address is on file for this clinic, so the report and the checkout links can be emailed on request." : "No email address is on file for this caller: if they want something sent, hand off to the owner.",
  ].filter(Boolean).join("\n\n");
}
