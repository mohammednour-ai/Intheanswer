import { db } from "../db";
import { env, ownerDetails, OWNER_PLACEHOLDER_RE } from "../env";
import type { JobContext } from "../jobs/queue";
import { PermanentJobError } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { randomToken } from "../tokens";
import { parsePage, textContains } from "../site/parse";
import { putFile } from "../storage";
import { effectiveDryRun } from "../settings";
import { queueMessage, signature } from "../sending/outbox";
import { scanLanguage, claudeVerifier, type Flag, type ModelVerifier } from "../pipeline/verify";
import type { Evidence } from "../pipeline/audit/types";
import type { UsageLike } from "../adapters/claude";
import { htmlToPdf } from "./pdf";
import { buildFullReportData, renderFullReport, type FullReportData } from "./fullReport";

/**
 * Fulfilment of a paid order: build the full report from stored evidence, run
 * it through the gate, render it, store it and queue the delivery email.
 * One report and one delivery email per order, however often the job runs.
 */

export interface FullGate {
  data: FullReportData;
  flags: Flag[];
  removed: { what: string; why: string }[];
  usage: UsageLike | null;
  costUsd: number;
}

/** Same test as the teaser gate: a quoted passage must still be on the stored page. */
async function quoteHolds(e: Evidence): Promise<boolean> {
  if (!e.quote || !e.url) return true;
  if (e.kind !== "page_quote" && e.kind !== "raw_source") return true;
  const [p] = await db()<{ body: string | null }[]>`select body from page_cache where url = ${e.url}`;
  if (e.kind === "raw_source") return !p?.body || p.body.includes(e.quote) || textContains(p.body, e.quote);
  return !!p?.body && textContains(parsePage(e.url, p.body).text, e.quote);
}

const evidenceText = (ev: Evidence[]) =>
  ev.map((e) => (e.kind === "pages_read" ? `[pages read] ${e.label ?? e.url ?? ""}` : `[${e.kind}] ${e.url ?? ""} ${e.quote ? `"${e.quote}"` : ""} ${e.label ?? ""}`.trim())).join("\n");

/**
 * The gate for a full report.
 * 1. The score is re-counted from the stored results; a mismatch removes it and holds the report.
 * 2. Every finding is matched again to its stored check (still a gap, same sentence, never
 *    "could not verify" or "could not test") and every quote is re-found on the stored page.
 *    What does not match is removed.
 * 3. Model pass: each surviving finding is read against its evidence; unsupported ones are removed.
 * 4. Language scan and owner placeholders. A hit holds the report for the owner.
 */
