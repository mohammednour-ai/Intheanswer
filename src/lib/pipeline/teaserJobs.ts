import { db } from "../db";
import { env } from "../env";
import type { JobContext } from "../jobs/queue";
import { PermanentJobError } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { randomToken, sha256 } from "../tokens";
import { buildTeaserData } from "../reports/teaser";
import { renderTeaser } from "../reports/renderTeaser";
import { htmlToPdf } from "../reports/pdf";
import { putFile } from "../storage";
import { buildFirstEmail } from "../emails/firstEmail";
import { verifyTeaser, scanLanguage, type Flag } from "./verify";
import { decideReview } from "../sending/modes";
import { sendJobPriority } from "../sending/priority";
import { effectiveDryRun, getSettings } from "../settings";
import type { TeaserData } from "../reports/types";

/**
 * Step 6 (build) and step 7 (verify) as two jobs. The report is not viewable
 * and the message cannot be sent until verification has run.
 */

/** Statuses a pipeline job must never overwrite. */
const CLOSED = ["suppressed", "do_not_contact", "customer", "excluded", "closed"];

export function reportUrl(token: string) {
  return `${env().APP_URL}/r/${token}`;
}

async function handleBuildTeaser(ctx: JobContext) {
  const { clinicId, scoreId, toEmail, sourceUrl, messageType } = ctx.job.payload as {
    clinicId: string; scoreId: string; toEmail?: string; sourceUrl?: string; messageType?: string;
  };
  const sql = db();
  let to = toEmail;
  let src = sourceUrl;
  if (!to) {
    const [c] = await sql<{ email: string; source_url: string }[]>`
      select email, source_url from contacts where clinic_id=${clinicId} and is_primary limit 1`;
    if (!c) throw new PermanentJobError("no contact for clinic");
    to = c.email;
    src = c.source_url;
  }
  // A clinic that can no longer be contacted (unsubscribed, bought, excluded) gets no teaser.
  const [cl] = await sql<{ status: string }[]>`select status::text from clinics where id=${clinicId}`;
  if (!cl) throw new PermanentJobError("clinic not found");
  if (CLOSED.includes(cl.status)) return { skipped: `clinic is ${cl.status}` };
  // The same address is never cold-emailed as two clinics (one practice can have two listings).
  const [dup] = await sql<{ clinic_id: string }[]>`
    select clinic_id from messages where lower(to_email)=${to.toLowerCase()} and clinic_id <> ${clinicId}
      and type in ('first_email', 'follow_up') and status in ('draft','pending_review','held','approved','scheduled','sending','sent')
    limit 1`;
  if (dup && (messageType ?? "first_email") === "first_email") {
    await sql`update clinics set status='excluded', status_reason=${`same contact address as another clinic already in outreach (${to})`}, updated_at=now() where id=${clinicId}`;
    return { skipped: "duplicate recipient" };
  }

  const token = randomToken();
  const data = await buildTeaserData(clinicId, scoreId, token);
  const draft = buildFirstEmail(data, { toEmail: to, sourceUrl: src ?? "", reportUrl: reportUrl(token) });
  const dry = await effectiveDryRun();
  // One report and one draft per score: a retry of this job finds the first ones.
  const key = `teaser:${scoreId}`;
  const made = await sql.begin(async (tx) => {
    const [existing] = await tx<{ id: string; report_id: string }[]>`select id, report_id from messages where idempotency_key=${key}`;
    if (existing) return { reportId: existing.report_id, messageId: existing.id };
    await tx`update reports set superseded=true where clinic_id=${clinicId} and kind='teaser' and not superseded`;
    await tx`update messages set status='cancelled', updated_at=now()
             where clinic_id=${clinicId} and type in ('first_email', 'self_serve_teaser') and status in ('draft', 'pending_review', 'held')`;
    const [report] = await tx<{ id: string }[]>`
      insert into reports (clinic_id, kind, token, score_id, data, html)
      values (${clinicId}, 'teaser', ${token}, ${scoreId}, ${tx.json({ ...data, verified: false } as never)}, ${renderTeaser(data)})
      returning id`;
    const [msg] = await tx<{ id: string }[]>`
      insert into messages (clinic_id, type, status, to_email, contact_source_url, subject, body_text, report_id, attach_pdf, claims, dry_run, idempotency_key)
      values (${clinicId}, ${messageType ?? "first_email"}, 'draft', ${to}, ${src ?? null}, ${draft.subject}, ${draft.bodyText},
              ${report.id}, true, ${tx.json(draft.claims as never)}, ${dry}, ${key})
      returning id`;
    await tx`update clinics set status='teaser_built', updated_at=now() where id=${clinicId} and status <> all(${CLOSED})`;
    return { reportId: report.id, messageId: msg.id };
  });
  await ctx.enqueue("verify_teaser", `verify:${made.reportId}`, { reportId: made.reportId, messageId: made.messageId, scoreId }, { priority: 60 });
  return { reportId: made.reportId, messageId: made.messageId, findings: data.findings.length };
}

