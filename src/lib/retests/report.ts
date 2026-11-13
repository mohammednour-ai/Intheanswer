import { db } from "../db";
import { env, ownerDetails, OWNER_PLACEHOLDER_RE } from "../env";
import { formatLongDate } from "../time";
import { CHECK_LABELS } from "../pipeline/audit/types";
import { scanLanguage, type Flag } from "../pipeline/verify";
import { LIMITS_LINE } from "../reports/teaser";
import {
  comparisonSummary, monthlyServices, renderComparisonReport,
  type ComparisonData, type ComparisonRow, type MonthlyServices,
} from "../reports/monthly";
import type { Claim, RowStatus } from "../reports/types";
import { htmlToPdf } from "../reports/pdf";
import { updateLivePageResults } from "../pages/workflow";
import { putFile } from "../storage";
import { randomToken } from "../tokens";
import { effectiveDryRun } from "../settings";
import { queueMessage, signature, type QueuedMessage } from "../sending/outbox";

/**
 * Builds, verifies, renders, stores and delivers the two reports that compare
 * a clinic's test with its previous one:
 *   - the monthly report for a subscriber        (reports.kind 'monthly', message type monthly_report)
 *   - the retest some weeks after a one-time purchase (reports.kind 'retest', message type retest_upgrade)
 *
 * Everything in them is assembled from stored rows; the gate (verifyComparison)
 * derives each number again from the evidence and removes what it cannot
 * support. The sentences are templates filled from the verified numbers, so
 * there is no free text for a model to check.
 */

export interface ComparisonDeps {
  pdf?: (html: string) => Promise<Buffer>;
  put?: (key: string, data: Buffer, contentType: string) => Promise<string>;
}

interface ScoreRow {
  id: string; clinic_id: string; recommended: number; listed_only: number; total: number; test_run_id: string; audit_id: string;
  created_at: Date; finished_at: Date | null; started_at: Date; assistant: string; model: string; run_label: string;
}

async function scoreRow(scoreId: string): Promise<ScoreRow | undefined> {
  const [s] = await db()<ScoreRow[]>`
    select s.id, s.clinic_id, s.recommended, s.listed_only, s.total, s.test_run_id, s.audit_id, s.created_at,
           t.finished_at, t.started_at, t.assistant, t.model, t.run_label
    from scores s join test_runs t on t.id = s.test_run_id where s.id = ${scoreId}`;
  return s;
}

async function storedResults(clinicId: string, testRunId: string) {
  return db()<{ answer_id: string; question_index: number; question: string; status: RowStatus }[]>`
    select a.id as answer_id, a.question_index, a.question, r.status::text as status
    from test_answers a join clinic_test_results r on r.test_answer_id = a.id and r.clinic_id = ${clinicId}
    where a.test_run_id = ${testRunId} order by a.question_index`;
}

async function installedSince(clinicId: string, since: Date | null) {
  const rows = await db()<{ id: string; title: string; live_url: string | null; target_question: string; at: Date }[]>`
    select p.id, p.title, p.live_url, p.target_question, e.at
    from answer_pages p
    join lateral (select max(at) as at from answer_page_events where page_id = p.id and to_status = 'live') e on true
    where p.clinic_id = ${clinicId} and p.status = 'live' and e.at is not null and (${since}::timestamptz is null or e.at > ${since})
    order by e.at`;
  return rows.map((p) => ({ pageId: p.id, title: p.title, liveUrl: p.live_url, question: p.target_question, wentLive: formatLongDate(p.at) }));
}

/** Confirmed gaps of the earlier audit that the current audit checked again and no longer reports. */
async function fixedSince(previousAuditId: string, currentAuditId: string) {
  if (previousAuditId === currentAuditId) return [];
  const rows = await db()<{ check_key: string; before: string; now: string }[]>`
    select b.check_key, coalesce(b.finding_text, b.summary) as before, n.summary as now
    from audit_checks b join audit_checks n on n.check_key = b.check_key and n.audit_id = ${currentAuditId}
    where b.audit_id = ${previousAuditId} and b.is_gap and b.result <> 'could_not_verify'
      and not n.is_gap and n.result <> 'could_not_verify'
    order by b.severity desc`;
  return rows.map((r) => ({ key: r.check_key, label: CHECK_LABELS[r.check_key] ?? r.check_key, before: r.before, now: r.now }));
}