export async function verifyFullReport(
  input: FullReportData,
  opts: { live: boolean; verifier?: ModelVerifier | null; verifierErrors?: "throw" | "flag" },
): Promise<FullGate> {
  const sql = db();
  const data: FullReportData = structuredClone(input);
  const flags: Flag[] = [];
  const removed: FullGate["removed"] = [];
  const clinicId = data.clinic.id;

  // --- 1. score -----------------------------------------------------------
  if (data.score) {
    const [s] = await sql<{ test_run_id: string }[]>`select test_run_id from scores where clinic_id = ${clinicId} order by created_at desc limit 1`;
    const stored = s
      ? await sql<{ status: string }[]>`
          select r.status::text from clinic_test_results r join test_answers a on a.id = r.test_answer_id
          where r.clinic_id = ${clinicId} and a.test_run_id = ${s.test_run_id}`
      : [];
    const rec = stored.filter((x) => x.status === "recommended").length;
    if (!s || stored.length !== data.score.total || rec !== data.score.recommended) {
      flags.push({ code: "score_mismatch", message: `score ${data.score.recommended}/${data.score.total} does not match stored results ${rec}/${stored.length}; it was removed`, severity: "block" });
      removed.push({ what: "score", why: "does not match the stored test results" });
      data.score = null;
      data.testDate = null;
    }
  }

  // --- 2. findings against stored checks ----------------------------------
  const checks = await sql<{ check_key: string; result: string; is_gap: boolean; text: string }[]>`
    select ac.check_key, ac.result::text, ac.is_gap, coalesce(ac.finding_text, ac.summary) as text
    from audit_checks ac join audits a on a.id = ac.audit_id where a.clinic_id = ${clinicId} and not a.superseded`;
  const [run] = await sql<{ id: string }[]>`
    select id from site_test_runs where clinic_id = ${clinicId} and status = 'done' order by finished_at desc limit 1`;
  const siteChecks = run
    ? await sql<{ check_key: string; result: string; text: string }[]>`
        select check_key, result::text, coalesce(finding_text, line) as text from site_test_checks where run_id = ${run.id}`
    : [];
  const survivors: FullReportData["findings"] = [];
  for (const f of data.findings) {
    const site = f.key.startsWith("site:");
    const rows: { result: string; text: string; is_gap?: boolean }[] = site
      ? siteChecks.filter((x) => x.check_key === f.key.slice(5))
      : checks.filter((x) => x.check_key === f.key);
    if (!rows.length) {
      removed.push({ what: f.label, why: "no stored check" });
      continue;
    }
    if (rows.every((x) => x.result === "could_not_verify" || x.result === "could_not_test")) {
      removed.push({ what: f.label, why: "the check could not be run; it may never be stated as a problem" });
      continue;
    }
    const ok = site
      ? rows.some((x) => x.result === "needs_work" && x.text === f.seen)
      : rows.some((x) => x.is_gap && x.result !== "could_not_verify" && x.text === f.seen);
    if (!ok) {
      removed.push({ what: f.label, why: "the sentence does not match the stored check" });
      continue;
    }
    let quotes = true;
    for (const e of f.evidence ?? []) if (!(await quoteHolds(e))) quotes = false;
    if (!quotes) {
      removed.push({ what: f.label, why: "a quoted passage is no longer on the stored page" });
      continue;
    }
    survivors.push(f);
  }
  data.findings = survivors;

  // --- 3. model pass --------------------------------------------------------
  let usage: UsageLike | null = null;
  let costUsd = 0;
  const verifier = opts.verifier === undefined ? claudeVerifier : opts.verifier;
  if (!verifier) {
    flags.push({ code: "model_verification_not_run", message: "the model verification pass did not run", severity: "block" });
  } else if (data.findings.length) {
    const items = data.findings.map((f, i) => ({ id: `finding-${i}`, claim: f.seen, evidence: evidenceText(f.evidence ?? []) }));
    try {
      const r = await verifier(items);
      usage = r.usage;
      costUsd = r.costUsd;
      const drop = new Set<number>();
      for (const v of r.verdicts) {
        if (v.supported || !v.id.startsWith("finding-")) continue;
        const i = Number(v.id.split("-")[1]);
        if (data.findings[i]) {
          drop.add(i);
          removed.push({ what: data.findings[i].label, why: `verifier: ${v.issue}: ${v.explanation}` });
        }
      }
      // a finding with no verdict was not checked: it is removed, never sent as fact
      items.forEach((it, i) => {
        if (!r.verdicts.some((v) => v.id === it.id)) {
          drop.add(i);
          removed.push({ what: data.findings[i].label, why: "the verifier gave no verdict" });
        }
      });
      data.findings = data.findings.filter((_, i) => !drop.has(i));
    } catch (e) {
      if (opts.verifierErrors === "throw") throw e;
      flags.push({ code: "model_verification_not_run", message: `the model verification pass failed: ${(e as Error).message}`, severity: "block" });
    }
  }

  // --- 4. language, placeholders, something left to deliver -------------------
  if (data.findings.length === 0) {
    flags.push({ code: "no_findings", message: "no finding survived verification", severity: "block" });
  }
  const scan = (text: string, where: string) => {
    for (const f of scanLanguage(text, where)) if (!flags.some((x) => x.message === f.message)) flags.push(f);
  };
  for (const f of data.findings) scan(`${f.seen}\n${f.fix}`, `finding "${f.label}"`);
  for (const c of data.siteTest?.checks ?? []) scan(c.line, `site test "${c.label}"`);
  for (const p of data.pages) scan(`${p.title}\n${p.reason}`, `proposed page "${p.title}"`);
  if (data.firstDraft) scan([data.firstDraft.title, ...data.firstDraft.directAnswer, ...data.firstDraft.details].join("\n"), "first page draft");
  for (const t of data.reviews?.themes ?? []) scan(t.theme, "review theme");
  const o = ownerDetails();
  if ([o.name, o.businessName, o.mailingAddress, o.phone].some((v) => OWNER_PLACEHOLDER_RE.test(v))) {
    flags.push({ code: "owner_details_placeholder", message: "owner name, business name, address or phone is still a placeholder", severity: opts.live ? "block" : "warn" });
  }
  return { data, flags, removed, usage, costUsd };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export const fullReportUrl = (token: string) => `${env().APP_URL}/r/${token}`;

export function deliveryEmail(x: { data: FullReportData; reportUrl: string; pdf: boolean; intakeUrl: string | null; monthlyReports?: boolean }): { subject: string; bodyText: string } {
  const d = x.data;
  const parts = [`${d.findings.length} ${d.findings.length === 1 ? "finding" : "findings"}, each with what we saw and the fix`];
  if (d.siteTest) parts.push("the results of the full site test");
  if (d.pages.length) parts.push("the pages we propose for your site");
  parts.push("your fix files");
  const lines = ["Hello,", ""];
  if (x.intakeUrl) {
    lines.push(
      "Welcome to the full service plan. Two things to start.",
      "",
      `1. Your full report for ${d.clinic.name}:`,
      x.reportUrl,
      "",
      "2. A short form about your website, so we can begin the work:",
      x.intakeUrl,
      "Please do not put passwords in the form.",
    );
  } else if (x.monthlyReports) {
    lines.push(
      "Welcome to monthly reports.",
      "",
      `Your first full report for ${d.clinic.name} is ready:`,
      x.reportUrl,
      "",
      "Each month we retest the same questions and your website, and send you the updated report.",
    );
  } else {
    lines.push(`Your full report for ${d.clinic.name} is ready:`, x.reportUrl);
  }
  lines.push(
    "",
    "In the report:",
    ...parts.map((p) => `- ${p}`),
    ...(x.pdf ? ["", "A PDF copy is attached."] : []),
    "",
    "All wording for your site is a draft. Please confirm every fact before it is published.",
    "No one can guarantee what an AI assistant will say. We report what it said and fix what we can see.",
    "",
    "Questions: reply to this email.",
    "",
    "--",
    signature(),
  );
  const subject = x.intakeUrl ? `Welcome to the full service plan: ${d.clinic.name}`
    : x.monthlyReports ? `Your first monthly report: ${d.clinic.name}`
    : `Your full report: ${d.clinic.name}`;
  return { subject, bodyText: lines.join("\n") };
}

export interface FullReportDeps {
  /** null skips the model pass (the report is then held). Default: Claude. */
  verifier?: ModelVerifier | null;
  pdf?: (html: string) => Promise<Buffer>;
  store?: typeof putFile;
  verifierErrors?: "throw" | "flag";
  cost?: JobContext["cost"];
}

interface StoredFull extends FullReportData {
  gate?: { flags: Flag[]; removed: FullGate["removed"] };
}

export async function buildAndDeliverFullReport(orderId: string, deps: FullReportDeps = {}) {
  const sql = db();
  const [order] = await sql<{ id: string; clinic_id: string | null; kind: string; plan: string | null; status: string; customer_email: string | null; report_id: string | null }[]>`
    select id, clinic_id, kind, plan, status, customer_email, report_id from orders where id = ${orderId}`;
  if (!order) throw new PermanentJobError(`order ${orderId} not found`);
  if (!["paid", "partially_refunded"].includes(order.status)) return { skipped: `order is ${order.status}` };
  if (!order.clinic_id) throw new PermanentJobError("order has no clinic");
  // the full service plan (website work, intake form); monthly reports get the report only
  const monthly = order.kind === "subscription" && order.plan !== "reports";
  const monthlyReports = order.kind === "subscription" && order.plan === "reports";

  let report: { id: string; token: string; data: StoredFull; pdf_path: string | null } | undefined;
  if (order.report_id) {
    [report] = await sql<{ id: string; token: string; data: StoredFull; pdf_path: string | null }[]>`
      select id, token, data, pdf_path from reports where id = ${order.report_id}`;
  }
  let built = false;
  if (!report) {
    const raw = await buildFullReportData(order.clinic_id);
    const [teaser] = await sql<{ token: string }[]>`
      select token from reports where clinic_id = ${order.clinic_id} and kind = 'teaser' and data->>'verified' = 'true'
      order by superseded, created_at desc limit 1`;
    raw.onMonthlyPlan = monthly;
    raw.monthlyUrl = teaser ? `${env().APP_URL}/buy/${teaser.token}/monthly` : null;

    const gate = await verifyFullReport(raw, { live: !(await effectiveDryRun()), verifier: deps.verifier, verifierErrors: deps.verifierErrors });
    if (gate.usage && deps.cost) await deps.cost({ provider: "anthropic", operation: "verify_full_report", units: gate.usage as never, costUsd: gate.costUsd, clinicId: order.clinic_id });
    const flags = [...gate.flags];
    const token = randomToken();
    let pdfRef: string | null = null;
    let pdfBytes: number | null = null;
    try {
      const pdf = await (deps.pdf ?? htmlToPdf)(renderFullReport(gate.data, { web: false }));
      pdfRef = await (deps.store ?? putFile)(`reports/${token}.pdf`, pdf, "application/pdf");
      pdfBytes = pdf.length;
    } catch (e) {
      flags.push({ code: "pdf_failed", message: `PDF could not be rendered: ${(e as Error).message}`, severity: "block" });
    }
    const stored: StoredFull & { kind: string; verified: boolean; orderId: string } = {
      ...gate.data, kind: "full", verified: true, orderId, gate: { flags, removed: gate.removed },
    };
    const [score] = await sql<{ id: string }[]>`select id from scores where clinic_id = ${order.clinic_id} order by created_at desc limit 1`;
    report = await sql.begin(async (tx) => {
      // the order row is the lock: two runs for one order cannot both store a report
      const [o] = await tx<{ report_id: string | null }[]>`select report_id from orders where id = ${orderId} for update`;
      if (o.report_id) {
        const [r] = await tx<{ id: string; token: string; data: StoredFull; pdf_path: string | null }[]>`
          select id, token, data, pdf_path from reports where id = ${o.report_id}`;
        return r;
      }
      const [r] = await tx<{ id: string; token: string; data: StoredFull; pdf_path: string | null }[]>`
        insert into reports (clinic_id, kind, token, score_id, data, html, pdf_path, pdf_bytes)
        values (${order.clinic_id}, 'full', ${token}, ${gate.data.score ? (score?.id ?? null) : null}, ${tx.json(stored as never)},
                ${renderFullReport(gate.data, { web: true })}, ${pdfRef}, ${pdfBytes})
        returning id, token, data, pdf_path`;
      await tx`update orders set report_id = ${r.id} where id = ${orderId}`;
      built = true;
      return r;
    });
  }
  if (!report) throw new Error("report row missing");

  if (!order.customer_email) return { reportId: report.id, built, message: null, note: "no buyer email: nothing queued" };
  let intake: string | null = null;
  if (monthly) {
    const [f] = await sql<{ token: string }[]>`select token from intake_forms where order_id = ${orderId}`;
    if (!f) throw new Error("intake form for this order is missing"); // created with the payment; retry
    intake = `${env().APP_URL}/intake/${f.token}`;
  }
  const mail = deliveryEmail({ data: report.data, reportUrl: fullReportUrl(report.token), pdf: !!report.pdf_path, intakeUrl: intake, monthlyReports });
  const flags: Flag[] = [...(report.data.gate?.flags ?? [])];
  for (const f of scanLanguage(mail.subject + "\n" + mail.bodyText.split("\n--\n")[0], "email")) flags.push(f);
  const msg = await queueMessage({
    type: "full_report_delivery",
    toEmail: order.customer_email,
    subject: mail.subject,
    bodyText: mail.bodyText,
    idempotencyKey: `delivery:${orderId}`,
    clinicId: order.clinic_id,
    reportId: report.id,
    attachPdf: !!report.pdf_path,
    flags,
    claims: report.data.findings.map((f, i) => ({ id: `finding-${i}`, where: "finding", claim: f.seen, evidence: f.evidence, verified: true })),
    priority: 20,
  });
  return { reportId: report.id, built, message: msg.id, status: msg.status, findings: report.data.findings.length, removed: report.data.gate?.removed.length ?? 0 };
}

register("build_full_report", async (ctx: JobContext) => {
  const { orderId } = ctx.job.payload as { orderId?: string };
  if (!orderId) throw new PermanentJobError("no orderId");
  return buildAndDeliverFullReport(orderId, {
    cost: ctx.cost,
    // a model outage is retried; on the last attempt the report is held for the owner instead
    verifierErrors: ctx.job.attempts < ctx.job.max_attempts ? "throw" : "flag",
  });
});