async function handleVerifyTeaser(ctx: JobContext) {
  const { reportId, messageId, scoreId } = ctx.job.payload as { reportId: string; messageId: string; scoreId: string };
  const sql = db();
  const [rep] = await sql<{ data: TeaserData; token: string; clinic_id: string }[]>`select data, token, clinic_id from reports where id=${reportId}`;
  const [msg] = await sql<{ to_email: string; contact_source_url: string | null; subject: string; body_text: string; claims: never; type: string; status: string }[]>`
    select to_email, contact_source_url, subject, body_text, claims, type, status::text from messages where id=${messageId}`;
  if (!rep || !msg) throw new PermanentJobError("report or message missing");
  if (msg.status !== "draft") return { skipped: `message already ${msg.status}` };

  const settings = await getSettings();
  const dry = await effectiveDryRun(settings);
  const v = await verifyTeaser({
    data: rep.data,
    draft: { subject: msg.subject, bodyText: msg.body_text, claims: msg.claims },
    scoreId,
    live: !dry,
    withModel: true,
  });
  if (v.usage) await ctx.cost({ provider: "anthropic", operation: "verify", units: v.usage as never, costUsd: v.costUsd, clinicId: rep.clinic_id });

  // rebuild the email from what survived, then scan it again
  const draft = buildFirstEmail(v.data, { toEmail: msg.to_email, sourceUrl: msg.contact_source_url ?? "", reportUrl: reportUrl(rep.token) });
  const flags: Flag[] = v.flags.filter((f) => f.code !== "email_finding_removed");
  for (const f of scanLanguage(draft.subject + "\n" + draft.bodyText.split("\n--\n")[0], "email (rebuilt)", v.exclude)) {
    if (!flags.some((x) => x.code === f.code)) flags.push(f);
  }
  const blocked = flags.some((f) => f.severity === "block");

  const html = renderTeaser(v.data);
  let pdfRef: string | null = null;
  let pdfBytes: number | null = null;
  try {
    const pdf = await htmlToPdf(html);
    pdfRef = await putFile(`reports/${rep.token}.pdf`, pdf, "application/pdf");
    pdfBytes = pdf.length;
  } catch (e) {
    flags.push({ code: "pdf_failed", message: `PDF could not be rendered: ${(e as Error).message}`, severity: "block" });
  }
  const finalBlocked = blocked || flags.some((f) => f.code === "pdf_failed");

  // review decision (consumes the "first N" counter atomically)
  const result = await sql.begin(async (tx) => {
    const decision = await decideReview(tx as never, msg.type);
    let status: string;
    let reason: string | null = decision.reason;
    if (finalBlocked) {
      status = "held";
      reason = "verification gate: " + flags.filter((f) => f.severity === "block").map((f) => f.message).join("; ");
    } else if (decision.requiresReview) {
      status = "pending_review";
    } else if (flags.length > 0) {
      // AUTO is strict: any flag at all goes to a person
      status = "pending_review";
      reason = "AUTO mode, but the gate raised warnings";
    } else {
      status = "approved";
    }
    const claims = [...v.data.claims, ...draft.claims];
    await tx`update reports set data=${tx.json({ ...v.data, verified: true, removed: v.removed } as never)}, html=${html},
              pdf_path=${pdfRef}, pdf_bytes=${pdfBytes} where id=${reportId}`;
    await tx`update messages set status=${status}, subject=${draft.subject}, body_text=${draft.bodyText},
              claims=${tx.json(claims as never)}, flags=${tx.json(flags as never)}, gate_passed=${!finalBlocked},
              requires_review=${status !== "approved"}, review_reason=${reason}, mode_at_creation=${decision.mode},
              content_hash=${sha256(draft.subject + "\n" + draft.bodyText)},
              expires_at=${status === "pending_review" ? new Date(Date.now() + settings.pending_expiry_days * 86400e3) : null},
              updated_at=now()
              where id=${messageId}`;
    await tx`update clinics set status=${finalBlocked ? "held" : "queued"},
              status_reason=${finalBlocked ? reason : null}, updated_at=now()
              where id=${rep.clinic_id} and status <> all(${CLOSED})`;
    return { status, reason };
  });
  if (result.status === "approved") await ctx.enqueue("send_message", `send:${messageId}`, { messageId }, { priority: await sendJobPriority(rep.clinic_id) });
  return { status: result.status, flags, removed: v.removed, findings: v.data.findings.length };
}

register("build_teaser", handleBuildTeaser);
register("verify_teaser", handleVerifyTeaser);