function claimsOf(d: Omit<ComparisonData, "claims" | "summary">): Claim[] {
  const claims: Claim[] = d.rows.map((r) => ({
    id: `row-${r.questionIndex}`,
    where: "row" as const,
    claim: `Question ${r.questionIndex + 1}: ${r.before ? `${r.before} at the previous test, ` : ""}${r.now} now`,
    evidence: [
      { kind: "answer_quote" as const, ref: r.answerId, label: `This test: ${r.question}` },
      ...(r.previousAnswerId ? [{ kind: "answer_quote" as const, ref: r.previousAnswerId, label: "Previous test" }] : []),
    ],
    verified: true,
  }));
  claims.push({
    id: "summary-score", where: "summary", verified: true,
    claim: `Recommended in ${d.score.recommended} of ${d.score.total}${d.previous ? `; previously ${d.previous.recommended} of ${d.previous.total}` : ""}`,
    evidence: [{ kind: "pages_read" as const, label: `stored results of test run ${d.test.testRunId}${d.previous ? ` and ${d.previous.testRunId}` : ""}` }],
  });
  return claims;
}

export interface BuildOptions {
  kind: "monthly" | "retest";
  cycle: string;
  grace?: boolean;
  orderId?: string;
  /** The report this one follows (last month's, or the full report). */
  previousReport?: { id: string; kind: string; score_id: string | null; created_at: Date } | null;
  /** Used as the earlier score when the previous report has none: the latest score before this moment. */
  baselineBefore?: Date | null;
  monthlyUrl?: string | null;
}

export async function buildComparisonData(clinicId: string, scoreId: string, o: BuildOptions): Promise<ComparisonData> {
  const sql = db();
  const cur = await scoreRow(scoreId);
  if (!cur || cur.clinic_id !== clinicId) throw new Error("score not found for this clinic");
  const [c] = await sql<{ name: string; site_name: string | null; city: string; domain: string | null }[]>`
    select c.name, c.site_name, ci.name as city, c.domain from clinics c join cities ci on ci.id = c.city_id where c.id = ${clinicId}`;

  // the earlier score: the previous report's, else the latest score from a different test run
  let prev = o.previousReport?.score_id ? await scoreRow(o.previousReport.score_id) : undefined;
  if (!prev || prev.test_run_id === cur.test_run_id) {
    const [p] = await sql<{ id: string }[]>`
      select id from scores where clinic_id = ${clinicId} and test_run_id <> ${cur.test_run_id}
        and created_at < ${o.baselineBefore ?? cur.created_at} order by created_at desc limit 1`;
    prev = p ? await scoreRow(p.id) : undefined;
  }

  const now = await storedResults(clinicId, cur.test_run_id);
  const before = prev ? await storedResults(clinicId, prev.test_run_id) : [];
  const rows: ComparisonRow[] = now.map((r) => {
    const b = before.find((x) => x.question_index === r.question_index && x.question === r.question);
    return { questionIndex: r.question_index, question: r.question, answerId: r.answer_id, now: r.status, before: b?.status ?? null, previousAnswerId: b?.answer_id ?? null };
  });

  await updateLivePageResults(clinicId, cur.test_run_id);
  const services: MonthlyServices = o.kind === "monthly"
    ? await monthlyServices(clinicId, prev?.test_run_id ?? null, o.cycle)
    : { ...(await monthlyServices(clinicId, null)), reviews: null, pages: [] };
  const owner = ownerDetails();
  const date = formatLongDate(cur.finished_at ?? cur.started_at);
  const base: Omit<ComparisonData, "claims" | "summary"> = {
    kind: o.kind,
    verified: false,
    cycle: o.cycle,
    ...(o.kind === "monthly" ? { grace: !!o.grace } : { orderId: o.orderId }),
    clinic: { id: clinicId, name: c.site_name ?? c.name, city: c.city, domain: c.domain },
    test: { assistant: cur.assistant, model: cur.model, date, runLabel: cur.run_label, testRunId: cur.test_run_id },
    score: { id: cur.id, auditId: cur.audit_id, recommended: cur.recommended, listedOnly: cur.listed_only, total: cur.total },
    previous: prev
      ? { reportId: o.previousReport?.id ?? null, reportKind: o.previousReport?.kind ?? null, scoreId: prev.id, testRunId: prev.test_run_id,
          auditId: prev.audit_id, recommended: prev.recommended, listedOnly: prev.listed_only, total: prev.total,
          date: formatLongDate(prev.finished_at ?? prev.started_at) }
      : null,
    rows,
    installed: o.kind === "monthly" ? await installedSince(clinicId, o.previousReport?.created_at ?? null) : [],
    fixed: prev ? await fixedSince(prev.audit_id, cur.audit_id) : [],
    services,
    offer: o.kind === "retest" && o.monthlyUrl ? { monthlyUrl: o.monthlyUrl } : null,
    limits: LIMITS_LINE(cur.assistant, cur.model, date, c.city, cur.total),
    owner: { name: owner.name, businessName: owner.businessName, mailingAddress: owner.mailingAddress, phone: owner.phone, email: owner.email },
  };
  return { ...base, summary: comparisonSummary({ ...base, claims: [] }), claims: claimsOf(base) };
}

