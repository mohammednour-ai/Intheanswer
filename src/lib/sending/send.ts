import { db } from "../db";
import { env, ownerDetails, ownerDetailsComplete } from "../env";
import { DeferJob, enqueue, type JobContext } from "../jobs/queue";
import { register } from "../jobs/handlers";
import { effectiveDryRun, getSettings } from "../settings";
import { getFile } from "../storage";
import { unsubscribeToken, unsubscribeUrl } from "../tokens";
import { fromHeader, mail } from "../adapters/mail";
import { checkSend, COLD_TYPES } from "./rules";
import { ALWAYS_AUTO } from "./modes";
import { queueMessage, signature } from "./outbox";
import { addBusinessDays, localDate } from "../time";
import { registerScheduled } from "../schedule/tick";

/**
 * The send job. Approval only queues this job: every rule (kill switch,
 * auto-pause, DNS gate, suppression, two-contact limit, hours, warm-up cap,
 * spacing) is applied here, at the moment of sending, in both modes.
 *
 * Dry run: everything runs, the message is marked sent with dry_run = true,
 * a send_audit_log row is written, and nothing leaves. A message created or
 * approved while in dry run stays a dry-run message even if the app goes live
 * before its turn, so switching to live never releases a backlog by surprise.
 */

/** Types addressed to people outside the business (they get the unsubscribe header). */
const OWNER_TYPES = new Set(["owner_digest", "owner_alert"]);
const SEND_LOCK = 724001; // advisory lock: one send decision at a time, so caps cannot be overrun

interface Row {
  id: string;
  type: string;
  status: string;
  to_email: string;
  clinic_id: string | null;
  subject: string;
  body_text: string;
  body_html: string | null;
  report_id: string | null;
  attach_pdf: boolean;
  contact_source_url: string | null;
  content_hash: string | null;
  inbound_id: string | null;
  dry_run: boolean;
  updated_at: Date;
}

