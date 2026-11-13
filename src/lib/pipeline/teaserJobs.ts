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
import { ensureCode, shortUrl } from "../qr";
import { effectiveDryRun, getSettings } from "../settings";
import type { TeaserData } from "../reports/types";

/**
 * Step 6 (build) and step 7 (verify) as two jobs. The report is not viewable
 * and the message cannot be sent until verification has run.
 */

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
  const token = randomToken();
  const data = await buildTeaserData(clinicId, scoreId, token);
  const draft = buildFirstEmail(data, { toEmail: to, sourceUrl: src ?? "", reportUrl: shortUrl(await ensureCode(clinicId), "e") });
  const [report] = await sql<{ id: string }[]>`
    insert into reports (clinic_id, kind, token, score_id, data, html)
    values (${clinicId}, 'teaser', ${token}, ${scoreId}, ${sql.json({ ...data, verified: false } as never)}, ${renderTeaser(data)})
    returning id`;
  const [msg] = await sql<{ id: string }[]>`
    insert into messages (clinic_id, type, status, to_email, contact_source_url, subject, body_text, report_id, attach_pdf, claims, dry_run)
    values (${clinicId}, ${messageType ?? "first_email"}, 'draft', ${to}, ${src ?? null}, ${draft.subject}, ${draft.bodyText},
            ${report.id}, true, ${sql.json(draft.claims as never)}, ${await effectiveDryRun()})
    returning id`;
  await sql`update clinics set status='teaser_built', updated_at=now() where id=${clinicId}`;
  await ctx.enqueue("verify_teaser", `verify:${report.id}`, { reportId: report.id, messageId: msg.id, scoreId }, { priority: 60 });
  return { reportId: report.id, messageId: msg.id, findings: data.findings.length };
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
  const draft = buildFirstEmail(v.data, { toEmail: msg.to_email, sourceUrl: msg.contact_source_url ?? "", reportUrl: shortUrl(await ensureCode(rep.clinic_id), "e") });
  const flags: Flag[] = v.flags.filter((f) => f.code !== "email_finding_removed");
  for (const f of scanLanguage(draft.subject + "\n" + draft.bodyText.split("\n--\n")[0], "email (rebuilt)")) {
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
              status_reason=${finalBlocked ? reason : null}, updated_at=now() where id=${rep.clinic_id}`;
    return { status, reason };
  });
  if (result.status === "approved") await ctx.enqueue("send_message", `send:${messageId}`, { messageId }, { priority: await sendJobPriority(rep.clinic_id) });
  return { status: result.status, flags, removed: v.removed, findings: v.data.findings.length };
}

register("build_teaser", handleBuildTeaser);
register("verify_teaser", handleVerifyTeaser);