/**
 * The gate. Every number is counted again from the stored results; a change
 * with no stored evidence behind it is taken out, never stated.
 */
export async function verifyComparison(input: ComparisonData, opts: { live: boolean }): Promise<{ data: ComparisonData; flags: Flag[]; removed: { what: string; why: string }[] }> {
  const sql = db();
  const d: ComparisonData = structuredClone(input);
  const flags: Flag[] = [];
  const removed: { what: string; why: string }[] = [];
  const clinicId = d.clinic.id;

  // 1. this test: the score and every row must match the stored results
  const now = await storedResults(clinicId, d.test.testRunId);
  const rec = now.filter((r) => r.status === "recommended").length;
  const [sc] = await sql<{ recommended: number; total: number }[]>`select recommended, total from scores where id = ${d.score.id} and clinic_id = ${clinicId}`;
  if (!sc || sc.recommended !== rec || sc.total !== now.length || d.score.recommended !== rec || d.score.total !== now.length) {
    flags.push({ code: "score_mismatch", message: `score ${d.score.recommended}/${d.score.total} does not match stored results ${rec}/${now.length}`, severity: "block" });
  }
  for (const r of d.rows) {
    const s = now.find((x) => x.answer_id === r.answerId);
    if (!s || s.status !== r.now) flags.push({ code: "row_status_mismatch", message: `question ${r.questionIndex + 1}: status not supported by the stored result`, severity: "block" });
  }

  // 2. the previous test: without matching stored results the comparison is dropped, not guessed
  if (d.previous) {
    const before = await storedResults(clinicId, d.previous.testRunId);
    const brec = before.filter((r) => r.status === "recommended").length;
    if (!before.length || brec !== d.previous.recommended || before.length !== d.previous.total) {
      removed.push({ what: "previous score", why: "does not match the stored results of the previous test" });
      d.previous = null;
      for (const r of d.rows) { r.before = null; r.previousAnswerId = null; }
      d.fixed = [];
    } else {
      for (const r of d.rows) {
        if (!r.before) continue;
        const s = before.find((x) => x.answer_id === r.previousAnswerId);
        if (!s || s.status !== r.before || s.question !== r.question) {
          removed.push({ what: `question ${r.questionIndex + 1}: previous result`, why: "no stored result for the same question at the previous test" });
          r.before = null;
          r.previousAnswerId = null;
        }
      }
    }
  } else {
    for (const r of d.rows) { r.before = null; r.previousAnswerId = null; }
    d.fixed = [];
  }

  // 3. pages that went live: the page must be live now, with a recorded "live" event
  const keptPages: ComparisonData["installed"] = [];
  for (const p of d.installed) {
    const [ok] = await sql`
      select 1 from answer_pages p where p.id = ${p.pageId} and p.clinic_id = ${clinicId} and p.status = 'live'
        and exists (select 1 from answer_page_events e where e.page_id = p.id and e.to_status = 'live')`;
    if (ok) keptPages.push(p);
    else removed.push({ what: `page "${p.title}"`, why: "not recorded as live" });
  }
  d.installed = keptPages;

  // 4. findings no longer reported: both audits must say so
  if (d.previous) {
    const still = await fixedSince(d.previous.auditId, d.score.auditId);
    const kept = d.fixed.filter((f) => still.some((x) => x.key === f.key && x.before === f.before && x.now === f.now));
    for (const f of d.fixed) if (!kept.includes(f)) removed.push({ what: f.label, why: "the stored audits do not show this change" });
    d.fixed = kept;
  }

  // 5. site test changes, page results and review numbers: taken again from the stored rows
  const fresh = d.kind === "monthly" ? await monthlyServices(clinicId, d.previous?.testRunId ?? null, d.cycle) : await monthlyServices(clinicId, null);
  for (const c of d.services.siteChanges) {
    if (!fresh.siteChanges.some((x) => x.key === c.key && x.before === c.before && x.after === c.after)) removed.push({ what: `site check ${c.label}`, why: "the stored site tests do not show this change" });
  }
  d.services.siteChanges = d.services.siteChanges.filter((c) => fresh.siteChanges.some((x) => x.key === c.key && x.before === c.before && x.after === c.after));
  if (d.services.reviews) {
    // review numbers only ever come from the clinic's own connected Business Profile
    const [conn] = await sql`select 1 from gbp_connections where clinic_id = ${clinicId} and status = 'connected'`;
    if (!conn || !fresh.reviews || fresh.reviews.current.total_count !== d.services.reviews.current.total_count) {
      removed.push({ what: "review numbers", why: "no snapshot from a connected Business Profile for this month" });
      d.services.reviews = null;
    }
  }
  d.services.pages = d.kind === "monthly" ? fresh.pages : [];

  // 6. rebuild the sentences from what survived, then the language rules
  d.summary = comparisonSummary(d);
  d.claims = claimsOf(d);
  const text = [...d.summary, ...d.fixed.flatMap((f) => [f.before, f.now]), ...d.services.siteChanges.map((c) => c.line), ...d.installed.map((p) => p.title)].join("\n");
  flags.push(...scanLanguage(text, "report", knownText(d)));
  if (OWNER_PLACEHOLDER_RE.test(JSON.stringify(d.owner))) {
    flags.push({ code: "owner_details_placeholder", message: "owner name, business name, address or phone is still a placeholder", severity: opts.live ? "block" : "warn" });
  }
  d.removed = removed;
  return { data: d, flags, removed };
}

