import { db } from "../db";
import { enqueue } from "../jobs/queue";
import { effectiveDryRun, getSettings } from "../settings";
import { sha256 } from "../tokens";
import { ownerDetails, env } from "../env";
import { decideReview } from "./modes";

/**
 * The one way to create an outbound message outside the teaser pipeline.
 *
 * - Idempotent: `idempotencyKey` is unique; a repeat returns the first message.
 * - The REVIEW / AUTO switch for the type decides whether it waits for the
 *   owner (`pending_review`) or goes straight to the send job (`approved`).
 *   Receipts, unsubscribe confirmations and owner mail are always automatic.
 * - These messages do not expire while they wait for review (only teasers do).
 * - Nothing here sends: the `send_message` job re-applies every sending rule.
 */
export interface NewMessage {
  type: string;                      // a message_type enum value
  toEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string | null;
  idempotencyKey: string;
  clinicId?: string | null;
  reportId?: string | null;          // attachPdf sends this report's PDF
  attachPdf?: boolean;
  contactSourceUrl?: string | null;
  inReplyTo?: string | null;         // messages.id this answers
  inboundId?: string | null;         // inbound_messages.id this answers
  claims?: unknown[];
  flags?: { code: string; message: string; severity: "block" | "warn" }[];
  /** Force owner review whatever the mode says (e.g. a drafted reply the gate was unsure of). */
  forceReview?: string;
  priority?: number;                 // send job priority, lower runs first (default 50)
}

export interface QueuedMessage {
  id: string;
  status: string;
  created: boolean;
}

export async function queueMessage(m: NewMessage): Promise<QueuedMessage> {
  const sql = db();
  const settings = await getSettings();
  const dry = await effectiveDryRun(settings);
  const flags = m.flags ?? [];
  const blocked = flags.some((f) => f.severity === "block");

  const row = await sql.begin(async (tx) => {
    const [existing] = await tx<{ id: string; status: string }[]>`
      select id, status::text from messages where idempotency_key = ${m.idempotencyKey}`;
    if (existing) return { ...existing, created: false };
    const decision = await decideReview(tx as never, m.type);
    let status = "approved";
    let reason: string | null = decision.reason;
    if (blocked) {
      status = "held";
      reason = "verification gate: " + flags.filter((f) => f.severity === "block").map((f) => f.message).join("; ");
    } else if (m.forceReview) {
      status = "pending_review";
      reason = m.forceReview;
    } else if (decision.requiresReview) {
      status = "pending_review";
    } else if (flags.length) {
      status = "pending_review";
      reason = "AUTO mode, but the gate raised warnings";
    }
    const [ins] = await tx<{ id: string }[]>`
      insert into messages (clinic_id, type, status, to_email, contact_source_url, subject, body_text, body_html,
                            report_id, attach_pdf, claims, flags, gate_passed, requires_review, review_reason,
                            mode_at_creation, in_reply_to, inbound_id, expires_at, content_hash, idempotency_key, dry_run)
      values (${m.clinicId ?? null}, ${m.type}, ${status}, ${m.toEmail.trim().toLowerCase()}, ${m.contactSourceUrl ?? null},
              ${m.subject}, ${m.bodyText}, ${m.bodyHtml ?? null}, ${m.reportId ?? null}, ${m.attachPdf ?? false},
              ${tx.json((m.claims ?? []) as never)}, ${tx.json(flags as never)}, ${!blocked}, ${status !== "approved"}, ${reason},
              ${decision.mode}, ${m.inReplyTo ?? null}, ${m.inboundId ?? null},
              ${null},
              ${sha256(m.subject + "\n" + m.bodyText)}, ${m.idempotencyKey}, ${dry})
      returning id`;
    return { id: ins.id, status, created: true };
  });
  if (row.created && row.status === "approved") {
    await enqueue("send_message", `send:${row.id}`, { messageId: row.id }, { priority: m.priority ?? 50 });
  }
  return row;
}

/** Mail to the owner (alerts, digests): always automatic, never reviewed. */
export async function queueOwnerMail(kind: "owner_alert" | "owner_digest", key: string, subject: string, bodyText: string): Promise<QueuedMessage> {
  return queueMessage({ type: kind, toEmail: env().OWNER_EMAIL, subject, bodyText, idempotencyKey: `${kind}:${key}`, priority: 5 });
}

/** Sender block that closes every email (CASL: who is sending and how to reach them). */
export function signature(): string {
  const o = ownerDetails();
  return [`${o.name}`, `${o.businessName}`, `${o.mailingAddress} · ${o.phone}`, `intheanswer.ca`].join("\n");
}