/** What must be in a message to a clinic before it may leave (CASL identification + unsubscribe). */
export function identificationProblems(type: string, body: string): string[] {
  if (OWNER_TYPES.has(type)) return [];
  const o = ownerDetails();
  const problems: string[] = [];
  const has = (s: string) => body.toLowerCase().includes(s.toLowerCase());
  if (!has(o.name)) problems.push("the sender's name is missing");
  if (!has(o.mailingAddress)) problems.push("the mailing address is missing");
  if (COLD_TYPES.has(type) || type === "self_serve_teaser") {
    if (!/\/unsubscribe\//.test(body)) problems.push("the unsubscribe link is missing");
  }
  return problems;
}

export async function sendMessage(messageId: string, ctx?: Pick<JobContext, "log" | "job">, now = new Date()): Promise<{ outcome: string; reason?: string }> {
  const sql = db();
  const settings = await getSettings();
  const appDry = await effectiveDryRun(settings);

  // Decide under a lock, and mark the message "sending" before the lock is
  // released, so two workers can never both pass the daily cap or the spacing.
  const decision = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${SEND_LOCK})`;
    const [m] = await tx<Row[]>`select id, type::text, status::text, to_email, clinic_id, subject, body_text, body_html, report_id,
                                       attach_pdf, contact_source_url, content_hash, inbound_id, dry_run, updated_at
                                from messages where id = ${messageId} for update`;
    if (!m) return { kind: "gone" as const };
    const stuck = m.status === "sending" && now.getTime() - m.updated_at.getTime() > 10 * 60e3; // a worker died mid-send
    if (!["approved", "scheduled"].includes(m.status) && !stuck) return { kind: "skip" as const, status: m.status };
    const dry = appDry || m.dry_run;
    const check = await checkSend({ id: m.id, type: m.type, to_email: m.to_email, clinic_id: m.clinic_id }, settings, now, { dryRun: dry });
    if (check.outcome === "block") {
      await tx`update messages set status='blocked', last_error=${check.reason}, updated_at=now() where id=${m.id}`;
      return { kind: "block" as const, reason: check.reason };
    }
    if (check.outcome === "defer") {
      await tx`update messages set status='scheduled', scheduled_for=${check.retryAt ?? null}, last_error=${check.reason}, updated_at=now() where id=${m.id}`;
      return { kind: "defer" as const, reason: check.reason, retryAt: check.retryAt ?? new Date(now.getTime() + 3600e3) };
    }
    const problems = identificationProblems(m.type, m.body_text);
    if (!dry && !ownerDetailsComplete().ok) problems.push(`owner details are still placeholders (${ownerDetailsComplete().missing.join(", ")})`);
    if (problems.length) {
      const reason = `not sent: ${problems.join("; ")}`;
      await tx`update messages set status='held', requires_review=true, review_reason=${reason}, updated_at=now() where id=${m.id}`;
      return { kind: "held" as const, reason };
    }
    await tx`update messages set status='sending', sent_at=${now}, updated_at=now() where id=${m.id}`;
    return { kind: "send" as const, m, dry };
  });

  if (decision.kind === "gone") return { outcome: "gone" };
  if (decision.kind === "skip") return { outcome: "skipped", reason: `message is ${decision.status}` };
  if (decision.kind === "block") return { outcome: "blocked", reason: decision.reason };
  if (decision.kind === "held") return { outcome: "held", reason: decision.reason };
  if (decision.kind === "defer") {
    // The DNS gate heals itself: look again (at most hourly) instead of waiting for the owner.
    if (/SPF\/DKIM\/DMARC/.test(decision.reason)) await enqueue("check_dns", `dns:${now.toISOString().slice(0, 13)}`, {}, { priority: 20 });
    const secs = Math.max(60, Math.ceil((decision.retryAt.getTime() - now.getTime()) / 1000));
    throw new DeferJob(secs, decision.reason);
  }

  const { m, dry } = decision;
  let providerId: string | null = null;
  try {
    if (!dry) {
      const e = env();
      const headers: Record<string, string> = {};
      if (!OWNER_TYPES.has(m.type)) {
        headers["List-Unsubscribe"] = `<${e.APP_URL}/api/unsubscribe/${unsubscribeToken(m.to_email)}>`;
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      }
      if (m.inbound_id) {
        const [inb] = await sql<{ message_id: string | null }[]>`select raw->>'messageId' as message_id from inbound_messages where id=${m.inbound_id}`;
        if (inb?.message_id) {
          headers["In-Reply-To"] = inb.message_id;
          headers["References"] = inb.message_id;
        }
      }
      const attachments: { filename: string; content: Buffer }[] = [];
      if (m.attach_pdf && m.report_id) {
        const [rep] = await sql<{ pdf_path: string | null }[]>`select pdf_path from reports where id=${m.report_id}`;
        const pdf = rep?.pdf_path ? await getFile(rep.pdf_path) : null;
        if (!pdf) throw new Error("the report PDF could not be loaded for the attachment");
        attachments.push({ filename: "in-the-answer-report.pdf", content: pdf });
      }
      const res = await mail().send({
        from: fromHeader(),
        to: m.to_email,
        subject: m.subject,
        text: m.body_text,
        html: m.body_html,
        replyTo: e.MAIL_REPLY_TO,
        headers,
        attachments,
        idempotencyKey: `msg-${m.id}`,
      });
      providerId = res.id;
    }
  } catch (err) {
    // back to approved: the job's retry (with backoff) tries again; the idempotency key prevents a double send
    const final = ctx ? ctx.job.attempts >= ctx.job.max_attempts : false;
    await sql`update messages set status=${final ? "failed" : "approved"}, sent_at=null, last_error=${(err as Error).message}, updated_at=now() where id=${m.id}`;
    throw err;
  }

  await sql.begin(async (tx) => {
    await tx`update messages set status='sent', sent_at=${now}, provider_message_id=${providerId}, dry_run=${dry}, last_error=null, updated_at=now() where id=${m.id}`;
    await tx`insert into send_audit_log (message_id, recipient, recipient_source_url, sent_at, content_hash, unsubscribe_status, dry_run, provider_message_id)
             values (${m.id}, ${m.to_email}, ${m.contact_source_url}, ${now}, ${m.content_hash ?? ""},
                     ${OWNER_TYPES.has(m.type) ? "owner mail" : "not_suppressed; link included"}, ${dry}, ${providerId})`;
    if (!dry && m.clinic_id && COLD_TYPES.has(m.type)) {
      await tx`update clinics set contact_count = contact_count + 1,
                 status = case when status in ('queued', 'teaser_built', 'contacted') then 'contacted'::clinic_status else status end,
                 status_reason = null, updated_at = now() where id = ${m.clinic_id}`;
    }
    if (!dry && m.clinic_id && m.type === "self_serve_teaser") {
      await tx`update clinics set status = case when status in ('queued', 'teaser_built') then 'contacted'::clinic_status else status end, updated_at = now() where id = ${m.clinic_id}`;
      await tx`update self_serve_requests set status='sent' where clinic_id=${m.clinic_id} and status in ('running', 'received')`;
    }
    if (m.inbound_id) await tx`update inbound_messages set handled = true where id = ${m.inbound_id}`;
    if (!ALWAYS_AUTO.has(m.type) && dry && m.clinic_id && COLD_TYPES.has(m.type)) {
      await tx`update clinics set status_reason = 'dry run: the email was not sent' where id = ${m.clinic_id} and status = 'queued'`;
    }
  });
  await ctx?.log(dry ? "dry run: marked sent, nothing left" : "sent", { to: m.to_email, providerId });
  return { outcome: dry ? "dry_run" : "sent" };
}

register("send_message", async (ctx) => sendMessage((ctx.job.payload as { messageId: string }).messageId, ctx));

// ---------------------------------------------------------------------------
// Follow-up: one short note, once, if the first email got no reply.
// ---------------------------------------------------------------------------

export function buildFollowUp(o: { clinicName: string; toEmail: string; sourceUrl: string | null; reportUrl: string; firstSentOn: string }): { subject: string; bodyText: string } {
  const body = [
    `Hello ${o.clinicName} team,`,
    ``,
    `On ${o.firstSentOn} I sent you a free report on whether an AI assistant names your clinic when patients ask for a recommendation. In case it was missed, it is still here:`,
    o.reportUrl,
    ``,
    `This is the only reminder I will send.`,
    ``,
    signature(),
    ``,
    `--`,
    `You are receiving this because ${o.toEmail} is published on ${o.sourceUrl ?? "your website"}. To stop all emails from me, use this link (no login needed): ${unsubscribeUrl(o.toEmail)}`,
  ].join("\n");
  return { subject: `Your free report for ${o.clinicName}`, bodyText: body };
}

/**
 * Queue the follow-up for clinics whose first email went out (live) at least
 * follow_up_business_days business days ago with no reply. Idempotent per
 * clinic; the send job still applies every rule, including the two-contact limit.
 */
export async function queueDueFollowUps(now = new Date()): Promise<number> {
  const sql = db();
  const s = await getSettings();
  const rows = await sql<{ clinic_id: string; name: string; to_email: string; contact_source_url: string | null; sent_at: Date; token: string | null; report_id: string | null }[]>`
    select m.clinic_id, c.name, m.to_email, m.contact_source_url, m.sent_at, r.token, r.id as report_id
    from messages m join clinics c on c.id = m.clinic_id left join reports r on r.id = m.report_id
    where m.type = 'first_email' and m.status = 'sent' and m.dry_run = false
      and c.status = 'contacted' and c.replied = false and c.contact_count = 1
      and m.bounced_at is null and m.complained_at is null
      and not exists (select 1 from messages f where f.clinic_id = m.clinic_id and f.type = 'follow_up')
    order by m.sent_at limit 200`;
  let n = 0;
  for (const r of rows) {
    if (addBusinessDays(r.sent_at, s.follow_up_business_days).getTime() > now.getTime()) continue;
    if (!r.token) continue;
    const d = buildFollowUp({
      clinicName: r.name, toEmail: r.to_email, sourceUrl: r.contact_source_url,
      reportUrl: `${env().APP_URL}/r/${r.token}`, firstSentOn: localDate(r.sent_at),
    });
    const q = await queueMessage({
      type: "follow_up", toEmail: r.to_email, subject: d.subject, bodyText: d.bodyText, clinicId: r.clinic_id,
      reportId: r.report_id, contactSourceUrl: r.contact_source_url, idempotencyKey: `followup:${r.clinic_id}`, priority: 60,
    });
    if (q.created) n++;
  }
  return n;
}

// Once a business day, before the sending window opens: queue due follow-ups.
registerScheduled({
  name: "follow_ups",
  every: "day",
  atHour: 9,
  businessDaysOnly: true,
  pipeline: true,
  run: async ({ now }) => ({ queued: await queueDueFollowUps(now) }),
});