/** Names and questions taken from stored data: repeated, not worded by us, so not read as our claims. */
const knownText = (d: ComparisonData) => ({
  names: [d.clinic.name],
  quoted: [...d.rows.map((r) => r.question), ...d.installed.map((p) => p.question)],
});

export const reportUrl = (token: string) => `${env().APP_URL}/r/${token}`;

const monthName = (cycle: string) => {
  const [y, m] = cycle.split("-").map(Number);
  return new Intl.DateTimeFormat("en-CA", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 15)));
};

export function monthlyEmail(d: ComparisonData, url: string, pdf: boolean): { subject: string; bodyText: string } {
  const lines = [
    "Hello,",
    "",
    `Here is the ${monthName(d.cycle)} report for ${d.clinic.name}.`,
    "",
    ...d.summary,
    "",
    `The full report, question by question: ${url}`,
    ...(pdf ? ["A PDF copy is attached."] : []),
    "",
    "These results are from one assistant on the test date. Assistants change what they recommend, and no one can guarantee that a clinic is named.",
    "",
    "You receive this report as part of your plan. Reply to this email with any question.",
  ];
  return { subject: `${d.clinic.name}: your ${monthName(d.cycle)} report`, bodyText: lines.join("\n") + "\n\n--\n" + signature() };
}

export function retestEmail(d: ComparisonData, url: string, monthlyUrl: string): { subject: string; bodyText: string } {
  const lines = [
    "Hello,",
    "",
    `Your full report included one retest. We ran the same questions again for ${d.clinic.name}.`,
    "",
    ...d.summary,
    "",
    `The retest, question by question: ${url}`,
    "",
    "If you would like us to install the fixes and retest every month, the full service plan is here:",
    monthlyUrl,
    "",
    "These results are from one assistant on the test date. Assistants change what they recommend, and no one can guarantee that a clinic is named.",
    "",
    "This is the only retest message for your order. Reply to this email with any question.",
  ];
  return { subject: `${d.clinic.name}: your retest result`, bodyText: lines.join("\n") + "\n\n--\n" + signature() };
}

export interface DeliverInput extends BuildOptions {
  clinicId: string;
  scoreId: string;
  toEmail: string;
  messageKey: string;
  /** Extra reason to send the message to the owner first. */
  forceReview?: string;
}

/**
 * One report and one message per (clinic, kind, cycle), however often it runs:
 * the report row is found again by its cycle, and the message by its key.
 */
export async function buildAndDeliverComparison(input: DeliverInput, deps: ComparisonDeps = {}): Promise<{ reportId: string; built: boolean; message: QueuedMessage; flags: Flag[]; removed: number }> {
  const sql = db();
  type Stored = ComparisonData & { gate?: { flags: Flag[] } };
  let [report] = await sql<{ id: string; token: string; data: Stored; pdf_path: string | null }[]>`
    select id, token, data, pdf_path from reports
    where clinic_id = ${input.clinicId} and kind = ${input.kind} and data->>'cycle' = ${input.cycle} and not superseded
    order by created_at desc limit 1`;
  let built = false;
  if (!report) {
    const raw = await buildComparisonData(input.clinicId, input.scoreId, input);
    const gate = await verifyComparison(raw, { live: !(await effectiveDryRun()) });
    const flags = [...gate.flags];
    const token = randomToken();
    const html = renderComparisonReport(gate.data);
    let pdfRef: string | null = null;
    let pdfBytes: number | null = null;
    if (input.kind === "monthly") {
      try {
        const pdf = await (deps.pdf ?? htmlToPdf)(html);
        pdfRef = await (deps.put ?? putFile)(`reports/${token}.pdf`, pdf, "application/pdf");
        pdfBytes = pdf.length;
      } catch (e) {
        flags.push({ code: "pdf_failed", message: `PDF could not be rendered: ${(e as Error).message}`, severity: "block" });
      }
    }
    const stored: Stored = { ...gate.data, verified: true, gate: { flags } };
    [report] = await sql<{ id: string; token: string; data: Stored; pdf_path: string | null }[]>`
      insert into reports (clinic_id, kind, token, score_id, previous_report_id, data, html, pdf_path, pdf_bytes)
      values (${input.clinicId}, ${input.kind}, ${token}, ${input.scoreId}, ${input.previousReport?.id ?? null},
              ${sql.json(stored as never)}, ${html}, ${pdfRef}, ${pdfBytes})
      returning id, token, data, pdf_path`;
    built = true;
  }
  const d = report.data;
  const url = reportUrl(report.token);
  const mail = d.kind === "monthly" ? monthlyEmail(d, url, !!report.pdf_path) : retestEmail(d, url, d.offer?.monthlyUrl ?? `${env().APP_URL}/pricing`);
  const flags: Flag[] = [...(d.gate?.flags ?? [])];
  const main = mail.subject + "\n" + mail.bodyText.split("\n--\n")[0];
  for (const f of scanLanguage(main, "email", knownText(d))) if (!flags.some((x) => x.code === f.code)) flags.push(f);
  const message = await queueMessage({
    type: d.kind === "monthly" ? "monthly_report" : "retest_upgrade",
    toEmail: input.toEmail,
    subject: mail.subject,
    bodyText: mail.bodyText,
    idempotencyKey: input.messageKey,
    clinicId: input.clinicId,
    reportId: report.id,
    attachPdf: !!report.pdf_path,
    flags,
    claims: d.claims,
    // a retest message is about the before and after: without an earlier test the owner decides
    forceReview: input.forceReview ?? (d.kind === "retest" && !d.previous ? "no earlier test result to compare this retest with" : undefined),
    priority: 30,
  });
  return { reportId: report.id, built, message, flags, removed: d.removed?.length ?? 0 };
}
